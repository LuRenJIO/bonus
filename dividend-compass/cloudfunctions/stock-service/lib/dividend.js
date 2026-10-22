/**
 * 分红数据解析与股息率计算
 *
 * 核心口径：
 * 1. TTM股息率 = 最近4个季度报告期（以最新已实施分红的报告期为锚）已实施税前现金分红合计 ÷ 最新股价。
 *    标准财务滚动口径：如锚为 2026 中报（REPORT_DATE=2026-06-30），则计入 2026中报/2026一季/2025年报/2025三季，
 *    不含 2025 中报——修正"按除息日滑窗365天"在分红节奏提前/推迟/漂移时的重复计入问题。
 * 2. 年度股息率 = 某分红年度（按报告期归属年）全部已实施分红合计 ÷ 最新股价
 * 3. 分红年度归属：按 REPORT_DATE 的年份聚合（2025-09-30 三季报特别分红 与 2025-12-31 年报分红
 *    均归属 2025 年度），与上市公司"年度利润分配"语义一致
 */

function toDateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const m = dt.getMonth() + 1;
  const day = dt.getDate();
  return dt.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/** 季度末日期串映射 */
const QUARTER_END = { 3: '31', 6: '30', 9: '30', 12: '31' };

/** 锚报告期（YYYY-MM-DD）及其前 count-1 个季度末报告期，升序外的倒序无所谓（调用方逐个查表） */
function quarterReports(anchor, count) {
  const y = parseInt(anchor.slice(0, 4), 10);
  const mm = parseInt(anchor.slice(5, 7), 10);
  let q = { 3: 0, 6: 1, 9: 2, 12: 3 }[mm];
  if (q === undefined) q = mm < 6 ? 0 : mm < 9 ? 1 : mm < 12 ? 2 : 3;   // 异常月份归入最近季度
  const out = [];
  let yy = y;
  for (let i = 0; i < count; i++) {
    const mEnd = [3, 6, 9, 12][q];
    out.push(yy + '-' + (mEnd < 10 ? '0' + mEnd : mEnd) + '-' + QUARTER_END[mEnd]);
    q -= 1;
    if (q < 0) { q = 3; yy -= 1; }
  }
  return out;
}

/**
 * 报告期口径 TTM（核心实现）：
 * 1. 截止 endDate 前已实施的现金分红，按报告期去重（同报告期取除息日最新一条）
 * 2. 锚 = 全部已实施中最新报告期，取锚及其前 3 个季度末报告期
 * 3. TTM = 这 4 个报告期分红之和（无分红的季度计 0）
 * @returns {perShare, detail, anchor, wanted}；若集合内无任何报告期数据返回 null（调用方回退滑窗）
 */
function calcTTMByReport(implemented, endDate) {
  const endStr = endDate ? toDateStr(endDate) : toDateStr(new Date());
  const byReport = {};
  let hasReport = false;
  implemented.forEach((it) => {
    if (!it.hasCash || !(it.perShare > 0) || !it.exDate || it.exDate > endStr) return;
    if (!it.reportDate) return;
    hasReport = true;
    const prev = byReport[it.reportDate];
    if (!prev || it.exDate > prev.exDate) byReport[it.reportDate] = it;
  });
  if (!hasReport) return null;
  const reports = Object.keys(byReport).sort();
  const anchor = reports[reports.length - 1];
  const wanted = quarterReports(anchor, 4);
  let total = 0;
  const detail = [];
  wanted.forEach((rd) => {
    const it = byReport[rd];
    if (it) {
      total += it.perShare;
      detail.push({
        exDate: it.exDate,
        perShare: +it.perShare.toFixed(4),
        profile: it.profile,
        bonusYear: it.bonusYear,
        reportDate: rd,
      });
    }
  });
  detail.sort((a, b) => (a.reportDate < b.reportDate ? 1 : -1));
  return { perShare: +total.toFixed(4), detail, anchor, wanted };
}

/** 旧滑窗口径（近365天求和），仅作报告期字段缺失时的回退 */
function windowTTM(implemented, endDate) {
  const endStr = toDateStr(endDate || new Date());
  const cutoff = toDateStr(new Date(new Date(endStr).getTime() - 365 * 24 * 3600 * 1000));
  let total = 0;
  const detail = [];
  implemented.forEach((it) => {
    if (it.hasCash && it.exDate && it.exDate > cutoff && it.exDate <= endStr) {
      total += it.perShare;
      detail.push({ exDate: it.exDate, perShare: +it.perShare.toFixed(4), profile: it.profile, bonusYear: it.bonusYear });
    }
  });
  return { perShare: +total.toFixed(4), detail };
}

