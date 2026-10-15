/**
 * 分红可持续性体检（6 维度，0-100 分）
 * 面向低波红利策略：评估当前分红水平未来能否持续
 */

function clampScore(v) { return Math.max(0, Math.min(100, Math.round(v))); }

/** 类型安全数字判断（注意 isFinite(null) === true 的 JS 陷阱，不可直接用 isFinite 判空） */
function isNum(v) { return typeof v === 'number' && isFinite(v); }

function gradeOf(score) {
  if (score >= 80) return { grade: 'A', label: '优质' };
  if (score >= 65) return { grade: 'B', label: '良好' };
  if (score >= 50) return { grade: 'C', label: '一般' };
  return { grade: 'D', label: '偏弱' };
}

/**
 * @param opts {
 *   payoutRatios: [{year, payoutRatio, ...}] 各年度派息率
 *   annualAgg: 年度分红聚合
 *   financeAnnual: 年度财务（降序）
 *   ttmDividend: {perShare} TTM每股分红
 *   perUnassignProfit: 最新每股未分配利润
 *   latestDebtRatio: 最新资产负债率(%)
 * }
 */
function healthCheck(opts) {
  const { payoutRatios = [], annualAgg = [], financeAnnual = [], ttmDividend, perUnassignProfit, latestDebtRatio } = opts;
  const items = [];

  // ---------- ① 派息率水平与稳定性 ----------
  {
    const prs = payoutRatios.filter((p) => p.payoutRatio !== null).slice(-3).map((p) => p.payoutRatio);
    let score = 50, status = 'warn', value = '数据不足', note = '派息率数据不足';
    if (prs.length) {
      const avg = prs.reduce((a, b) => a + b, 0) / prs.length;
      const spread = Math.max(...prs) - Math.min(...prs);
      if (avg >= 20 && avg <= 70) { score = 90; status = 'good'; }
      else if (avg > 70 && avg <= 100) { score = 65; status = 'warn'; }
      else if (avg > 100) { score = 35; status = 'bad'; }
      else { score = 60; status = 'warn'; } // <20% 分红偏少
      if (spread > 25) { score -= 15; } // 波动大扣分
      score = clampScore(score);
      value = '近' + prs.length + '年均值 ' + avg.toFixed(1) + '%';
      note = avg > 100 ? '派息率超过100%，分红超过当年利润，难以持续' :
        (avg < 20 ? '派息率偏低，分红意愿有限' :
        (spread > 25 ? '派息率波动较大，政策稳定性一般' : '派息率处于合理区间且较稳定'));
    }
    items.push({ name: '派息率水平', value, status, score, note });
  }

  // ---------- ② 分红连续性 ----------
  {
    const years = annualAgg.filter((a) => a.perShare > 0);
    const lastYear = years.length ? years[years.length - 1].year : null;
    const yearSet = new Set(years.map((a) => a.year));
    let consecutive = 0;
    if (lastYear !== null) { let y = lastYear; while (yearSet.has(y)) { consecutive++; y--; } }
    // 检查是否中断（最近两年是否都有分红）
    const nowYear = new Date().getFullYear();
    const hasGap = lastYear !== null && (nowYear - lastYear) >= 2;
    let score, status;
    if (hasGap) { score = 30; status = 'bad'; }
    else if (consecutive >= 8) { score = 95; status = 'good'; }
    else if (consecutive >= 5) { score = 80; status = 'good'; }
    else if (consecutive >= 3) { score = 60; status = 'warn'; }
    else { score = 35; status = 'bad'; }
    items.push({
      name: '分红连续性',
      value: hasGap ? '已中断（最近分红年度 ' + lastYear + '）' : '连续分红 ' + consecutive + ' 年',
      status, score: clampScore(score),
      note: hasGap ? '最近两年未实施现金分红，持续性存疑' :
        (consecutive >= 5 ? '长期稳定分红，公司治理成熟' : '分红历史较短，需继续观察'),
    });
  }

  // ---------- ③ 盈利稳定性 ----------
  {
    const recent = financeAnnual.slice(0, 3).filter((f) => f.reportDate && f.reportDate.endsWith('12-31'));
    let score = 50, status = 'warn', value = '数据不足', note = '年度盈利数据不足';
    if (recent.length >= 2) {
      const profits = recent.map((f) => f.parentNetProfit).filter((p) => isNum(p));
      const allPositive = profits.every((p) => p > 0);
      const maxDrawdown = (() => {
        let worst = 0, peak = -Infinity;
        [...profits].reverse().forEach((p) => { peak = Math.max(peak, p); if (peak > 0) worst = Math.min(worst, (p - peak) / peak); });
        return worst * 100;
      })();
      const yoys = recent.map((f) => f.netProfitYoy).filter((y) => isNum(y));
      const yoyRange = yoys.length ? Math.max(...yoys) - Math.min(...yoys) : null;
      if (!allPositive) { score = 25; status = 'bad'; note = '近年存在亏损年度，分红基础不牢'; }
      else if (maxDrawdown > -15 && (yoyRange === null || yoyRange < 30)) { score = 90; status = 'good'; note = '盈利持续为正且波动小，分红能力强'; }
      else if (maxDrawdown > -30) { score = 65; status = 'warn'; note = '盈利有一定波动'; }
      else { score = 45; status = 'warn'; note = '盈利波动较大，分红或受影响'; }
      value = '近' + profits.length + '年最大回撤 ' + maxDrawdown.toFixed(1) + '%';
    }
    items.push({ name: '盈利稳定性', value, status, score: clampScore(score), note });
  }

  // ---------- ④ 现金流质量 ----------
  {
    const cf = financeAnnual.slice(0, 3)
      .filter((f) => isNum(f.perOperateCashflow) && isNum(f.eps) && f.eps > 0)
      .map((f) => f.perOperateCashflow / f.eps);
    let score = 50, status = 'warn', value = '数据不足', note = '经营现金流数据不足';
    if (cf.length >= 2) {
      const avg = cf.reduce((a, b) => a + b, 0) / cf.length;
      if (avg >= 1) { score = 90; status = 'good'; note = '利润含金量高，现金流充分覆盖净利润'; }
      else if (avg >= 0.7) { score = 65; status = 'warn'; note = '现金流基本覆盖利润，关注回款质量'; }
      else { score = 35; status = 'bad'; note = '现金流明显弱于账面利润，分红资金来源承压'; }
      value = '经营现金流/净利 = ' + avg.toFixed(2);
    }
    items.push({ name: '现金流质量', value, status, score: clampScore(score), note });
  }

  // ---------- ⑤ 未分配利润覆盖 ----------
  {
    let score = 50, status = 'warn', value = '数据不足', note = '每股未分配利润数据不足';
    if (isNum(perUnassignProfit) && ttmDividend && ttmDividend.perShare > 0) {
      const cover = perUnassignProfit / ttmDividend.perShare;
      if (cover >= 3) { score = 90; status = 'good'; note = '未分配利润丰厚，即使利润下滑也有充足分红储备'; }
      else if (cover >= 1.5) { score = 70; status = 'good'; note = '未分配利润对分红覆盖较好'; }
      else if (cover >= 1) { score = 55; status = 'warn'; note = '未分配利润覆盖一般'; }
      else { score = 30; status = 'bad'; note = '未分配利润薄弱，分红能力受限'; }
      value = '可覆盖 ' + cover.toFixed(1) + ' 年当前分红';
    }
    items.push({ name: '未分配利润', value, status, score: clampScore(score), note });
  }

  // ---------- ⑥ 资产负债水平 ----------
  {
    let score = 50, status = 'warn', value = '数据不足', note = '资产负债率数据不足';
    if (isNum(latestDebtRatio)) {
      if (latestDebtRatio < 50) { score = 90; status = 'good'; }
      else if (latestDebtRatio < 65) { score = 70; status = 'good'; }
      else if (latestDebtRatio < 75) { score = 50; status = 'warn'; }
      else { score = 30; status = 'bad'; }
      value = '资产负债率 ' + latestDebtRatio.toFixed(1) + '%';
      note = latestDebtRatio < 65 ? '负债水平安全，分红不受偿债挤压' :
        (latestDebtRatio < 75 ? '负债偏高，分红与偿债需平衡' : '负债率高，分红可持续性承压');
    }
    items.push({ name: '负债水平', value, status, score: clampScore(score), note });
  }

  // ---------- 加权总分 ----------
  const weights = [0.22, 0.20, 0.18, 0.15, 0.15, 0.10];
  let total = 0;
  items.forEach((it, i) => { total += it.score * weights[i]; });
  const score = clampScore(total);
  const { grade, label } = gradeOf(score);

  return {
    score, grade, label,
    items: items.map((it) => ({
      name: it.name, value: it.value, status: it.status, score: it.score, note: it.note,
    })),
  };
}

module.exports = { healthCheck };
