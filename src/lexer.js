// ============================================================================
// lexer.js — PDF 词法分析器 + 对象解析器
// ----------------------------------------------------------------------------
// PDF 有 8 种基本对象类型（PDF 32000-1 §7.3）：
//   boolean   true / false
//   numeric   整数 / 实数（允许 ".5" "-.002" "34.5" "--5" 这类畸形写法）
//   string    (literal) 与 <hex>
//   name      /Name，#xx 转义十六进制
//   array     [ ... ]
//   dict      << ... >>   （本质是有键名的 array）
//   stream    dict + stream ... endstream
//   null
//   加上两个"复合"类型：间接引用 "n g R"、文件定位符 "n g obj"
//
// 词法难点：
//   1. 空白字符含 \0（空字节），且注释 % 到行尾
//   2. 字符串里的转义：\n \r \t \b \f \( \) \\ \ddd(1-3位八进制) \r\n(续行)
//   3. 流长度可以是间接引用，且常常是错的 —— 必须能回退扫描 endstream
// ============================================================================

export const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
export const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isWs = (c) => WHITESPACE.has(c);
const isDelim = (c) => DELIMITER.has(c);
const isRegular = (c) => !isWs(c) && !isDelim(c);

/** 命名对象：用 Name 类包装，避免与字符串混淆 */
export class Name {
  constructor(name) { this.name = name; }
  toString() { return '/' + this.name; }
}
export const isName = (o) => o instanceof Name;

/** 间接引用 */
export class Ref {
  constructor(num, gen) { this.num = num; this.gen = gen; }
  get key() { return this.num + '_' + this.gen; }
  toString() { return `${this.num} ${this.gen} R`; }
}
export const isRef = (o) => o instanceof Ref;

/** 流对象 */
export class PDFStream {
  constructor(dict, raw, startOffset) {
    this.dict = dict;          // Map-like
    this.raw = raw;            // Uint8Array 未解码的原始流数据
    this.startOffset = startOffset;
    this._decoded = null;
  }
  get isImg() { return this.dict.get('Subtype') === 'Image' || (this.dict.get('Type') === 'XObject' && this.dict.get('Subtype') === 'Image'); }
}
/** 字典：内部用 JS Map，key 是去掉 '/' 的名字字符串 */
export class Dict {
  constructor(entries) { this.map = entries || new Map(); }
  get(k) { return this.map.get(k); }
  has(k) { return this.map.has(k); }
  set(k, v) { this.map.set(k, v); return this; }
  keys() { return this.map.keys(); }
  entries() { return this.map.entries(); }
  get size() { return this.map.size; }
  /** 取数组型字典项，如 Resources（可能是 dict 或 ref） */
  getDict(k, resolver) {
    let v = this.map.get(k);
    if (isRef(v) && resolver) v = resolver.resolve(v);
    return v instanceof Dict ? v : null;
  }
}
export const isDict = (o) => o instanceof Dict;
export const isStream = (o) => o instanceof PDFStream;

