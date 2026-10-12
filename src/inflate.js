// ============================================================================
// inflate.js — 从零实现的 DEFLATE (RFC 1951) 解码器 + zlib (RFC 1950) 包装
// ----------------------------------------------------------------------------
// 为什么必须自己写：
//   PDF 里几乎所有流数据（页面内容、字体、图像、xref stream）都用 FlateDecode
//   压缩。浏览器有内置 DecompressionStream('deflate')，但它只能处理完整 zlib 流，
//   而 PDF 允许 (1) 裸 deflate、(2) 流被截断后提前 endstream、(3) 单个流里拼接
//   多个 deflate 块并忽略尾部垃圾。我们需要"容错式"解压，所以手写。
//
// 核心算法（与 zlib 官方实现同构，但结构为了可读性重排）：
//   1. 比特流读取器：DEFLATE 是 LSB-first 位打包，跟大端直觉相反
//   2. Huffman 解码：canonical Huffman，用 (code,len)->symbol 的查表法
//   3. 三种块：stored(00) / fixed(01) / dynamic(10)
//   4. LZ77 回溯复制：(dist, len) 对，把已输出窗口的字节拷到当前位置
// ============================================================================

/** 比特流读取器：LSB-first。DEFLATE 的整数是"低位先出"。 */
class BitReader {
  constructor(bytes, startByte = 0) {
    this.bytes = bytes;
    this.pos = startByte;      // 下一个要读的字节
    this.bitBuf = 0;
    this.bitCnt = 0;
    this.eof = false;      // 输入耗尽标志：越界后必须中止，否则会死循环
  }
  /** 读 n 位（n<=24），返回无符号整数 */
  bits(n) {
    while (this.bitCnt < n) {
      if (this.pos >= this.bytes.length) {
        // 越界：标记 eof 并视为 0 比特。调用方需检查 eof 后中止，
        // 否则 LZ77 会无限复制（同符号回溯）导致 CPU 打满。
        this.eof = true;
        this.bitBuf |= 0 << this.bitCnt;
        this.bitCnt += 8;
        continue;
      }
      this.bitBuf |= this.bytes[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return v;
  }
  /** 丢掉当前字节剩余的位，对齐到字节边界（stored 块前需要） */
  alignToByte() {
    const drop = this.bitCnt & 7;
    this.bitBuf >>>= drop;
    this.bitCnt -= drop;
  }
  /** 按字节读一个（调用前需 alignToByte） */
  byte() {
    if (this.bitCnt >= 8) {
      const v = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
      return v;
    }
    if (this.pos >= this.bytes.length) return -1;
    return this.bytes[this.pos++];
  }
}

// ---- 长度/距离的 (基值, 额外位数) 表 ----------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// code length 字母表顺序（动态块的 code length 编码）
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * 构建 canonical Huffman 解码表。
 * 做法：统计每个长度的码字数量 -> 计算"下一个码值" -> 展开成线性表，
 * 解码时逐位比对（canonical Huffman 的最大码长 15，线性扫描足够快，
 * 真实场景下比树形查表更省内存，缓存友好）。
 */
function buildHuffman(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  if (maxLen === 0) return { maxLen: 0, counts: new Int32Array(16), symbols: new Int32Array(0) };

  const counts = new Int32Array(maxLen + 1);
  for (const l of lengths) counts[l]++;

  // offsets[k] = 码长为 k 的第一个符号在 symbols 数组中的起始下标。
  // 注意是 offsets[k]，不是 offsets[k+1]（zlib 参考实现的经典写法，容易写错一格）
  const offsets = new Int32Array(maxLen + 2);
  for (let k = 1; k < maxLen; k++) offsets[k + 1] = offsets[k] + counts[k];

  const symbols = new Int32Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym]) symbols[offsets[lengths[sym]]++] = sym;
  }
  return { maxLen, counts, symbols };
}

/** 从位流解出一个 Huffman 符号（逐位累积码值） */
function decodeSymbol(br, huff) {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= huff.maxLen; len++) {
    code |= br.bits(1);
    const count = huff.counts[len];
    if (code - first < count) return huff.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('inflate: invalid Huffman code');
}

