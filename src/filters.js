// ============================================================================
// filters.js — PDF 滤镜链（/Filter 的每一环）+ PNG/TIFF 预测器反滤波
// ----------------------------------------------------------------------------
// PDF 流数据的处理是"管道"：
//    raw bytes --[DecodeParms1 + Filter1]--> ... --[DecodeParmsN + FilterN]--> 逻辑数据
// 应用/子类型决定管道末端吐出来的是什么：
//    /Subtype /Image  -> 像素数据（还要按 /ColorSpace /BitsPerComponent 解码）
//    其他              -> 文本字节（内容流、字体程序、ToUnicode CMap 等）
//
// 常见滤镜：
//   FlateDecode      zlib，已在 inflate.js 实现
//   LZWDecode        TIFF 变体，PDF 特有参数 EarlyChange
//   ASCII85Decode    base85
//   ASCIIHexDecode   base16
//   RunLengthDecode  RLE
//   DCTDecode/JPXDecode/CCITTFaxDecode/JBIG2Decode -> 图像，直接交给渲染层
// 预测器（Predictor >= 2）在 Flate/LZW 之后执行，是"编码端预变换"，
// 解码端要做逆运算。
// ============================================================================

import { inflate, inflateRaw } from './inflate.js';

/** 逐行做 Predictor 反滤波。bpp = 每像素字节数（含 colors*bits）。 */
function undoPredictor(data, predictor, colors, bpc, columns) {
  if (predictor <= 1) return data;

  if (predictor === 2) {
    // TIFF predictor：逐行逐分量累加（左邻居）
    const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
    const rowLen = Math.ceil(colors * bpc * columns / 8);
    const rows = Math.floor(data.length / rowLen);
    for (let r = 0; r < rows; r++) {
      const base = r * rowLen;
      for (let i = bpp; i < rowLen; i++) data[base + i] = (data[base + i] + data[base + i - bpp]) & 0xff;
    }
    return data;
  }

  // PNG predictors: 2 = Up, 3 = Average, 4 = Paeth（每个子过滤器；0 = None）
  // 编码后的数据是 [ft][row bytes][ft][row bytes]...
  // 反滤波必须输出**不含 ft 字节**的紧凑行数据，所以这里写进新缓冲，
  // 而不是原地修改（原实现的 bug：ft 字节残留在输出里，每行错位 1 字节）。
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
  const rowLen = Math.ceil(colors * bpc * columns / 8);   // 不含 ft
  const stride = rowLen + 1;                              // 含 ft
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * rowLen);
  const prior = new Uint8Array(rowLen);
  const cur = new Uint8Array(rowLen);

  for (let r = 0; r < rows; r++) {
    const base = r * stride;
    const ft = data[base];
    for (let i = 0; i < rowLen; i++) cur[i] = data[base + 1 + i];

    switch (ft) {
      case 0: break;                                    // None
      case 1:                                           // Sub: + 左邻居
        for (let i = bpp; i < rowLen; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
        break;
      case 2:                                           // Up: + 上邻居
        for (let i = 0; i < rowLen; i++) cur[i] = (cur[i] + prior[i]) & 0xff;
        break;
      case 3: {                                         // Average: +(左+上)/2
        for (let i = 0; i < rowLen; i++) {
          const left = i >= bpp ? cur[i - bpp] : 0;
          cur[i] = (cur[i] + ((left + prior[i]) >> 1)) & 0xff;
        }
        break;
      }
      case 4: {                                         // Paeth
        for (let i = 0; i < rowLen; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;        // left
          const b = prior[i];                           // up
          const c = i >= bpp ? prior[i - bpp] : 0;      // up-left
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          cur[i] = (cur[i] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xff;
        }
        break;
      }
      default: break;
    }
    out.set(cur, r * rowLen);
    prior.set(cur);
  }
  return out;
}

/** ASCIIHexDecode: '>' 结束，忽略空白，非 hex 字符丢弃，末位奇数补 0 */
function asciiHexDecode(data) {
  const out = new Uint8Array(Math.ceil(data.length / 2));
  let o = 0, hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break; // '>'
    let v = -1;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 55;
    else if (c >= 0x61 && c <= 0x66) v = c - 87;
    else continue;
    if (hi < 0) hi = v;
    else { out[o++] = (hi << 4) | v; hi = -1; }
  }
  if (hi >= 0) out[o++] = hi << 4;
  return out.subarray(0, o);
}

