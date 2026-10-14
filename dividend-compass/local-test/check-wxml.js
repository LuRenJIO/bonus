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
    else if (f.endsWith('.wxml')) files.push(p);
  });
  return files;
}

const files = walk(ROOT, []);
let allOk = true;

files.forEach((file) => {
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
  if (errors.length) {
    allOk = false;
    console.log('FAIL ' + rel);
    errors.forEach((e) => console.log('   ' + e));
  } else {
    console.log('PASS ' + rel);
  }
});

console.log(allOk ? '\nWXML 标签配对全部通过' : '\n存在标签配对问题');
process.exit(allOk ? 0 : 1);
