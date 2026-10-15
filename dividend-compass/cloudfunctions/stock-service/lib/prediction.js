/**
 * 预期分红与预期股息率预测
 *
 * 模式一（双模型区间预测）：
 *   模型A 分红趋势外推：近3~5个分红年度每股分红 CAGR 外推下一期
 *   模型B 派息率×净利润：近3年平均派息率 × 预测净利润（净利3年CAGR外推）÷ 总股本
 *   输出 保守/中性/乐观 三档分红及对应股息率
 *
 * 模式二（盈利修正预测）：在双模型基础上叠加修正因子：
 *   ① 最新报告期增速加权（近期动量）② 盈利稳定性 ③ 现金流覆盖 ④ 分红连续性
 *   输出修正后区间 + 因子明细 + 信心度评分
 */

function clamp(v, min, max) {
  if (!isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** 类型安全数字判断（注意 isFinite(null) === true 的 JS 陷阱，不可直接用 isFinite 判空） */
function isNum(v) { return typeof v === 'number' && isFinite(v); }

function cagr(from, to, years) {
  if (!(from > 0) || !(to > 0) || years <= 0) return null;
  return Math.pow(to / from, 1 / years) - 1;
}

function mean(arr) {
  const v = arr.filter((x) => isNum(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function std(arr) {
  const v = arr.filter((x) => isNum(x));
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
}

/**
 * @param annualAgg  dividend.aggregateAnnual 结果（升序）
 * @param payoutRatios dividend.calcPayoutRatios 结果
 * @param financeAnnual 年度财务（降序）
 * @param financeReports 报告期财务（降序，含最新一期）
 * @param price 最新股价
 * @param totalShares 最新总股本（股）
 */
function predict(annualAgg, payoutRatios, financeAnnual, financeReports, price, totalShares) {
  const result = {
    hasEnoughData: false,
    nextPeriod: null,          // 预测目标：下一分红年度
    basic: null,               // 模式一结果
    enhanced: null,            // 模式二结果
    notes: [],
  };

  const yearAgg = annualAgg.filter((a) => a.perShare > 0);
  if (!yearAgg.length || !price) {
    result.notes.push('该股票历史无现金分红或无行情，无法预测');
    return result;
  }

  const lastAgg = yearAgg[yearAgg.length - 1];
  const nextPeriodYear = lastAgg.year + 1;
  result.nextPeriod = nextPeriodYear + '年度';

  // ---------- 公共数据准备 ----------
  const profitMap = {}; // 年 → 归母净利润
  financeAnnual.forEach((f) => {
    if (f.reportDate && f.reportDate.endsWith('12-31') && isNum(f.parentNetProfit)) {
      profitMap[f.reportDate.slice(0, 4)] = f.parentNetProfit;
    }
  });
  const years = Object.keys(profitMap).sort();
  const lastProfitYear = years.length ? years[years.length - 1] : null;
  const lastProfit = lastProfitYear ? profitMap[lastProfitYear] : null;

  const shares = totalShares || lastAgg.latestShares || 0;

  // ---------- 模型A：分红趋势外推 ----------
  const divSeries = yearAgg.slice(-5);
  let divCAGR = null;
  if (divSeries.length >= 3) {
    divCAGR = cagr(divSeries[0].perShare, divSeries[divSeries.length - 1].perShare, divSeries.length - 1);
  } else if (divSeries.length === 2) {
    divCAGR = divSeries[1].perShare / divSeries[0].perShare - 1;
  }
  const clampedDivGrowth = divCAGR === null ? 0.02 : clamp(divCAGR, -0.30, 0.30);
  const modelA = lastAgg.perShare * (1 + clampedDivGrowth);

  // ---------- 模型B：派息率 × 预测净利润 ----------
  const prValues = payoutRatios
    .filter((p) => p.payoutRatio !== null && p.payoutRatio > 0 && p.payoutRatio < 200)
    .slice(-3)
    .map((p) => p.payoutRatio / 100);
  let modelB = null;
  let modelBBase = null;
  if (lastProfit && shares > 0) {
    // 净利润3年CAGR
    let profitCAGR = null;
    if (lastProfitYear && profitMap[lastProfitYear - 2] > 0) {
      profitCAGR = cagr(profitMap[lastProfitYear - 2], lastProfit, 2);
    } else if (lastProfitYear && profitMap[lastProfitYear - 3] > 0) {
      profitCAGR = cagr(profitMap[lastProfitYear - 3], lastProfit, 3);
    }
    const g = profitCAGR === null ? 0 : clamp(profitCAGR, -0.50, 0.50);
    const nextProfit = lastProfit * (1 + g);
    const pr = prValues.length ? mean(prValues) : null;
    const basePR = pr !== null ? clamp(pr, 0.05, 1.5) : (lastProfit ? clamp(lastAgg.totalCash / lastProfit, 0.05, 1.5) : 0.3);
    modelBBase = { nextProfit, payoutRatio: basePR, profitGrowth: g, profitCAGR };
    modelB = (basePR * nextProfit) / shares;
  }

  // ---------- 模式一：双模型区间 ----------
  let conservative, neutral, optimistic;
  const candidates = [modelA];
  if (modelB !== null && isFinite(modelB) && modelB > 0) candidates.push(modelB);
  if (!candidates.length) {
    result.notes.push('有效预测数据不足');
    return result;
  }
  if (candidates.length === 1) {
    const v = candidates[0];
    conservative = v * 0.85;
    neutral = v;
    optimistic = v * 1.10;
  } else {
    conservative = Math.min.apply(null, candidates) * 0.90;
    neutral = mean(candidates);
    optimistic = Math.max.apply(null, candidates) * 1.08;
  }
  result.hasEnoughData = true;
  result.basic = {
    modelA: {
      value: +modelA.toFixed(4),
      divGrowth: divCAGR === null ? null : +(divCAGR * 100).toFixed(2),
      clampedGrowth: +(clampedDivGrowth * 100).toFixed(2),
      desc: '近' + divSeries.length + '个分红年度趋势外推',
    },
    modelB: modelBBase ? {
      value: +modelB.toFixed(4),
      payoutRatio: +(modelBBase.payoutRatio * 100).toFixed(2),
      profitGrowth: +(modelBBase.profitGrowth * 100).toFixed(2),
      nextProfit: modelBBase.nextProfit,
      desc: '均值派息率 × 预测净利润',
    } : null,
    range: {
      conservative: +conservative.toFixed(4),
      neutral: +neutral.toFixed(4),
      optimistic: +optimistic.toFixed(4),
    },
    yields: {
      conservative: +((conservative / price) * 100).toFixed(2),
      neutral: +((neutral / price) * 100).toFixed(2),
      optimistic: +((optimistic / price) * 100).toFixed(2),
    },
  };

  // ---------- 模式二：盈利修正 ----------
  const factors = [];
  let profitAdjust = 1;     // 对预测净利润的乘数调整
  let rangeAdjust = 1;      // 对区间宽度的调整

  // ① 最新报告期增速加权：近期动量
  let latestYoY = null;
  let latestReport = null;
  for (const f of (financeReports || [])) {
    if (isNum(f.netProfitYoy) && f.reportDate) { latestYoY = f.netProfitYoy; latestReport = f.reportType || f.reportDate; break; }
  }
  if (latestYoY !== null && modelBBase) {
    const blended = modelBBase.profitGrowth * 100 * 0.4 + clamp(latestYoY, -60, 60) * 0.6;
    profitAdjust *= (1 + (blended - modelBBase.profitGrowth * 100) / 100);
    factors.push({
      name: '最新业绩动量',
      value: latestYoY.toFixed(2) + '%（' + latestReport + '）',
      effect: blended >= modelBBase.profitGrowth * 100 ? '+' : '-',
      detail: '按最新报告期净利增速与3年趋势加权（6:4），修正年度盈利预期',
    });
  }

  // ② 盈利稳定性：近3年净利增速波动
  const growthSeries = [];
  for (let i = 0; i < financeAnnual.length - 1 && growthSeries.length < 3; i++) {
    if (isNum(financeAnnual[i].netProfitYoy)) growthSeries.push(financeAnnual[i].netProfitYoy);
  }
  const gStd = std(growthSeries);
  if (gStd !== null) {
    const stability = clamp(1 - gStd / 120, 0.75, 1);
    profitAdjust *= stability;
    factors.push({
      name: '盈利稳定性',
      value: '增速波动 ±' + gStd.toFixed(1) + '%',
      effect: stability < 1 ? '-' : '0',
      detail: '近' + growthSeries.length + '期净利润增速标准差越大，预测越保守',
    });
  }

  // ③ 现金流覆盖：近3年经营现金流/净利润
  const cfRatios = [];
  financeAnnual.slice(0, 3).forEach((f) => {
    if (isNum(f.perOperateCashflow) && isNum(f.eps) && f.eps > 0) cfRatios.push(f.perOperateCashflow / f.eps);
  });
  const cfRatio = mean(cfRatios);
  if (cfRatio !== null) {
    const cfFactor = cfRatio >= 1 ? 1 : clamp(cfRatio, 0.7, 1);
    profitAdjust *= cfFactor;
    factors.push({
      name: '现金流覆盖',
      value: '经营现金流/净利 = ' + cfRatio.toFixed(2),
      effect: cfFactor < 1 ? '-' : '0',
      detail: cfRatio >= 1 ? '净利润有充足现金流支撑' : '现金流对利润覆盖不足，预测下调',
    });
  }

  // ④ 分红连续性：连续分红年数与递增趋势
  const continueYears = countConsecutiveDividendYears(yearAgg);
  let continuityFactor = 1;
  let continuityNote = '';
  if (continueYears >= 8) { continuityFactor = 1.05; continuityNote = '连续分红' + continueYears + '年，分红意愿极强'; }
  else if (continueYears >= 5) { continuityFactor = 1.0; continuityNote = '连续分红' + continueYears + '年，分红意愿较强'; }
  else if (continueYears >= 3) { continuityFactor = 0.95; continuityNote = '连续分红' + continueYears + '年'; }
  else { continuityFactor = 0.88; continuityNote = '连续分红仅' + continueYears + '年，持续性待观察'; }
  rangeAdjust *= continuityFactor;
  factors.push({
    name: '分红连续性',
    value: '连续' + continueYears + '年分红',
    effect: continuityFactor > 1 ? '+' : (continuityFactor < 1 ? '-' : '0'),
    detail: continuityNote,
  });

  // 修正后的区间
  const eConservative = conservative * profitAdjust * rangeAdjust;
  const eNeutral = neutral * profitAdjust * rangeAdjust;
  const eOptimistic = optimistic * profitAdjust * rangeAdjust;

  // 信心度评分
  let confidence = 55;
  if (divSeries.length >= 4) confidence += 8;
  if (continueYears >= 5) confidence += 10;
  if (gStd !== null && gStd < 15) confidence += 8;
  if (cfRatio !== null && cfRatio >= 1) confidence += 7;
  if (prValues.length >= 3 && std(prValues) < 0.15) confidence += 7;
  confidence = Math.round(clamp(confidence, 30, 95));

  result.enhanced = {
    factors,
    confidence,
    profitAdjust: +(profitAdjust * 100).toFixed(1),
    range: {
      conservative: +eConservative.toFixed(4),
      neutral: +eNeutral.toFixed(4),
      optimistic: +eOptimistic.toFixed(4),
    },
    yields: {
      conservative: +((eConservative / price) * 100).toFixed(2),
      neutral: +((eNeutral / price) * 100).toFixed(2),
      optimistic: +((eOptimistic / price) * 100).toFixed(2),
    },
  };

  return result;
}

/** 从最新年度往前数连续分红年数 */
function countConsecutiveDividendYears(yearAgg) {
  if (!yearAgg.length) return 0;
  const yearSet = new Set(yearAgg.map((a) => a.year));
  const lastYear = yearAgg[yearAgg.length - 1].year;
  let count = 0;
  let y = lastYear;
  while (yearSet.has(y)) { count++; y--; }
  return count;
}

module.exports = { predict, countConsecutiveDividendYears };
