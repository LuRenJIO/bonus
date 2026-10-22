/**
 * TTM 报告期口径专项单测（node local-test/test-dividend-ttm.js）
 * 覆盖：分红提前/推迟/仅年报/同报告期去重/报告期字段缺失回退/股息率历史序列
 */
const div = require('../cloudfunctions/stock-service/lib/dividend');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

// 造数：parseDividends 的 raw 结构
function mk(reportDate, exDate, per10, profile) {
  return {
    reportDate, exDate, bonusPer10: per10,
    profile: profile || ('10派' + per10 + '元(含税)'),
    progress: '实施分配', planNoticeDate: exDate, recordDate: exDate,
    bonusShares: 0, transferShares: 0, totalShares: null,
  };
}
function calc(rawList, now) {
  const { implemented } = div.parseDividends(rawList, now);
  return div.calcTTMDividend(implemented);
}

// ---------- 1. 用户场景：今年中期比去年中期早（分红节奏提前） ----------
console.log('\n== 1. 分红节奏提前（用户描述场景） ==');
{
  // 某公司年报分红除息 4 月、中报分红 2025 年在 8 月除息、2026 年提前到 6 月
  const raw = [
    mk('2026-06-30', '2026-06-15', 5.0),    // 2026 中报（提前）
    mk('2025-12-31', '2026-04-10', 10.0),   // 2025 年报
    mk('2025-06-30', '2025-08-20', 4.0),    // 2025 中报（上一年，除息日仍在 1 年滑窗内）
    mk('2024-12-31', '2025-04-08', 9.0),    // 2024 年报
  ];
  const ttm = calc(raw, '2026-09-01');
  assert(ttm.basis === 'report', '使用报告期口径');
  assert(ttm.anchor === '2026-06-30', '锚定最新报告期 2026-06-30: ' + ttm.anchor);
  // 4 个季度报告期 = 2026-06-30 / 2026-03-31 / 2025-12-31 / 2025-09-30 → 5.0 + 10.0
  assert(ttm.perShare === 1.5, 'TTM = 2026中报0.5 + 2025年报1.0 = 1.5 (每股): ' + ttm.perShare);
  assert(!ttm.detail.some((d) => d.reportDate === '2025-06-30'), '去年中报(2025-06-30)被正确排除');
  assert(ttm.detail.length === 2, '明细 2 条: ' + ttm.detail.length);
}

// ---------- 2. 仅年报分红（节奏漂移） ----------
console.log('\n== 2. 仅年报分红（除息日漂移不重复计） ==');
{
  const raw = [
    mk('2025-12-31', '2026-04-15', 12.0),   // 2025 年报
    mk('2024-12-31', '2025-04-18', 10.0),   // 2024 年报（除息日距今年报仅隔 1 年，滑窗边界极易误计）
  ];
  const ttm = calc(raw, '2026-05-01');
  assert(ttm.perShare === 1.2, 'TTM = 2025年报 1.2（不含 2024 年报）: ' + ttm.perShare);
}

// ---------- 3. 分红推迟（年报推迟到三季度实施） ----------
console.log('\n== 3. 分红推迟 ==');
{
  const raw = [
    mk('2026-06-30', '2026-08-20', 5.0),    // 2026 中报
    mk('2025-12-31', '2026-09-10', 10.0),   // 2025 年报（推迟实施）
    mk('2025-06-30', '2025-08-15', 4.0),    // 2025 中报
  ];
  const ttm = calc(raw, '2026-09-20');
  // 锚 = 2026-06-30 → 4 季度报告期含 2025-12-31 → 5.0 + 10.0；2025 中报(2025-06-30)排除
  assert(ttm.perShare === 1.5, 'TTM = 2026中报 + 2025年报(推迟) = 1.5 (每股): ' + ttm.perShare);
}

// ---------- 4. 同一报告期多条记录（异常数据取除息最新） ----------
console.log('\n== 4. 同报告期去重 ==');
{
  const raw = [
    mk('2025-12-31', '2026-04-10', 10.0),
    mk('2025-12-31', '2026-04-08', 9.5),    // 同报告期早两天（应被丢弃）
  ];
  const ttm = calc(raw, '2026-05-01');
  assert(ttm.perShare === 1.0, '同报告期取除息最新 1.0: ' + ttm.perShare);
}

// ---------- 5. 报告期字段缺失 → 回退滑窗 ----------
console.log('\n== 5. 报告期缺失回退滑窗 ==');
{
  const raw = [
    { reportDate: null, exDate: '2026-04-10', bonusPer10: 100, profile: '', progress: '实施分配', planNoticeDate: '', recordDate: '', bonusShares: 0, transferShares: 0, totalShares: null },
    { reportDate: null, exDate: '2025-11-10', bonusPer10: 40, profile: '', progress: '实施分配', planNoticeDate: '', recordDate: '', bonusShares: 0, transferShares: 0, totalShares: null },
  ];
  const ttm = calc(raw, '2026-05-01');
  assert(ttm.basis === 'window', '回退滑窗口径: ' + ttm.basis);
  assert(ttm.perShare === 14.0, '滑窗求和 14.0: ' + ttm.perShare);
}

// ---------- 6. 历史时点滚动锚（股息率序列口径一致性） ----------
console.log('\n== 6. 股息率历史序列（锚随历史时点滚动） ==');
{
  const raw = [
    mk('2026-06-30', '2026-06-15', 5.0),
    mk('2025-12-31', '2026-04-10', 10.0),
    mk('2025-06-30', '2025-08-20', 4.0),
    mk('2024-12-31', '2025-04-08', 9.0),
  ];
  const { implemented } = div.parseDividends(raw, '2026-09-01');
  const monthly = [
    { ym: '2025-09', close: 1000 },   // 该月锚=2025-06-30 → TTM 含 2025中报4+2024年报9=13
    { ym: '2026-08', close: 1000 },   // 该月锚=2026-06-30 → TTM 含 2026中报5+2025年报10=15
  ];
  const series = div.calcYieldSeries(implemented, monthly, null);
  const y2509 = series.points.find((p) => p.ym === '2025-09');
  const y2608 = series.points.find((p) => p.ym === '2026-08');
  assert(y2509 && y2509.yield === 0.13, '2025-09 月末 TTM/价 = 1.3/1000 = 0.13%: ' + (y2509 && y2509.yield));
  assert(y2608 && y2608.yield === 0.15, '2026-08 月末 TTM/价 = 1.5/1000 = 0.15%: ' + (y2608 && y2608.yield));
}

// ---------- 7. 季度枚举边界 ----------
console.log('\n== 7. 季度枚举 ==');
{
  const q1 = div.quarterReports('2026-03-31', 4);
  assert(JSON.stringify(q1) === JSON.stringify(['2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30']), '锚=一季报回溯跨年: ' + JSON.stringify(q1));
  const q4 = div.quarterReports('2026-12-31', 2);
  assert(JSON.stringify(q4) === JSON.stringify(['2026-12-31', '2026-09-30']), '锚=年报取2季: ' + JSON.stringify(q4));
}

console.log('\n========== TTM 专项: ' + pass + ' 通过, ' + fail + ' 失败 ==========');
process.exit(fail ? 1 : 0);
