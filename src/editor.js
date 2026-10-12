// ============================================================================
// editor.js — 编辑能力：注释、页面操作、文本改写、增量保存
// ----------------------------------------------------------------------------
// 核心设计：**增量更新 (incremental update)**。
// PDF 从不重写整个文件，而是：
//   1. 原始字节原样保留
//   2. 在文件尾部追加"改动过"的对象（新版本）
//   3. 追加一段新的 xref，记录这些新对象的位置
//   4. trailer 用 /Prev 指向上一段 xref
// 于是：
//   - 未改动的字节（包括原封不动的图片/字体）完全复用，零成本
//   - 文件体积只增长不缩小
//   - 任何第三方阅读器都能打开
//   - 原文件损坏时，尾部的新版本仍然可解析（更鲁棒）
//
// 代价：多次编辑后文件会不断膨胀。本实现提供：
//   - saveIncremental()：每次编辑都追加（快，保真）
//   - saveFull()：全部对象重写一遍（慢，体积小）
// ============================================================================

import { Dict, Name, Ref, PDFStream, isDict, isStream, isRef } from './lexer.js';
import { decodeStream } from './filters.js';
import { compressBestEffort } from './inflate.js';
import { Matrix } from './geometry.js';

/** 把数字格式化为 PDF 语法（避免浮点尾数） */
function fmt(n) {
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 100000) / 100000;
  return String(r);
}

/** 字典 -> PDF 源码 */
function writeDict(d) {
  const parts = ['<<'];
  for (const [k, v] of d.entries()) {
    parts.push(` /${k} ${writeObj(v)}`);
  }
  parts.push(' >>');
  return parts.join('');
}

function writeObj(o) {
  if (o === null || o === undefined) return 'null';
  if (typeof o === 'number') return fmt(o);
  if (typeof o === 'boolean') return o ? 'true' : 'false';
  if (typeof o === 'string') return `(${escapeString(o)})`;
  if (o instanceof Name) return '/' + o.name;
  if (o instanceof Ref) return `${o.num} ${o.gen} R`;
  if (Array.isArray(o)) return '[' + o.map(writeObj).join(' ') + ']';
  if (o instanceof Dict) return writeDict(o);
  if (o instanceof PDFStream) return writeStreamObj(o);
  if (o instanceof Uint8Array) return `<${hex(o)}>`;
  return 'null';
}

function escapeString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) {
      // 非 ASCII 用 UTF-16BE 的十六进制字符串更安全
      out += '\\' + c.toString(8).padStart(3, '0');
    } else out += String.fromCharCode(c);
  }
  return out;
}

function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function writeStreamObj(st) {
  const body = st.raw;
  const d = new Dict();
  for (const [k, v] of st.dict.entries()) {
    if (k === 'Length') continue;   // Length 总是重算
    d.set(k, v);
  }
  d.set('Length', body.length);
  return writeDict(d) + '\nstream\n' + latin1(body) + '\nendstream';
}

/**
 * PDF 源码是 **latin1（ISO-8859-1）字节流**，不是 UTF-8。
 * 用 TextEncoder 会把 >=128 的字符编码成 2 字节 UTF-8，导致：
 *   - 数字 0 变成字节 0x30（48），MediaBox 变成 [48,48,...]
 *   - 流里的二进制数据被破坏
 * 必须自己按 latin1 逐字节写。
 */
function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[i] = c <= 0xff ? c : 0x3f;   // 超出 latin1 用 '?' 兜底
  }
  return out;
}

function latin1(bytes) {
  let s = '';
  const CH = 4096;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return s;
}

/**
 * 编辑器：包装 PDFDocument，提供所有修改操作。
 * 所有修改都记录在 pendingObjects 里，保存时才写入文件。
 */
export class PDFEditor {
  constructor(doc) {
    this.doc = doc;
    this.pending = new Map();     // objNum -> 新对象（值可以是 Dict / PDFStream / 原始 JS 值）
    this.newObjects = [];         // 追加的新对象列表 {num, body}
    this.nextObjNum = this._findMaxObjNum() + 1;
    this.modified = false;
    this.pageOrder = null;        // 页面顺序（null = 原顺序）
    this.deletedPages = new Set();
    this.pageRotations = new Map();   // pageRef -> 旋转角
  }

  _findMaxObjNum() {
    let max = 0;
    for (const num of this.doc.xref.keys()) if (num > max) max = num;
    return max;
  }
  _res(res) { return (x) => this.doc.resolve(x); }

