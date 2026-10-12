// 端到端渲染测试：在 Node 里模拟浏览器的渲染管线，验证像素输出
// 这验证的是 app.js 里 renderPages 的**逻辑**（不含 Canvas API）
import { PDFDocument } from '../src/xref.js';
import { interpretContent, renderOps } from '../src/content.js';
import { Rasterizer, Color, clipMaskFromPaths } from '../src/raster.js';
import { Matrix, Path } from '../src/geometry.js';
import { decodeStream } from '../src/filters.js';
import { PDFEditor } from '../src/editor.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };

/** 复刻 app.js 的 base 矩阵构造 */
function baseMatrix(mb, rotate, zoom, dpr) {
  const pw = Math.abs(mb[2] - mb[0]), ph = Math.abs(mb[3] - mb[1]);
  let m = new Matrix(zoom * dpr, 0, 0, -zoom * dpr,
    -mb[0] * zoom * dpr, mb[3] * zoom * dpr);
  if (rotate === 90) m = m.multiply(new Matrix(0, 1, -1, 0, ph, 0));
  else if (rotate === 180) m = m.multiply(new Matrix(-1, 0, 0, -1, pw, ph));
  else if (rotate === 270) m = m.multiply(new Matrix(0, -1, 1, 0, 0, pw));
  return m;
}

/** 复刻 app.js 的渲染页函数，返回 ImageData */
function renderPage(doc, pageIndex, zoom = 1, dpr = 1) {
  const pages = doc.pages();
  const pg = pages[pageIndex];
  const dict = doc.resolve(pg.ref);
  const inherited = pg.inherited || {};
  const mb = (doc.resolve(dict.get('MediaBox') || inherited.MediaBox) || [0, 0, 595, 842]).map(Number);
  const rotate = ((Number(doc.resolve(dict.get('Rotate') || inherited.Rotate)) || 0) % 360 + 360) % 360;
  const pw = Math.abs(mb[2] - mb[0]), ph = Math.abs(mb[3] - mb[1]);
  const swap = rotate === 90 || rotate === 270;
  const W = Math.round((swap ? ph : pw) * zoom * dpr);
  const H = Math.round((swap ? pw : ph) * zoom * dpr);

  const res = doc.resolve(dict.get('Resources') || inherited.Resources);
  const contents = doc.resolve(dict.get('Contents'));
  const parts = [];
  if (Array.isArray(contents)) {
    for (const r of contents) {
      const s = doc.resolve(r);
      if (s && s.raw !== undefined) { try { parts.push(decodeStream(s, x => doc.resolve(x)).data); } catch { } }
    }
  } else if (contents && contents.raw !== undefined) {
    try { parts.push(decodeStream(contents, x => doc.resolve(x)).data); } catch { }
  }
  let content = null;
  if (parts.length) {
    let t = 0; for (const p of parts) t += p.length;
    content = new Uint8Array(t);
    let o = 0; for (const p of parts) { content.set(p, o); o += p.length; }
  }
  if (!content) return null;

  const r = interpretContent(content, res, x => doc.resolve(x));
  const base = baseMatrix(mb, rotate, zoom, dpr);

  const deviceOps = r.ops.map(o => {
    if (o.op === 'fill' || o.op === 'stroke' || o.op === 'clip') {
      const np = new Path();
      for (const sp of o.path.subpaths) np.subpaths.push({ pts: sp.pts.slice(), closed: sp.closed });
      np.transform(base);
      return { ...o, path: np };
    }
    return o;
  });

  const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let p = 0; p < img.data.length; p += 4) {
    img.data[p] = 255; img.data[p + 1] = 255; img.data[p + 2] = 255; img.data[p + 3] = 255;
  }
  renderOps(deviceOps, img, { Rasterizer, clipMaskFromPaths, Color, quality: 5 });
  return { img, W, H, mb, rotate, ops: r.ops, textItems: r.textItems };
}

const px = (r, x, y) => {
  const i = (y * r.W + x) * 4;
  return [r.img.data[i], r.img.data[i + 1], r.img.data[i + 2], r.img.data[i + 3]];
};
const countNonWhite = (r) => {
  let n = 0;
  for (let i = 0; i < r.img.data.length; i += 4) {
    if (r.img.data[i] < 250 || r.img.data[i + 1] < 250 || r.img.data[i + 2] < 250) n++;
  }
  return n;
};

// ---- 内置示例（与 app.js 的 loadDemo 一致）----
const DEMO = `
q 0.2 0.3 0.7 rg 40 600 320 60 re f Q
q 1 0.85 0.2 rg 40 520 180 50 re f Q
0.9 0.3 0.2 rg 40 430 m 200 430 l 120 340 l f
BT /F1 24 Tf 40 660 Td (Hello from a hand-written PDF) Tj ET
BT /F1 14 Tf 40 380 Td (Drag the mouse across this page to draw a highlight.) Tj ET
BT /F1 12 Tf 40 300 Td (Text is extracted character by character, with coordinates.) Tj ET
`.trim();