let FIXED_LIT = null, FIXED_DIST = null;
function getFixedTables() {
  if (FIXED_LIT) return;
  const lit = new Uint8Array(288);
  lit.fill(8, 0, 144);      // 0-143: 8 bits
  lit.fill(9, 144, 256);     // 144-255: 9 bits
  lit.fill(7, 256, 280);     // 256-279: 7 bits
  lit.fill(8, 280, 288);     // 280-287: 8 bits
  FIXED_LIT = buildHuffman(lit);
  FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5));
}

/** 动态输出容器：可增长 Uint8Array */
class OutBuf {
  constructor(cap = 1 << 16) {
    this.buf = new Uint8Array(cap);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap = (cap * 1.5) | 0;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  push(b) { this.ensure(1); this.buf[this.len++] = b; }
  copy(dist, len) {
    if (dist > this.len) { // 损坏数据：填充 0 而不是抛异常
      for (let i = 0; i < len; i++) this.push(0);
      return;
    }
    this.ensure(len);
    let from = this.len - dist;
    for (let i = 0; i < len; i++) this.buf[this.len++] = this.buf[from++];
  }
  result() { return this.buf.subarray(0, this.len); }
}

/**
 * 裸 DEFLATE 解压（不含 zlib 头）。
 * @param {Uint8Array} input
 * @param {number} startBitByte 起始字节偏移
 * @param {Uint8Array} [prefix] 已解压的前缀（用于处理被截断的流）
 * @returns {{data: Uint8Array, bytesConsumed: number, error: string|null}}
 */
export function inflateRaw(input, startBitByte = 0, prefix = null) {
  const br = new BitReader(input, startBitByte);
  const out = new OutBuf(prefix ? prefix.length + (1 << 15) : 1 << 16);
  if (prefix) { out.buf.set(prefix, 0); out.len = prefix.length; }

  let error = null;
  try {
    for (;;) {
      if (br.eof) { error = error || 'input exhausted'; break; }
      const last = br.bits(1);
      const type = br.bits(2);
      if (br.eof) { error = error || 'input exhausted'; break; }

      if (type === 0) {
        // ---- stored：原始字节，LEN/NLEN 校验 ----
        br.alignToByte();
        const len = br.byte() | (br.byte() << 8);
        const nlen = br.byte() | (br.byte() << 8);
        if ((len ^ 0xffff) !== nlen) { error = 'stored LEN/NLEN mismatch'; break; }
        out.ensure(len);
        for (let i = 0; i < len; i++) {
          const b = br.byte();
          if (b < 0) { error = 'stored block truncated'; break; }
          out.push(b);
        }
        if (error) break;
      } else if (type === 1 || type === 2) {
        let litHuff, distHuff;
        if (type === 1) {
          getFixedTables();
          litHuff = FIXED_LIT; distHuff = FIXED_DIST;
        } else {
          // ---- dynamic：先解出 code length 序列，再解出两棵主树 ----
          const hlit = br.bits(5) + 257;
          const hdist = br.bits(5) + 1;
          const hclen = br.bits(4) + 4;
          const clens = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = br.bits(3);
          const clHuff = buildHuffman(clens);

          const lens = new Uint8Array(hlit + hdist);
          let i = 0;
          while (i < lens.length) {
            if (br.eof) { error = 'input exhausted'; break; }
            const sym = decodeSymbol(br, clHuff);
            if (sym < 16) lens[i++] = sym;
            else if (sym === 16) {
              if (i === 0) { error = 'repeat with no previous length'; break; }
              const rep = 3 + br.bits(2);
              const prev = lens[i - 1];
              for (let j = 0; j < rep && i < lens.length; j++) lens[i++] = prev;
            } else if (sym === 17) {
              const rep = 3 + br.bits(3);
              for (let j = 0; j < rep && i < lens.length; j++) lens[i++] = 0;
            } else {
              const rep = 11 + br.bits(7);
              for (let j = 0; j < rep && i < lens.length; j++) lens[i++] = 0;
            }
          }
          if (error) break;
          litHuff = buildHuffman(lens.subarray(0, hlit));
          distHuff = buildHuffman(lens.subarray(hlit));
        }

        // ---- LZ77 主循环 ----
        for (;;) {
          if (br.eof) { error = error || 'input exhausted'; break; }
          // 记录进入本次解码前的输出长度：若解码过程中耗尽输入，
          // 该符号是垃圾（比特全 0 解出来的），必须回滚丢弃，
          // 否则会在有效数据尾部追加一段乱码。
          const mark = out.len;
          const sym = decodeSymbol(br, litHuff);
          const exhausted = br.eof;
          if (sym < 256) {
            if (exhausted) { out.len = mark; error = error || 'input exhausted'; break; }
            out.push(sym);
          }
          else if (sym === 256) break;               // end of block
          else {
            const li = sym - 257;
            if (li >= LEN_BASE.length) { error = 'bad length symbol'; break; }
            const length = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
            const ds = decodeSymbol(br, distHuff);
            if (ds >= DIST_BASE.length) { error = 'bad distance symbol'; break; }
            const dist = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
            // 膨胀比熔断：正常 PDF 数据最大压缩比约 1000:1，超过即视为损坏，
            // 防止恶意/损坏流撑爆内存
            if (out.len > input.length * 1200 + (1 << 22)) { error = 'decompression bomb'; break; }
            if (exhausted || br.eof) { out.len = mark; error = error || 'input exhausted'; break; }
            out.copy(dist, length);
          }
          if (error) break;
        }
        if (error) break;
      } else {
        error = 'reserved block type 3';
        break;
      }
      if (last) break;
    }
  } catch (e) {
    error = error || e.message;
  }

  // 计算实际消耗的字节数（含位流中未读完的部分）
  const bytesConsumed = br.pos - (br.bitCnt >> 3);
  return { data: out.result(), bytesConsumed: Math.max(0, bytesConsumed), error };
}

/**
 * zlib (RFC 1950) 解压：校验 2 字节头 (CMF/FLG)，剥离头尾后调用 inflateRaw。
 * 若头部不合法或解压失败，回退尝试裸 deflate —— 现实中很多 PDF 生成器
 * 写出不合法的 zlib 头，必须容错。
 */
export function inflate(input, prefix = null) {
  if (input.length >= 2) {
    const cmf = input[0], flg = input[1];
    const headerOk = (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
    if (headerOk) {
      let start = 2;
      if (flg & 0x20) start += 4; // FDICT 预设字典，PDF 不用
      const r = inflateRaw(input, start, prefix);
      if (r.error === null || r.data.length > (prefix ? prefix.length : 0)) return r;
    }
  }
  return inflateRaw(input, 0, prefix);
}

// ---------------------------------------------------------------------------
// deflate 压缩：为了写出合法 PDF，我们也需要"能压"。
// 完整实现 LZ77 匹配搜索成本高，这里实现 stored(00) 块打包 —— 完全合法，
// 体积与原始相同。真正的压缩留给浏览器原生 CompressionStream（见下方
// compressBestEffort），Node 环境下退化为 stored。
// ---------------------------------------------------------------------------

export function deflateStored(input) {
  const MAX = 65535;
  const parts = [];
  let off = 0;
  // zlib 头: CMF=0x78 (deflate, 32K window), FLG 使 (0x78<<8|FLG)%31==0
  parts.push(new Uint8Array([0x78, 0x01]));
  do {
    const n = Math.min(MAX, input.length - off);
    const last = off + n >= input.length ? 1 : 0;
    parts.push(new Uint8Array([last, n & 0xff, (n >> 8) & 0xff, (~n) & 0xff, ((~n) >> 8) & 0xff]));
    parts.push(input.subarray(off, off + n));
    off += n;
  } while (off < input.length);
  // adler32
  let a = 1, b = 0;
  for (let i = 0; i < input.length; i++) { a = (a + input[i]) % 65521; b = (b + a) % 65521; }
  const adler = ((b << 16) | a) >>> 0;
  parts.push(new Uint8Array([(adler >>> 24) & 255, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255]));
  return concat(parts);
}

function concat(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

/**
 * 优先用浏览器原生 CompressionStream('deflate') 拿真压缩率，
 * 不可用时退化为 stored。返回 Promise<Uint8Array>。
 */
export async function compressBestEffort(input) {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('deflate');
      const stream = new Blob([input]).stream().pipeThrough(cs);
      const ab = await new Response(stream).arrayBuffer();
      const out = new Uint8Array(ab);
      // 只有真的更小才用（否则退 stored，避免体积变大）
      const stored = deflateStored(input);
      return out.length < stored.length ? out : stored;
    } catch { /* fall through */ }
  }
  return deflateStored(input);
}