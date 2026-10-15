/**
 * 低波视角风险指标（月度口径）
 *
 * 输入：个股月末收盘价序列 + 沪深300月末收盘价序列（同源同长度窗口）
 * 输出：
 *   volatility   近1年年化波动率 = 近12个月收益率标准差 × √12（%）
 *   maxDrawdown  近1年最大回撤 = 区间内从峰值到谷值的最大跌幅（%，正数）
 *   beta         近5年月度Beta = cov(个股, 沪深300) / var(沪深300)
 * 数据不足时对应字段为 null，不猜测。
 */

function monthlyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1].close > 0) {
      out.push({ ym: closes[i].ym, r: closes[i].close / closes[i - 1].close - 1 });
    }
  }
  return out;
}

/** 按月份对齐两组收益率（取交集，保持时间升序） */
function alignReturns(stockCloses, indexCloses) {
  const idxMap = {};
  (indexCloses || []).forEach((c) => { idxMap[c.ym] = c.close; });
  const pairs = [];   // [{ym, s, i}]
  for (let i = 1; i < stockCloses.length; i++) {
    const prevYm = stockCloses[i - 1].ym;
    const ym = stockCloses[i].ym;
    if (idxMap[ym] !== undefined && idxMap[prevYm] !== undefined &&
        stockCloses[i - 1].close > 0 && idxMap[prevYm] > 0) {
      pairs.push({
        ym,
        s: stockCloses[i].close / stockCloses[i - 1].close - 1,
        i: idxMap[ym] / idxMap[prevYm] - 1,
      });
    }
  }
  return pairs;
}

function stdDev(arr) {
  if (arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const varr = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (arr.length - 1);
  return Math.sqrt(varr);
}

function calcRiskMetrics(stockCloses, indexCloses) {
  if (!stockCloses || stockCloses.length < 3) return null;

  // ---- 近1年年化波动率（近12个月收益率）----
  const rets = monthlyReturns(stockCloses);
  const last12 = rets.slice(-12);
  const volatility = last12.length >= 6 && stdDev(last12.map((x) => x.r)) !== null
    ? +(stdDev(last12.map((x) => x.r)) * Math.sqrt(12) * 100).toFixed(1)
    : null;

  // ---- 近1年最大回撤（近13个月末价格）----
  const closes12 = stockCloses.slice(-13);
  let peak = -Infinity;
  let mdd = 0;
  closes12.forEach((c) => {
    if (c.close > peak) peak = c.close;
    if (peak > 0) {
      const dd = (peak - c.close) / peak;
      if (dd > mdd) mdd = dd;
    }
  });
  const maxDrawdown = closes12.length >= 3 ? +(mdd * 100).toFixed(1) : null;

  // ---- Beta（近60个月，对沪深300）----
  let beta = null;
  if (indexCloses && indexCloses.length >= 13) {
    const pairs = alignReturns(stockCloses, indexCloses).slice(-60);
    if (pairs.length >= 12) {
      const ms = pairs.reduce((a, p) => a + p.s, 0) / pairs.length;
      const mi = pairs.reduce((a, p) => a + p.i, 0) / pairs.length;
      let cov = 0, vi = 0;
      pairs.forEach((p) => {
        cov += (p.s - ms) * (p.i - mi);
        vi += (p.i - mi) * (p.i - mi);
      });
      if (vi > 0) beta = +(cov / vi).toFixed(2);
    }
  }

  if (volatility === null && maxDrawdown === null && beta === null) return null;
  return { volatility, maxDrawdown, beta };
}

module.exports = { calcRiskMetrics };
