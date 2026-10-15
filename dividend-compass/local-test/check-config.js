/**
 * 交付前配置一致性校验
 * 运行：node local-test/check-config.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let allOk = true;
const fail = (msg) => { allOk = false; console.log('  ✗ ' + msg); };
const pass = (msg) => console.log('  ✓ ' + msg);

// 1. 所有 JSON 文件语法合法
console.log('[1] JSON 语法检查');
const jsonFiles = [
  'project.config.json',
  'miniprogram/app.json',
  'miniprogram/sitemap.json',
  'miniprogram/pages/index/index.json',
  'miniprogram/pages/stock/stock.json',
  'cloudfunctions/stock-service/package.json',
  'cloudfunctions/favorites/package.json',
];
jsonFiles.forEach((f) => {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    pass(f);
  } catch (e) {
    fail(f + ' 语法错误: ' + e.message);
  }
});

// 2. project.config.json 关键字段
console.log('[2] project.config.json 关键字段');
const pc = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
if (/^wx[0-9a-f]{16}$/.test(pc.appid)) pass('appid 格式正确: ' + pc.appid);
else fail('appid 格式异常: ' + pc.appid);
if (pc.miniprogramRoot === 'miniprogram/') pass('miniprogramRoot');
else fail('miniprogramRoot');
if (pc.cloudfunctionRoot === 'cloudfunctions/') pass('cloudfunctionRoot');
else fail('cloudfunctionRoot');

// 3. app.json 声明的页面四件套齐全
console.log('[3] 页面文件完整性');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
appJson.pages.forEach((p) => {
  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    const f = path.join(ROOT, 'miniprogram', p + '.' + ext);
    if (fs.existsSync(f)) pass(p + '.' + ext);
    else fail('缺少 ' + p + '.' + ext);
  });
});

// 4. 云函数入口存在
console.log('[4] 云函数完整性');
['stock-service', 'favorites'].forEach((fn) => {
  if (fs.existsSync(path.join(ROOT, 'cloudfunctions', fn, 'index.js'))) pass(fn + '/index.js');
  else fail('缺少 ' + fn + '/index.js');
  const pkg = path.join(ROOT, 'cloudfunctions', fn, 'package.json');
  if (fs.existsSync(pkg)) {
    const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    pass(fn + '/package.json (main=' + j.main + ')');
  } else fail('缺少 ' + fn + '/package.json');
});

// 5. 前端引用的云函数名与目录一致
console.log('[5] 云函数名引用一致性');
const utilJs = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/util.js'), 'utf8');
['stock-service', 'favorites'].forEach((fn) => {
  if (utilJs.includes("name: '" + fn + "'")) pass('util.js 调用 ' + fn);
  else fail('util.js 未找到 ' + fn + ' 调用');
});

// 6. wxs 引用存在
console.log('[6] wxs 引用');
const stockWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/stock/stock.wxml'), 'utf8');
if (/src="\.\/format\.wxs"/.test(stockWxml) && fs.existsSync(path.join(ROOT, 'miniprogram/pages/stock/format.wxs'))) {
  pass('format.wxs 引用正常');
} else {
  fail('format.wxs 引用异常');
}

// 7. app.js 云初始化
console.log('[7] 云开发初始化');
const appJs = fs.readFileSync(path.join(ROOT, 'miniprogram/app.js'), 'utf8');
if (appJs.includes('wx.cloud.init')) pass('app.js 含 wx.cloud.init');
else fail('app.js 缺少云初始化');

console.log(allOk ? '\n全部检查通过，可交付' : '\n存在问题，请修复');
process.exit(allOk ? 0 : 1);
