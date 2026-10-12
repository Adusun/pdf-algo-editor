// ============================================================================
// font.js — 字体引擎：TrueType 轮廓 / CFF-Type2 解释器 / 编码映射
// ----------------------------------------------------------------------------
// 三重映射（缺一不可）：
//   1. 内容流字节 --Encoding--> Unicode
//   2. Unicode --cmap--> gid（字体内置索引表）
//   3. gid --loca/glyf 或 CharStrings--> 轮廓路径
// 另有反向表 ToUnicode（gid → Unicode），用于文字提取/搜索。
//
// 这里实现最常用的一条完整链路：
//   - TrueType (glyf/loca)，含复合字形
//   - OpenType CFF (CFF 表 + Type2 charstring 解释器)
//   - 简单字体(Type1)的 Encoding /Differences
//   - ToUnicode CMap (bfchar / bfrange)
// ============================================================================

import { Path, Matrix } from './geometry.js';
import { decodeStream } from './filters.js';
import { isStream, isDict } from './lexer.js';

/** 大端读取器（TrueType 表全是 big-endian） */
class BE {
  constructor(bytes, offset = 0) { this.b = bytes; this.p = offset; }
  u8() { return this.b[this.p++]; }
  i8() { const v = this.b[this.p++]; return v > 127 ? v - 256 : v; }
  u16() { const v = (this.b[this.p] << 8) | this.b[this.p + 1]; this.p += 2; return v; }
  i16() { const v = this.u16(); return v > 32767 ? v - 65536 : v; }
  /**
   * 32 位无符号。必须用乘法而不是 << 移位：
   * << 会产生有符号 32 位结果，0xFFFFFFFF 会变成 -1，
   * 后续做 subarray(off, off+len) 时算出负偏移，导致整张表读错位置。
   */
  u32() {
    const b = this.b;
    const v = b[this.p] * 0x1000000 + (b[this.p + 1] << 16) +
      (b[this.p + 2] << 8) + b[this.p + 3];
    this.p += 4;
    return v >>> 0;
  }
  tag() {
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.b[this.p++]);
    return s;
  }
}

/**
 * 简单字体 + 字体的公共封装。
 * 对外暴露：
 *   decode(bytes)      -> 字符码 -> Unicode
 *   glyphPath(code)    -> 该字符的轮廓（用户空间坐标）
 *   charWidth(code)    -> 前进宽度（1/1000 em）
 *   toUnicode(code)    -> 字符码 -> Unicode 字符串
 */
export class Font {
  constructor(dict, resolve) {
    this.dict = dict;
    this.resolve = resolve;
    this.subtype = this._name(dict.get('Subtype'));
    this.baseFont = this._name(dict.get('BaseFont')) || 'Unknown';
    this.type0 = false;
    this.cidFont = false;
    this.tt = null;        // TrueType 解析结果
    this.cff = null;       // CFF 解析结果
    this.widths = null;    // 字符码 -> 宽度
    this.defaultWidth = 500;
    this.toUniMap = new Map();
    this.encodingMap = new Map();
    this.cmapToGid = new Map();
    this._glyphCache = new Map();
    this._load();
  }

  _name(v) { return v && typeof v === 'object' && 'name' in v ? v.name : (typeof v === 'string' ? v : null); }

  _load() {
    const d = this.dict;
    // ---- 字体程序 ----
    const isCID = this._name(d.get('Type')) === 'CIDFontType0' ||
      this._name(d.get('Type')) === 'CIDFontType2';
    let descendant = d;
    if (this.subtype === 'Type0') {
      this.type0 = true;
      this.cidFont = true;
      descendant = this.resolve(d.get('DescendantFonts'));
      descendant = Array.isArray(descendant) ? this.resolve(descendant[0]) : descendant;
      if (!isDict(descendant)) descendant = new Map();
      this.descendantDict = descendant;
    }

    // 加载内嵌字体程序
    const fp = this.resolve(descendant.get('FontDescriptor') || d.get('FontDescriptor'));
    const fontFileKey = isCID
      ? (this._name(descendant.get('Subtype')) === 'CIDFontType0' ? 'FontFile3' : 'FontFile2')
      : (this.subtype === 'Type1' ? 'FontFile' : 'FontFile2');
    let fontStream = null;
    if (isDict(fp)) {
      const ff = this.resolve(fp.get(fontFileKey)) || this.resolve(fp.get('FontFile3')) ||
        this.resolve(fp.get('FontFile2')) || this.resolve(fp.get('FontFile'));
      if (isStream(ff)) {
        try {
          const dec = decodeStream(ff, (x) => this.resolve(x));
          // 若剩余的是图像/JBIG2 滤镜，说明我们无法解出轮廓
          if (dec.remainingFilters.length === 0) fontStream = dec.data;
        } catch { /* 忽略 */ }
      }
    }
    if (fontStream) {
      this._parseFontProgram(fontStream);
    }

    // ---- CID 字体的 DW / W 宽度 ----
    if (this.cidFont) {
      this.defaultWidth = Number(this.resolve(descendant.get('DW'))) || 1000;
      const W = this.resolve(descendant.get('W'));
      this.widths = this._parseCidWidths(W);
      this.cidToGid = this.resolve(descendant.get('CIDToGIDMap'));
    } else {
      this._parseSimpleWidths();
      this._parseEncoding();
      this._parseToUnicode();
    }
    if (this.cff && !this.cmapToGid.size) this._buildIdentityCmap();
    if (!this.cmapToGid.size && this.tt) this._buildCmapFromFont();
  }

  /** 解析内嵌字体程序：TrueType 还是 CFF */
  _parseFontProgram(bytes) {
    const r = new BE(bytes);
    let tag;
    try { tag = r.u32(); } catch { return; }
    // sfnt 版本：0x00010000 (TrueType) / 'OTTO' (CFF) / 'true' / 'ttcf'
    if (tag === 0x00010000 || tag === 0x74727565 /*true*/ || tag === 0x74746366 /*ttcf*/) {
      this.tt = parseTrueType(bytes);
      if (this.tt && this.tt.hasCFF) {
        this.cff = parseCFF(this.tt.cffData);
      }
    } else if (tag === 0x4f54544f /*OTTO*/) {
      // OTTO: 直接从 sfnt 目录找 CFF 表
      const numTables = r.u16();
      r.p = 12;
      for (let i = 0; i < numTables; i++) {
        r.p = 12 + i * 16;
        const t = r.tag();
        const off = r.u32(), len = r.u32();
        if (t === 'CFF ') this.cff = parseCFF(bytes.subarray(off, off + len));
        else if (t === 'glyf') { /* CFF OpenType 通常没有 glyf */ }
      }
    } else {
      // 可能是裸 CFF（Type1E / 某些 PDF 直接嵌 CFF）
      try { this.cff = parseCFF(bytes); } catch { /* ignore */ }
    }
  }

