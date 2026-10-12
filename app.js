// ============================================================================
// app.js — 浏览器端 UI：把六层核心接成可用的编辑器
// ============================================================================

import { PDFDocument } from './src/xref.js';
import { interpretContent, extractPageText } from './src/content.js';
import { renderOps } from './src/content.js';
import { Rasterizer, Color, clipMaskFromPaths } from './src/raster.js';
import { Matrix, Path } from './src/geometry.js';
import { PDFEditor } from './src/editor.js';
import { Dict, Name, Ref, isDict } from './src/lexer.js';
import { decodeStream } from './src/filters.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  bytes: null,        // 原始文件字节
  doc: null,          // PDFDocument
  editor: null,       // PDFEditor
  zoom: 1,
  tool: 'none',
  color: '#ffe94a',
  lineWidth: 2,
  annotCount: 0,
  selectedPage: -1,
  pageCanvases: [],   // 每页 canvas，便于叠加标注预览
  currentStrokes: null,
};

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------
async function loadFile(file) {
  log(`读取 ${file.name}…`, 'ok');
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const t0 = performance.now();
  const doc = new PDFDocument(bytes.slice()).parse();
  const tParse = performance.now() - t0;

  state.bytes = bytes;
  state.doc = doc;
  state.editor = new PDFEditor(doc);
  state.annotCount = 0;

  const pages = doc.pages();
  log(`解析完成：${pages.length} 页，${doc.xref.size} 个对象，用时 ${tParse.toFixed(0)}ms`, 'ok');
  if (doc.recovered) log('xref 已损坏，已通过全文件扫描重建', 'warn');
  for (const w of doc.warnings.slice(0, 3)) log(w, 'warn');

  $('#iPages').textContent = pages.length;
  $('#iObjs').textContent = doc.xref.size;
  $('#iSize').textContent = (bytes.length / 1024).toFixed(1) + ' KB';
  $('#iMode').textContent = doc.recovered ? '暴力恢复' : (doc.encrypted ? '加密(未解密)' : '正常');
  $('#iMode').style.color = doc.recovered ? '#854f0b' : 'var(--ok)';
  $('#iAnnots').textContent = '0';

  for (const id of ['btnSave', 'btnFull', 'btnRotL', 'btnRotR', 'btnDel', 'btnAdd']) $('#' + id).disabled = false;

  await renderAll();
  fitWidth();
  showPageText(0);
  $('#empty').style.display = 'none';
}

