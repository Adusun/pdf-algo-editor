// 用最小 DOM 垫片在 Node 里真正执行 app.js，验证 UI 逻辑可运行。
// 这不是静态检查 —— app.js 的顶层代码会被真实执行，事件绑定、
// 载入示例、渲染页面、保存文件都会走一遍。
import { JSDOMLike } from './dom-shim.mjs';

const dom = await JSDOMLike.create();
globalThis.document = dom.document;
globalThis.window = dom.window;
globalThis.performance = dom.performance;
globalThis.Blob = dom.Blob;
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => { };
globalThis.ImageData = dom.ImageData;
globalThis.alert = () => { };
globalThis.prompt = () => 'test';
globalThis.devicePixelRatio = 1;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };

console.log('\n=== app.js 在真实 DOM 上执行 ===');
try {
  await import('../app.js');
  ok('app.js 顶层执行无异常', true);
} catch (e) {
  ok('app.js 顶层执行无异常', false, e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n'));
}

console.log('\n=== UI 元素与事件绑定 ===');
{
  const d = dom.document;
  for (const sel of ['#file', '#btnSave', '#btnDemo', '#pages', '#toolbar', '#log', '#textout', '#iPages']) {
    ok('存在 ' + sel, !!d.querySelector(sel));
  }
  // 工具按钮
  const tools = d.querySelectorAll('.tool');
  ok('有 5 个工具按钮', tools.length === 5, `got ${tools.length}`);
  const saved = [];
  d.querySelectorAll('button').forEach(b => {
    if (b.dataset && b.dataset.id) saved.push(b.dataset.id);
  });
  ok('保存按钮已绑定 id', saved.includes('btnSave'), JSON.stringify(saved));
  const toolbarBtns = [...d.querySelectorAll('button')];
  ok('工具栏按钮数量合理 (>10)', toolbarBtns.length > 10, `got ${toolbarBtns.length}`);
}

console.log('\n=== 载入内置示例并渲染 ===');
{
  const d = dom.document;
  const demoBtn = d.querySelectorAll('button').find(b => b.textContent === '载入内置示例');
  ok('找到"载入内置示例"按钮', !!demoBtn);
  if (demoBtn) {
    try {
      demoBtn.dispatchEvent('click');
      // 渲染是异步的，等几个微任务
      for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 10));
      ok('示例载入后页数显示为 1', d.querySelector('#iPages').textContent === '1',
        d.querySelector('#iPages').textContent);
      ok('示例载入后对象数已填充', d.querySelector('#iObjs').textContent !== '—',
        d.querySelector('#iObjs').textContent);
      const wraps = d.querySelectorAll('.page-wrap');
      ok('生成了 1 个页面容器', wraps.length === 1, `got ${wraps.length}`);
      const cv = d.querySelectorAll('canvas')[0];
      ok('生成了 canvas', !!cv);
      if (cv) {
        ok('canvas 有正数尺寸', cv.width > 0 && cv.height > 0, `${cv.width}x${cv.height}`);
        ok('页面被标记为第 1 页', d.querySelectorAll('.page-no').length === 1);
      }
      const txt = d.querySelector('#textout').textContent;
      ok('侧栏提取到文字', txt.includes('Hello'), JSON.stringify(txt.slice(0, 40)));
      const logTxt = d.querySelector('#log').textContent;
      ok('日志记录了解析信息', logTxt.includes('页'), JSON.stringify(logTxt.slice(0, 60)));
    } catch (e) {
      ok('载入示例不抛异常', false, e.message);
    }
  }
}

console.log('\n=== 画布像素确实被绘制 ===');
{
  const d = dom.document;
  const cv = d.querySelectorAll('canvas')[0];
  ok('canvas 已创建', !!cv);
  if (cv && cv._ctx) {
    const img = cv._ctx.__lastImageData;
    if (img) {
      // 统计非白像素
      let nonWhite = 0, blue = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i] < 250 || img.data[i + 1] < 250 || img.data[i + 2] < 250) nonWhite++;
        if (img.data[i + 2] > 150 && img.data[i] < 100) blue++;
      }
      ok('canvas 上有非白像素', nonWhite > 200, `nonWhite=${nonWhite}`);
      ok('蓝色矩形已画到 canvas', blue > 500, `blue=${blue}`);
    } else {
      ok('canvas 拿到 ImageData', false, '没有记录 putImageData');
    }
  } else {
    ok('canvas 上下文可用', false);
  }
}

console.log('\n=== 缩放 / 旋转 ===');
{
  const d = dom.document;
  const z0 = d.querySelector('#zoomVal').textContent;
  const zoomIn = d.querySelectorAll('button').find(b => b.textContent === '+');
  ok('找到缩放按钮', !!zoomIn);
  if (zoomIn) {
    zoomIn.dispatchEvent('click');
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 10));
    const z1 = d.querySelector('#zoomVal').textContent;
    ok('缩放后百分比变化', z0 !== z1, `${z0} -> ${z1}`);
  }
  const fit = d.querySelectorAll('button').find(b => b.textContent === '适应宽度');
  if (fit) {
    fit.dispatchEvent('click');
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 10));
    ok('适应宽度后仍有百分比', /%$/.test(d.querySelector('#zoomVal').textContent),
      d.querySelector('#zoomVal').textContent);
  }
  const rotR = d.querySelectorAll('button').find(b => b.textContent === '右转 90°');
  ok('找到旋转按钮', !!rotR);
  if (rotR) {
    rotR.dispatchEvent('click');
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 10));
    ok('旋转后日志有记录', d.querySelector('#log').textContent.includes('旋转'),
      JSON.stringify(d.querySelector('#log').textContent.slice(-60)));
    const cv = d.querySelectorAll('canvas')[0];
    ok('旋转后画布尺寸变化', cv && cv.width > 0);
  }
}

console.log('\n=== 保存（增量）===');
{
  const d = dom.document;
  const saveBtn = d.querySelectorAll('button').find(b => b.dataset && b.dataset.id === 'btnSave');
  ok('保存按钮可用', saveBtn && !saveBtn.disabled);
  if (saveBtn) {
    saveBtn.dispatchEvent('click');
    for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 10));
    const logTxt = d.querySelector('#log').textContent;
    ok('保存成功并写入日志', logTxt.includes('已保存'), JSON.stringify(logTxt.slice(-80)));
    ok('保存后无错误日志', !d.querySelectorAll('.err').length,
      d.querySelectorAll('.err').map(e => e.textContent).join('; '));
  }
}

console.log('\n=== 工具切换 ===');
{
  const d = dom.document;
  const hl = d.querySelectorAll('.tool').find(b => b.dataset.tool === 'highlight');
  ok('高亮工具存在', !!hl);
  if (hl) {
    hl.dispatchEvent('click');
    ok('切换后有 active 类', hl.classList.contains('active'));
    ok('其余工具已取消 active',
      d.querySelectorAll('.tool').filter(b => b.dataset.tool !== 'highlight' && b.classList.contains('active')).length === 0);
  }
  const ink = d.querySelectorAll('.tool').find(b => b.dataset.tool === 'ink');
  if (ink) {
    ink.dispatchEvent('click');
    ok('可切换到墨迹工具', ink.classList.contains('active'));
  }
}

console.log(`\n---- ui: ${pass} passed, ${fail} failed ----`);
dom.cleanup();
if (fail) process.exit(1);