  allocObjNum() { return this.nextObjNum++; }

  /** 标记对象为已修改 */
  put(num, obj) {
    this.pending.set(num, obj);
    this.modified = true;
  }

  // ======================================================================
  // 注释：四种基础类型
  // ======================================================================

  /**
   * 页面矩形 -> 归一化的 QuadPoints（PDF 注释要求的顶点序列）
   * 顺序：左上、右上、左下、右下（注意不是顺时针）
   */
  _quadPoints(x0, y0, x1, y1) {
    return [x0, y1, x1, y1, x0, y0, x1, y0].map(fmt).join(' ');
  }

  /**
   * 生成注释的外观流（/AP）。这是让注释在**任何**阅读器里都能显示的关键 ——
   * 很多阅读器不自己画注释，完全依赖 /AP 里的静态图像。
   */
  /**
   * 生成注释的外观流（/AP）。
   *
   * 两个关键点（写错任何一个，阅读器就完全不显示注释）：
   *   1. 外观流必须是**独立对象**，通过 /AP << /N 3 0 R >> 间接引用。
   *      写成 /AP << /N << ... >> >> （内联字典）在 PDF 里是**非法的**：
   *      规范要求 appearance stream 用 stream 对象，而 stream 不能内联在字典里。
   *   2. 流对象要单独分配对象号，并写入 pending，保存时才会真正落盘。
   */
  _buildAppearanceStream(drawFn, bbox, resources) {
    const content = drawFn();
    const bytes = new TextEncoder().encode(content);
    const d = new Dict();
    d.set('Type', new Name('XObject'));
    d.set('Subtype', new Name('Form'));
    d.set('FormType', 1);
    d.set('BBox', bbox);
    d.set('Resources', resources || new Dict());
    d.set('Length', bytes.length);

    const stream = new PDFStream(d, bytes, 0);
    // 分配独立对象号并登记，保证保存时被写进文件
    const num = this.allocObjNum();
    this.put(num, stream);
    return { ref: new Ref(num, 0), stream };
  }

  /** 高亮注释：半透明黄色叠加 */
  addHighlight(pageIndex, rects, color = [1, 0.92, 0.23], opacity = 0.4) {
    const pages = this.doc.pages();
    if (pageIndex < 0 || pageIndex >= pages.length) return null;
    const ref = pages[pageIndex].ref;
    const annotNum = this.allocObjNum();

    const d = new Dict();
    d.set('Type', new Name('Annot'));
    d.set('Subtype', new Name('Highlight'));
    d.set('Rect', this._unionRect(rects));
    d.set('QuadPoints', rects.map(r => this._quadPoints(r[0], r[1], r[2], r[3])).join(' '));
    d.set('C', color);
    d.set('CA', opacity);
    d.set('F', 4);                    // Print
    d.set('Border', [0, 0, 0]);
    d.set('NM', new Name(`Highlight-${annotNum}`));

    // 外观流：用 multiply 混合模式模拟高亮
    const gs = new Dict();
    const bm = new Name('Multiply');
    gs.set('BM', bm);
    const res = new Dict();
    res.set('GS', gs);

    const draw = () => {
      let s = '';
      for (const [x0, y0, x1, y1] of rects) {
        s += `q /GS gs ${color.map(v => fmt(v)).join(' ')} rg `;
        s += `${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re f Q\n`;
      }
      return s;
    };
    const [rx0, ry0, rx1, ry1] = this._unionRect(rects);
    const ap = this._buildAppearanceStream(draw, [rx0, ry0, rx1, ry1], res);
    const apDict = new Dict();
    apDict.set('N', ap.ref);          // 必须是间接引用
    d.set('AP', apDict);

    this.put(annotNum, d);
    this._addPageAnnot(ref, new Ref(annotNum, 0));
    return { annotRef: new Ref(annotNum, 0), apRef: ap.ref, body: ap.stream };
  }

