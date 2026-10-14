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

    // 年度分红视图
    console.log('\n  [年度分红视图]');
    d.dividend.annual.forEach((a) => {
      console.log('    ' + a.year + ': 每股' + a.perShare + '元 (' + a.times + '次)  派息率: ' +
        (a.payoutRatio === null ? '-' : a.payoutRatio + '%') + '  以现价计股息率: ' + a.yieldNow + '%');
    });
    assert(d.dividend.annual.length >= 3, '年度分红数据 >= 3年');

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
      console.log('  [双模型] 模型A(趋势): ' + p.basic.modelA.value + '元 (增速' + p.basic.modelA.divGrowth + '%)');
      if (p.basic.modelB) console.log('           模型B(派息率×净利): ' + p.basic.modelB.value + '元 (派息率' + p.basic.modelB.payoutRatio + '%, 净利增速' + p.basic.modelB.profitGrowth + '%)');
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
    assert(p.basic && p.basic.range.neutral > 0, '双模型中性预测 > 0');
    assert(p.enhanced && p.enhanced.range.neutral > 0, '盈利修正预测 > 0');

    // 体检
    const h = d.health;
    console.log('\n  [分红体检] ' + h.score + '分 ' + h.grade + '(' + h.label + ')');
    h.items.forEach((it) => console.log('    ' + (it.status === 'good' ? '●绿' : it.status === 'warn' ? '●黄' : '●红') + ' ' + it.name + ': ' + it.value + ' (' + it.score + '分) ' + it.note));
    assert(h.score > 0 && h.items.length === 6, '体检6项完整');
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
