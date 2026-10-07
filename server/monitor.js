// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');

// 口径常量：单日计入小时不足 18 小时的，该日不计入平均与总量
const MIN_VALID_HOURS_PER_DAY = 18;

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

// 日有效性闸门：计入小时不足 18 小时，或补录小时超过单日上限（设置 maxImputeHoursPerDay），
// 该日整体不计入月均与总量；返回不能计入的原因列表（页面要写明补录了几小时、超了多少）
function dayGate(countedHours, imputedHours, settings) {
  const maxImpute = Number(settings.maxImputeHoursPerDay);
  const reasons = [];
  if (countedHours < MIN_VALID_HOURS_PER_DAY) {
    reasons.push('有效小时 ' + countedHours + ' 不足 ' + MIN_VALID_HOURS_PER_DAY + ' 小时');
  }
  if (imputedHours > maxImpute) {
    reasons.push('补录 ' + imputedHours + ' 小时，超过单日补录上限 ' + maxImpute + ' 小时（超 ' + (imputedHours - maxImpute) + ' 小时）');
  }
  return { valid: reasons.length === 0, reasons };
}

// 日均：按小时流量加权；有效小时不足 18 小时该日无效；补算小时不超过上限
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayRows(data, outletId, metric, day);
  const counted = rows.filter((r) => r.counted);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const imputedHours = counted.filter((r) => r.source === '补录').length;
  const base = {
    day,
    outletId,
    metric,
    rows,
    countedHours: counted.length,
    imputedHours,
    limit,
    minHoursPerDay: MIN_VALID_HOURS_PER_DAY,
    maxImputeHoursPerDay: Number(settings.maxImputeHoursPerDay),
  };
  if (!counted.length) {
    return Object.assign(base, {
      average: 0, valid: false, invalidReasons: ['没有计入的小时值'], reason: '没有计入的小时值',
      exceed: false, flowTotal: 0,
    });
  }
  const gate = dayGate(counted.length, imputedHours, settings);
  const sum = counted.reduce((acc, r) => acc + r.concentration, 0);
  const average = store.round(sum / counted.length, 2);
  const flowTotal = counted.reduce((acc, r) => acc + r.flow, 0);
  return Object.assign(base, {
    average,
    valid: gate.valid,
    invalidReasons: gate.reasons,
    reason: gate.reasons.join('；'),
    exceed: gate.valid && average > limit,
    flowTotal: store.round(flowTotal, 1),
  });
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

// 每日补录条数统计：该排放口当月每一天（有数据的天）的补录记录数，含分指标明细
function imputationByDay(data, outletId, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    const rows = readingsOf(data, { outletId, day });
    if (!rows.length) continue;
    const byMetric = {};
    let imputedCount = 0;
    for (const r of rows) {
      if (r.source !== '补录') continue;
      byMetric[r.metric] = (byMetric[r.metric] || 0) + 1;
      imputedCount += 1;
    }
    out.push({ day, imputedCount, byMetric });
  }
  return out;
}

// 月均值：按有效天的日均平均，分母是有效天数（无效日既不进分子也不进分母）
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  if (!series.length) return 0;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / series.length, 2);
}

// 月总量（吨）：只对有效日逐小时累加，浓度与流量取同一时刻的那一对；无效日整体不进总量
function monthTotal(data, outletId, metric, month) {
  const settings = data.settings;
  let mg = 0;
  const series = dailySeries(data, outletId, metric, month);
  for (const s of series) {
    if (!s.valid) continue;
    for (const row of s.rows) {
      if (!row.counted) continue;
      mg += row.concentration * row.flow;
    }
  }
  return store.round(mg / Number(settings.tonsDivisor), 4);
}

// 每日补录条数统计：该排放口当月每一天的补录记录数（含分指标明细），用于页面把补录与自动区分展示
function imputationByDay(data, outletId, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    const rows = readingsOf(data, { outletId, day });
    if (!rows.length) continue;
    const byMetric = {};
    let imputedCount = 0;
    for (const r of rows) {
      if (r.source !== '补录') continue;
      byMetric[r.metric] = (byMetric[r.metric] || 0) + 1;
      imputedCount += 1;
    }
    out.push({ day, imputedCount, autoCount: rows.length - imputedCount, byMetric });
  }
  return out;
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
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series) {
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
    const invalidDays = series.filter((s) => !s.valid).map((s) => ({ day: s.day, reason: s.reason }));
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: monthTotal(data, outletId, metric, month),
      validDayCount: series.length - invalidDays.length,
      invalidDayCount: invalidDays.length,
      invalidDays,
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
  exceedance, outletsOf, outletSummary, dayGate, imputationByDay,
  MIN_VALID_HOURS_PER_DAY,
};