/** 词法分析器：持有字节数组 + 游标，提供 token 接口 */
export class Lexer {
  constructor(bytes, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  skipWhite() {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWs(c)) { this.pos++; continue; }
      if (c === 0x25) { // '%' 注释
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
        continue;
      }
      break;
    }
  }

  /** 读一个裸词（连续 regular 字符），用于 obj/endobj/stream/R/true 等 */
  readKeyword() {
    this.skipWhite();
    const start = this.pos;
    // 关键：先判断是否为数字起始。若是，只吞掉数字部分，
    // 这样 "1 rg" 中的 rg 才会被完整读成一个操作符，
    // 而不是把 "1rg" 当成一个畸形数字拆成 1 + r + g。
    const c0 = this.bytes[this.pos];
    let end = this.pos;
    if (c0 !== undefined &&
      ((c0 >= 0x30 && c0 <= 0x39) || c0 === 0x2b || c0 === 0x2d || c0 === 0x2e)) {
      let p = this.pos + 1;
      while (p < this.bytes.length) {
        const c = this.bytes[p];
        if ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2b || c === 0x2d) { p++; continue; }
        if (c === 0x65 || c === 0x45) {
          const nxt = this.bytes[p + 1];
          if (nxt !== undefined && ((nxt >= 0x30 && nxt <= 0x39) || nxt === 0x2b || nxt === 0x2d)) { p += 2; continue; }
          break;
        }
        break;
      }
      end = p;
    } else {
      while (end < this.bytes.length && isRegular(this.bytes[end])) end++;
    }
    this.pos = end;
    return this.decodeLatin1(this.bytes.subarray(start, end));
  }

  decodeLatin1(bytes) {
    let s = '';
    // 分块避免 apply 参数过多
    const CH = 4096;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return s;
  }

  /** 解析一个对象。resolver 需要提供以解析间接引用（用于流长度） */
  parseObject(resolver) {
    this.skipWhite();
    if (this.pos >= this.bytes.length) return null;
    const c = this.bytes[this.pos];

    if (c === 0x2f) return this.parseName();
    if (c === 0x28) return this.parseLiteralString();
    if (c === 0x5b) return this.parseArray(resolver);
    if (c === 0x3c) {
      // '<' 可能是 hex string 或 dict 开头 '<<'
      if (this.bytes[this.pos + 1] === 0x3c) return this.parseDict(resolver);
      return this.parseHexString();
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7d) { this.pos++; return null; } // 越界闭合符

    // 数字 / 关键字 / 引用
    const save = this.pos;
    const kw = this.readKeyword();
    if (kw === '') { this.pos = save + 1; return null; }

    if (kw === 'true') return true;
    if (kw === 'false') return false;
    if (kw === 'null') return null;

    if (/^[+-.\d]/.test(kw) || kw === '-' || kw === '+') {
      const num = parsePDFNumber(kw);
      // 尝试解析间接引用 "num gen R"。
      // 三条硬性要求（缺一不可，否则会把操作符误判成引用）：
      //   1) 下一个 token 必须是纯数字（世代号）
      //   2) 再下一个 token 必须是单独的 'R'
      //   3) 'R' 之后必须紧跟分隔符/空白（否则 "Rgb" 这种会误判）
      if (num !== null && Number.isInteger(num) && num >= 0) {
        const afterNum = this.pos;
        const genKw = this.readKeyword();
        if (/^\d+$/.test(genKw)) {
          const gen = parseInt(genKw, 10);
          const afterGen = this.pos;
          const rKw = this.readKeyword();
          const afterR = this.pos;
          if (rKw === 'R') {
            // R 之后必须不是 regular 字符
            const nextC = this.bytes[afterR];
            const okAfter = nextC === undefined || isWs(nextC) || isDelim(nextC);
            if (okAfter) return new Ref(num, gen);
          }
          this.pos = afterGen;
        }
        this.pos = afterNum;   // 不是引用，退回到只消费了 num 的位置
      }
      if (num === null) { this.pos = save + 1; return null; }
      return num;
    }

    // 未知关键字 = 内容流里的操作符（rg/re/f/Tj...）。
    // readKeyword 已经把整个裸词读出来了（游标已越过它），
    // 绝不能像早期版本那样 this.pos = save; this.pos++ 强行回退 1 字节 ——
    // 那会把 "rg" 截成 "r"，剩下的 "g" 被当成下一个操作符，
    // 表现为 rg 的操作数错位、颜色全黑。
    return { __unknown: kw };
  }

  parseName() {
    this.pos++; // 跳过 '/'
    const b = this.bytes;
    const out = [];
    while (this.pos < b.length && isRegular(b[this.pos])) {
      let c = b[this.pos++];
      if (c === 0x23 && this.pos + 1 < b.length) { // '#' 十六进制转义
        const h = this.decodeLatin1(b.subarray(this.pos, this.pos + 2));
        if (/^[0-9a-fA-F]{2}$/.test(h)) { c = parseInt(h, 16); this.pos += 2; }
      }
      out.push(c);
    }
    return new Name(String.fromCharCode.apply(null, out));
  }

  /** (literal string) -> 返回 Uint8Array（未做 PDFDocEncoding/UTF16 转换，
   *  因为字节含义取决于上下文：文本串可能是 PDFDocEncoding 或 UTF-16BE） */
  parseLiteralString() {
    this.pos++; // '('
    const b = this.bytes;
    const out = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c) { // backslash
        const e = b[this.pos++];
        switch (e) {
          case 0x6e: out.push(0x0a); break; // \n
          case 0x72: out.push(0x0d); break; // \r
          case 0x74: out.push(0x09); break; // \t
          case 0x62: out.push(0x08); break; // \b
          case 0x66: out.push(0x0c); break; // \f
          case 0x28: out.push(0x28); break; // \(
          case 0x29: out.push(0x29); break; // \)
          case 0x5c: out.push(0x5c); break; // \\
          case 0x0d: if (b[this.pos] === 0x0a) this.pos++; break; // 续行
          case 0x0a: break; // 续行
          default:
            if (e >= 0x30 && e <= 0x37) { // 1-3 位八进制
              let v = e - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) { v = v * 8 + (d - 0x30); this.pos++; }
                else break;
              }
              out.push(v & 0xff);
            } else {
              out.push(e); // 未知转义：字符本身
            }
        }
        continue;
      }
      if (c === 0x28) { depth++; out.push(c); continue; }
      if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); continue; }
      out.push(c);
    }
    return new Uint8Array(out);
  }

  /** <hex string> */
  parseHexString() {
    this.pos++; // '<'
    const b = this.bytes;
    const nibbles = [];
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      let v = -1;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 55;
      else if (c >= 0x61 && c <= 0x66) v = c - 87;
      else continue; // 空白忽略
      nibbles.push(v);
    }
    const out = new Uint8Array(Math.ceil(nibbles.length / 2));
    for (let i = 0; i < nibbles.length; i += 2) {
      const hi = nibbles[i], lo = i + 1 < nibbles.length ? nibbles[i + 1] : 0;
      out[i >> 1] = (hi << 4) | lo;
    }
    return out;
  }

  parseArray(resolver) {
    this.pos++; // '['
    const arr = [];
    for (;;) {
      this.skipWhite();
      if (this.pos >= this.bytes.length) break;
      const c = this.bytes[this.pos];
      if (c === 0x5d) { this.pos++; break; } // ']'
      const before = this.pos;
      const obj = this.parseObject(resolver);
      if (this.pos === before) { this.pos++; continue; } // 防死循环
      arr.push(obj);
    }
    return arr;
  }

  parseDict(resolver) {
    // 调用方分两种情况进入：
    //   a) parseObject 已确认游标停在 '<<'，直接 +2 即可；
    //   b) 外部调用（如 xref 读取器读完 "trailer" 后）游标停在换行处，
    //      必须先跳空白，否则会把 '\n<' 当成 '<<' 跳过，解析出空字典
    //      （这个 bug 曾导致 /Prev 链断掉、trailer 全空）。
    // 用 skipWhite + 统一 +2 覆盖两种情况。
    this.skipWhite();
    this.pos += 2; // 越过 '<<'
    const d = new Dict();
    for (;;) {
      this.skipWhite();
      if (this.pos >= this.bytes.length) break;
      const c = this.bytes[this.pos];
      if (c === 0x3e && this.bytes[this.pos + 1] === 0x3e) { this.pos += 2; break; } // '>>'
      if (c !== 0x2f) {
        // 字典键必须是名字，遇到别的就跳过防止死循环
        const before = this.pos;
        const junk = this.parseObject(resolver);
        if (this.pos === before) this.pos++;
        if (junk === null && this.pos < this.bytes.length && this.bytes[this.pos] !== 0x2f) continue;
        continue;
      }
      const key = this.parseName().name;
      const val = this.parseObject(resolver);
      if (val !== undefined) d.set(key, val);
    }
    return d;
  }

  /**
   * 在 dict 之后尝试读 stream 数据。
   * 关键鲁棒性：/Length 可能是间接引用、也可能根本是错的。
   * 策略：先按 Length 读，再验证后面是否紧跟 endstream；
   *       不行就回退到扫描 "endstream" 关键字。
   */
  tryParseStream(dict, startPos, resolver) {
    this.pos = startPos;
    this.skipWhite();
    if (this.readKeyword() !== 'stream') return null;
    // stream 关键字后必须是 CRLF 或 LF
    const b = this.bytes;
    if (b[this.pos] === 0x0d) this.pos++;
    if (b[this.pos] === 0x0a) this.pos++;

    let len = -1;
    const lenObj = dict.get('Length');
    if (typeof lenObj === 'number') len = lenObj;
    else if (isRef(lenObj) && resolver) {
      const v = resolver.resolve(lenObj);
      if (typeof v === 'number') len = v;
    }

    const dataStart = this.pos;
    let raw = null;

    if (len >= 0 && dataStart + len <= b.length) {
      const after = dataStart + len;
      const save = this.pos;
      this.pos = after;
      this.skipWhite();
      const kw = this.readKeyword();
      if (kw === 'endstream') {
        raw = b.subarray(dataStart, after);
      } else {
        this.pos = save;
      }
    }

    if (raw === null) {
      // 回退：扫描 endstream
      const idx = indexOfKeyword(b, dataStart, 'endstream');
      if (idx < 0) raw = b.subarray(dataStart);
      else {
        // endstream 前通常有一个换行，需要剥掉
        let end = idx;
        if (end > dataStart && b[end - 1] === 0x0a) end--;
        if (end > dataStart && b[end - 1] === 0x0d) end--;
        raw = b.subarray(dataStart, end);
        this.pos = idx;
        this.skipWhite();
        this.readKeyword();
      }
    }
    return new PDFStream(dict, raw, dataStart);
  }
}

