/**
 * signal.js —— 黄金坑信号分类（纯函数）
 *
 * 触发高股息提醒时，按最新财报净利润同比给信号"分成色"：
 *   gold  🟡 黄金坑：净利仍在增长，高股息是跌出来的
 *   warn  🔴 警惕：净利下滑，分红可持续性存疑
 *   plain ⚪ 仅提醒：财务数据缺失/上年亏损（同比无意义）
 *
 * 局限：净利润同比为滞后指标（随季报/年报更新），分类仅供研究参考。
 */

/**
 * @param financeReports dataSource.getFinanceMain(code, 0) 结果（按报告期降序）
 * @returns {'gold'|'warn'|'plain'}
 */
function classifySignal(financeReports) {
  if (!Array.isArray(financeReports) || !financeReports.length) return 'plain';
  const latest = financeReports[0];
  if (!latest || !latest.reportDate || !isFinite(latest.parentNetProfit)) return 'plain';
  // 上一年同报告期（如 2026-09-30 → 2025-09-30）
  const prevKey = String(Number(latest.reportDate.slice(0, 4)) - 1) + latest.reportDate.slice(4);
  const prev = financeReports.find((f) => f.reportDate === prevKey);
  if (!prev || !isFinite(prev.parentNetProfit) || prev.parentNetProfit <= 0) return 'plain';
  return latest.parentNetProfit >= prev.parentNetProfit ? 'gold' : 'warn';
}

/** 信号 → 提醒文案前缀（订阅消息/横幅共用） */
function signalPrefix(signal) {
  if (signal === 'gold') return '🟡黄金坑·';
  if (signal === 'warn') return '🔴警惕·';
  return '';
}

module.exports = { classifySignal, signalPrefix };