  /** 简单字体宽度数组：/FirstChar 起，/Widths[i] 对应字符码 FirstChar+i */
  _parseSimpleWidths() {
    const start = Number(this.resolve(this.dict.get('FirstChar'))) || 0;
    const ws = this.resolve(this.dict.get('Widths'));
    if (Array.isArray(ws)) {
      this.widths = new Map();
      for (let i = 0; i < ws.length; i++) {
        const w = Number(this.resolve(ws[i]));
        if (isFinite(w)) this.widths.set(start + i, w);
      }
    }
    const desc = this.resolve(this.dict.get('FontDescriptor'));
    if (isDict(desc)) {
      const mw = Number(this.resolve(desc.get('MissingWidth')));
      if (isFinite(mw)) this.defaultWidth = mw;
    }
  }

  /** CID 字体 /W 数组：[c [w1 w2 ...] | cfirst clast w] ... */
  _parseCidWidths(W) {
    const map = new Map();
    if (!Array.isArray(W)) return map;
    let i = 0;
    while (i < W.length) {
      const a = Number(this.resolve(W[i]));
      if (!isFinite(a)) break;
      const next = this.resolve(W[i + 1]);
      if (Array.isArray(next)) {
        for (let k = 0; k < next.length; k++) {
          const w = Number(this.resolve(next[k]));
          if (isFinite(w)) map.set(a + k, w);
        }
        i += 2;
      } else {
        const b = Number(this.resolve(W[i + 1]));
        const w = Number(this.resolve(W[i + 2]));
        if (isFinite(b) && isFinite(w)) for (let c = a; c <= b && c - a < 65536; c++) map.set(c, w);
        i += 3;
      }
    }
    return map;
  }

  /** 简单字体 /Encoding：基表 + /Differences */
  _parseEncoding() {
    const enc = this.resolve(this.dict.get('Encoding'));
    // 默认基表：按 BaseFont 猜 StandardEncoding 还是 WinAnsi
    const baseName = this.baseFont || '';
    const isSymbol = baseName.includes('Symbol');
    const tableName = isSymbol ? null : 'WinAnsiEncoding';
    const table = STANDARD_ENCODINGS[tableName] || STANDARD_ENCODINGS['StandardEncoding'];
    for (let c = 0; c < 256; c++) {
      const u = table[c];
      if (u) this.encodingMap.set(c, u);
    }
    if (isDict(enc)) {
      const be = this.resolve(enc.get('BaseEncoding'));
      const base = this._name(be);
      if (base && STANDARD_ENCODINGS[base]) {
        for (let c = 0; c < 256; c++) {
          const u = STANDARD_ENCODINGS[base][c];
          if (u) this.encodingMap.set(c, u);
        }
      }
      const diffs = this.resolve(enc.get('Differences'));
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const item of diffs) {
          const v = this.resolve(item);
          if (typeof v === 'number') code = Math.round(v);
          else {
            const n = this._name(v);
            if (n) {
              const u = GLYPH_TO_UNICODE[n] || (n.length === 1 ? n.charCodeAt(0) : 0);
              if (u) this.encodingMap.set(code, u);
              else this.encodingMap.set(code, null); // 明确无 Unicode 映射
              code++;
            }
          }
        }
      }
    }
  }

  /** 解析 ToUnicode CMap：bfchar 与 bfrange */
  _parseToUnicode() {
    let tu = this.resolve(this.dict.get('ToUnicode'));
    if (!isStream(tu)) {
      const desc = this.resolve(this.dict.get('FontDescriptor'));
      if (isDict(desc)) tu = this.resolve(desc.get('ToUnicode'));
    }
    if (!isStream(tu)) return;
    let text;
    try { text = latin1(decodeStream(tu, (x) => this.resolve(x)).data); } catch { return; }
    // bfchar
    const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let m;
    while ((m = charRe.exec(text))) {
      const body = m[1];
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let c;
      while ((c = re.exec(body))) {
        const src = parseInt(c[1], 16);
        const dstHex = c[2];
        // 目标可能是 2 字节（CID）或 4 字节（UTF-16BE）
        const dst = hexToUtf16(dstHex);
        this.toUniMap.set(src, dst);
      }
    }
    // bfrange
    const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = rangeRe.exec(text))) {
      const body = m[1];
      // 形式1: <lo> <hi> <dstStart>
      const re1 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let c;
      while ((c = re1.exec(body))) {
        const lo = parseInt(c[1], 16), hi = parseInt(c[2], 16);
        const dstHex = c[3];
        const dstLen = dstHex.length;
        const base = dstLen <= 2 ? parseInt(dstHex, 16)
          : dstLen <= 4 ? parseInt(dstHex, 16)
            : parseInt(dstHex.slice(0, 4), 16);
        const isUnicodeDst = dstLen > 4;
        for (let k = 0; k <= hi - lo && k < 65536; k++) {
          if (isUnicodeDst) {
            const cp = base + k;
            this.toUniMap.set(lo + k, String.fromCharCode(cp));
          } else {
            this.toUniMap.set(lo + k, String.fromCharCode(base + k));
          }
        }
      }
      // 形式2: <lo> <hi> [ <d1> <d2> ... ]
      const re2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
      while ((c = re2.exec(body))) {
        const lo = parseInt(c[1], 16);
        const items = c[3].match(/<([0-9A-Fa-f]+)>/g) || [];
        items.forEach((it, k) => {
          this.toUniMap.set(lo + k, hexToUtf16(it.slice(1, -1)));
        });
      }
    }
  }

  /** CID 字体默认：CID 直接当 gid 用 */
  _buildIdentityCmap() {
    if (this.cidFont) {
      const c2g = this.cidToGid;
      if (c2g instanceof Uint8Array) {
        // 2 字节 CID -> gid 表
        for (let cid = 0; cid < c2g.length / 2; cid++) {
          this.cmapToGid.set(cid, (c2g[cid * 2] << 8) | c2g[cid * 2 + 1]);
        }
      }
    }
  }

  /** 从 TrueType 的 cmap 子表建立 Unicode -> gid */
  _buildCmapFromFont() {
    if (!this.tt || !this.tt.cmap) return;
    const off = pickCmapSubtableOffset(this.tt.cmap);
    if (off < 0) return;
    for (const [u, gid] of parseCmapSubtableAt(this.tt.cmap, off)) this.cmapToGid.set(u, gid);
  }

  // ---- 对外接口 ----

  /**
   * 把内容流里的字节串解码为字符数组。
   * 返回 [{ code, bytes, unicode }]，code 是用于查字形的字符码
   * （单字节字体=字节值，Identity-H=2字节 gid）。
   */
  decode(bytes) {
    const out = [];
    if (this.type0) {
      // Identity-H/V: 2 字节一个字符码
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes[i] << 8) | bytes[i + 1];
        out.push({ code, bytes: [bytes[i], bytes[i + 1]], unicode: this.toUnicode(code) });
      }
    } else {
      for (let i = 0; i < bytes.length; i++) {
        const code = bytes[i];
        out.push({ code, bytes: [bytes[i]], unicode: this.toUnicode(code) });
      }
    }
    return out;
  }

  /** 字符码 -> Unicode 字符串（优先 ToUnicode，其次 Encoding）
   *  必须返回字符串：encodingMap 存的是码点数字，直接返回会让调用方
   *  拿到 number 而在 .trim()/.charCodeAt() 处炸掉。 */
  toUnicode(code) {
    if (this.toUniMap.size) {
      const u = this.toUniMap.get(code);
      if (u !== undefined) return String(u);
    }
    if (this.encodingMap.has(code)) {
      const u = this.encodingMap.get(code);
      if (u === null || u === undefined) return '';
      return typeof u === 'number' ? String.fromCharCode(u) : String(u);
    }
    if (!this.type0 && code >= 32 && code < 127) return String.fromCharCode(code);
    return '';
  }

  /** 字符码 -> 前进宽度（1/1000 em） */
  charWidth(code) {
    if (this.widths) {
      const w = this.widths.get(code);
      if (isFinite(w)) return w;
    }
    return this.defaultWidth;
  }

  /** 字符码 -> 字形编号 gid */
  gidFor(code) {
    if (this.type0) {
      if (this.cidFont) {
        if (this.cmapToGid.size && this.cmapToGid.has(code)) return this.cmapToGid.get(code);
        return code; // Identity
      }
      const u = this.encodingMap.get(code);
      if (u != null) {
        const g = this.cmapToGid.get(u);
        if (g !== undefined) return g;
      }
      return code;
    }
    const u = this.encodingMap.get(code);
    if (u != null) {
      const g = this.cmapToGid.get(u);
      if (g !== undefined) return g;
    }
    return code;
  }

  /**
   * 取出字形轮廓路径（未做字体变换，单位是 1/1000 em）。
   * 返回 Path 或 null（空白字形如空格返回空路径）。
   */
  glyphPath(code) {
    const gid = this.gidFor(code);
    if (this._glyphCache.has(gid)) return this._glyphCache.get(gid);
    let p = null;
    try {
      if (this.cff && this.cff.glyphs && this.cff.glyphs[gid]) {
        p = this.cff.glyphs[gid];
      } else if (this.tt && this.tt.glyf) {
        p = glyphFromGlyf(this.tt, gid, 0);
      }
    } catch { p = null; }
    if (!p) p = new Path();
    // 归一化到 1000 em 单位
    const scale = 1000 / (this.unitsPerEm || 1000);
    if (scale !== 1) {
      p.transform(new Matrix(scale, 0, 0, scale, 0, 0));
    }
    this._glyphCache.set(gid, p);
    return p;
  }
}