/** 从 from 开始查找裸关键字 keyword（如 'endstream'）的位置 */
export function indexOfKeyword(bytes, from, keyword) {
  const kw = new TextEncoder().encode(keyword);
  const n = bytes.length, m = kw.length;
  const first = kw[0];
  for (let i = from; i <= n - m; i++) {
    if (bytes[i] !== first) continue;
    let match = true;
    // 前后必须是分隔符边界，避免匹配到 "endstreamXYZ"
    if (i > 0 && isRegular(bytes[i - 1])) continue;
    for (let k = 1; k < m; k++) if (bytes[i + k] !== kw[k]) { match = false; break; }
    if (match && i + m < n && isRegular(bytes[i + m])) continue;
    if (match) return i;
  }
  return -1;
}

/** 读一个裸词（连续 regular 字符）直到空白或分隔符。
 *  注意：PDF 里数字后面紧跟操作符是常态（"1 rg"），
 *  所以裸词读取必须先判断"是否是数字"，否则会把 "1rg" 整体当成一个畸形数字。 */
export function readToken(bytes, pos) {
  let p = pos;
  // 数字起始判定：+ - . 或数字
  const c0 = bytes[p];
  let isNum = false;
  if (c0 !== undefined) {
    if ((c0 >= 0x30 && c0 <= 0x39) || c0 === 0x2b || c0 === 0x2d || c0 === 0x2e) {
      isNum = true;
      // 但 "1e5" 这种真的是数字；"-3.5" 也是。问题在于 "1rg"：
      // 遇到字母后要判断它是指数的一部分(e/E)还是操作符的开头。
    }
  }
  const start = p;
  if (isNum) {
    p++;
    while (p < bytes.length) {
      const c = bytes[p];
      if (c >= 0x30 && c <= 0x39) { p++; continue; }
      if (c === 0x2e || c === 0x2b || c === 0x2d) { p++; continue; }
      // 指数标记：后面必须跟数字，否则视为操作符起始（如 1rg 的 g）
      if ((c === 0x65 || c === 0x45)) {
        const nxt = bytes[p + 1];
        if (nxt !== undefined && ((nxt >= 0x30 && nxt <= 0x39) || nxt === 0x2b || nxt === 0x2d)) {
          p += 2; continue;
        }
        break;
      }
      break;
    }
  }
  return p;
}

/** 解析 PDF 数字，畸形输入尽量宽容 */
export function parsePDFNumber(tok) {
  let s = tok.trim();
  if (s === '') return null;
  let sign = 1, i = 0;
  while (i < s.length && (s[i] === '+' || s[i] === '-')) { if (s[i] === '-') sign *= -1; i++; }
  let intPart = '', fracPart = '', seenDot = false, seenDigit = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '.') { if (seenDot) break; seenDot = true; }
    else if (c >= '0' && c <= '9') { seenDigit = true; seenDot ? fracPart += c : intPart += c; }
    else if ((c === '+' || c === '-')) break; // 畸形：符号出现在中间，截断
    else break;
  }
  if (!seenDigit) {
    // 可能是 ".e5" 之类，尝试整体 parseFloat
    const v = parseFloat(s);
    return isFinite(v) ? v : null;
  }
  const v = parseFloat(intPart + (fracPart ? '.' + fracPart : ''));
  return sign * v;
}