/**
 * 解析原始分红记录列表
 * @param rawList dataSource.getDividendHistory 返回的记录（按预案公告日降序）
 * @param now 当前日期（可注入，便于测试）
 */
function parseDividends(rawList, now) {
  const today = toDateStr(now || new Date());
  const implemented = [];   // 已实施（除息日已到）
  const pending = [];       // 已公告未实施（预案/审议中，除息日未到或未定）
  rawList.forEach((r) => {
    const item = {
      perShare: (r.bonusPer10 || 0) / 10,   // 每股税前现金分红(元)
      hasCash: (r.bonusPer10 || 0) > 0,
      hasShareBonus: (r.bonusShares || 0) > 0 || (r.transferShares || 0) > 0,
      exDate: r.exDate,
      reportDate: r.reportDate,
      planNoticeDate: r.planNoticeDate,
      recordDate: r.recordDate,
      progress: r.progress,
      profile: r.profile,
      totalShares: r.totalShares,
      bonusYear: r.reportDate ? Number(r.reportDate.slice(0, 4)) : null,
    };
    const isDone = r.progress && r.progress.indexOf('实施') >= 0;
    if (isDone && item.exDate && item.exDate <= today) {
      implemented.push(item);
    } else if (item.hasCash || item.hasShareBonus) {
      pending.push(item);
    }
  });
  // 已实施按除息日降序
  implemented.sort((a, b) => (a.exDate < b.exDate ? 1 : -1));
  return { implemented, pending, today };
}

/** TTM 每股现金分红合计（报告期口径；报告期字段缺失时回退滑窗）。返回 {perShare, detail, basis} */
function calcTTMDividend(implemented) {
  const byReport = calcTTMByReport(implemented);
  if (byReport) {
    return { perShare: byReport.perShare, detail: byReport.detail, basis: 'report', anchor: byReport.anchor };
  }
  const win = windowTTM(implemented);
  return { perShare: win.perShare, detail: win.detail, basis: 'window' };
}

/** 按分红年度聚合每股现金分红（仅已实施） */
function aggregateAnnual(implemented) {
  const map = {};
  implemented.forEach((it) => {
    if (!it.hasCash || !it.bonusYear) return;
    if (!map[it.bonusYear]) {
      map[it.bonusYear] = { year: it.bonusYear, perShare: 0, times: 0, totalCash: 0, latestShares: 0, records: [] };
    }
    const agg = map[it.bonusYear];
    agg.perShare += it.perShare;
    agg.times += 1;
    if (it.totalShares) {
      agg.latestShares = Math.max(agg.latestShares, it.totalShares);
      agg.totalCash += it.perShare * it.totalShares;
    }
    agg.records.push({ exDate: it.exDate, perShare: +it.perShare.toFixed(4), profile: it.profile });
  });
  return Object.values(map).sort((a, b) => a.year - b.year); // 升序
}

/**
 * 计算各年度派息率（年度现金分红总额 ÷ 当年归母净利润）
 * @param annualAgg aggregateAnnual 结果
 * @param financeAnnual 年度财务数组（dataSource.getFinanceMain(code, 1)）
 */
function calcPayoutRatios(annualAgg, financeAnnual) {
  const profitMap = {};
  financeAnnual.forEach((f) => {
    if (f.reportDate && f.reportDate.endsWith('12-31')) {
      profitMap[f.reportDate.slice(0, 4)] = f.parentNetProfit;
    }
  });
  return annualAgg.map((agg) => {
    const profit = profitMap[agg.year];
    const totalCash = agg.totalCash > 0 ? agg.totalCash : agg.perShare * agg.latestShares;
    const ratio = profit && totalCash ? +(totalCash / profit * 100).toFixed(2) : null;
    return {
      year: agg.year,
      perShare: +agg.perShare.toFixed(4),
      payoutRatio: ratio,          // %
      netProfit: profit || null,
      dividendTotal: totalCash || null,
    };
  });
}

/** 最近完整分红年度（已实施记录中最后一个有分红的年度） */
function latestFullYear(annualAgg) {
  if (!annualAgg.length) return null;
  return annualAgg[annualAgg.length - 1];
}

/**
 * 股息率曲线时序：各月末 TTM 股息率 + 预期股息率点
 * 口径与核心 TTM 一致（报告期口径）：各月末以"该月末前已实施分红"重算 TTM（锚随历史时点滚动）
 * @param implemented parseDividends 结果（降序，内部转升序）
 * @param monthlyCloses dataSource.getMonthlyCloses 结果（升序）
 * @param expectedYield 预期股息率%（中性预测，可 null）
 */