// ---------------------------------------------------------------------------
// TrueType 解析
// ---------------------------------------------------------------------------
export function parseTrueType(bytes) {
  const r = new BE(bytes);
  r.u32();                        // sfnt version
  const numTables = r.u16();
  r.u16(); r.u16(); r.u16();      // searchRange / entrySelector / rangeShift
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    // 表目录项固定 16 字节：tag(4) + checkSum(4) + offset(4) + length(4)
    // 漏读 checkSum 会导致 offset 被当成 length，subarray 越界读出错乱数据。
    r.p = 12 + i * 16;
    const tag = r.tag();
    r.u32();                      // checkSum（不做校验）
    const off = r.u32();
    const len = r.u32();
    if (off > bytes.length) continue;
    tables[tag] = bytes.subarray(off, Math.min(bytes.length, off + len));
  }
  const head = tables['head'];
  let unitsPerEm = 1000;
  let indexToLocFormat = 0;
  let numGlyphs = 0;
  if (head && head.length >= 54) {
    // head 表字段偏移（TrueType spec）：
    //   18-19 unitsPerEm      42-43 indexToLocFormat
    // 注意 42 不是 18 —— 写错会导致长 loca 表被当成短表读，
    // 所有字形偏移全乱，轮廓全空。
    const h = new BE(head);
    h.p = 18;
    unitsPerEm = h.u16() || 1000;
    h.p = 42;
    indexToLocFormat = h.u16();   // 无符号：只用 0(短) / 1(长)
  }
  const maxp = tables['maxp'];
  if (maxp && maxp.length >= 6) {
    // maxp: 0-3 version, 4-5 numGlyphs
    const m = new BE(maxp);
    m.p = 4;
    numGlyphs = m.u16();
  }
  return {
    tables, unitsPerEm, indexToLocFormat, numGlyphs,
    head: tables['head'],          // 暴露出来便于调试与校验
    maxp: tables['maxp'],
    glyf: tables['glyf'], loca: tables['loca'],
    cmap: tables['cmap'], hasCFF: !!tables['CFF '],
    cffData: tables['CFF '],
  };
}

