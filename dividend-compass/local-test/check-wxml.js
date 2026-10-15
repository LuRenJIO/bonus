/**
 * 校验 WXML 标签配对（简单版：检查 view/text/block/image/button/input/icon 等容器标签开闭平衡）
 * 运行：node local-test/check-wxml.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');

function walk(dir, files) {
  fs.readdirSync(dir).forEach((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, files);
    else if (f.endsWith('.wxml') || f.endsWith('.wxs')) files.push(p);
  });
  return files;
}

const files = walk(ROOT, []);

// WXS 受限语法守卫：这些写法在普通 JS 合法，但 WXS 编译器不支持
const WXS_FORBIDDEN = [
  { re: /\d[eE][+-]?\d/, what: '科学计数法字面量（如 1e8，请写 100000000）' },
  { re: /\bisNaN\b/, what: 'isNaN（WXS 无此全局函数，用 v === v 判 NaN）' },
  { re: /\blet\s+[A-Za-z_$]/, what: 'let 声明（WXS 仅支持 var）' },
  { re: /\bconst\s+[A-Za-z_$]/, what: 'const 声明（WXS 仅支持 var）' },
  { re: /=>/, what: '箭头函数（WXS 不支持）' },
  { re: /`/, what: '模板字符串反引号（WXS 不支持）' },
];

let allOk = true;

// WXML 表达式守卫：{{}} 内不支持任意函数调用（.toFixed( / Math. 等会编译报错 unexpected token `.`）
const MUSTACHE_FN = [
  { re: /\.(toFixed|slice|map|filter|reduce|join|concat|push|indexOf|replace|split|round|sqrt|pow|abs|min|max)\s*\(/, what: '{{}} 内的方法调用（.toFixed() 等，请在 JS/WXS 侧格式化后绑定）' },
  { re: /Math\s*\./, what: '{{}} 内的 Math.xxx（不支持全局对象，请在 JS 侧计算）' },
];

files.forEach((file) => {
  if (!file.endsWith('.wxml')) return; // wxs 只做受限语法检查，不做标签配对
  const content = fs.readFileSync(file, 'utf8');
  // 去掉注释
  const src = content.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const errors = [];
  const regex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?\s*>/g;
  let m;
  while ((m = regex.exec(src)) !== null) {
    const isClose = m[0][1] === '/';
    const selfClose = /\/\s*>$/.test(m[0]);
    const tag = m[1];
    if (tag === 'input' || tag === 'icon' || tag === 'import' || tag === 'include' || tag === 'wxs') continue;
    if (selfClose) continue;
    if (!isClose) {
      stack.push({ tag, pos: m.index });
    } else {
      const top = stack.pop();
      if (!top) {
        errors.push('多余的闭合标签 </' + tag + '> @' + m.index);
      } else if (top.tag !== tag) {
        errors.push('标签不匹配: <' + top.tag + ' @' + top.pos + ' 被 </' + tag + '> @' + m.index + ' 闭合');
      }
    }
  }
  if (stack.length) {
    stack.forEach((s) => errors.push('未闭合标签 <' + s.tag + '> @' + s.pos));
  }
  const rel = path.relative(ROOT, file);
  // Mustache 表达式函数调用检查
  const mustaches = src.match(/\{\{[\s\S]*?\}\}/g) || [];
  mustaches.forEach((ms) => {
    MUSTACHE_FN.forEach((rule) => {
      if (rule.re.test(ms)) {
        const line = src.slice(0, src.indexOf(ms)).split('\n').length;
        errors.push('第' + line + '行: ' + rule.what);
      }
    });
  });
  if (errors.length) {
    allOk = false;
    console.log('FAIL ' + rel);
    errors.forEach((e) => console.log('   ' + e));
  } else {
    console.log('PASS ' + rel);
  }
});

console.log(allOk ? '\nWXML 标签配对全部通过' : '\n存在标签配对问题');

// ---- WXS 受限语法检查 ----
console.log('\n---- WXS 语法守卫 ----');
const wxsFiles = walk(ROOT, []).filter((f) => f.endsWith('.wxs'));
if (!wxsFiles.length) console.log('(未发现 wxs 文件)');
wxsFiles.forEach((file) => {
  const rel = path.relative(ROOT, file);
  // 去掉注释行再检查
  const src = fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n');
  const hits = [];
  WXS_FORBIDDEN.forEach((rule) => {
    const m = rule.re.exec(src);
    if (m) hits.push('第' + (src.slice(0, m.index).split('\n').length) + '行: ' + rule.what);
  });
  if (hits.length) {
    allOk = false;
    console.log('FAIL ' + rel);
    hits.forEach((h) => console.log('   ' + h));
  } else {
    console.log('PASS ' + rel);
  }
});

process.exit(allOk ? 0 : 1);