function makeDemoPDF() {
  const objs = [
    { n: 1, b: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, b: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { n: 3, b: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 700] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
    { n: 4, b: `<< /Length ${DEMO.length} >>\nstream\n${DEMO}\nendstream` },
    { n: 5, b: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ];
  let out = '%PDF-1.4\n';
  const off = {};
  for (const o of objs) { off[o.n] = out.length; out += `${o.n} 0 obj\n${o.b}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(new TextEncoder().encode(out));
}

console.log('\n=== 端到端：解析 -> 解释 -> 光栅 -> 像素 ===');
{
  const doc = new PDFDocument(makeDemoPDF()).parse();
  ok('文档解析成功', !doc.recovered, doc.warnings.join('; '));

  const r = renderPage(doc, 0, 1, 1);
  ok('渲染出画布', !!r && r.W === 420 && r.H === 700, r ? `${r.W}x${r.H}` : 'null');
  const nonWhite = countNonWhite(r);
  ok('画布上有内容', nonWhite > 500, `nonWhite=${nonWhite}`);
  ok('背景是白色', px(r, 5, 5)[0] > 250 && px(r, 5, 5)[3] === 255);

  // 蓝色矩形 (40,600)-(360,660) -> 画布上 y = 700-660=40 到 700-600=100
  ok('蓝色矩形已绘制 (RGB 0.2,0.3,0.7)',
    Math.abs(px(r, 200, 70)[0] - 51) < 12 && Math.abs(px(r, 200, 70)[1] - 77) < 12 && Math.abs(px(r, 200, 70)[2] - 179) < 12,
    JSON.stringify(px(r, 200, 70)));
  // 黄色矩形 (40,520)-(220,570) -> y = 130..180
  ok('黄色矩形已绘制 (RGB 1,0.85,0.2)',
    Math.abs(px(r, 100, 155)[0] - 255) < 8 && Math.abs(px(r, 100, 155)[1] - 217) < 10 && px(r, 100, 155)[2] < 60,
    JSON.stringify(px(r, 100, 155)));
  // 红色三角形顶点 (40,430)(200,430)(120,340)
  // 画布 y = 700 - pdfY -> 占据 y=270..360，底部最宽，采样取 y=350
  const tri = px(r, 120, 350);
  ok('三角形下部为红 (0.9,0.3,0.2)',
    Math.abs(tri[0] - 230) < 12 && Math.abs(tri[1] - 77) < 12 && Math.abs(tri[2] - 51) < 12,
    JSON.stringify(tri));
  const triAbove = px(r, 120, 260);
  ok('三角形上方未被填充', triAbove[0] > 250 && triAbove[1] > 250, JSON.stringify(triAbove));
  const triSide = px(r, 20, 350);
  ok('三角形左侧外未被填充', triSide[0] > 250, JSON.stringify(triSide));

  // 抗锯齿：矩形边界 x=40 与像素边界对齐，边缘像素是满覆盖（正常）。
  // 真正能体现抗锯齿的是三角形斜边 —— 斜边必然切过像素中间。
  let sawAA = false;
  for (let y = 275; y < 355; y++) {
    // 沿三角形左斜边扫描，找"既不是纯红也不是纯白"的像素
    for (let x = 40; x < 120; x++) {
      const p = px(r, x, y);
      const isRed = Math.abs(p[0] - 230) < 15 && p[1] < 100;
      const isWhite = p[0] > 250 && p[1] > 250;
      if (!isRed && !isWhite) { sawAA = true; break; }
    }
    if (sawAA) break;
  }
  ok('三角形斜边存在抗锯齿中间色', sawAA);
}

console.log('\n=== 文字提取 ===');
{
  const doc = new PDFDocument(makeDemoPDF()).parse();
  const r = renderPage(doc, 0, 1, 1);
  const text = r.textItems.map(t => t.unicode).join('');
  ok('提取到完整文字', text.includes('Hello from a hand-written PDF'), JSON.stringify(text.slice(0, 40)));
  ok('文字坐标正确（第一个字符在 40,660）',
    Math.abs(r.textItems[0].x - 40) < 0.01 && Math.abs(r.textItems[0].y - 660) < 0.01,
    `(${r.textItems[0].x},${r.textItems[0].y})`);
  ok('文字有宽度信息', r.textItems[0].width > 0, `w=${r.textItems[0].width}`);
  // 空格保留
  ok('文字中的空格被保留', text.includes('from a'), JSON.stringify(text.slice(0, 30)));
}

console.log('\n=== 缩放 ===');
{
  const doc = new PDFDocument(makeDemoPDF()).parse();
  const r1 = renderPage(doc, 0, 1, 1);
  const r2 = renderPage(doc, 0, 2, 1);
  ok('2 倍缩放画布尺寸翻倍', r2.W === 840 && r2.H === 1400, `${r2.W}x${r2.H}`);
  const n1 = countNonWhite(r1), n2 = countNonWhite(r2);
  ok('2 倍缩放后内容面积约 4 倍', n2 > n1 * 3.2 && n2 < n1 * 4.8, `${n1} -> ${n2}`);
  // 同一 PDF 坐标在 2 倍下对应 2 倍像素
  const p1 = px(r1, 200, 70), p2 = px(r2, 400, 140);
  ok('相同位置颜色一致', Math.abs(p1[0] - p2[0]) < 10 && Math.abs(p1[2] - p2[2]) < 10,
    `${p1} vs ${p2}`);
}

console.log('\n=== 页面旋转 ===');
{
  const doc = new PDFDocument(makeDemoPDF()).parse();
  const ed = new PDFEditor(doc);
  ed.rotatePage(0, 90);
  const saved = await ed.saveIncremental(makeDemoPDF());
  const doc2 = new PDFDocument(saved).parse();
  ok('旋转后重新解析成功', !doc2.recovered);
  const r = renderPage(doc2, 0, 1, 1);
  ok('旋转 90° 后画布宽高互换', r.W === 700 && r.H === 420, `${r.W}x${r.H}`);
  ok('旋转后仍有内容', countNonWhite(r) > 500);
  // 旋转后蓝色矩形（页面顶部）在画布右侧
  ok('旋转 90° 后内容位置正确（蓝色在右）',
    px(r, 600, 200)[2] > 150, JSON.stringify(px(r, 600, 200)));
}

console.log('\n=== 注释渲染到像素 ===');
{
  const doc = new PDFDocument(makeDemoPDF()).parse();
  const ed = new PDFEditor(doc);
  // 在蓝色矩形区域加高亮
  ed.addHighlight(0, [[50, 610, 350, 650]], [1, 0, 0], 0.5);
  const saved = await ed.saveIncremental(makeDemoPDF());
  const doc2 = new PDFDocument(saved).parse();
  ok('含注释的文档可解析', !doc2.recovered, doc2.warnings.join('; '));

  // 复刻 drawAnnots：把外观流重放
  const page = doc2.pages()[0];
  const pd = doc2.resolve(page.ref);
  const annots = doc2.resolve(pd.get('Annots'));
  ok('页面有 1 个注释', Array.isArray(annots) && annots.length === 1);
  const a = doc2.resolve(annots[0]);
  ok('注释是 Highlight', a.get('Subtype')?.name === 'Highlight');
  const rect = doc2.resolve(a.get('Rect'));
  ok('注释 Rect 正确', rect[0] === 50 && rect[1] === 610 && rect[2] === 350 && rect[3] === 650,
    JSON.stringify(rect));

  const ap = doc2.resolve(a.get('AP'));
  const n = doc2.resolve(ap.get('N'));
  ok('外观流可解码', n && n.raw !== undefined);
  const stream = decodeStream(n, x => doc2.resolve(x)).data;
  const stext = new TextDecoder('latin1').decode(stream);
  ok('外观流含绘制指令', stext.includes('re') && stext.includes('f'), JSON.stringify(stext.slice(0, 70)));
  ok('外观流用了 Multiply 混合', stext.includes('/GS gs'));

  // 直接渲染外观流，确认能产生像素
  const bbox = doc2.resolve(n.dict.get('BBox')).map(Number);
  const sub = interpretContent(stream, doc2.resolve(n.dict.get('Resources')) || new Dict(), x => doc2.resolve(x)).ops;
  const base = baseMatrix([0, 0, 420, 700], 0, 1, 1);
  const full = base.multiply(new Matrix(1, 0, 0, 1, rect[0] - bbox[0], rect[1] - bbox[1]));
  const dev = sub.map(op => {
    if (op.path) {
      const np = new Path();
      for (const sp of op.path.subpaths) np.subpaths.push({ pts: sp.pts.slice(), closed: sp.closed });
      np.transform(full);
      return { ...op, path: np };
    }
    return op;
  });
  const img = { width: 420, height: 700, data: new Uint8ClampedArray(420 * 700 * 4).fill(255) };
  renderOps(dev, img, { Rasterizer, clipMaskFromPaths, Color, quality: 5 });
  // 注释 rect 是 PDF 坐标 (50,610)-(350,650)，页面高 700
  // -> 画布 y = 700-650=50 到 700-610=90，采样取中间 y=70, x=200
  const mid = (() => { const i = ((70 * 420) + 200) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; })();
  ok('注释外观流渲染出红色像素', mid[0] > 200 && mid[1] < 80 && mid[2] < 80, JSON.stringify(mid));
}

console.log(`\n---- e2e: ${pass} passed, ${fail} failed ----`);
if (fail) process.exit(1);