/** 从 glyf 表取字形轮廓（支持复合字形递归，depth 限制防环） */
export function glyphFromGlyf(tt, gid, depth = 0) {
  const path = new Path();
  if (!tt.glyf || !tt.loca || depth > 5) return path;
  const loca = tt.loca, glyf = tt.glyf;
  const fmt = tt.indexToLocFormat;
  let start, end;
  if (fmt === 0) {
    if ((gid + 1) * 2 + 1 >= loca.length) return path;
    start = (loca[gid * 2] << 8) | loca[gid * 2 + 1];
    end = (loca[gid * 2 + 2] << 8) | loca[gid * 2 + 3];
  } else {
    if ((gid + 1) * 4 + 3 >= loca.length) return path;
    start = ((loca[gid * 4] << 24) | (loca[gid * 4 + 1] << 16) | (loca[gid * 4 + 2] << 8) | loca[gid * 4 + 3]) >>> 0;
    end = ((loca[gid * 4 + 4] << 24) | (loca[gid * 4 + 5] << 16) | (loca[gid * 4 + 6] << 8) | loca[gid * 4 + 7]) >>> 0;
  }
  if (end <= start || end > glyf.length) return path;

  const g = new BE(glyf, start);
  const numContours = g.i16();
  g.p += 8; // xMin,yMin,xMax,yMax

  if (numContours >= 0) {
    // ---- 简单字形 ----
    const endPts = [];
    for (let i = 0; i < numContours; i++) endPts.push(g.u16());
    const nPoints = numContours === 0 ? 0 : endPts[numContours - 1] + 1;
    const insLen = g.u16();
    g.p += insLen; // 跳过提示信息
    // 标志位（可能多字节压缩）
    const flags = [];
    while (flags.length < nPoints) {
      const f = g.u8();
      flags.push(f);
      if (f & 8) { const rep = g.u8(); for (let k = 0; k < rep; k++) flags.push(f); }
    }
    flags.length = nPoints;
    // x 坐标（差分编码）
    const xs = [];
    let x = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & 2) { const d = g.u8(); x += (f & 16) ? d : -d; }
      else if (!(f & 16)) { x += g.i16(); }
      xs.push(x);
    }
    // y 坐标
    const ys = [];
    let y = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & 4) { const d = g.u8(); y += (f & 32) ? d : -d; }
      else if (!(f & 32)) { y += g.i16(); }
      ys.push(y);
    }

    // 按轮廓切分点，用 on/off 曲线判断如何连线：
    //   连续两个 on 点 -> 中间插入隐含的 off 点（取中点）
    //   on-off 或 off-on -> 直接二次贝塞尔
    let s = 0;
    for (let ci = 0; ci < numContours; ci++) {
      const e = endPts[ci];
      if (e < s) { s = e + 1; continue; }
      const n = e - s + 1;
      if (n <= 0) { s = e + 1; continue; }
      // 找到轮廓上的第一个 on 点
      let firstOn = -1;
      for (let i = 0; i < n; i++) {
        if (flags[s + i] & 1) { firstOn = i; break; }
      }
      if (firstOn < 0) { s = e + 1; continue; } // 全是 off 点，退化为直线

      // 按"起点在 on 点"的顺序重排
      const pts = [];
      for (let k = 0; k < n; k++) {
        const i = (firstOn + k) % n;
        pts.push({ x: xs[s + i], y: ys[s + i], on: !!(flags[s + i] & 1) });
      }

      path.moveTo(pts[0].x, pts[0].y);
      let i = 1;
      // 关键：循环上界是 i < n 而不是 i <= n。
      // 走到 i === n 时 pts[i % n] 又回到起点，会多画一个重复顶点；
      // 轮廓本来就是闭合的（最后一点通过 close() 连回起点），
      // 不需要也不应该再显式画一次起点。
      while (i < n) {
        const cur = pts[i % n];
        if (cur.on) {
          path.lineTo(cur.x, cur.y);
          i++;
        } else {
          // cur 是 off 点：与下一个点组成二次贝塞尔
          const nxt = pts[(i + 1) % n];
          if (nxt.on) {
            // off -> on：直接二次贝塞尔到该on 点，i 前进 2
            path.quadTo(cur.x, cur.y, nxt.x, nxt.y);
            i += 2;
          } else {
            // off -> off：隐含的 on 点在两者中点，画两段
            const midX = (cur.x + nxt.x) / 2, midY = (cur.y + nxt.y) / 2;
            path.quadTo(cur.x, cur.y, midX, midY);
            path.quadTo(nxt.x, nxt.y, midX, midY);
            i += 1;
          }
        }
      }
      path.close();
      s = e + 1;
    }
  } else {
    // ---- 复合字形：引用其它字形并做变换 ----
    // flags 位含义（TrueType spec）：
    //   0x0001 ARG_1_AND_2_ARE_WORDS   0x0002 ARGS_ARE_XY_VALUES
    //   0x0008 WE_HAVE_A_SCALE  0x0020 MORE_COMPONENTS
    //   0x0040 WE_HAVE_AN_X_AND_Y_SCALE  0x0080 WE_HAVE_A_TWO_BY_TWO
    // 关键：缩放矩阵必须按位互斥读取。三个 scale 位同时出现时
    // 读出的值个数不同，若无条件连读会导致游标错位、后续组件全乱。
    for (;;) {
      const flags = g.u16();
      const glyphIndex = g.u16();
      let a1, a2;
      if (flags & 0x0001) { a1 = g.i16(); a2 = g.i16(); }
      else { a1 = g.i8(); a2 = g.i8(); }

      // 2x2 变换矩阵 [m00 m10 m01 m11]，默认单位阵
      let m00 = 1, m10 = 0, m01 = 0, m11 = 1;
      if (flags & 0x0008) {                    // WE_HAVE_A_SCALE（单个值）
        const s = g.i16() / 16384;
        m00 = s; m11 = s;
      } else if (flags & 0x0040) {             // X_AND_Y_SCALE（两个值）
        m00 = g.i16() / 16384;
        m11 = g.i16() / 16384;
      } else if (flags & 0x0080) {             // TWO_BY_TWO（四个值）
        m00 = g.i16() / 16384;
        m10 = g.i16() / 16384;
        m01 = g.i16() / 16384;
        m11 = g.i16() / 16384;
      }

      applyComponent(path, glyphIndex, a1, a2, m00, m10, m01, m11, tt, depth);

      if (!(flags & 0x0020)) break;            // 最后一个组件
    }
  }
  return path;
}

const MORE_COMPONENTS = 0x20;

/** 把复合字形的某个组件变换后追加到路径
   *  变换 = translate(dx,dy) × [m00 m10; m01 m11] */
function applyComponent(path, gid, dx, dy, m00, m10, m01, m11, tt, depth) {
  const sub = glyphFromGlyf(tt, gid, depth + 1);
  if (sub.subpaths.length === 0) return;
  sub.transform(new Matrix(m00, m10, m01, m11, dx, dy));
  appendPath(path, sub);
}

/** 把 src 的所有子路径追加到 dst（避免共享数组引用） */
export function appendPath(dst, src) {
  for (const sp of src.subpaths) {
    dst.subpaths.push({ pts: sp.pts.slice(), closed: sp.closed });
  }
  return dst;
}

