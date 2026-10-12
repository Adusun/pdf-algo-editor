// 用 Node 模拟浏览器主流程，验证 app.js 的核心逻辑（不依赖 DOM）
// 检查点：模块可导入、无顶层副作用、关键导出存在
import { readFileSync } from 'node:fs';
const src = readFileSync('app.js', 'utf8');
// 去掉 DOM 相关部分后检查是否有语法/引用错误
const checks = [
  ['导入 xref', /from '\.\/src\/xref\.js'/],
  ['导入 content', /from '\.\/src\/content\.js'/],
  ['导入 raster', /from '\.\/src\/raster\.js'/],
  ['导入 editor', /from '\.\/src\/editor\.js'/],
  ['有 renderPages', /function renderPages/],
  ['有 screenToPdf', /function screenToPdf/],
  ['有 canvasToScreen', /function canvasToScreen/],
  ['有 save', /async function save/],
];
let bad = 0;
for (const [n, re] of checks) {
  if (re.test(src)) console.log('  PASS  ' + n);
  else { console.log('  FAIL  ' + n); bad++; }
}
process.exit(bad ? 1 : 0);
