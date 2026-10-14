/**
 * 分红数据解析与股息率计算
 *
 * 核心口径：
 * 1. TTM股息率 = 近365天内已实施除息的每股税前现金分红合计 ÷ 最新股价
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

/** 近12个月（TTM）每股现金分红合计 */
function calcTTMDividend(implemented) {
  const cutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const cutoffStr = toDateStr(cutoff);
  let total = 0;
  const detail = [];
  implemented.forEach((it) => {
    if (it.hasCash && it.exDate && it.exDate > cutoffStr) {
      total += it.perShare;
      detail.push({ exDate: it.exDate, perShare: +it.perShare.toFixed(4), profile: it.profile, bonusYear: it.bonusYear });
    }
  });
  return { perShare: +total.toFixed(4), detail };
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

module.exports = { parseDividends, calcTTMDividend, aggregateAnnual, calcPayoutRatios, latestFullYear, toDateStr };