// ---------------------------------------------------------------------------
// CFF / Type2 charstring 解释器
// ---------------------------------------------------------------------------
export function parseCFF(bytes) {
  const result = { glyphs: [], unitsPerEm: 1000, charset: null };
  try {
    const hdrSize = bytes[2];
    const offSize = bytes[3];
    // Name INDEX
    let p = hdrSize;
    p = skipIndex(bytes, p);
    // Top DICT INDEX
    const topStart = p;
    p = skipIndex(bytes, p);
    // String INDEX
    p = skipIndex(bytes, p);
    // Global Subr INDEX
    const gsubrStart = p;
    p = skipIndex(bytes, p);

    const topDict = parseDictFromIndex(bytes, topStart, offSize);

    // CharStrings offset 来自 Top DICT 的 17 号操作符
    const csOff = topDict.get(17);
    const privSize = topDict.get(18);
    let privOff = 0;
    if (privSize) privOff = csOff + privSize;

    if (topDict.has(0x0c07)) result.unitsPerEm = topDict.get(0x0c07) || 1000;

    // Private DICT -> Subrs 偏移(19)
    let lsubrOff = -1, lsubrs = [];
    if (privSize && privOff < bytes.length) {
      const pd = parseDict(bytes, privOff, privOff + privSize);
      if (pd.has(19) && pd.has(18)) {
        lsubrOff = privOff + pd.get(19);
        lsubrs = readIndex(bytes, lsubrOff, bytes[privOff + pd.get(18)]);
      }
    }

    // 全局子程序
    const gsubrs = readIndex(bytes, gsubrStart);

    // CharStrings INDEX
    const csIdx = readIndex(bytes, csOff);
    // 默认宽度/名义宽度来自 Private DICT(20, 21)
    let nominalWidth = 0, defaultWidth = 0;
    if (privSize && privOff < bytes.length) {
      const pd = parseDict(bytes, privOff, privOff + privSize);
      nominalWidth = pd.get(21) || 0;
      defaultWidth = pd.get(20) || 0;
    }

    for (const cs of csIdx) {
      result.glyphs.push(runType2(cs, gsubrs, lsubrs, nominalWidth, defaultWidth));
    }
  } catch (e) {
    // 部分失败也保留已解析的字形
  }
  return result;
}

function skipIndex(bytes, p) {
  const count = (bytes[p] << 8) | bytes[p + 1];
  if (count === 0) return p + 2;
  const offSize = bytes[p + 2];
  return p + 2 + 1 + count * offSize + 1;
}

function readIndex(bytes, start) {
  if (start >= bytes.length) return [];
  const count = (bytes[start] << 8) | bytes[start + 1];
  if (count === 0) return [];
  const offSize = bytes[start + 2];
  const readOff = (i) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = (v << 8) | bytes[start + 3 + i * offSize + k];
    return v >>> 0;
  };
  const dataStart = start + 3 + (count + 1) * offSize - 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    const o1 = readOff(i), o2 = readOff(i + 1);
    out.push(bytes.subarray(dataStart + o1, dataStart + o2));
  }
  return out;
}

/** 解析 CFF DICT（二进制键值对，含偏置编码整数） */
function parseDict(bytes, start, end) {
  const map = new Map();
  let p = start;
  const operands = [];
  while (p < end && p < bytes.length) {
    let b0 = bytes[p];
    if (b0 <= 21) {
      // 操作符
      let op = b0;
      p++;
      if (b0 === 12) { op = 0x0c00 | bytes[p++]; }
      map.set(op, operands.length === 1 ? operands[0] : operands.slice());
      operands.length = 0;
    } else if (b0 === 28) {
      operands.push(((bytes[p + 1] << 8) | bytes[p + 2]) << 16 >> 16);
      p += 3;
    } else if (b0 === 29) {
      operands.push(((((bytes[p + 1] << 24) | (bytes[p + 2] << 16) | (bytes[p + 3] << 8) | bytes[p + 4]) << 16) >> 16));
      p += 5;
    } else if (b0 === 30) {
      // 实数：BCD 编码
      let s = '';
      p++;
      while (p < bytes.length) {
        const bb = bytes[p++];
        s += ((bb >> 4) & 15);
        if (bb & 0x80) { s += (bb & 15); break; }
        s += (bb & 15) + ',';
      }
      operands.push(parseFloat(s));
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      p++;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + bytes[p + 1] + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - bytes[p + 1] - 108);
      p += 2;
    } else p++;
  }
  return map;
}
function parseDictFromIndex(bytes, idxStart, offSize) {
  const arr = readIndex(bytes, idxStart);
  return arr.length ? parseDict(bytes, 0, arr[0].length) : new Map();
}

/**
 * Type2 charstring 解释器（栈式虚拟机）。
 * 支持主要绘图算子 + hintmask 跳过 + 变宽整数的特殊处理。
 */