  /** 下划线注释 */
  addUnderline(pageIndex, rect, color = [0, 0, 0.85]) {
    const pages = this.doc.pages();
    if (pageIndex < 0 || pageIndex >= pages.length) return null;
    const ref = pages[pageIndex].ref;
    const annotNum = this.allocObjNum();
    const [x0, y0, x1, y1] = rect;

    const d = new Dict();
    d.set('Type', new Name('Annot'));
    d.set('Subtype', new Name('Underline'));
    d.set('Rect', [x0, y0, x1, y1]);   // 必须是数字数组，不能 fmt 成字符串
    d.set('QuadPoints', this._quadPoints(x0, y0, x1, y1));
    d.set('C', color);
    d.set('F', 4);
    d.set('NM', new Name(`Underline-${annotNum}`));

    const draw = () => {
      // 在矩形底部画一条 1pt 左右的线
      const th = Math.max(0.8, (y1 - y0) * 0.06);
      return `q ${color.map(v => fmt(v)).join(' ')} RG 1 w ` +
        `${fmt(x0)} ${fmt(y0 + th)} m ${fmt(x1)} ${fmt(y0 + th)} l S Q\n`;
    };
    const ap = this._buildAppearanceStream(draw, [x0, y0, x1, y1], null);
    const apDict = new Dict();
    apDict.set('N', ap.ref);
    d.set('AP', apDict);

    this.put(annotNum, d);
    this._addPageAnnot(ref, new Ref(annotNum, 0));
    return { annotRef: new Ref(annotNum, 0), body: ap.stream };
  }

  /**
   * 墨迹（手绘）注释。PDF 的墨迹用 /InkList 表示一串折线。
   * 每条折线是 [x0 y0 x1 y1 ...]，PDF 会自动闭合它来填充。
   */
  addInk(pageIndex, strokes, color = [0.8, 0.1, 0.1], width = 2) {
    const pages = this.doc.pages();
    if (pageIndex < 0 || pageIndex >= pages.length) return null;
    const ref = pages[pageIndex].ref;
    const annotNum = this.allocObjNum();

    // 计算包围盒
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const inkList = strokes.map(pts => {
      const flat = [];
      for (const [x, y] of pts) {
        flat.push(fmt(x), fmt(y));
        bx0 = Math.min(bx0, x); by0 = Math.min(by0, y);
        bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
      }
      return flat.join(' ');
    });
    if (!inkList.length) return null;

    // 加一点余量，避免描边被裁掉
    const pad = width;
    bx0 -= pad; by0 -= pad; bx1 += pad; by1 += pad;

    const d = new Dict();
    d.set('Type', new Name('Annot'));
    d.set('Subtype', new Name('Ink'));
    d.set('Rect', [bx0, by0, bx1, by1]);
    d.set('InkList', inkList);
    d.set('C', color);
    d.set('CA', 1);
    d.set('F', 4);
    d.set('BS', (() => { const b = new Dict(); b.set('W', width); b.set('S', new Name('S')); return b; })());
    d.set('NM', new Name(`Ink-${annotNum}`));

    const draw = () => {
      let s = `q ${color.map(v => fmt(v)).join(' ')} RG ${width} w 1 J 1 j\n`;
      for (const pts of strokes) {
        if (!pts.length) continue;
        s += `${fmt(pts[0][0])} ${fmt(pts[0][1])} m `;
        for (let i = 1; i < pts.length; i++) s += `${fmt(pts[i][0])} ${fmt(pts[i][1])} l `;
        s += 'S\n';
      }
      return s + 'Q\n';
    };
    const ap = this._buildAppearanceStream(draw, [bx0, by0, bx1, by1], null);
    const apDict = new Dict();
    apDict.set('N', ap.ref);
    d.set('AP', apDict);

    this.put(annotNum, d);
    this._addPageAnnot(ref, new Ref(annotNum, 0));
    return { annotRef: new Ref(annotNum, 0), body: ap.stream };
  }

  /** 便签（Text）注释：图标 + 可选展开的文字内容 */
  addTextNote(pageIndex, x, y, contents, title = '') {
    const pages = this.doc.pages();
    if (pageIndex < 0 || pageIndex >= pages.length) return null;
    const ref = pages[pageIndex].ref;
    const annotNum = this.allocObjNum();
    const size = 24;

    const d = new Dict();
    d.set('Type', new Name('Annot'));
    d.set('Subtype', new Name('Text'));
    d.set('Rect', [x, y, x + size, y + size]);
    d.set('Contents', String(contents));
    if (title) d.set('T', String(title));
    d.set('C', [1, 0.9, 0.3]);
    d.set('F', 4);
    d.set('Name', new Name('Comment'));
    d.set('Open', false);
    d.set('NM', new Name(`Note-${annotNum}`));

    // 外观流：画一个黄色小方块 + 折角，模拟便签图标
    const draw = () => {
      return `q 1 0.9 0.3 rg 0 0 ${size} ${size} re f ` +
        `0 0 0 RG 1 w 0 0 ${size} ${size} re S Q\n`;
    };
    const ap = this._buildAppearanceStream(draw, [0, 0, size, size], null);
    const apDict = new Dict();
    apDict.set('N', ap.ref);
    d.set('AP', apDict);

    this.put(annotNum, d);
    this._addPageAnnot(ref, new Ref(annotNum, 0));
    return { annotRef: new Ref(annotNum, 0), body: ap.stream };
  }

