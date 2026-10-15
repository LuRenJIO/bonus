/**
 * scan-remind/lib/scan-core.js 纯逻辑单测（node 直接运行）
 * 覆盖：机会匹配、内容行组装（20字符截断）、订阅消息 data 组装、日期工具
 */
const core = require('../cloudfunctions/scan-remind/lib/scan-core');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ 断言失败: ' + msg); }
}

console.log('========== scan-core 单测 ==========');

// ---- matchAlerts ----
const rules = [
  { code: '600519', name: '贵州茅台', threshold: 4.0 },
  { code: '600900', name: '长江电力', threshold: 3.5 },
  { code: '000001', name: '平安银行', threshold: 6.0 },
];
const quotes = {
  '600519': { price: 1312.97 },           // 47.385/1312.97 ≈ 3.61% < 4.0 → 不触发
  '600900': { price: 29.6 },              // 1.0/29.6 ≈ 3.38% < 3.5 → 不触发
  '000001': { price: 10.0 },              // TTM 0.6 → 6.0% >= 6.0 → 触发
};
const ttm = { '600519': 47.385, '600900': 1.0, '000001': 0.6 };

let hits = core.matchAlerts(rules, quotes, ttm);
assert(hits.length === 1, '仅平安银行触发（1条）');
assert(hits[0].code === '000001' && hits[0].ttmYield === 6.0, '触发标的与股息率正确: ' + hits[0].name + ' ' + hits[0].ttmYield + '%');

// 边界：行情缺失 / 分红为0 不触发也不报错
hits = core.matchAlerts([rules[0]], {}, ttm);                       // 无行情
assert(hits.length === 0, '缺行情数据不触发');
hits = core.matchAlerts([rules[0]], { '600519': { price: 1312.97 } }, {});  // 无TTM
assert(hits.length === 0, '缺TTM数据不触发');
hits = core.matchAlerts(rules, quotes, { '600519': 0, '600900': 0, '000001': 0 });
assert(hits.length === 0, '零分红不触发');
hits = core.matchAlerts([], quotes, ttm);
assert(hits.length === 0, '空规则安全');

// ---- buildRemindLines：20字符截断 ----
const lines1 = core.buildRemindLines([
  { name: '平安银行', ttmYield: 6.0 },
  { name: '贵州茅台', ttmYield: 4.04 },
]);
assert(lines1 === '平安银行6%、贵州茅台4.04%', '内容行拼接: ' + lines1);
assert(core.clip20(lines1).length <= 20, 'clip20 后 ≤20 字符');

const lines2 = core.buildRemindLines([
  { name: '超长名称的股票比如工业富联母公司鸿海精密', ttmYield: 5.55 },
  { name: '平安银行', ttmYield: 6.0 },
]);
assert(lines2.length <= 20, '超长内容截断 ≤20: (' + lines2.length + ') ' + lines2);
assert(core.buildRemindLines([]) === '', '空触发返回空串');

// ---- buildExDivLines ----
const ex1 = core.buildExDivLines([
  { name: '贵州茅台', amount: 5196.23 },
  { name: '长江电力', amount: 2000.55 },
]);
assert(ex1 === '贵州茅台5196元、长江电力2001元', '除息内容行: ' + ex1);
assert(core.buildExDivLines([]) === '', '空除息返回空串');
const ex2 = core.buildExDivLines([{ name: '贵州茅台', amount: 123.456 }]);
assert(ex2 === '贵州茅台123元', '单条四舍五入: ' + ex2);

// ---- buildMessageData ----
const md = core.buildMessageData('平安银行6%', '10月15日 08:30', { content: 'thing3', time: 'date4' });
assert(md.thing3 && md.thing3.value === '平安银行6%', '字段代号按映射输出');
assert(md.date4 && md.date4.value === '10月15日 08:30', '时间字段输出');
Object.keys(md).forEach((k) => {
  assert(md[k].value.length <= 20, '订阅消息字段 ' + k + ' ≤20字符');
});
const mdDefault = core.buildMessageData('x', 'y');
assert(mdDefault.thing1 && mdDefault.time2, '默认字段 thing1/time2');

// ---- 日期工具 ----
assert(/^\d{4}-\d{2}-\d{2}$/.test(core.localDateStr(new Date())), 'localDateStr 格式');
assert(/^\d+月\d+日 \d{2}:\d{2}$/.test(core.localWhenStr(new Date())), 'localWhenStr 格式');

// ---- fmtPct ----
assert(core.fmtPct(4.039999) === '4.04%', 'fmtPct 两位小数: ' + core.fmtPct(4.039999));

console.log('\n========== scan-core 测试汇总: ' + pass + ' 通过, ' + fail + ' 失败 ==========');
process.exit(fail ? 1 : 0);