export function runType2(code, gsubrs, lsubrs, nominalWidth = 0, defaultWidth = 0) {
  const path = new Path();
  const stack = [];
  let x = 0, y = 0, nStems = 0;
  let haveWidth = false;
  let width = 0;
  let open = false;   // 是否在路径中
  let trans = [];     // hint 替换后的坐标
  let depth = 0;

  // Type2 整数编码：
//   32..246   单字节：v - 139
//   247..250  两字节： (v-247)*256 + b1 + 108
//   251..254  两字节： -(v-251)*256 - b1 - 108
//   255       16.16 定点数（5 字节）
//   28        三字节有符号：b1b2 与 b1<<8|b2 组合后作 16 位有符号
function parseNum(b0) {
    if (b0 >= 32 && b0 <= 246) return [b0 - 139, 1];
    if (b0 >= 247 && b0 <= 250) {
      const v = (b0 - 247) * 256 + code[codeIndex[0] + 1] + 108;
      return [v, 2];
    }
    if (b0 >= 251 && b0 <= 254) {
      const v = -((b0 - 251) * 256) - code[codeIndex[0] + 1] - 108;
      return [v, 2];
    }
    if (b0 === 28) {
      // 三字节有符号：value = b1<<16 | b2<<8 | b3，按 24 位有符号解释
      const v = ((code[codeIndex[0] + 1] << 16) | (code[codeIndex[0] + 2] << 8) |
        code[codeIndex[0] + 3]);
      return [v & 0x800000 ? v - 0x1000000 : v, 4];
    }
    if (b0 === 255) {
      const v = (code[codeIndex[0] + 1] << 24) | (code[codeIndex[0] + 2] << 16) |
        (code[codeIndex[0] + 3] << 8) | code[codeIndex[0] + 4];
      return [v / 65536, 5];
    }
    return [0, 1];
  }
  const codeIndex = [0];

  function moveTo(nx, ny) {
    if (open) path.close();
    path.moveTo(nx, ny);
    open = true;
  }
  function lineTo(nx, ny) {
    if (!open) moveTo(nx, ny); else path.lineTo(nx, ny);
  }

  while (codeIndex[0] < code.length && depth < 10) {
    const v = code[codeIndex[0]];
    if (v >= 32 || v === 28) {
      const [num, adv] = parseNum(v);
      codeIndex[0] += adv;
      stack.push(num);
      // 宽度：栈里在第一个 moveto 前出现偶数个操作数时，
      // 若数量为奇数说明最前面是宽度（规范：argc 为偶数且 >4 时首元素为 width）
      continue;
    }
    codeIndex[0]++;
    switch (v) {
      case 1: case 3: case 18: case 23: // hstem vstem hstemhm vstemhm
        if (stack.length % 2 === 1 && stack.length > 4) { width = stack.shift(); haveWidth = true; }
        else if (!haveWidth && stack.length % 2 === 1) { width = stack.shift(); haveWidth = true; }
        nStems += stack.length >> 1;
        stack.length = 0;
        break;
      case 19: case 20: // hintmask cntrmask
        if (stack.length % 2 === 1) { width = stack.shift(); haveWidth = true; }
        nStems += stack.length >> 1;
        stack.length = 0;
        codeIndex[0] += (nStems + 7) >> 3;  // 跳过掩码字节
        break;
      case 21: // rmoveto
        if (stack.length > 2) { width = stack.shift(); haveWidth = true; }
        x += stack[0] || 0; y += stack[1] || 0;
        moveTo(x, y);
        stack.length = 0;
        break;
      case 22: { // hmoveto
        if (stack.length > 1) { width = stack.shift(); haveWidth = true; }
        x += stack[0] || 0;
        moveTo(x, y);
        stack.length = 0;
        break;
      }
      case 4: // vmoveto
        if (stack.length > 1) { width = stack.shift(); haveWidth = true; }
        y += stack[0] || 0;
        moveTo(x, y);
        stack.length = 0;
        break;
      case 5: // rlineto
        for (let i = 0; i + 1 < stack.length; i += 2) {
          x += stack[i]; y += stack[i + 1];
          lineTo(x, y);
        }
        stack.length = 0;
        break;
      case 6: case 7: { // hlineto / vlineto
        let horiz = v === 6;
        for (let i = 0; i < stack.length; i++) {
          if (horiz) x += stack[i]; else y += stack[i];
          lineTo(x, y);
          horiz = !horiz;
        }
        stack.length = 0;
        break;
      }
      case 8: // rrcurveto
        for (let i = 0; i + 5 < stack.length; i += 6) {
          const c1x = x + stack[i], c1y = y + stack[i + 1];
          const c2x = c1x + stack[i + 2], c2y = c1y + stack[i + 3];
          const ex = c2x + stack[i + 4], ey = c2y + stack[i + 5];
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          open = true;
          x = ex; y = ey;
        }
        stack.length = 0;
        break;
      case 24: { // rcurveline
        let i = 0;
        for (; i + 5 < stack.length - 2; i += 6) {
          const c1x = x + stack[i], c1y = y + stack[i + 1];
          const c2x = c1x + stack[i + 2], c2y = c1y + stack[i + 3];
          const ex = c2x + stack[i + 4], ey = c2y + stack[i + 5];
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          open = true;
          x = ex; y = ey;
        }
        x += stack[i] || 0; y += stack[i + 1] || 0;
        lineTo(x, y);
        stack.length = 0;
        break;
      }
      case 25: { // rlinecurve
        let i = 0;
        for (; i + 1 < stack.length - 6; i += 2) {
          x += stack[i]; y += stack[i + 1];
          lineTo(x, y);
        }
        if (i + 5 < stack.length) {
          const c1x = x + stack[i], c1y = y + stack[i + 1];
          const c2x = c1x + stack[i + 2], c2y = c1y + stack[i + 3];
          const ex = c2x + stack[i + 4], ey = c2y + stack[i + 5];
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          open = true;
          x = ex; y = ey;
        }
        stack.length = 0;
        break;
      }
      case 26: case 27: { // vvcurveto / hhcurveto
        let i = 0, d = 0;
        if (stack.length % 4 === 1) { d = stack[0]; i = 1; }
        for (; i + 3 < stack.length; i += 4) {
          let c1x, c1y;
          if (v === 26) { c1x = x + d; c1y = y + stack[i]; }
          else { c1x = x + stack[i]; c1y = y + d; }
          const c2x = c1x + stack[i + 1], c2y = c1y + stack[i + 2];
          if (v === 26) { const ex = c2x + stack[i + 3], ey = c2y; path.curveTo(c1x, c1y, c2x, c2y, ex, ey); x = ex; y = ey; }
          else { const ex = c2x, ey = c2y + stack[i + 3]; path.curveTo(c1x, c1y, c2x, c2y, ex, ey); x = ex; y = ey; }
          open = true;
          d = 0;
        }
        stack.length = 0;
        break;
      }
      case 30: case 31: { // vhcurveto / hvcurveto
        let horiz = v === 31;
        let i = 0;
        while (i + 3 < stack.length) {
          const last = (i + 8 > stack.length);
          let c1x, c1y, c2x, c2y, ex, ey;
          if (horiz) {
            c1x = x + stack[i]; c1y = y;
            c2x = c1x + stack[i + 1]; c2y = c1y + stack[i + 2];
            ey = c2y + stack[i + 3];
            if (last) { ex = c2x + stack[i + 4]; if (i + 4 < stack.length) {} else ex = c2x; }
            else ex = c2x;
            // 末点规则复杂，这里按常见实现处理
            if (last && i + 4 < stack.length) ex = c2x + stack[i + 4];
            path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
            x = ex; y = ey;
          } else {
            c1x = x; c1y = y + stack[i];
            c2x = c1x + stack[i + 1]; c2y = c1y + stack[i + 2];
            ex = c2x + stack[i + 3];
            if (last && i + 4 < stack.length) ey = c2y + stack[i + 4]; else ey = c2y;
            path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
            x = ex; y = ey;
          }
          open = true;
          i += 4;
          horiz = !horiz;
        }
        stack.length = 0;
        break;
      }
      case 10: { // callsubr
        const idx = stack.pop() | 0;
        if (lsubrs && lsubrs[idx]) {
          const sub = lsubrs[idx];
          const saveIdx = codeIndex[0];
          // 内联执行：把子程序插入到当前位置之后较复杂，
          // 简化为递归执行并恢复游标
          depth++;
          codeIndex[0] = 0;
          const endIdx = runSubroutine(sub, () => ({ x, y }));
          depth--;
          codeIndex[0] = saveIdx;
        }
        break;
      }
      case 29: { // callgsubr
        const idx = stack.pop() | 0;
        if (gsubrs && gsubrs[idx]) {
          depth++;
          codeIndex[0] = 0;
          runSubroutine(gsubrs[idx], null);
          depth--;
        }
        break;
      }
      case 11: // return
        return path;
      case 14: // endchar
        if (open) path.close();
        return path;
      case 12: {
        // escape: flex(35), hflex(34), hflex1(36), flex1(37)
        const op2 = code[codeIndex[0]++];
        if (op2 === 35) { // flex
          let c1x = x + stack[0], c1y = y + stack[1];
          let c2x = c1x + stack[2], c2y = c1y + stack[3];
          let ex = c2x + stack[4], ey = c2y + stack[5];
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          const jx = stack[6], jy = stack[7];
          c1x = ex + stack[8]; c1y = ey + stack[9];
          c2x = c1x + stack[10]; c2y = c1y + stack[11];
          ex = c2x + jx; ey = c2y + jy;
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          x = ex; y = ey;
          open = true;
        } else if (op2 === 34) { // hflex
          const y0 = y;
          let c1x = x + stack[0], c1y = y;
          let c2x = c1x + stack[1], c2y = stack[2];
          let ex = c2x + stack[3], ey = c2y;
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          c1x = ex + stack[4]; c1y = ey;
          c2x = c1x + stack[5]; c2y = c2y;
          ex = c2x + stack[6]; ey = y0;
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          x = ex; y = ey;
          open = true;
        } else if (op2 === 36) { // hflex1
          const y0 = y;
          let c1x = x + stack[0], c1y = y + stack[1];
          let c2x = c1x + stack[2], c2y = c1y + stack[3];
          let ex = c2x + stack[4], ey = c2y;
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          c1x = ex + stack[5]; c1y = ey;
          c2x = c1x + stack[6]; c2y = c1y + stack[7];
          ex = c2x + stack[8]; ey = y0;
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          x = ex; y = ey;
          open = true;
        } else if (op2 === 37) { // flex1
          const sx = x, sy = y;
          let dx = 0, dy = 0;
          for (let i = 0; i < 10; i += 2) { dx += stack[i]; dy += stack[i + 1]; }
          let c1x = x + stack[0], c1y = y + stack[1];
          let c2x = c1x + stack[2], c2y = c1y + stack[3];
          let ex = c2x + stack[4], ey = c2y + stack[5];
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          c1x = ex + stack[6]; c1y = ey + stack[7];
          c2x = c1x + stack[8]; c2y = c1y + stack[9];
          if (Math.abs(dx) > Math.abs(dy)) { ex = c2x + stack[10]; ey = sy; }
          else { ex = sx; ey = c2y + stack[10]; }
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          x = ex; y = ey;
          open = true;
        }
        stack.length = 0;
        break;
      }
      default:
        stack.length = 0;
    }
  }
  if (open) path.close();

  function runSubroutine(sub, _) {
    // 简化：把子程序的操作数当作已在栈上，这里直接执行其绘图算子
    // 通过临时替换 code 与游标实现"内联"
    const savedCode = code;
    const savedStackLen = stack.length;
    code = sub;
    codeIndex[0] = 0;
    let guard = 0;
    while (codeIndex[0] < code.length && guard++ < 10000 && depth < 10) {
      const vv = code[codeIndex[0]];
      if (vv >= 32 || vv === 28) {
        const [num, adv] = parseNum(vv);
        codeIndex[0] += adv;
        stack.push(num);
        continue;
      }
      codeIndex[0]++;
      if (vv === 11) break;                    // return
      if (vv === 10 || vv === 29) { stack.pop(); continue; } // 嵌套调用忽略
      // 内联的移动/线/曲线算子：复用主逻辑的关键部分
      if (vv === 21) { x += stack[0] || 0; y += stack[1] || 0; moveTo(x, y); stack.length = 0; }
      else if (vv === 5) {
        for (let i = 0; i + 1 < stack.length; i += 2) { x += stack[i]; y += stack[i + 1]; lineTo(x, y); }
        stack.length = 0;
      } else if (vv === 8) {
        for (let i = 0; i + 5 < stack.length; i += 6) {
          const c1x = x + stack[i], c1y = y + stack[i + 1];
          const c2x = c1x + stack[i + 2], c2y = c1y + stack[i + 3];
          const ex = c2x + stack[i + 4], ey = c2y + stack[i + 5];
          path.curveTo(c1x, c1y, c2x, c2y, ex, ey);
          open = true; x = ex; y = ey;
        }
        stack.length = 0;
      } else stack.length = 0;
    }
    code = savedCode;
    stack.length = savedStackLen;
  }
  return path;
}