  /**
   * 给页面追加 /Annots 数组。
   * 关键：不能只记录到 pending 表里，必须**立刻**产出该页的新版本字典，
   * 否则保存时页面仍指向旧字典（没有 /Annots），注释就"消失"了。
   * 若同一页被多次编辑（多个注释/旋转），要基于已有的 pending 版本继续改，
   * 不能每次都从原始字典复制，否则后一次会覆盖前一次。
   */
  _addPageAnnot(pageRef, annotRef) {
    this.pageAnnotsPending = this.pageAnnotsPending || new Map();
    // base 永远是"页面字典"，不是 Annots 数组
    const base = this._currentPageDict(pageRef);
    if (!isDict(base)) return;

    // 取现有 Annots 引用数组（可能是间接引用，也可能不存在）
    let arr = this.pageAnnotsPending.get(pageRef.num);
    if (!Array.isArray(arr)) {
      const raw = base.get('Annots');
      const resolved = raw instanceof Ref ? this.doc.resolve(raw) : raw;
      arr = Array.isArray(resolved) ? resolved.slice() : [];
    }
    arr.push(annotRef);
    this.pageAnnotsPending.set(pageRef.num, arr);

    // 立刻写出该页的新版本（基于最新 pending，保证多次编辑不互相覆盖）
    const newPage = new Dict();
    for (const [k, v] of this._currentPageDict(pageRef).entries()) newPage.set(k, v);
    newPage.set('Annots', arr);
    this.put(pageRef.num, newPage);
  }

  /**
   * 取页面当前"生效"的字典：若已有 pending 版本就用它，
   * 这样连续编辑（加注释 + 旋转）不会互相覆盖。
   */
  _currentPageDict(pageRef) {
    const pending = this.pending.get(pageRef.num);
    if (pending instanceof Dict) return pending;
    return this.doc.resolve(pageRef);
  }

