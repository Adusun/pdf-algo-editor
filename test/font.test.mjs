// 字体引擎测试：构造一个最小 TrueType 字体，逐表验证解析
import { parseTrueType, glyphFromGlyf, Font, parseCFF, runType2 } from '../src/font.js';
import { Matrix } from '../src/geometry.js';
import { Dict, Name, isDict, PDFStream } from '../src/lexer.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };

// ---------------------------------------------------------------------------
// 构造最小 TrueType 字体：一个矩形字形 + 一个三角形字形
// ---------------------------------------------------------------------------
function buildGlyf(glyphs) {
  // glyphs: [{contours: [[[x,y,onFlag],...],...], composite?: {gid,dx,dy,scale}}]
  const parts = [];
  const locaOffsets = [0];
  for (const g of glyphs) {
    const bytes = [];
    const numContours = g.contours.length;
    let p = 10; // 头部 10 字节
    // endPtsOfContours
    const endPts = [];
    let n = 0;
    for (const c of g.contours) { n += c.length; endPts.push(n - 1); }
    for (const e of endPts) { bytes.push((e >> 8) & 255, e & 255); }
    p += endPts.length * 2;
    // instructionLength = 0
    bytes.push(0, 0); p += 2;
    // flags
    const allPts = g.contours.flat();
    for (const pt of allPts) bytes.push(pt[2] ? 1 : 0);
    p += allPts.length;
    // x 差分
    let prev = 0;
    for (const pt of allPts) {
      const d = pt[0] - prev;
      prev = pt[0];
      bytes.push((d >> 8) & 255, d & 255);   // 用 int16 简化
      p += 2;
    }
    // y 差分
    prev = 0;
    for (const pt of allPts) {
      const d = pt[1] - prev;
      prev = pt[1];
      bytes.push((d >> 8) & 255, d & 255);
      p += 2;
    }
    // 补齐到 4 字节对齐（loca 要求）
    while (bytes.length % 4) bytes.push(0);
    // 组装 glyph 记录头
    const rec = new Uint8Array(10 + bytes.length);
    rec[0] = (numContours >> 8) & 255; rec[1] = numContours & 255;
    rec.set(bytes, 10);
    parts.push(rec);
    locaOffsets.push(locaOffsets[locaOffsets.length - 1] + rec.length);
  }
  const glyfLen = locaOffsets[locaOffsets.length - 1];
  const glyf = new Uint8Array(glyfLen);
  let off = 0;
  parts.forEach(r => { glyf.set(r, off); off += r.length; });
  const loca = new Uint8Array(locaOffsets.length * 4);
  locaOffsets.forEach((v, i) => {
    loca[i * 4] = (v >>> 24) & 255; loca[i * 4 + 1] = (v >>> 16) & 255;
    loca[i * 4 + 2] = (v >>> 8) & 255; loca[i * 4 + 3] = v & 255;
  });
  return { glyf, loca };
}