// ---------------------------------------------------------------------------
// cmap 子表解析（格式 0 / 4 / 6 / 12）
// ---------------------------------------------------------------------------
/**
 * 从字体的 cmap 表里挑一个 Unicode 子表。
 * 返回的是**子表在 cmap 表内的字节偏移**，不是 (plat,enc) 键。
 */
function pickCmapSubtableOffset(cmapBytes) {
  if (!cmapBytes || cmapBytes.length < 4) return -1;
  const r = new BE(cmapBytes);
  if (r.u16() !== 0) return -1;
  const n = r.u16();
  if (!n || n > 512) return -1;
  let best = -1, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const plat = r.u16(), enc = r.u16(), off = r.u32();
    if (off >= cmapBytes.length) continue;
    const sc = scoreCmap(plat, enc);
    if (sc > bestScore) { bestScore = sc; best = off; }
  }
  return best;
}

/**
 * 解析 cmap 子表，返回 [unicode, gid] 数组。
 *
 * cmap 表的结构容易踩坑：
 *   0-1  version（应为 0）
 *   2-3  numEncodingRecords
 *   之后每个记录 8 字节：platformID(2) encodingID(2) offset(4)
 *   **真正的子表在记录之后**，必须先遍历记录找到合适的 offset，
 *   直接把偏移 0 处的字节当子表头解析是错的（这是本函数最初的 bug）。
 */
function parseCmapTable(bytes) {
  const pairs = [];
  if (!bytes || bytes.length < 4) return pairs;
  const r = new BE(bytes);
  const version = r.u16();
  if (version !== 0) return pairs;      // 合法 cmap 顶层 version 恒为 0
  const numRecords = r.u16();
  if (numRecords === 0 || numRecords > 512) return pairs;

  // 遍历编码记录，按优先级挑一个 Unicode 子表
  const candidates = [];
  for (let i = 0; i < numRecords; i++) {
    const plat = r.u16();
    const enc = r.u16();
    const off = r.u32();
    if (off >= bytes.length) continue;
    candidates.push({ plat, enc, off, score: scoreCmap(plat, enc) });
  }
  if (!candidates.length) return pairs;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  return parseCmapSubtableAt(bytes, best.off);
}

/** 给 cmap 子表按可用性打分，越高越优先（3,10 = UCS-4 Unicode 全码位） */
function scoreCmap(plat, enc) {
  if (plat === 3 && enc === 10) return 100;      // Windows UCS-4
  if (plat === 0 && enc === 6) return 95;       // Unicode full repertoire
  if (plat === 3 && enc === 1) return 90;       // Windows BMP
  if (plat === 0 && enc >= 4) return 85;       // Unicode BMP (2,0)/(2,1)/(3,0)...
  if (plat === 0) return 60;                    // Unicode
  if (plat === 3 && enc === 0) return 40;       // Windows Symbol
  if (plat === 1 && enc === 0) return 20;       // Mac Roman
  return 10;
}

