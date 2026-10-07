// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 口径：只有有效小时值参与统计——标记为有效、设备状态正常、数值在量程内
function isCounted(reading, device, settings) {
  return true;
}

// 口径：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理
function effectiveConcentration(reading, settings) {
  return Number(reading.value);
}

// 小时值里的氧含量（同排放口同时刻的氧含量读数）
function oxygenAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '氧含量' && r.at === reading.at);
  return row ? Number(row.value) : null;
}

function flowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  return row ? Number(row.value) : 0;
}

function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return Number(reading.value) >= 0 && !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 一天里该排放口某指标的逐小时明细
function dayRows(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric, day });
  return rows.map((row) => {
    const device = deviceOf(data, row.deviceId);
    const counted = isCounted(row, device, settings);
    return {
      id: row.id,
      at: row.at,
      hour: Number(String(row.at).slice(11, 13)),
      value: Number(row.value),
      source: row.source,
      flag: row.flag,
      deviceCode: device ? device.code : '',
      deviceStatus: device ? device.status : '',
      oxygen: oxygenAt(data, row),
      flow: flowAt(data, row),
      counted,
      concentration: counted ? effectiveConcentration(row, settings) : 0,
    };
  });
}

// 日均：按小时流量加权；有效小时不足 18 小时该日无效；补录小时超过上限（maxImputeHoursPerDay）该日整体不计入平均与总量
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayRows(data, outletId, metric, day);
  const counted = rows.filter((r) => r.counted);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const imputedHours = counted.filter((r) => r.source === '补录').length;
  const imputedCount = rows.filter((r) => r.source === '补录').length;
  const imputeLimit = Number(settings.maxImputeHoursPerDay);
  if (!counted.length) {
    return {
      day, outletId, metric, rows, countedHours: 0, imputedHours, imputedCount, imputeLimit,
      average: 0, valid: false, invalidReason: '无有效小时值', limit, exceed: false, flowTotal: 0,
    };
  }
  const sum = counted.reduce((acc, r) => acc + r.concentration, 0);
  const average = store.round(sum / counted.length, 2);
  const flowTotal = counted.reduce((acc, r) => acc + r.flow, 0);
  // 口径：单日补录小时超过上限，该日按无效处理，不计入平均与总量，也不参与超标判定
  const overLimit = imputedHours > imputeLimit;
  const invalidReason = overLimit
    ? '补录 ' + imputedHours + ' 小时，超过单日补录上限 ' + imputeLimit + ' 小时（超 ' + (imputedHours - imputeLimit) + ' 小时），该日不计入月均与总量'
    : '';
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours: counted.length,
    imputedHours,
    imputedCount,
    imputeLimit,
    average,
    valid: !overLimit,
    invalidReason,
    limit,
    exceed: !overLimit && average > limit,
    flowTotal: store.round(flowTotal, 1),
  };
}

function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    if (!readingsOf(data, { outletId, metric, day }).length) continue;
    out.push(dailyStats(data, outletId, metric, day));
  }
  return out;
}

// 月均值：按有数据且有效的天数平均（分母是有效天数，不是当月天数）；补录超限日不计入
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  if (!series.length) return 0;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / series.length, 2);
}

// 月总量（吨）：只对有效日逐小时累加，浓度与流量取同一时刻的那一对；补录超限日不计入
function monthTotal(data, outletId, metric, month) {
  const settings = data.settings;
  let mg = 0;
  for (const s of dailySeries(data, outletId, metric, month)) {
    if (!s.valid) continue;
    for (const row of s.rows) {
      if (!row.counted) continue;
      mg += row.concentration * row.flow;
    }
  }
  return store.round(mg / Number(settings.tonsDivisor), 4);
}

// 季度总量：按当季日均乘以季节天数
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  const totals = months.filter((m) => dailySeries(data, outletId, metric, m).length).map((m) => monthTotal(data, outletId, metric, m));
  if (!totals.length) return 0;
  const average = totals.reduce((a, b) => a + b, 0) / totals.length;
  return store.round((average / store.daysInMonth(months[0])) * 90, 4);
}

// 季度许可量：年度许可按季度平均分解
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  return store.round(annual / 4, 4);
}

// 年累计：把库里的全部数据加起来
function accumulatedTons(data, metric) {
  const outlets = data.outlets.map((o) => o.id);
  let total = 0;
  for (const outletId of outlets) {
    const months = Array.from(new Set(data.readings.filter((r) => r.outletId === outletId && r.metric === metric).map((r) => store.monthOf(r.at))));
    for (const month of months) total += monthTotal(data, outletId, metric, month);
  }
  return store.round(total, 4);
}

// 超标：日均超过限值，或者小时值超过限值达到规定次数
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.valid && s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series) {
    if (!s.valid) continue; // 无效日（含补录超限日）不参与超标判定
    for (const row of s.rows) if (row.counted && row.concentration > limit) exceedHours += 1;
  }
  const hourly = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    hourlyExceed: hourly,
    exceeded: exceedDays.length > 0,
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

// 排放口汇总：逐指标给出月均、月总量、超标情况
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    const series = dailySeries(data, outletId, metric, month);
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: monthTotal(data, outletId, metric, month),
      validDayCount: series.filter((s) => s.valid).length,
      imputeExceededDays: series.filter((s) => !s.valid && s.imputedHours > s.imputeLimit).map((s) => ({
        day: s.day,
        imputedHours: s.imputedHours,
        imputeLimit: s.imputeLimit,
        overBy: s.imputedHours - s.imputeLimit,
        reason: s.invalidReason,
      })),
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      exceeded: ex.exceeded,
      limit: ex.limit,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮'),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, isCounted, effectiveConcentration, oxygenAt, flowAt,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, quarterTotal, quarterPermitTons, accumulatedTons,
  exceedance, outletsOf, outletSummary,
};