function buildFont(glyphs, cmapPairs, numGlyphs) {
  const { glyf, loca } = buildGlyf(glyphs);
  const tables = {};
  // head (54 字节)
  const head = new Uint8Array(54);
  head[0] = 0; head[1] = 1;        // version 1.0
  head[18] = (1000 >> 8) & 255; head[19] = 1000 & 255;   // unitsPerEm = 1000 (偏移 18)
  head[42] = 0; head[43] = 1;      // indexToLocFormat = 1 (long loca, 偏移 42)
  tables['head'] = head;
  // maxp
  const maxp = new Uint8Array(6);
  maxp[0] = 0; maxp[1] = 1;
  maxp[4] = (numGlyphs >> 8) & 255; maxp[5] = numGlyphs & 255;
  tables['maxp'] = maxp;
  // cmap：顶层表 = version(0) + numEncodingRecords + 记录数组(每条8字节)
  //      + 子表数据。子表**不在**偏移 0 处，必须通过记录里的 offset 定位。
  // 这里构造一个 format 4 子表，把 [minChar..maxChar] 映射到连续 gid。
  const codes = cmapPairs.map(p => p[0]);
  const gids = cmapPairs.map(p => p[1]);
  const minC = Math.min(...codes), maxC = Math.max(...codes);
  // 段1: [minC, maxC] 用 idDelta 映射；段2: 0xFFFF 终止
  const segCount = 2;
  // 头部14 + endCode(seg*2) + reservedPad(2) + startCode/idDelta/idRangeOff(seg*6)
  // = 18 + seg*8；写成 16+seg*8 会少 2 字节，把 idRangeOff 挤到数组外。
  const subLen = 18 + segCount * 8;
  const sub = new Uint8Array(subLen);
  const sv = new DataView(sub.buffer);
  sv.setUint16(0, 4);                 // format = 4
  sv.setUint16(2, subLen);            // length
  sv.setUint16(4, 0);                 // language
  sv.setUint16(6, segCount * 2);      // segCountX2
  sv.setUint16(8, 2);                 // searchRange
  sv.setUint16(10, 0);                // entrySelector
  sv.setUint16(12, 0);                // rangeShift
  // endCode @14
  sv.setUint16(14, maxC);
  sv.setUint16(16, 0xffff);
  sv.setUint16(18, 0);                // reservedPad
  // startCode @20
  sv.setUint16(20, minC);
  sv.setUint16(22, 0xffff);
  // idDelta @24  (gid = (char + delta) & 0xffff)
  // idDelta 语义: gid = (charCode + idDelta) mod 65536
  // minC 必须映射到 gids[0]，所以 delta = gids[0] - minC
  sv.setInt16(24, (gids[0] - minC) & 0xffff);
  sv.setInt16(26, 1);
  // idRangeOff @28 (0 表示用 idDelta)
  sv.setUint16(28, 0);
  sv.setUint16(30, 0);

  const dirLen = 4 + 1 * 8;           // version+numTables + 1 条记录
  const cmap = new Uint8Array(dirLen + subLen);
  const cv = new DataView(cmap.buffer);
  cv.setUint16(0, 0);                 // version = 0
  cv.setUint16(2, 1);                 // numEncodingRecords = 1
  cv.setUint16(4, 3);                 // platformID = 3 (Windows)
  cv.setUint16(6, 1);                 // encodingID = 1 (BMP)
  cv.setUint32(8, dirLen);            // 子表偏移
  cmap.set(sub, dirLen);
  tables['cmap'] = cmap;
  tables['glyf'] = glyf;
  tables['loca'] = loca;

  // 组装 sfnt
  const tags = Object.keys(tables);
  const numTables = tags.length;
  let sr = 1, es = 0;
  while (sr * 2 <= numTables) { sr *= 2; es++; }
  const headerLen = 12 + numTables * 16;
  const out = new Uint8Array(headerLen + tags.reduce((s, t) => s + ((tables[t].length + 3) & ~3), 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, numTables);
  dv.setUint16(6, sr * 16); dv.setUint16(8, es); dv.setUint16(10, numTables * 16 - sr * 16);
  let dataOff = headerLen;
  const recs = [];
  tags.forEach((t, i) => {
    const off = dataOff;
    recs.push({ t, off, len: tables[t].length });
    const pad = (tables[t].length + 3) & ~3;
    dataOff += pad;
  });
  recs.forEach((r, i) => {
    // sfnt 表目录项布局（16 字节）：
    //   0-3 tag, 4-7 checkSum, 8-11 offset, 12-15 length
    // 漏掉 checkSum 会让解析器把 offset 读成 0 —— 这是本测试最初的 bug。
    const base = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[base + k] = r.t.charCodeAt(k);
    dv.setUint32(base + 4, 0);            // checkSum（解析器不校验，填 0）
    dv.setUint32(base + 8, r.off);       // offset
    dv.setUint32(base + 12, r.len);      // length
    out.set(tables[r.t], r.off);
  });
  return out;
}

// glyph 0: .notdef 空；glyph 1: 矩形 100x1000；glyph 2: 三角形
const glyphs = [
  { contours: [] },
  { contours: [[[0, 0, 1], [1000, 0, 1], [1000, 1000, 1], [0, 1000, 1]]] },
  { contours: [[[0, 0, 1], [800, 0, 1], [400, 800, 1]]] },
];
const fontBytes = buildFont(glyphs, [[65, 1], [66, 2]], 3);

console.log('\n=== TrueType 表解析 ===');
{
  const tt = parseTrueType(fontBytes);
  ok('识别 sfnt 版本', !!tt);
  ok('读到 unitsPerEm=1000', tt.unitsPerEm === 1000, `got ${tt.unitsPerEm}`);
  ok('读到 numGlyphs=3', tt.numGlyphs === 3, `got ${tt.numGlyphs}`);
  ok('indexToLocFormat=1', tt.indexToLocFormat === 1, `got ${tt.indexToLocFormat}`);
  ok('glyf/loca/head 表存在', !!tt.glyf && !!tt.loca && !!tt.head);
  ok('glyf 长度合理', tt.glyf.length > 0 && tt.glyf.length < 200, `got ${tt.glyf.length}`);
}

console.log('\n=== 简单字形轮廓（矩形）===');
{
  const tt = parseTrueType(fontBytes);
  const p = glyphFromGlyf(tt, 1, 0);
  ok('矩形有 1 个子路径', p.subpaths.length === 1, `got ${p.subpaths.length}`);
  ok('矩形 4 个点', p.subpaths[0] && p.subpaths[0].pts.length === 8, `got ${p.subpaths[0]?.pts.length / 2}`);
  const [x0, y0, x1, y1] = p.bounds();
  ok('矩形包围盒 = [0,0,1000,1000]', x0 === 0 && y0 === 0 && x1 === 1000 && y1 === 1000,
    JSON.stringify(p.bounds()));
  ok('.notdef 为空路径', glyphFromGlyf(tt, 0, 0).subpaths.length === 0);
}

console.log('\n=== 三角形字形 ===');
{
  const tt = parseTrueType(fontBytes);
  const p = glyphFromGlyf(tt, 2, 0);
  ok('三角形 1 个子路径', p.subpaths.length === 1);
  ok('三角形 3 个点', p.subpaths[0].pts.length === 6, `got ${p.subpaths[0].pts.length / 2}`);
  const [x0, y0, x1, y1] = p.bounds();
  ok('三角形包围盒 = [0,0,800,800]', x0 === 0 && y0 === 0 && x1 === 800 && y1 === 800,
    JSON.stringify(p.bounds()));
}

console.log('\n=== cmap 映射 ===');
{
  const tt = parseTrueType(fontBytes);
  const FontClass = Font;
  // 造一个最小字体字典，用真实文件包装
  const d = new Dict();
  d.set('Subtype', new Name('TrueType'));
  d.set('BaseFont', new Name('TestFont'));
  const desc = new Dict();
  // 必须用真正的 PDFStream 类：decodeStream 内部用 isStream() 做类型判断，
  // 伪造的普通对象会被判为非流，导致字体程序解不出来。
  const ffDict = new Dict();
  ffDict.set('Length', fontBytes.length);
  const ff = new PDFStream(ffDict, fontBytes, 0);
  desc.set('FontFile2', ff);
  d.set('FontDescriptor', desc);
  const f = new FontClass(d, (x) => x);
  ok('Font 识别出 TrueType 表', !!f.tt && !!f.tt.glyf, `tt=${!!f.tt}`);
  ok('cmap 建立成功', f.cmapToGid.size >= 2, `size=${f.cmapToGid.size}`);
  ok("'A' -> gid 1", f.cmapToGid.get(65) === 1, `got ${f.cmapToGid.get(65)}`);
  ok("'B' -> gid 2", f.cmapToGid.get(66) === 2, `got ${f.cmapToGid.get(66)}`);
  ok('gidFor(65) = 1', f.gidFor(65) === 1);
  const gp = f.glyphPath(65);
  ok('glyphPath(A) 得到矩形轮廓', gp.subpaths.length === 1 && gp.subpaths[0].pts.length === 8,
    `subpaths=${gp.subpaths.length} pts=${gp.subpaths[0]?.pts.length / 2}`);
  const [x0, y0, x1, y1] = gp.bounds();
  ok('glyphPath 已归一化到 1000 em', x1 === 1000 && y1 === 1000, JSON.stringify(gp.bounds()));
}

console.log('\n=== Type2 charstring 解释器 ===');
{
  // rmoveto(100,200) rlineto(300,0) rlineto(0,300) rlineto(-300,0) close
  // 编码：139+100=239, 139+200=339, 21(r moveto)
  //       139+300=439, 139+0=139, 5(rlineto)
  //       139+0=139, 139+300=439, 5
  //       139-300: 251..254 形式 -> -(0)*256-... 用 139-300 不行，改用 28 形式或直接算
  function enc(n) {
    if (n >= -107 && n <= 107) return [n + 139];
    if (n > 107 && n < 1130) { const v = n - 108; return [247 + (v >> 8), v & 255]; }
    return [28, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const cs = [...enc(100), ...enc(200), 21,
    ...enc(300), ...enc(0), 5,
    ...enc(0), ...enc(300), 5,
    ...enc(-300), ...enc(0), 5, 14];
  const path = runType2(Uint8Array.from(cs), [], [], 0, 0);
  ok('Type2 生成子路径', path.subpaths.length === 1, `got ${path.subpaths.length}`);
  ok('Type2 矩形 4 个点', path.subpaths[0] && path.subpaths[0].pts.length === 8,
    `got ${path.subpaths[0]?.pts.length / 2}`);
  const [x0, y0, x1, y1] = path.bounds();
  ok('Type2 包围盒正确 [100,200,400,500]',
    x0 === 100 && y0 === 200 && x1 === 400 && y1 === 500, JSON.stringify(path.bounds()));
}

console.log('\n=== 二次贝塞尔字形（off 点）===');
{
  // 全 off 点轮廓（三角形），考验 on/off 配对逻辑
  const g = { contours: [[[0, 0, 0], [500, 0, 0], [0, 500, 0]]] };
  // 手工构造：需要一个 on 点。改为 2 on 1 off
  const g2 = { contours: [[[0, 0, 1], [500, 0, 0], [0, 500, 1]]] };
  const tt = buildFont([{ contours: [] }, g2], [[65, 1]], 2);
  const parsed = parseTrueType(tt);
  const p = glyphFromGlyf(parsed, 1, 0);
  ok('含 off 点的字形产生子路径', p.subpaths.length === 1, `got ${p.subpaths.length}`);
  // 有 off 点时中间会插入隐含点，点数应 > 3
  ok('off 点被展开为曲线点', p.subpaths[0].pts.length / 2 >= 4,
    `got ${p.subpaths[0].pts.length / 2} pts`);
}

console.log(`\n---- font: ${pass} passed, ${fail} failed ----`);
if (fail) process.exit(1);