/** 从给定偏移解析具体子表（格式 0/4/6/12） */
function parseCmapSubtableAt(bytes, offset) {
  const pairs = [];
  const sub = bytes.subarray(offset);
  if (!sub || sub.length < 4) return pairs;
  const s = new BE(sub);
  const format = s.u16();
  try {
    if (format === 0) {
      s.u16(); s.u16();                 // length, language
      for (let i = 0; i < 256; i++) { const gid = s.u8(); if (gid) pairs.push([i, gid]); }
    } else if (format === 4) {
      // 字段顺序（OpenType spec）：
      //   0 format, 2 length, 4 language, 6 segCountX2, 8 searchRange,
      //  10 entrySelector, 12 rangeShift, 14 endCode[seg], ...
      // 必须逐个读过去，漏掉 length/language 会让后续数组整体错位 4 字节。
      s.u16();                           // length
      s.u16();                           // language
      const segX2 = s.u16();              // segCountX2
      const seg = segX2 >> 1;
      s.p += 6;                          // searchRange, entrySelector, rangeShift
      const endCode = [], startCode = [], idDelta = [], idRangeOff = [];
      for (let i = 0; i < seg; i++) endCode.push(s.u16());
      s.u16();                           // reservedPad
      for (let i = 0; i < seg; i++) startCode.push(s.u16());
      for (let i = 0; i < seg; i++) idDelta.push(s.i16());
      // idRangeOff 数组的起始字节位置，算字形索引时以它为基准
      const rangeBase = s.p;
      for (let i = 0; i < seg; i++) idRangeOff.push(s.u16());
      for (let i = 0; i < seg; i++) {
        if (startCode[i] === 0xffff) continue;
        for (let c = startCode[i]; c <= endCode[i] && c !== 0x10000; c++) {
          let gid;
          if (idRangeOff[i] === 0) {
            gid = (c + idDelta[i]) & 0xffff;
          } else {
            // 关键：索引是相对**本条记录的位置**，不是相对子表开头
            const addr = rangeBase + i * 2 + idRangeOff[i] + (c - startCode[i]) * 2;
            if (addr + 1 >= sub.length) continue;
            gid = (sub[addr] << 8) | sub[addr + 1];
            if (gid !== 0) gid = (gid + idDelta[i]) & 0xffff;
          }
          if (gid) pairs.push([c, gid]);
        }
      }
    } else if (format === 6) {
      s.u16();
      const first = s.u16(), count = s.u16();
      for (let i = 0; i < count; i++) { const gid = s.u16(); if (gid) pairs.push([first + i, gid]); }
    } else if (format === 12) {
      s.u16(); s.u32();                  // reserved, length
      const nGroups = s.u32();
      for (let i = 0; i < nGroups && i < 100000; i++) {
        const startChar = s.u32(), endChar = s.u32(), startGid = s.u32();
        for (let c = startChar; c <= endChar && c - startChar < 4096; c++) {
          pairs.push([c, startGid + (c - startChar)]);
        }
      }
    }
  } catch { /* 部分失败保留已解析内容 */ }
  return pairs;
}

// ---------------------------------------------------------------------------
// 标准编码表（精简版：只需覆盖常用区域）
// ---------------------------------------------------------------------------
function buildStandardTables() {
  // ASCII 区（32-126）在 StandardEncoding 与 WinAnsiEncoding 下基本一致
  const ascii = new Array(256).fill(null);
  for (let c = 32; c < 127; c++) ascii[c] = c;
  const std = ascii.slice();
  const win = ascii.slice();
  // StandardEncoding 的重音符区
  const stdHigh = { 161: 0x20ac, 162: 0x201a, 163: 0x0192, 164: 0x201e, 165: 0x2026, 166: 0x2020, 167: 0x2021, 168: 0x02c6, 169: 0x2030, 170: 0x0160, 171: 0x2039, 172: 0x0152, 173: 0x017d, 174: 0x2018, 175: 0x2019, 176: 0x201c, 177: 0x201d, 178: 0x2022, 179: 0x2013, 180: 0x2014, 181: 0x02dc, 182: 0x2122, 183: 0x0161, 184: 0x203a, 185: 0x0153, 186: 0x017e, 187: 0x0178, 188: 0x201a, 189: 0x201e, 190: 0x2030, 191: 0x00b7 };
  for (const [k, v] of Object.entries(stdHigh)) std[+k] = v;
  // WinAnsi 的重音符区（代码值 128-159）
  const winHigh = { 128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x02c6, 137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a, 156: 0x0153, 158: 0x017e, 159: 0x0178 };
  for (const [k, v] of Object.entries(winHigh)) win[+k] = v;
  return {
    StandardEncoding: std,
    WinAnsiEncoding: win,
    MacRomanEncoding: ascii.slice(),
    PDFDocEncoding: ascii.slice(),
  };
}
export const STANDARD_ENCODINGS = buildStandardTables();

/** 字形名 -> Unicode（Adobe 标准字形名的常见部分） */
export const GLYPH_TO_UNICODE = (() => {
  const map = {};
  const put = (n, u) => { map[n] = u; };
  put('space', 32); put('exclam', 33); put('quotedbl', 34); put('numbersign', 35);
  put('dollar', 36); put('percent', 37); put('ampersand', 38); put('quoteright', 39);
  put('parenleft', 40); put('parenright', 41); put('asterisk', 42); put('plus', 43);
  put('comma', 44); put('hyphen', 45); put('period', 46); put('slash', 47);
  put('zero', 48); put('one', 49); put('two', 50); put('three', 51); put('four', 52);
  put('five', 53); put('six', 54); put('seven', 55); put('eight', 56); put('nine', 57);
  put('colon', 58); put('semicolon', 59); put('less', 60); put('equal', 61);
  put('greater', 62); put('question', 63); put('at', 64);
  for (let c = 65; c <= 90; c++) put(String.fromCharCode(c), c);
  put('bracketleft', 91); put('backslash', 92); put('bracketright', 93);
  put('asciicircum', 94); put('underscore', 95); put('quoteleft', 96);
  put('grave', 96); put('braceleft', 123); put('bar', 124); put('braceright', 125);
  put('asciitilde', 126);
  return map;
})();

// ---- 小工具 ----
function latin1(bytes) {
  let s = '';
  const CH = 4096;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return s;
}
function hexToUtf16(hex) {
  // 4 位十六进制 = 2 字节 BMP；更多位可能是代理对
  if (hex.length <= 4) return String.fromCharCode(parseInt(hex, 16));
  let out = '';
  for (let i = 0; i + 3 < hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
  }
  return out;
}

export { BE };