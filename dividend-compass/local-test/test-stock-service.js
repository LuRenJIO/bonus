/**
 * stock-service 云函数本地测试（真实外部接口全链路）
 * 运行：node local-test/test-stock-service.js
 *
 * 验证：搜索 / 实时行情 / 全量聚合（TTM股息率、年度分红、派息率、双模型预测、盈利修正、体检）
 */
const path = require('path');
const Module = require('module');

require('./proxy-patch'); // 沙箱/代理网络环境专用，生产云函数不需要

// stock-service 零依赖，直接 require
const fn = require('../cloudfunctions/stock-service/index.js');
// 前端纯函数（buildLadder 不依赖 wx，可在 node 下验证）
const util = require('../miniprogram/utils/util.js');

function fmtYi(v) {
  if (v === null || v === undefined || !isFinite(v)) return '-';
  return (v / 1e8).toFixed(2) + '亿';
}

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
  console.log('  ✓ ' + msg);
}

(async () => {
  let pass = 0, fail = 0;

  // ---------- 1. 搜索 ----------
  console.log('\n========== 1. 搜索「茅台」 ==========');
  try {
    const r = await fn.main({ action: 'search', keyword: '茅台' });
    assert(r.success, '搜索接口成功');
    assert(r.data.length >= 1, '返回结果数 >= 1');
    const mt = r.data.find((it) => it.code === '600519');
    assert(mt && mt.name === '贵州茅台', '包含贵州茅台(600519), secid=' + (mt && mt.secid));
    console.log('  结果: ' + r.data.map((d) => d.name + '(' + d.code + ')').join(', '));
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 2. 实时行情 ----------
  console.log('\n========== 2. 实时行情 600519 ==========');
  try {
    const r = await fn.main({ action: 'quote', code: '600519' });
    assert(r.success, '行情接口成功 (来源: ' + (r.data && r.data.source) + ')');
    assert(r.data.price > 100, '现价合理: ' + r.data.price);
    console.log('  现价: ' + r.data.price + '  涨跌: ' + r.data.changePercent + '%  市值: ' + fmtYi(r.data.totalMarketCap));
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 3. 全量聚合：贵州茅台（多次分红样本） ----------
  console.log('\n========== 3. 全量聚合 600519 贵州茅台 ==========');
  try {
    const r = await fn.main({ action: 'overview', code: '600519' });
    assert(r.success, 'overview 成功');
    const d = r.data;
    console.log('  名称: ' + d.name + '  现价: ' + d.quote.price);

    // TTM 分红与股息率
    console.log('\n  [TTM分红] ' + JSON.stringify(d.dividend.ttm));
    assert(d.dividend.ttm.perShare > 0, 'TTM每股分红 > 0: ' + d.dividend.ttm.perShare + '元');
    assert(d.dividend.ttm.yield > 0, 'TTM股息率: ' + d.dividend.ttm.yield + '%');

    // 年度分红视图（应按时间由近到远排列）
    console.log('\n  [年度分红视图]');
    d.dividend.annual.forEach((a) => {
      console.log('    ' + a.year + ': 每股' + a.perShare + '元 (' + a.times + '次)  派息率: ' +
        (a.payoutRatio === null ? '-' : a.payoutRatio + '%') + '  以现价计股息率: ' + a.yieldNow + '%');
    });
    assert(d.dividend.annual.length >= 3, '年度分红数据 >= 3年');
    const yearsDesc = d.dividend.annual.map((a) => a.year);
    const sortedDesc = yearsDesc.slice().sort((a, b) => b - a);
    assert(JSON.stringify(yearsDesc) === JSON.stringify(sortedDesc), '历年分红按时间由近到远排列: ' + yearsDesc.join(' > '));

    // 已公告未实施
    if (d.dividend.pending.length) {
      console.log('  [待实施分红] ' + JSON.stringify(d.dividend.pending[0]));
    }

    // 最新财报
    console.log('\n  [最新报告期] ' + d.finance.latest.reportDate + ' ' + d.finance.latest.reportType +
      '  营收: ' + fmtYi(d.finance.latest.revenue) + '  归母净利: ' + fmtYi(d.finance.latest.parentNetProfit) +
      '  ROE: ' + d.finance.latest.roeWeighted + '%');
    console.log('  [年度财报]');
    d.finance.annual.forEach((f) => {
      console.log('    ' + f.reportDate.slice(0, 4) + ': 营收' + fmtYi(f.revenue) + ' 净利' + fmtYi(f.parentNetProfit) +
        ' EPS ' + f.eps + ' ROE ' + f.roeWeighted + '% 每股未分配 ' + f.perUnassignProfit);
    });

    // 预测
    const p = d.prediction;
    console.log('\n  [预测目标] ' + p.nextPeriod);
    if (p.basic) {
      console.log('  [多模型] 模型A(趋势): ' + p.basic.modelA.value + '元 (增速' + p.basic.modelA.divGrowth + '%)');
      if (p.basic.modelB) console.log('           模型B(派息率×净利): ' + p.basic.modelB.value + '元 (派息率' + p.basic.modelB.payoutRatio + '%, 净利增速' + p.basic.modelB.profitGrowth + '%)');
      if (p.basic.modelC) console.log('           模型C(机构预期): ' + p.basic.modelC.value + '元 (一致预期EPS ' + p.basic.modelC.eps + '元 × 派息率' + p.basic.modelC.payoutRatio + '%, ' + p.basic.modelC.orgCount + '篇研报)');
      console.log('           区间: 保守' + p.basic.range.conservative + ' / 中性' + p.basic.range.neutral + ' / 乐观' + p.basic.range.optimistic + '元');
      console.log('           预期股息率: ' + p.basic.yields.conservative + '% / ' + p.basic.yields.neutral + '% / ' + p.basic.yields.optimistic + '%');
    }
    if (p.enhanced) {
      console.log('  [盈利修正] 区间: 保守' + p.enhanced.range.conservative + ' / 中性' + p.enhanced.range.neutral + ' / 乐观' + p.enhanced.range.optimistic + '元');
      console.log('             预期股息率: ' + p.enhanced.yields.conservative + '% / ' + p.enhanced.yields.neutral + '% / ' + p.enhanced.yields.optimistic + '%');
      console.log('             信心度: ' + p.enhanced.confidence + '/100, 修正因子: ' + p.enhanced.factors.length + '项');
      p.enhanced.factors.forEach((f) => console.log('               - ' + f.name + ': ' + f.value + ' (' + f.effect + ')'));
    }
    assert(p.hasEnoughData === true, '预测数据充足');
    assert(p.basic && p.basic.range.neutral > 0, '多模型中性预测 > 0');
    assert(p.enhanced && p.enhanced.range.neutral > 0, '盈利修正预测 > 0');
    // 机构一致预期（茅台研报覆盖充分，应产出模型C与一致预期因子）
    if (d.consensus) {
      console.log('  [机构一致预期] ' + (d.consensus.industryName || '-') + ' · 近1年' + d.consensus.count + '篇 · 各年中位数EPS: ' + JSON.stringify(d.consensus.medianByYear) + ' · 评级: ' + JSON.stringify(d.consensus.ratings));
      assert(p.basic.modelC !== null, '模型C(机构预期)已产出');
      assert(p.enhanced.factors.some((f) => f.name === '机构一致预期'), '增强模式含因子⑤机构一致预期');
      assert(p.enhanced.factors.some((f) => f.name === '行业与机构态度'), '增强模式含因子⑥行业与机构态度');
    }

    // 强制刷新：两次 overview，第二次带 refresh=true，返回的 calcTime 应不同（绕过5分钟缓存）
    const r2 = await fn.main({ action: 'overview', code: '600519' });
    assert(r2.data.meta.calcTime === d.meta.calcTime, '不带 refresh 时命中缓存（calcTime 相同）');
    const r3 = await fn.main({ action: 'overview', code: '600519', refresh: true });
    assert(r3.data.meta.calcTime !== d.meta.calcTime, 'refresh=true 绕过缓存重新计算（calcTime 已更新）');
    const d3 = r3.data;

    // 股息率曲线
    const yc = d3.yieldCurve;
    assert(yc && yc.points && yc.points.length >= 24, '股息率曲线点位 >= 24个月');
    for (let i = 1; i < yc.points.length; i++) assert(yc.points[i].ym > yc.points[i - 1].ym, '曲线月份升序: ' + yc.points[i - 1].ym + ' < ' + yc.points[i].ym);
    assert(yc.points.every((p) => p.yield >= 0), '曲线股息率非负');
    const lastPt = yc.points[yc.points.length - 1];
    console.log('\n  [股息率曲线] ' + yc.points.length + '个月末点 (' + yc.points[0].ym + ' ~ ' + lastPt.ym + ')' +
      ', 最新TTM股息率 ' + lastPt.yield + '%' + (yc.expected ? ', 预期点 ' + yc.expected.ym + ': ' + yc.expected.yield + '%' : ''));
    // 与核心 TTM 口径一致性（月末现价≠最新价，允许小幅偏差）
    assert(Math.abs(lastPt.yield - d3.dividend.ttm.yield) < 0.6, '曲线末点与TTM口径一致: ' + lastPt.yield + ' vs ' + d3.dividend.ttm.yield);
    if (yc.expected) {
      const neutralY = d3.prediction.enhanced ? d3.prediction.enhanced.yields.neutral : d3.prediction.basic.yields.neutral;
      assert(Math.abs(yc.expected.yield - neutralY) < 0.01, '预期点=中性预测股息率');
    }

    // 股息率历史分位
    assert(yc.percentile >= 1 && yc.percentile <= 99, '股息率历史分位 1~99: ' + yc.percentile + '%');
    console.log('  [历史分位] 当前股息率处于近5年 ' + yc.percentile + '% 分位');

    // 波动与风险指标
    const rk = d3.risk;
    assert(rk, '风险指标已产出');
    assert(rk.volatility > 0 && rk.volatility < 100, '年化波动率合理: ' + rk.volatility + '%');
    assert(rk.maxDrawdown >= 0 && rk.maxDrawdown < 100, '近1年最大回撤合理: ' + rk.maxDrawdown + '%');
    assert(rk.beta !== null && rk.beta > -1 && rk.beta < 4, 'Beta(对沪深300)合理: ' + rk.beta);
    console.log('  [风险指标] 年化波动率 ' + rk.volatility + '% · 最大回撤 ' + rk.maxDrawdown + '% · Beta ' + rk.beta);

    // 股息率阶梯（前端纯函数，本地直接验证；用盈利修正中性分红）
    const neutralDiv = p.enhanced ? p.enhanced.range.neutral : p.basic.range.neutral;
    const ladder = util.buildLadder(neutralDiv, d3.quote.price);
    assert(ladder && ladder.rows.length === 13, '阶梯13档（3%~9%步进0.5%）');
    for (let i = 1; i < ladder.rows.length; i++) assert(parseFloat(ladder.rows[i].price) < parseFloat(ladder.rows[i - 1].price), '阶梯价格单调递减');
    const hit = ladder.rows[ladder.closestIndex];
    console.log('  [股息率阶梯] 预期分红' + neutralDiv + '元 × 13档，现价' + d3.quote.price + '元命中 ' + hit.yield + '% 档（对应股价' + hit.price + '元）');
    assert(Math.abs(neutralDiv / 0.05 - parseFloat(ladder.rows[4].price)) < 0.01, '5%档价格=分红/0.05');

    // 体检
    const h = d.health;
    console.log('\n  [分红体检] ' + h.score + '分 ' + h.grade + '(' + h.label + ')');
    h.items.forEach((it) => console.log('    ' + (it.status === 'good' ? '●绿' : it.status === 'warn' ? '●黄' : '●红') + ' ' + it.name + ': ' + it.value + ' (' + it.score + '分) ' + it.note));
    assert(h.score > 0 && h.items.length === 6, '体检6项完整');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 3.5 边缘：分红较少的股票不崩溃 ----------
  console.log('\n========== 3.5 边缘 300750 宁德时代 ==========');
  try {
    const rEdge = await fn.main({ action: 'overview', code: '300750', refresh: true });
    assert(rEdge.success === true, 'overview 正常返回');
    const edgeYc = rEdge.data.yieldCurve;
    console.log('  TTM ' + rEdge.data.dividend.ttm.yield + '%  曲线点数 ' + (edgeYc ? edgeYc.points.length : 0) +
      (edgeYc && edgeYc.expected ? '  预期点 ' + edgeYc.expected.yield + '%' : '  (无预期点)'));
    if (edgeYc) assert(edgeYc.points.length >= 2, '曲线点位正常');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 4. 全量聚合：长江电力（典型红利股，单次年度分红） ----------
  console.log('\n========== 4. 全量聚合 600900 长江电力 ==========');
  try {
    const r = await fn.main({ action: 'overview', code: '600900' });
    assert(r.success, 'overview 成功');
    const d = r.data;
    console.log('  ' + d.name + ' 现价' + d.quote.price + '  TTM分红' + d.dividend.ttm.perShare + '元  TTM股息率' + d.dividend.ttm.yield + '%');
    console.log('  预测(' + d.prediction.nextPeriod + '): 中性分红' + d.prediction.basic.range.neutral + '元 → 股息率' + d.prediction.basic.yields.neutral + '%');
    console.log('  体检: ' + d.health.score + '分 ' + d.health.grade);
    assert(d.dividend.ttm.yield > 1, '长电股息率 > 1%');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 5. 边界：无分红股票（如部分科技股） ----------
  console.log('\n========== 5. 边界测试 000001 平安银行 ==========');
  try {
    const r = await fn.main({ action: 'overview', code: '000001' });
    assert(r.success, 'overview 成功');
    const d = r.data;
    console.log('  ' + d.name + ' TTM股息率: ' + d.dividend.ttm.yield + '%  体检: ' + d.health.score + '分');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 6. 分红日历（全市场 + 自选） ----------
  console.log('\n========== 6. 分红日历 ==========');
  try {
    const r = await fn.main({
      action: 'calendar',
      days: 30,
      codes: [{ code: '600519', name: '贵州茅台' }, { code: '600900', name: '长江电力' }],
    });
    assert(r.success, 'calendar 成功');
    const mkt = r.data.market || [];
    assert(mkt.length > 0, '全市场未来30天有除息安排(' + mkt.length + '条)');
    for (let i = 1; i < Math.min(mkt.length, 20); i++) {
      assert(mkt[i].exDate >= mkt[i - 1].exDate, '全市场按除息日升序');
    }
    assert(mkt.every((x) => x.perShare > 0 && /^\d{6}$/.test(x.code)), '字段完整(仅现金分红)');
    console.log('  [全市场] ' + mkt.length + '条, 首条: ' + mkt[0].exDate + ' ' + mkt[0].name + ' 每股' + mkt[0].perShare + '元');
    const fav = r.data.fav || [];
    console.log('  [自选] ' + fav.length + '只股票有近期分红安排');
    fav.forEach((g) => {
      assert(g.items && g.items.length > 0, g.name + ' 有分红项');
      g.items.slice(0, 2).forEach((it) => console.log('    ' + g.name + ' · ' + (it.exDate || '未定') + ' · 每股' + it.perShare + '元 · ' + it.progress));
    });
    // 动态验证：拿全市场首条即将除息的股票反查自选日历，必须可见
    if (mkt.length) {
      const pick = mkt[0];
      const r2 = await fn.main({ action: 'calendar', days: 30, codes: [{ code: pick.code, name: pick.name }] });
      const fav2 = (r2.data && r2.data.fav) || [];
      assert(fav2.length === 1 && fav2[0].items.length > 0, '即将除息股票在自选日历中可见');
      console.log('  [自选·动态] ' + pick.name + ' → ' + fav2[0].items[0].exDate + ' 每股' + fav2[0].items[0].perShare + '元');
    }
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 7. 收息记账（组合计算） ----------
  console.log('\n========== 7. 收息记账 ==========');
  try {
    const r = await fn.main({
      action: 'portfolio',
      holdings: [
        { code: '600519', market: 'SH', shares: 100, cost: 1500 },
        { code: '600900', market: 'SH', shares: 2000, cost: 28 },
        { code: '000001', market: 'SZ', shares: 10000 },  // 无成本
      ],
    });
    assert(r.success, 'portfolio 成功');
    const s = r.data.summary;
    assert(r.data.items.length === 3, '3条持仓');
    assert(s.totalValue > 0, '组合市值>0: ' + s.totalValue + '元');
    assert(s.yearReceived >= 0, '今年已收息>=0: ' + s.yearReceived + '元');
    assert(s.portfolioYield > 0 && s.portfolioYield < 15, '组合TTM股息率合理: ' + s.portfolioYield + '%');
    assert(s.expectedAnnual > 0, '预期年度分红>0: ' + s.expectedAnnual + '元');
    assert(s.pnl !== null && s.totalCost > 0, '含成本持仓的盈亏已计算: ' + s.pnl + '元 (' + s.pnlPercent + '%)');
    r.data.items.forEach((it) => {
      assert(it.price > 0, it.name + ' 有行情');
      console.log('  ' + it.name + ': ' + it.shares + '股 × ' + it.price + '元, TTM股息率' + it.ttmYield + '%, 今年已收' + it.yearDividend + '元');
    });
    console.log('  [汇总] 市值' + s.totalValue + '元 · 今年已收' + s.yearReceived + '元 · 组合股息率' + s.portfolioYield + '% · 盈亏' + s.pnlPercent + '%');
    // 空持仓
    const rEmpty = await fn.main({ action: 'portfolio', holdings: [] });
    assert(rEmpty.success && rEmpty.data.summary === null, '空持仓返回 summary=null');
    // 全部无成本 → 盈亏为空
    const rNoCost = await fn.main({ action: 'portfolio', holdings: [{ code: '600519', market: 'SH', shares: 100 }] });
    assert(rNoCost.data.summary.pnl === null, '无成本持仓时盈亏为 null');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 8. 首页红利速览 ----------
  console.log('\n========== 8. 红利速览 ==========');
  try {
    const r = await fn.main({ action: 'homebrief' });
    assert(r.success, 'homebrief 成功');
    const d = r.data;
    assert(d.csiDividend && isFinite(d.csiDividend.changePercent), '中证红利指数行情: ' + d.csiDividend.changePercent + '%');
    assert(d.hs300 && isFinite(d.hs300.changePercent), '沪深300指数行情: ' + d.hs300.changePercent + '%');
    assert(d.exTodayCount >= 0, '今日除息数量: ' + d.exTodayCount);
    d.exTodayTop.forEach((x) => assert(/^\d{6}$/.test(x.code) && x.perShare > 0, '除息股字段完整'));
    console.log('  中证红利 ' + d.csiDividend.changePercent + '% · 沪深300 ' + d.hs300.changePercent + '% · 今日除息 ' + d.exTodayCount + ' 只');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 9. 股息率提醒检查 ----------
  console.log('\n========== 9. 提醒检查 ==========');
  try {
    const r = await fn.main({
      action: 'checkAlerts',
      list: [
        { code: '600519', name: '贵州茅台', threshold: 0.01 },   // 必触发
        { code: '600519', name: '贵州茅台', threshold: 99 },     // 必不触发
        { code: '600900', name: '长江电力', threshold: 3.0 },    // 真实场景
      ],
    });
    assert(r.success, 'checkAlerts 成功');
    const rows = r.data;
    assert(rows.length === 3, '3条规则返回');
    assert(rows[0].triggered === true && rows[0].ttmYield > 0, '阈值0.01必触发: ' + rows[0].ttmYield + '%');
    assert(rows[1].triggered === false, '阈值99必不触发');
    assert(typeof rows[2].triggered === 'boolean', '真实阈值返回布尔');
    console.log('  茅台 TTM ' + rows[0].ttmYield + '% → 阈值0.01触发=' + rows[0].triggered + ' / 阈值99触发=' + rows[1].triggered);
    console.log('  长电 TTM ' + rows[2].ttmYield + '% → 阈值3.0触发=' + rows[2].triggered);
    // 空规则
    const rEmpty = await fn.main({ action: 'checkAlerts', list: [] });
    assert(rEmpty.success && rEmpty.data.length === 0, '空规则返回空数组');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  console.log('\n========== 测试汇总: ' + pass + ' 组通过, ' + fail + ' 组失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