/** ASCII85Decode: '~>' 结束，支持 'z' 缩写 4 个 0 */
function ascii85Decode(data) {
  const out = [];
  let tuple = 0, count = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // '~'
    if (c === 0x7a && count === 0) { out.push(0, 0, 0, 0); continue; } // 'z'
    if (c < 0x21 || c > 0x75) continue; // 空白等跳过
    tuple = tuple * 85 + (c - 0x21);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const b = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...b.slice(0, count - 1));
  }
  return new Uint8Array(out);
}

/** RunLengthDecode: 首字节 n，n<128 复制 n+1 个，n>128 重复 257-n 次，128=EOB */
function runLengthDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]);
    } else {
      const b = data[i++];
      for (let k = 0; k < 257 - n; k++) out.push(b);
    }
  }
  return new Uint8Array(out);
}

/**
 * LZWDecode —— PDF/TIFF 变体。
 * 数据结构：字典项 i 存 (firstByte, tailIndex)，其中 tailIndex 指向前一个
 * 字典项；单字节项(0..255)的 tailIndex = -1 表示结束。这样 emit() 沿链
 * 收集，再反序输出即可，无需每次拷贝。
 *
 * 码宽增长时机是本算法唯一的坑：
 *   EarlyChange=1 (PDF 默认)：next 达到 2^width - 1 时增宽
 *   EarlyChange=0            ：next 达到 2^width 时增宽
 * 另外 KwKwK 情形（code == next）：输出 prev + prev 的首字节，同时
 * 新字典项 = prev + code 的首字节。
 */
function lzw(data, earlyChange = 1) {
  const MAXN = 4096;
  const firstByte = new Int32Array(MAXN);
  const tail = new Int32Array(MAXN);
  let next = 258;
  const out = new Uint8Array(Math.max(64, data.length * 8));
  let oLen = 0;
  const grow = (need) => {
    if (oLen + need <= out.length) return;
    const nb = new Uint8Array(Math.max(out.length * 2, oLen + need + 1024));
    nb.set(out.subarray(0, oLen)); out.set = null; return nb;
  };
  let buf = out;
  const emit = (idx) => {
    // 统计长度并沿链收集（正序收集后反序输出）
    let len = 1, i = idx;
    while (tail[i] >= 0) { i = tail[i]; len++; }
    if (oLen + len > buf.length) {
      const nb = new Uint8Array(Math.max(buf.length * 2, oLen + len + 1024));
      nb.set(buf.subarray(0, oLen)); buf = nb;
    }
    // 从链尾往前写
    i = idx;
    while (tail[i] >= 0) { buf[oLen++] = firstByte[i]; i = tail[i]; }
    buf[oLen++] = firstByte[i];
    return firstByte[idx];
  };
  const headOf = (idx) => { while (tail[idx] >= 0) idx = tail[idx]; return firstByte[idx]; };
  const resetDict = () => {
    for (let i = 0; i < 256; i++) { firstByte[i] = i; tail[i] = -1; }
    next = 258;
  };
  resetDict();

  let codeWidth = 9, bitPos = 0, prev = -1;
  const totalBits = data.length * 8;
  const limitFor = (w) => (1 << w) - (earlyChange ? 1 : 0);

  while (bitPos + codeWidth <= totalBits) {
    let code = 0;
    for (let i = 0; i < codeWidth; i++) {
      const bp = bitPos + i;
      code = (code << 1) | ((data[bp >> 3] >> (7 - (bp & 7))) & 1);
    }
    bitPos += codeWidth;

    if (code === 256) { resetDict(); codeWidth = 9; prev = -1; continue; }
    if (code === 257) break;

    if (code < next) {
      emit(code);
      if (prev >= 0 && next < MAXN) { firstByte[next] = headOf(code); tail[next] = prev; next++; }
      prev = code;
    } else if (code === next && prev >= 0) {
      // KwKwK
      const head = headOf(prev);
      if (oLen + 1 > buf.length) {
        const nb = new Uint8Array(buf.length * 2 + 1024); nb.set(buf.subarray(0, oLen)); buf = nb;
      }
      emit(prev); buf[oLen++] = head;
      if (next < MAXN) { firstByte[next] = head; tail[next] = prev; next++; }
      prev = code;
    } else {
      break; // 越界码字，停止
    }
    if (next >= limitFor(codeWidth) && codeWidth < 12) codeWidth++;
  }
  return buf.subarray(0, oLen);
}

