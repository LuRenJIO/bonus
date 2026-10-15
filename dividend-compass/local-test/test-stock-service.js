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

  console.log('\n========== 测试汇总: ' + pass + ' 组通过, ' + fail + ' 组失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