function calcYieldSeries(implemented, monthlyCloses, expectedYield) {
  if (!monthlyCloses || monthlyCloses.length < 2) return null;
  const asc = implemented.slice().sort((a, b) => (a.exDate > b.exDate ? 1 : -1));
  const points = [];
  monthlyCloses.forEach((m) => {
    const endStr = monthEndStr(m.ym);
    const r = calcTTMByReport(asc, endStr);
    const ttm = r ? r.perShare : windowTTM(asc, endStr).perShare;
    points.push({ ym: m.ym, yield: +((ttm / m.close) * 100).toFixed(2) });
  });
  // 从第一个有分红的月份开始，避免曲线前段长期为 0
  let start = 0;
  while (start < points.length - 1 && points[start].yield <= 0) start++;
  const trimmed = points.slice(start);

  // 预期点：放在下一个月，前端以"预期"标注
  let expected = null;
  if (expectedYield !== null && expectedYield !== undefined && isFinite(expectedYield) && trimmed.length) {
    const lastYm = trimmed[trimmed.length - 1].ym;
    const y = parseInt(lastYm.slice(0, 4), 10);
    const mo = parseInt(lastYm.slice(5, 7), 10);
    const next = mo === 12 ? (y + 1) + '-01' : y + '-' + (mo + 1 < 10 ? '0' + (mo + 1) : mo + 1);
    expected = { ym: next, yield: +expectedYield.toFixed(2) };
  }
  return { points: trimmed, expected };
}

/** 月份 'YYYY-MM' → 该月末日期字符串（用于 TTM 截止判断，取次月1日前一天即月末） */
function monthEndStr(ym) {
  const y = parseInt(ym.slice(0, 4), 10);
  const mo = parseInt(ym.slice(5, 7), 10);
  const nextFirst = new Date(y, mo, 1);   // 次月1日
  nextFirst.setDate(0);                    // 回退到本月末
  return toDateStr(nextFirst);
}

/**
 * 股息率历史分位：最新点在全部历史点位中的分位（0-100 整数）
 * 高分位 = 当前股息率高于历史上大部分时间 = 股价相对便宜（红利策略买点信号）
 */
function yieldPercentile(points) {
  if (!points || points.length < 6) return null;
  const last = points[points.length - 1].yield;
  const below = points.filter((p) => p.yield <= last).length;
  return Math.round((below / points.length) * 100);
}

/**
 * 自选股近期分红日程：已定除息日的未来分红 + 已公告未定除息日的预案
 * @param rawList getDividendHistory 原始记录
 * @param days 未来天数（默认 60）
 * @param now 当前时间（可注入）
 * @returns [{exDate, perShare, profile, progress, planNoticeDate}] 除息日升序，未定日期排最后
 */
function upcomingDividends(rawList, days, now) {
  const today = toDateStr(now || new Date());
  const endDay = toDateStr(new Date((now || new Date()).getTime() + (days || 60) * 24 * 3600 * 1000));
  const withDate = [];
  const noDate = [];
  rawList.forEach((r) => {
    const perShare = (r.bonusPer10 || 0) / 10;
    if (perShare <= 0) return;   // 仅现金分红
    const isDone = r.progress && r.progress.indexOf('实施') >= 0;
    const exDate = r.exDate;
    const item = {
      exDate: exDate || null,
      perShare: +perShare.toFixed(4),
      profile: r.profile,
      progress: r.progress,
      planNoticeDate: r.planNoticeDate,
    };
    if (isDone && exDate && exDate >= today && exDate <= endDay) {
      withDate.push(item);        // 已实施、除息日为今天或窗口内未来
    } else if (!isDone && exDate && exDate >= today) {
      withDate.push(item);        // 已审议通过、除息日已定
    } else if (!isDone && !exDate) {
      noDate.push(item);          // 预案阶段，除息日未定
    }
  });
  withDate.sort((a, b) => (a.exDate > b.exDate ? 1 : -1));
  noDate.sort((a, b) => ((a.planNoticeDate || '') < (b.planNoticeDate || '') ? 1 : -1));
  return withDate.concat(noDate).slice(0, 10);
}

module.exports = { parseDividends, calcTTMDividend, calcTTMByReport, windowTTM, quarterReports, aggregateAnnual, calcPayoutRatios, latestFullYear, calcYieldSeries, yieldPercentile, upcomingDividends, toDateStr };