/** 生成一个内置示例（没有网络依赖） */
function loadDemo() {
  // 手工拼一个含中文/英文/图形的内容流，走完整解析-渲染链路
  const content = `
q 0.2 0.3 0.7 rg 40 600 320 60 re f Q
q 1 0.85 0.2 rg 40 520 180 50 re f Q
0.9 0.3 0.2 rg 40 430 m 200 430 l 120 340 l f
BT /F1 24 Tf 40 660 Td (Hello from a hand-written PDF) Tj ET
BT /F1 14 Tf 40 380 Td (Drag the mouse across this page to draw a highlight.) Tj ET
BT /F1 12 Tf 40 300 Td (Text is extracted character by character, with coordinates.) Tj ET
`.trim();

  const objs = [
    { n: 1, b: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, b: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { n: 3, b: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 700] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
    { n: 4, b: `<< /Length ${content.length} >>\nstream\n${content}\nendstream` },
    { n: 5, b: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ];
  let out = '%PDF-1.4\n';
  const off = {};
  for (const o of objs) { off[o.n] = out.length; out += `${o.n} 0 obj\n${o.b}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;

  loadBytes(new Uint8Array(new TextEncoder().encode(out)), '内置示例');
}

function loadBytes(bytes, name) {
  const doc = new PDFDocument(bytes.slice()).parse();
  state.bytes = bytes;
  state.doc = doc;
  state.editor = new PDFEditor(doc);
  state.annotCount = 0;
  log(`载入 ${name}：${doc.pages().length} 页`, 'ok');
  $('#iPages').textContent = doc.pages().length;
  $('#iObjs').textContent = doc.xref.size;
  $('#iSize').textContent = (bytes.length / 1024).toFixed(1) + ' KB';
  $('#iMode').textContent = doc.recovered ? '暴力恢复' : '正常';
  for (const id of ['btnSave', 'btnFull', 'btnRotL', 'btnRotR', 'btnDel', 'btnAdd']) $('#' + id).disabled = false;
  renderAll().then(() => { fitWidth(); showPageText(0); });
  $('#empty').style.display = 'none';
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
async function renderAll() {
  const pages = state.doc.pages();
  $('#pages').querySelectorAll('.page-wrap').forEach(e => e.remove());
  state.pageCanvases = [];

  for (let i = 0; i < pages.length; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    const cv = document.createElement('canvas');
    const no = document.createElement('div');
    no.className = 'page-no';
    no.textContent = i + 1;
    wrap.appendChild(cv); wrap.appendChild(no);
    $('#pages').appendChild(wrap);
    state.pageCanvases.push({ wrap, canvas: cv });
  }
  await renderPages();
}

async function renderPages() {
  const pages = state.doc.pages();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (let i = 0; i < pages.length; i++) {
    const { canvas } = state.pageCanvases[i];
    const pg = pages[i];
    const dict = state.doc.resolve(pg.ref);
    const inherited = pg.inherited || {};

    const mb = (state.doc.resolve(dict.get('MediaBox') || inherited.MediaBox) || [0, 0, 595, 842])
      .map(Number);
    const rotate = ((Number(state.doc.resolve(dict.get('Rotate') || inherited.Rotate)) || 0) % 360 + 360) % 360;

    const pw = Math.abs(mb[2] - mb[0]), ph = Math.abs(mb[3] - mb[1]);
    const swap = rotate === 90 || rotate === 270;
    const cssW = Math.round((swap ? ph : pw) * state.zoom);
    const cssH = Math.round((swap ? pw : ph) * state.zoom);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(canvas.width, canvas.height);
    // 白底
    for (let p = 0; p < img.data.length; p += 4) {
      img.data[p] = 255; img.data[p + 1] = 255; img.data[p + 2] = 255; img.data[p + 3] = 255;
    }

    // 解释内容流 -> 显示列表
    const ops = getPageOps(i);

    // 构造 base CTM：PDF 用户空间(左下原点) -> 画布像素(左上原点)
    const base = new Matrix(state.zoom * dpr, 0, 0, -state.zoom * dpr,
      -mb[0] * state.zoom * dpr, mb[3] * state.zoom * dpr);
    if (rotate === 90) base = base.multiply(new Matrix(0, 1, -1, 0, ph, 0));
    else if (rotate === 180) base = base.multiply(new Matrix(-1, 0, 0, -1, pw, ph));
    else if (rotate === 270) base = base.multiply(new Matrix(0, -1, 1, 0, 0, pw));

    // 把 base 变换合并进每个操作。
    // 注意：解释器在 finishPath 里已经把路径变换到 **CTM 空间**，
    // 所以这里只需再乘 base（页面空间 -> 画布像素），不能再乘 o.ctm，
    // 否则变换会被应用两次。
    const deviceOps = ops.map(o => {
      if (o.op === 'fill' || o.op === 'stroke' || o.op === 'clip') {
        const np = new Path();
        for (const sp of o.path.subpaths) np.subpaths.push({ pts: sp.pts.slice(), closed: sp.closed });
        np.transform(base);
        return { ...o, path: np };
      }
      if (o.op === 'image' && o.ctm) {
        return { ...o, ctm: base.multiply(o.ctm) };
      }
      return o;
    });

    renderOps(deviceOps, { width: canvas.width, height: canvas.height, data: img.data }, {
      Rasterizer, clipMaskFromPaths, Color, quality: 5,
    });

    // 叠加已有的注释外观（用浏览器 Canvas 画，外观流我们自己生成）
    drawAnnots(ctx, i, base, dpr);

    ctx.putImageData(img, 0, 0);
  }
  $('#zoomVal').textContent = Math.round(state.zoom * 100) + '%';
}

/** 取并缓存某页的显示列表 */
const opsCache = new Map();
function getPageOps(i) {
  const key = state.doc;
  if (opsCache.has(i)) return opsCache.get(i);
  const pages = state.doc.pages();
  const pg = pages[i];
  const dict = state.doc.resolve(pg.ref);
  const inherited = pg.inherited || {};
  const res = state.doc.resolve(dict.get('Resources') || inherited.Resources);
  const contents = state.doc.resolve(dict.get('Contents'));

  let content = null;
  const parts = [];
  if (Array.isArray(contents)) {
    for (const r of contents) {
      const s = state.doc.resolve(r);
      if (s && s.raw !== undefined) { try { parts.push(decodeStream(s, x => state.doc.resolve(x)).data); } catch { } }
    }
  } else if (contents && contents.raw !== undefined) {
    try { parts.push(decodeStream(contents, x => state.doc.resolve(x)).data); } catch { }
  }
  if (parts.length) {
    let total = 0; for (const p of parts) total += p.length;
    content = new Uint8Array(total);
    let o = 0; for (const p of parts) { content.set(p, o); o += p.length; }
  }
  if (!content) return [];

  const r = interpretContent(content, res, (x) => state.doc.resolve(x));
  const result = r.ops.map(op => ({
    ...op,
    ctm: op.c || new Matrix(),
  }));
  // 记录每个 op 的 CTM（解释器已在 finishPath 时把路径变换到 CTM 空间，
  // 这里只需要再叠加 base）
  opsCache.set(i, result);
  return result;
}

function invalidate() { opsCache.clear(); }

// ---------------------------------------------------------------------------
// 注释绘制（预览 + 已保存的）
// ---------------------------------------------------------------------------
function drawAnnots(ctx, pageIndex, base, dpr) {
  const pages = state.doc.pages();
  const pg = pages[pageIndex];
  const dict = state.doc.resolve(pg.ref);
  let annots = state.doc.resolve(dict.get('Annots'));
  if (!Array.isArray(annots)) return;

  for (const ar of annots) {
    const a = state.doc.resolve(ar);
    if (!isDict(a)) continue;
    const sub = state.doc.resolve(a.get('Subtype'));
    const rect = (state.doc.resolve(a.get('Rect')) || [0, 0, 0, 0]).map(Number);
    const c = (state.doc.resolve(a.get('C')) || [1, 1, 0]);
    const rgb = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

    // 优先用自己生成的外观流
    const ap = state.doc.resolve(a.get('AP'));
    const n = ap && isDict(ap) ? state.doc.resolve(ap.get('N')) : null;
    if (n && n.raw !== undefined) {
      try {
        const stream = decodeStream(n, x => state.doc.resolve(x)).data;
        const m = matrixFromRect(rect, base);
        // 直接把外观流当微缩内容流重放：它只有 re/f/S 等基础算子
        const ops = interpretContent(stream, state.doc.resolve(n.dict.get('Resources')) || new Dict(),
          x => state.doc.resolve(x)).ops;
        const tmp = { width: ctx.canvas.width, height: ctx.canvas.height, data: new Uint8ClampedArray(4) };
        // BBox 平移到 rect 左下角
        const bbox = (state.doc.resolve(n.dict.get('BBox')) || [0, 0, 1, 1]).map(Number);
        const offM = new Matrix(1, 0, 0, 1, -bbox[0], -bbox[1]);
        const full = m.multiply(offM);
        const scaled = ops.map(op => {
          if (op.path) {
            const np = new Path();
            for (const sp of op.path.subpaths) np.subpaths.push({ pts: sp.pts.slice(), closed: sp.closed });
            np.transform(full);
            return { ...op, path: np };
          }
          return op;
        });
        const tmpData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
        renderOps(scaled, tmpData, { Rasterizer, clipMaskFromPaths, Color, quality: 5 });
        ctx.putImageData(tmpData, 0, 0);
        continue;
      } catch { /* 落到下面的简化绘制 */ }
    }

    // 兜底：直接用 Canvas 画矩形
    const p0 = base.apply(rect[0], rect[1]);
    const p1 = base.apply(rect[2], rect[3]);
    ctx.save();
    ctx.fillStyle = rgb;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1]));
    ctx.restore();
  }
}

function matrixFromRect(rect, base) {
  // 外观流坐标原点在 Rect 左下角
  const s = new Matrix(1, 0, 0, 1, rect[0], rect[1]);
  return base.multiply(s);
}

// ---------------------------------------------------------------------------
// 坐标转换：屏幕 -> PDF 用户空间
// ---------------------------------------------------------------------------
function screenToPdf(pageIndex, clientX, clientY) {
  const { canvas } = state.pageCanvases[pageIndex];
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  const px = (clientX - rect.left) * dpr;
  const py = (clientY - rect.top) * dpr;

  const pages = state.doc.pages();
  const pg = pages[pageIndex];
  const dict = state.doc.resolve(pg.ref);
  const inherited = pg.inherited || {};
  const mb = (state.doc.resolve(dict.get('MediaBox') || inherited.MediaBox) || [0, 0, 595, 842]).map(Number);
  const rotate = ((Number(state.doc.resolve(dict.get('Rotate') || inherited.Rotate)) || 0) % 360 + 360) % 360;
  const pw = Math.abs(mb[2] - mb[0]), ph = Math.abs(mb[3] - mb[1]);
  const swap = rotate === 90 || rotate === 270;

  const base = new Matrix(state.zoom * dpr, 0, 0, -state.zoom * dpr,
    -mb[0] * state.zoom * dpr, mb[3] * state.zoom * dpr);
  let m = base;
  if (rotate === 90) m = base.multiply(new Matrix(0, 1, -1, 0, ph, 0));
  else if (rotate === 180) m = base.multiply(new Matrix(-1, 0, 0, -1, pw, ph));
  else if (rotate === 270) m = base.multiply(new Matrix(0, -1, 1, 0, 0, pw));

  const inv = m.invert();
  return inv.apply(px, py);
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------
let dragStart = null;
let dragRect = null;

function onPointerDown(e) {
  if (state.tool === 'none') return;
  const idx = Number(state.pageCanvases.findIndex(c => c.canvas === e.currentTarget));
  if (idx < 0) return;
  const [x, y] = screenToPdf(idx, e.clientX, e.clientY);
  dragStart = { x, y, page: idx };

  if (state.tool === 'ink') state.currentStrokes = [[[x, y]]];
  else dragRect = { x0: x, y0: y, x1: x, y1: y };

  e.currentTarget.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!dragStart) return;
  const idx = dragStart.page;
  const [x, y] = screenToPdf(idx, e.clientX, e.clientY);

  if (state.tool === 'ink') {
    const s = state.currentStrokes[state.currentStrokes.length - 1];
    const last = s[s.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) > 1.5) s.push([x, y]);
    previewInk();
  } else {
    dragRect.x1 = x; dragRect.y1 = y;
    previewRect();
  }
}

function onPointerUp(e) {
  if (!dragStart) return;
  const idx = dragStart.page;
  const { x, y } = screenToPdf(idx, e.clientX, e.clientY);
  const col = hexToRgb(state.color);

  try {
    if (state.tool === 'highlight' && dragRect) {
      const r = normRect(dragRect);
      if (r.w > 1 && r.h > 1) {
        state.editor.addHighlight(idx, [[r.x0, r.y0, r.x1, r.y1]], col, 0.4);
        state.annotCount++;
        afterEdit();
      }
    } else if (state.tool === 'underline' && dragRect) {
      const r = normRect(dragRect);
      if (r.w > 1 && r.h > 1) {
        state.editor.addUnderline(idx, [r.x0, r.y0, r.x1, r.y1], col);
        state.annotCount++;
        afterEdit();
      }
    } else if (state.tool === 'ink' && state.currentStrokes) {
      const strokes = state.currentStrokes.filter(s => s.length > 1);
      if (strokes.length) {
        state.editor.addInk(idx, strokes, col, state.lineWidth);
        state.annotCount++;
        afterEdit();
      }
    } else if (state.tool === 'note') {
      state.editor.addTextNote(idx, x, y, prompt('便签内容：') || '(空便签)', '');
      state.annotCount++;
      afterEdit();
    }
  } catch (err) {
    log('标注失败: ' + err.message, 'err');
  }

  dragStart = null; dragRect = null; state.currentStrokes = null;
  renderPages();
}

function normRect(r) {
  return {
    x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1),
    w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0),
  };
}

// 实时预览：直接在 canvas 上下文里画，不进 PDF
function previewRect() {
  renderPages().then(() => {
    const { canvas } = state.pageCanvases[dragStart.page];
    const ctx = canvas.getContext('2d');
    const r = normRect(dragRect);
    const a = canvasToScreen(dragStart.page, r.x0, r.y0);
    const b = canvasToScreen(dragStart.page, r.x1, r.y1);
    ctx.save();
    ctx.fillStyle = hexToRgba(state.color, 0.4);
    ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    ctx.restore();
  });
}

function previewInk() {
  renderPages().then(() => {
    const { canvas } = state.pageCanvases[dragStart.page];
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.strokeStyle = state.color;
    ctx.lineWidth = state.lineWidth * (canvas.width / canvas.getBoundingClientRect().width);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of state.currentStrokes) {
      if (s.length < 2) continue;
      ctx.beginPath();
      const a = canvasToScreen(dragStart.page, s[0][0], s[0][1]);
      ctx.moveTo(a[0], a[1]);
      for (let i = 1; i < s.length; i++) {
        const b = canvasToScreen(dragStart.page, s[i][0], s[i][1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
    }
    ctx.restore();
  });
}

function canvasToScreen(pageIndex, x, y) {
  const { canvas } = state.pageCanvases[pageIndex];
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  // 与 screenToPdf 用同一套 base 矩阵，做正向变换
  const pages = state.doc.pages();
  const pg = pages[pageIndex];
  const dict = state.doc.resolve(pg.ref);
  const inherited = pg.inherited || {};
  const mb = (state.doc.resolve(dict.get('MediaBox') || inherited.MediaBox) || [0, 0, 595, 842]).map(Number);
  const rotate = ((Number(state.doc.resolve(dict.get('Rotate') || inherited.Rotate)) || 0) % 360 + 360) % 360;
  const pw = Math.abs(mb[2] - mb[0]), ph = Math.abs(mb[3] - mb[1]);
  let m = new Matrix(state.zoom * dpr, 0, 0, -state.zoom * dpr,
    -mb[0] * state.zoom * dpr, mb[3] * state.zoom * dpr);
  if (rotate === 90) m = m.multiply(new Matrix(0, 1, -1, 0, ph, 0));
  else if (rotate === 180) m = m.multiply(new Matrix(-1, 0, 0, -1, pw, ph));
  else if (rotate === 270) m = m.multiply(new Matrix(0, -1, 1, 0, 0, pw));
  return m.apply(x, y);
}

function afterEdit() {
  $('#iAnnots').textContent = state.annotCount;
  log(`已添加标注（共 ${state.annotCount} 处，未保存）`, 'ok');
  invalidate();
  renderPages();
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

function log(msg, kind = '') {
  const el = document.createElement('div');
  el.className = kind;
  el.textContent = msg;
  $('#log').appendChild(el);
  $('#log').scrollTop = 1e9;
}

function showPageText(i) {
  try {
    const items = extractPageText(state.doc, i);
    $('#textout').textContent = items.length
      ? items.map(t => t.unicode).join('')
      : '（本页未提取到文字）';
  } catch (e) {
    $('#textout').textContent = '提取失败: ' + e.message;
  }
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------
async function save() {
  try {
    const out = await state.editor.saveIncremental(state.bytes);
    const blob = new Blob([out], { type: 'application/pdf' });
    download(blob, 'edited.pdf');
    log(`已保存（增量更新）：${(state.bytes.length / 1024).toFixed(1)}KB → ${(out.length / 1024).toFixed(1)}KB`, 'ok');
  } catch (e) {
    log('保存失败: ' + e.message, 'err');
  }
}
async function saveFull() {
  try {
    const out = await state.editor.saveFull();
    download(new Blob([out], { type: 'application/pdf' }), 'rewritten.pdf');
    log(`已完整重写：${(out.length / 1024).toFixed(1)}KB`, 'ok');
  } catch (e) {
    log('重写失败: ' + e.message, 'err');
  }
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

// ---------------------------------------------------------------------------
// 页面操作
// ---------------------------------------------------------------------------
async function rotate(delta) {
  const i = state.selectedPage >= 0 ? state.selectedPage : 0;
  const pages = state.doc.pages();
  const cur = Number(state.doc.resolve(pages[i].ref).get('Rotate')) || 0;
  state.editor.rotatePage(i, cur + delta);
  invalidate();
  renderPages();
  log(`第 ${i + 1} 页旋转 ${delta > 0 ? '+' : ''}${delta}°`, 'ok');
}
async function delPage() {
  const i = state.selectedPage >= 0 ? state.selectedPage : 0;
  if (state.doc.pages().length <= 1) return log('至少要保留一页', 'warn');
  state.editor.deletePage(i);
  state.selectedPage = -1;
  invalidate();
  renderPages();
  log(`已标记删除第 ${i + 1} 页（保存后生效）`, 'warn');
}
async function addPage() {
  const i = state.selectedPage >= 0 ? state.selectedPage + 1 : state.doc.pages().length;
  state.editor.insertBlankPage(i, 595, 842);
  log(`已在第 ${i + 1} 位插入空白页（保存后生效）`, 'ok');
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------
function zoomBy(f) {
  state.zoom = Math.max(0.25, Math.min(6, state.zoom * f));
  invalidate();
  renderPages();
}
function fitWidth() {
  const pages = state.doc.pages();
  if (!pages.length) return;
  const pg = state.doc.resolve(pages[0].ref);
  const inherited = pages[0].inherited || {};
  const mb = (state.doc.resolve(pg.get('MediaBox') || inherited.MediaBox) || [0, 0, 595, 842]).map(Number);
  const avail = $('#pages').clientWidth - 56;
  state.zoom = Math.max(0.2, Math.min(4, avail / Math.abs(mb[2] - mb[0])));
  invalidate();
  renderPages();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
$('#file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadFile(f);
});
$('#btnDemo').addEventListener('click', loadDemo);
$('#btnSave').addEventListener('click', save);
$('#btnFull').addEventListener('click', saveFull);
$('#btnZoomIn').addEventListener('click', () => zoomBy(1.25));
$('#btnZoomOut').addEventListener('click', () => zoomBy(0.8));
$('#btnFit').addEventListener('click', fitWidth);
$('#btnRotL').addEventListener('click', () => rotate(-90));
$('#btnRotR').addEventListener('click', () => rotate(90));
$('#btnDel').addEventListener('click', delPage);
$('#btnAdd').addEventListener('click', addPage);

$$('.tool').forEach(b => b.addEventListener('click', () => {
  $$('.tool').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.tool = b.dataset.tool;
  document.body.style.cursor = state.tool === 'none' ? '' : 'crosshair';
}));

$('#color').addEventListener('input', (e) => state.color = e.target.value);
$('#width').addEventListener('input', (e) => {
  state.lineWidth = +e.target.value;
  $('#widthVal').textContent = e.target.value;
});

// 页面点击选中 + 文字面板
$('#pages').addEventListener('click', (e) => {
  const idx = state.pageCanvases.findIndex(c => c.wrap.contains(e.target));
  if (idx < 0) return;
  $$('.page-wrap').forEach((w, i) => w.classList.toggle('selected', i === idx));
  state.selectedPage = idx;
  showPageText(idx);
});

$('#pages').addEventListener('pointerdown', onPointerDown);
$('#pages').addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);

// 拖放
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
});

log('就绪：拖入 PDF 或点击"载入内置示例"', 'ok');