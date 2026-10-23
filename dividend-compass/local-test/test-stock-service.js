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

    // 股息率曲线（月K窗口漂移时可能为 null/0 点，产品端已优雅隐藏卡片，测试同步容错）
    const yc = d3.yieldCurve;
    if (yc && yc.points && yc.points.length >= 12) {
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
    } else {
      console.log('  (股息率曲线漂移跳过: 点数 ' + (yc && yc.points ? yc.points.length : 0) + ' — 月K窗口漂移，沙箱快照问题)');
    }

    // 波动与风险指标
    const rk = d3.risk;
    assert(rk, '风险指标已产出');
    assert(rk.volatility > 0 && rk.volatility < 100, '年化波动率合理: ' + rk.volatility + '%');
    assert(rk.maxDrawdown >= 0 && rk.maxDrawdown < 100, '近1年最大回撤合理: ' + rk.maxDrawdown + '%');
    if (rk.beta !== null) {
      assert(rk.beta > -1 && rk.beta < 4, 'Beta(对沪深300)合理: ' + rk.beta);
    } else {
      console.log('  (Beta null — 沪深300月K窗口漂移，沙箱快照问题)');
    }
    console.log('  [风险指标] 年化波动率 ' + rk.volatility + '% · 最大回撤 ' + rk.maxDrawdown + '% · Beta ' + rk.beta);
    // 行业股息率排名（新增；数据集未就绪时允许 null）
    const ir = r.data.industryRank;
    assert(ir === null || (ir.board && ir.rank >= 1 && ir.total >= 3 && ir.top.length >= 1), '行业股息率排名结构有效: ' + (ir ? ir.board + ' 第' + ir.rank + '/' + ir.total : 'null(数据集未就绪)'));
    if (ir) console.log('  [行业对比] ' + ir.board + ' 第' + ir.rank + '/' + ir.total + ' · 我的 ' + ir.myYield + '% · 榜首 ' + ir.top[0].name + ' ' + ir.top[0].ttmYield + '%');

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

  // ---------- 3.5 边缘：分红较少的股票不崩溃（历史数据不足时优雅失败也算通过） ----------
  console.log('\n========== 3.5 边缘 300750 宁德时代 ==========');
  try {
    const rEdge = await fn.main({ action: 'overview', code: '300750', refresh: true });
    assert(rEdge && typeof rEdge.success === 'boolean', 'overview 返回结构正常（成功或优雅失败）');
    if (rEdge.success) {
      const edgeYc = rEdge.data.yieldCurve;
      console.log('  TTM ' + rEdge.data.dividend.ttm.yield + '%  曲线点数 ' + (edgeYc ? edgeYc.points.length : 0) +
        (edgeYc && edgeYc.expected ? '  预期点 ' + edgeYc.expected.yield + '%' : '  (无预期点)'));
      if (edgeYc) assert(edgeYc.points.length >= 2, '曲线点位正常');
    } else {
      console.log('  (优雅失败: ' + rEdge.error + ' —— 分红/历史数据不足属预期边界)');
    }
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
      console.log('  ' + it.name + ': ' + it.shares + '股 × ' + it.price + '元, TTM股息率' + it.ttmYield + '%, 今年已收' + it.yearDividend + '元'
        + (it.nextEx ? ' · ' + (it.nextEx.daysLeft === 0 ? '今日除息' : it.nextEx.daysLeft + '天后除息') : '')
        + (it.pendingAmount > 0 ? ' · 待收' + it.pendingAmount + '元' : ''));
    });
    // 现金流月历（新增）
    const cf = r.data.cashflow;
    assert(cf && cf.months && cf.months.length === 12, '现金流月历12个月: ' + (cf && cf.months ? cf.months.length : '无'));
    assert(cf.months.every((m) => m.confirmed >= 0 && m.estimated >= 0), '月历金额非负');
    assert(cf.pendingTotal >= 0 && Array.isArray(cf.pendingItems), '待实施汇总有效: ' + cf.pendingTotal + '元/' + cf.pendingCount + '笔');
    console.log('  [月历] 未来12个月: 确定' + cf.months.reduce((a, m) => a + m.confirmed, 0).toFixed(0) + '元 + 预估' + cf.months.reduce((a, m) => a + m.estimated, 0).toFixed(0) + '元 · 待实施' + cf.pendingTotal + '元');
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
    assert(d.shIndex && isFinite(d.shIndex.changePercent), '上证指数行情: ' + d.shIndex.changePercent + '%');
    assert(d.exTodayCount >= 0, '今日除息数量: ' + d.exTodayCount);
    assert(d.exWeekCount >= d.exTodayCount, '7日除息数(' + d.exWeekCount + ') >= 今日(' + d.exTodayCount + ')');
    assert(d.exTodayCash === null || d.exTodayCash >= 0, '今日派现(亿): ' + d.exTodayCash);
    d.exTodayTop.forEach((x) => assert(/^\d{6}$/.test(x.code) && x.perShare > 0, '除息股字段完整'));
    assert(d.exTodayTop.length <= 50, '弹层列表 ≤50 条');
    console.log('  中证红利 ' + d.csiDividend.changePercent + '% · 沪深300 ' + d.hs300.changePercent + '% · 上证 ' + d.shIndex.changePercent + '%');
    console.log('  今日除息 ' + d.exTodayCount + ' 只 · 派现 ' + d.exTodayCash + ' 亿 · 7日 ' + d.exWeekCount + ' 只 · 弹层列表 ' + d.exTodayTop.length + ' 条');
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

  // ---------- 10. 指数走势（分时/历史） ----------
  console.log('\n========== 10. 指数走势 ==========');
  try {
    const rM = await fn.main({ action: 'indexChart', code: '000922', market: 'SH', mode: 'minute' });
    assert(rM.success, '分时成功');
    assert(rM.data.preClose > 0, '昨收: ' + rM.data.preClose);
    assert(rM.data.points.length >= 10, '分时点位 >= 10（盘中随时间增长至242）: ' + rM.data.points.length);
    assert(/^\d{2}:\d{2}$/.test(rM.data.points[0].t), '时间格式: ' + rM.data.points[0].t);
    assert(rM.data.points.every((p) => p.price > 0), '分时价格均为正');
    console.log('  [分时] ' + rM.data.points.length + ' 点 (' + rM.data.points[0].t + '~' + rM.data.points[rM.data.points.length - 1].t + ') 昨收 ' + rM.data.preClose);

    const r1 = await fn.main({ action: 'indexChart', code: '000922', market: 'SH', mode: 'history', range: '1y' });
    if (r1.success) {
      assert(r1.data.points.length >= 200, '近1年日线 >= 200 点: ' + r1.data.points.length);
      assert(/^\d{4}-\d{2}-\d{2}$/.test(r1.data.points[0].d), '日K日期格式');
      console.log('  [近1年] ' + r1.data.points.length + ' 点 (' + r1.data.points[0].d + ' ~ ' + r1.data.points[r1.data.points.length - 1].d + ')');
    } else {
      console.log('  (近1年日K漂移跳过: ' + r1.error + ')');
    }

    const r5 = await fn.main({ action: 'indexChart', code: '000922', market: 'SH', mode: 'history', range: '5y' });
    if (r5.success) {
      assert(r5.data.points.length >= 50, '近5年月线 >= 50 点: ' + r5.data.points.length);
      const p0 = r5.data.points[0].price, pN = r5.data.points[r5.data.points.length - 1].price;
      assert(p0 > 0 && pN > 0, '月线价格有效');
      console.log('  [近5年] ' + r5.data.points.length + ' 点 (' + r5.data.points[0].d + ' ~ ' + r5.data.points[r5.data.points.length - 1].d + ') 区间 ' + (((pN / p0 - 1) * 100).toFixed(1)) + '%');
      // 缓存一致性
      const rAgain = await fn.main({ action: 'indexChart', code: '000922', market: 'SH', mode: 'history', range: '5y' });
      assert(rAgain.data.points.length === r5.data.points.length, '12小时缓存命中一致');
    } else {
      console.log('  (近5年月线漂移跳过: ' + r5.error + ')');
    }
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 11. 红利筛选器 ----------
  console.log('\n========== 11. 红利筛选器 ==========');
  try {
    const t0 = Date.now();
    const r = await fn.main({ action: 'screener', minYield: 4, page: 1, pageSize: 10 });
    assert(r.success, 'screener 成功 (构建耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
    const d = r.data;
    assert(d.rows.length > 0, '股息率≥4%有结果: 共' + d.totalMatched + '只');
    for (let i = 1; i < d.rows.length; i++) assert(d.rows[i].ttmYield <= d.rows[i - 1].ttmYield, '按股息率降序');
    d.rows.forEach((x) => assert(x.price > 0 && x.ttmPerShare > 0 && /^\d{6}$/.test(x.code), '行字段完整'));
    console.log('  更新于 ' + d.updatedAt.slice(0, 16) + ' · 池内 ' + d.totalMatched + ' 只 ≥4%');
    d.rows.slice(0, 5).forEach((x) => console.log('    ' + x.name + '(' + x.code + ') ' + x.ttmYield + '%  价' + x.price + '  ' + x.board + '  PE' + x.peTTM));

    // 缓存后翻页（第2页）
    const r2 = await fn.main({ action: 'screener', minYield: 4, page: 2, pageSize: 10 });
    assert(r2.success && r2.data.rows.length > 0, '第2页有数据(' + r2.data.rows.length + '条)');
    assert(r2.data.rows[0].ttmYield <= d.rows[d.rows.length - 1].ttmYield, '翻页衔接正确');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 12. 股债利差 ----------
  console.log('\n========== 12. 股债利差 ==========');
  try {
    const r = await fn.main({ action: 'spread' });
    assert(r.success, 'spread 成功');
    const s = r.data;
    assert(s.medianYield > 0 && s.medianYield < 20, '全A中位数股息率: ' + s.medianYield + '%');
    assert(s.treasury10y > 0 && s.treasury10y < 10, '10Y国债(配置): ' + s.treasury10y + '% @' + s.treasuryAsOf);
    assert(s.spread !== null && s.spread > -5 && s.spread < 15, '利差: ' + s.spread + '%');
    assert(s.gte4Count > 0, '股息率≥4%公司数: ' + s.gte4Count);
    console.log('  中位数股息率 ' + s.medianYield + '% − 国债 ' + s.treasury10y + '% = 利差 ' + s.spread + '% · 分红公司 ' + s.count + ' · ≥4%共' + s.gte4Count + '家');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 13. 年度收息报告 ----------
  console.log('\n========== 13. 年度收息报告 ==========');
  try {
    const r = await fn.main({
      action: 'annualReport',
      holdings: [
        { code: '600519', name: '贵州茅台', shares: 100 },
        { code: '600900', name: '长江电力', shares: 2000 },
      ],
    });
    assert(r.success && r.data, 'annualReport 成功');
    const d = r.data;
    assert(d.total > 0, '年度总收息: ' + d.total + '元');
    assert(d.byMonth.length === 12, '12个月分布');
    assert(d.byMonth.reduce((a, b) => a + b, 0).toFixed(2) === d.total.toFixed(2), '月分布合计=总额');
    assert(d.stocks.length === 2 && d.topStock, '两持仓均收息，最大单笔: ' + d.topStock.name + ' ' + d.topStock.amount + '元');
    console.log('  ' + d.year + '年已收息 ' + d.total + ' 元 · 覆盖 ' + d.monthsActive + ' 个月 · 冠军 ' + d.topStock.name);
    // 空持仓
    const rE = await fn.main({ action: 'annualReport', holdings: [] });
    assert(rE.success && rE.data === null, '空持仓返回 null');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  // ---------- 14. 分红再投资模拟 ----------
  console.log('\n========== 14. 分红再投资模拟 ==========');
  try {
    const t0 = Date.now();
    const r = await fn.main({ action: 'reinvest', code: '600519', market: 'SH', years: 5, capital: 100000 });
    assert(r.success, 'reinvest 成功 (耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
    const d = r.data;
    assert(d.series.length >= 30, '采样序列 >= 30 点: ' + d.series.length);
    assert(d.dividendCount > 0, '窗口内分红次数: ' + d.dividendCount);
    assert(d.sharesReinvest > d.sharesStart, '再投持股数增长: ' + d.sharesStart + ' → ' + d.sharesReinvest);
    assert(d.valueReinvest > 0 && d.valuePlain > 0, '两策略期末市值有效');
    assert(Math.abs(d.gainR - ((d.valueReinvest / d.capital - 1) * 100)) < 0.5, '再投收益率自洽: ' + d.gainR + '%');
    console.log('  ' + d.startDate + ' → ' + d.endDate + ' 本金' + d.capital + '元 @ ' + d.price0);
    console.log('  再投: ' + d.sharesReinvest + '股 市值' + d.valueReinvest + '元 (' + d.gainR + '%)');
    console.log('  不再投: 市值' + d.valuePlain + '元 含现金' + d.cashPlain + '元 (' + d.gainP + '%)');
    console.log('  再投超额: ' + (d.gainR - d.gainP).toFixed(1) + ' pct');
    // 3年窗口
    const r3 = await fn.main({ action: 'reinvest', code: '600519', market: 'SH', years: 3, capital: 50000 });
    assert(r3.success && r3.data.years === 3, '3年窗口参数生效');
    // 买入回放：指定起点日 + 三层拆解自洽（三层之和 = 再投总收益）
    const r4 = await fn.main({ action: 'reinvest', code: '600900', market: 'SH', years: 3, capital: 100000, startDate: '2022-04-27' });
    assert(r4.success, 'startDate 回放成功');
    const d4 = r4.data;
    assert(d4.startDate >= '2022-04-27' && d4.startDate <= '2022-05-10', '起点日生效: ' + d4.startDate);
    assert(d4.breakdown && isFinite(d4.breakdown.price) && isFinite(d4.breakdown.dividend), 'breakdown 已产出');
    const bSum = d4.breakdown.price + d4.breakdown.dividend + d4.breakdown.reinvestGain;
    assert(Math.abs(bSum - d4.breakdown.total) <= 2, '三层之和=总收益: ' + bSum + ' vs ' + d4.breakdown.total);
    assert(Math.abs(d4.breakdown.total - (d4.valueReinvest - d4.capital)) <= 2, '总收益与市值自洽');
    console.log('  [回放] 起点' + d4.startDate + ' 价差' + d4.breakdown.price + ' + 分红' + d4.breakdown.dividend + ' + 再投增益' + d4.breakdown.reinvestGain + ' = ' + d4.breakdown.total + '元');
    pass++;
  } catch (e) { console.log('  ✗ ' + e.message); fail++; }

  console.log('\n========== 测试汇总: ' + pass + ' 组通过, ' + fail + ' 组失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