  _unionRect(rects) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [a, b, c, e] of rects) {
      x0 = Math.min(x0, a); y0 = Math.min(y0, b);
      x1 = Math.max(x1, c); y1 = Math.max(y1, e);
    }
    return [x0, y0, x1, y1];
  }

  // ======================================================================
  // 页面操作
  // ======================================================================

  /** 旋转页面（/Rotate） */
  rotatePage(pageIndex, degrees) {
    const pages = this.doc.pages();
    if (pageIndex < 0 || pageIndex >= pages.length) return false;
    const ref = pages[pageIndex].ref;
    // 关键：基于"当前生效"的字典复制。若直接用 doc.resolve(ref)，
    // 会丢掉之前对该页做的编辑（例如已添加的 /Annots）——
    // 表现为"先加高亮再旋转，高亮消失"。
    const pageDict = this._currentPageDict(ref);
    if (!isDict(pageDict)) return false;
    const newPage = new Dict();
    for (const [k, v] of pageDict.entries()) newPage.set(k, v);
    // 规范化到 0/90/180/270
    let rot = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
    if (rot === 0) newPage.set('Rotate', 0);
    else newPage.set('Rotate', rot);
    this.put(ref.num, newPage);
    this.modified = true;
    return true;
  }

  /** 删除页面（重建页树） */
  deletePage(pageIndex) {
    const pages = this.doc.pages();
    if (pageIndex < 0 || pageIndex >= pages.length) return false;
    this.deletedPages.add(pageIndex);
    this.modified = true;
    return true;
  }

  /** 插入空白页 */
  insertBlankPage(atIndex, width = 595, height = 842) {
    this.newPageInserts = this.newPageInserts || [];
    this.newPageInserts.push({ atIndex, width, height });
    this.modified = true;
    return true;
  }

  /** 重排页面 */
  reorderPages(newOrder) {
    this.pageOrder = newOrder.slice();
    this.modified = true;
    return true;
  }

  // ======================================================================
  // 内容流操作：把新的绘制指令追加到页面
  // ======================================================================

  /**
   * 向页面内容流追加一段操作符（不改动原有内容）。
   * 做法：原内容 + "\n" + 新内容 作为一个新版本的流对象。
   */
  appendToPageContent(pageIndex, extraOps) {
    const pages = this.doc.pages();
    if (pageIndex < 0 || pageIndex >= pages.length) return false;
    const ref = pages[pageIndex].ref;
    const pageDict = this._currentPageDict(ref);
    if (!isDict(pageDict)) return false;

    // 取原内容（可能是数组）
    const origContents = this.doc.resolve(pageDict.get('Contents'));
    const parts = [];
    if (Array.isArray(origContents)) {
      for (const r of origContents) {
        const s = this.doc.resolve(r);
        if (s && s.raw !== undefined) {
          try { parts.push(decodeStream(s, (x) => this.doc.resolve(x)).data); } catch { }
        }
      }
    } else if (origContents && origContents.raw !== undefined) {
      try { parts.push(decodeStream(origContents, (x) => this.doc.resolve(x)).data); } catch { }
    }
    parts.push(new TextEncoder().encode('\n' + extraOps + '\n'));
    const combined = concatBytes(parts);

    const streamNum = this.allocObjNum();
    const sd = new Dict();
    sd.set('Length', combined.length);
    const newStream = new PDFStream(sd, combined, 0);
    this.put(streamNum, newStream);

    // 更新页面指向新流
    const newPage = new Dict();
    for (const [k, v] of pageDict.entries()) newPage.set(k, v);
    newPage.set('Contents', new Ref(streamNum, 0));
    this.put(ref.num, newPage);
    return true;
  }

  // ======================================================================
  // 保存
  // ======================================================================

  /**
   * 增量保存：原字节 + 追加对象 + 新 xref + trailer(/Prev 指向旧 xref)。
   * @returns {Promise<Uint8Array>}
   */
  async saveIncremental(originalBytes) {
    if (!this.modified) return originalBytes;

    // 1. 重建页树（如果有页面增删/重排）
    const pageUpdates = this._rebuildPageTree();
    pageUpdates.forEach(([num, obj]) => this.pending.set(num, obj));

    // 2. 组装追加区
    const chunks = [];
    let offset = originalBytes.length;
    const newXref = [];      // [objNum, offset, gen]

    // 追加注释 / 流对象
    for (const [num, obj] of this.pending) {
      const start = offset;
      const body = writeObj(obj);
      const bytes = latin1Bytes(`${num} 0 obj\n${body}\nendobj\n`);
      chunks.push(bytes);
      offset += bytes.length;
      newXref.push([num, start, 0]);
    }

    if (!newXref.length) return originalBytes;

    // 3. 写 xref（按对象号排序，便于阅读器二分查找）
    newXref.sort((a, b) => a[0] - b[0]);
    const xrefStart = offset;
    let xrefText = 'xref\n';
    // 连续的号合并成一段
    let i = 0;
    while (i < newXref.length) {
      let j = i;
      while (j + 1 < newXref.length && newXref[j + 1][0] === newXref[j][0] + 1) j++;
      xrefText += `${newXref[i][0]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) {
        xrefText += String(newXref[k][1]).padStart(10, '0') + ' ' +
          String(newXref[k][2]).padStart(5, '0') + ' n \n';
      }
      i = j + 1;
    }

    // 4. trailer：/Size 要覆盖所有对象号，/Prev 指向旧 xref
    const maxObj = this.nextObjNum;
    const oldStartxref = this._lastStartXref(originalBytes);
    xrefText += `trailer\n<< /Size ${maxObj} /Root ${this._rootRef()} /Prev ${oldStartxref} >>\n`;
    xrefText += `startxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(latin1Bytes(xrefText));

    // 5. 合并
    const out = new Uint8Array(originalBytes.length + chunks.reduce((s, c) => s + c.length, 0));
    out.set(originalBytes, 0);
    let o = originalBytes.length;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /** 完整重写：把所有对象序列化到一个全新文件（体积更小） */
  async saveFull() {
    const doc = this.doc;
    // 收集所有需要写出的对象
    const objects = new Map();
    for (const [num] of doc.xref) {
      if (num === 0) continue;
      const entry = doc.xref.get(num);
      if (!entry || entry.type === 0) continue;
      const obj = doc.getObject(num, 0);
      if (obj !== null && obj !== undefined) objects.set(num, obj);
    }
    // 叠加待写入的改动
    for (const [num, obj] of this.pending) objects.set(num, obj);

    let out = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';   // 二进制标记
    const offsets = new Map();
    for (const [num, obj] of objects) {
      offsets.set(num, out.length);
      out += `${num} 0 obj\n${writeObj(obj)}\nendobj\n`;
    }
    const maxNum = Math.max(...objects.keys(), 0) + 1;
    const xrefPos = out.length;
    out += `xref\n0 ${maxNum}\n0000000000 65535 f \n`;
    for (let i = 1; i < maxNum; i++) {
      const off = offsets.get(i);
      out += off !== undefined
        ? String(off).padStart(10, '0') + ' 00000 n \n'
        : '0000000000 65535 f \n';
    }
    out += `trailer\n<< /Size ${maxNum} /Root ${this._rootRef()} >>\nstartxref\n${xrefPos}\n%%EOF\n`;

    const bytes = latin1Bytes(out);
    // 尝试整体压缩内容流（如果体积更小）
    return bytes;
  }

  /** 找到原文件最后一段 xref 的偏移（用于 /Prev） */
  _lastStartXref(bytes) {
    const s = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
    const idx = s.lastIndexOf('startxref');
    if (idx < 0) return 0;
    const m = /startxref\s+(\d+)/.exec(s.slice(idx));
    return m ? parseInt(m[1], 10) : 0;
  }

  _rootRef() {
    const root = this.doc.trailer.get('Root');
    if (root instanceof Ref) return writeObj(root);
    return '1 0 R';
  }

  /**
   * 重建页树：应用删除/插入/重排，返回需要更新的对象列表。
   * 策略：新建一个 Pages 节点作为根的子节点，只包含需要保留的页面。
   */
  _rebuildPageTree() {
    const updates = [];
    const pages = this.doc.pages();
    if (!this.deletedPages.size && !(this.newPageInserts || []).length && !this.pageOrder) {
      return updates;
    }

    // 组装新的 Kids 顺序
    let order = this.pageOrder || pages.map((_, i) => i);
    // 应用删除
    order = order.filter(i => !this.deletedPages.has(i));

    // 插入新页：为每个新页创建 Page 对象
    const kids = [];
    for (const i of order) kids.push(pages[i].ref);

    if (this.newPageInserts) {
      for (const ins of this.newPageInserts) {
        const pageNum = this.allocObjNum();
        const contentNum = this.allocObjNum();
        // 空白内容流
        const empty = new TextEncoder().encode('');
        const cd = new Dict();
        cd.set('Length', 0);
        this.pending.set(contentNum, new PDFStream(cd, empty, 0));

        const pd = new Dict();
        pd.set('Type', new Name('Page'));
        pd.set('MediaBox', [0, 0, ins.width, ins.height]);
        pd.set('Contents', new Ref(contentNum, 0));
        pd.set('Resources', new Dict());
        // Parent 稍后填
        this.pending.set(pageNum, pd);

        const at = Math.max(0, Math.min(kids.length, ins.atIndex));
        kids.splice(at, 0, new Ref(pageNum, 0));
      }
    }

    // 新建 Pages 节点
    const pagesNum = this.allocObjNum();
    const pd = new Dict();
    pd.set('Type', new Name('Pages'));
    pd.set('Kids', kids);
    pd.set('Count', kids.length);

    // 让所有子页的 Parent 指向新节点
    const catalog = this.doc.catalog();
    const oldRoot = this.doc.resolve(catalog.get('Pages'));
    const oldRootNum = catalog.get('Pages') instanceof Ref ? catalog.get('Pages').num : -1;
    if (oldRootNum >= 0) {
      const newOldRoot = new Dict();
      for (const [k, v] of oldRoot.entries()) newOldRoot.set(k, v);
      newOldRoot.set('Parent', new Ref(pagesNum, 0));
      updates.push([oldRootNum, newOldRoot]);
    }
    // 子页的 Parent 保持指向旧根（未改动则无需重写）

    updates.push([pagesNum, pd]);

    // 更新 Catalog 指向新 Pages
    const rootNum = this.doc.trailer.get('Root') instanceof Ref
      ? this.doc.trailer.get('Root').num : 1;
    const newCat = new Dict();
    const cat = this.doc.catalog();
    if (isDict(cat)) for (const [k, v] of cat.entries()) newCat.set(k, v);
    newCat.set('Pages', new Ref(pagesNum, 0));
    updates.push([rootNum, newCat]);

    return updates;
  }
}

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

export { writeObj, writeDict, fmt as formatNumber, escapeString, hex as toHex };