// 判断哪些滤镜需要交给渲染/图像层（不解码）
const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'CCF']);

/**
 * 解码一个 PDF 流对象的数据部分。
 * @param {object} stream  {raw: Uint8Array, dict: Map-like}
 * @param {(n:string)=>any} resolve 用于解析间接的 DecodeParms
 * @returns {{data: Uint8Array, remainingFilters: string[], error: string|null}}
 */
export function decodeStream(stream, resolve) {
  let data = stream.raw;
  const d = stream.dict;
  const get = (k) => (d && typeof d.get === 'function' ? d.get(k) : undefined);

  let filterNames = resolve(get('Filter') ?? get('F'));
  if (filterNames === null || filterNames === undefined) filterNames = [];
  if (!Array.isArray(filterNames)) filterNames = [filterNames];

  let parms = resolve(get('DecodeParms') ?? get('DP'));
  if (parms === null || parms === undefined) parms = [];
  if (!Array.isArray(parms)) parms = [parms];

  const remaining = [];
  for (let i = 0; i < filterNames.length; i++) {
    // 关键：Filter 的值是 PDF 名字对象（Name），其 toString() 带前导 '/'。
    // 直接 String() 比较会得到 "/FlateDecode" 而匹配不上 'FlateDecode'，
    // 导致所有流"解码"成了空操作。必须取 .name。
    const rawName = resolve(filterNames[i]);
    const name = rawName && typeof rawName === 'object' && 'name' in rawName
      ? String(rawName.name)
      : String(rawName || '').replace(/^\//, '');
    if (IMAGE_FILTERS.has(name)) { remaining.push(name); continue; }

    const parm = resolve(parms[i]) || resolve(parms[0]);
    const pd = parm && typeof parm.get === 'function' ? parm : null;
    const pred = Number(resolve(pd?.get('Predictor')) || 1);
    const colors = Number(resolve(pd?.get('Colors')) || 1);
    const bpc = Number(resolve(pd?.get('BitsPerComponent')) || 8);
    const columns = Number(resolve(pd?.get('Columns')) || 1);
    const early = resolve(pd?.get('EarlyChange'));
    const earlyChange = early === undefined || early === null ? 1 : Number(early);
    const skipFirst = data.length > 0 ? (Number(resolve(pd?.get('Skip')) || 0)) : 0;

    switch (name) {
      case 'FlateDecode': case 'Fl':
        if (data[0] === 0x78 || data.length > 2) {
          const r = inflate(data);
          data = r.data;
          // 关键：截断的流要保留已解出的部分
          if (r.error && r.data.length === 0 && data.length === 0) { /* 全失败 */ }
        }
        break;
      case 'LZWDecode': case 'LZW':
        data = lzw(data, earlyChange);
        break;
      case 'ASCII85Decode': case 'A85':
        data = ascii85Decode(data);
        break;
      case 'ASCIIHexDecode': case 'AHx':
        data = asciiHexDecode(data);
        break;
      case 'RunLengthDecode': case 'RL':
        data = runLengthDecode(data);
        break;
      case 'Crypt':
        break;
      default:
        remaining.push(name);
    }
    if (skipFirst) data = data.subarray(skipFirst);
    if (pred > 1) data = undoPredictor(Uint8Array.from(data), pred, colors, bpc, columns);
  }
  return { data, remainingFilters: remaining, error: null };
}

export { undoPredictor, lzw, ascii85Decode, asciiHexDecode, runLengthDecode, IMAGE_FILTERS };