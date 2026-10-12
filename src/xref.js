// ============================================================================
// xref.js — 交叉引用表解析：经典表 + 交叉引用流 + 增量更新链 + 暴力恢复
// ----------------------------------------------------------------------------
// PDF 的核心设计：**间接更新 (incremental update)**。
// 保存修改不重写整个文件，而是在文件尾部追加一批新对象 + 一段新 xref，
// 用 /Prev 指向前一段 xref。解析时必须从最后一段开始向前回溯，
// 后出现的版本覆盖先前的（对象号相同取较新者，但 /Prev 里旧版本可能
// 含被删除对象 → 用 free 标记）。
//
// 三类 xref：
//   1. 经典表: "xref\n0 3\n0000000000 65535 f \n..." 后跟 trailer 字典
//   2. xref 流: 二进制流，/W [a b c] 定义每条记录字节宽度，
//              type 1=正常(offset,gen) 2=在某个 ObjStm 里 0=空闲
//   3. 混合(/XRefStm): 主表是经典表但同时用流补充 ObjStm 类型对象
//
// 最后必须实现 **暴力恢复**：真实世界里大量 PDF 的 xref 是坏的
// （文件经过传输损坏、多处编辑、二次压缩），此时唯一可靠办法是
// 全文件扫描 "N G obj" 模式重建索引。Adobe Reader 也这么做。
// ============================================================================

import { Lexer, Dict, Name, Ref, PDFStream, indexOfKeyword, isDict } from './lexer.js';
import { decodeStream } from './filters.js';

/** xref 条目：type 1 = 文件偏移，type 2 = 压缩对象流 */
class XrefEntry {
  constructor(type, a, b) { this.type = type; this.a = a; this.b = b; }
}

export class PDFDocument {
  constructor(bytes) {
    this.bytes = bytes;
    this.xref = new Map();      // objNum -> XrefEntry
    this.trailer = new Dict();
    this.cache = new Map();     // objNum -> parsed object
    this.objStmCache = new Map();
    this.recovered = false;
    this.warnings = [];
    this._encrypted = false;
  }

  /** 顶层入口：解析整个文档 */
  parse() {
    try {
      this._parseXrefChain();
    } catch (e) {
      this.warnings.push('xref 解析失败: ' + e.message + ' — 启用暴力恢复');
      this.recovered = true;
      this.cache.clear();
      this._recover();
    }
    // 校验完整性：catalog / pages 是否能取到
    if (!this._sanityCheck()) {
      this.recovered = true;
      // 关键：_sanityCheck 期间 getObject 会把解析失败的对象以 null 缓存。
      // 恢复流程重建索引后若不清缓存，后续拿到的仍是旧的 null，
      // 表现为"trailer 有 Root 但 catalog() 返回 null"。
      this.cache.clear();
      this._recover();
    }
    this._decryptInfo();
    return this;
  }

  // ---- xref 链解析 ----
  _parseXrefChain() {
    const start = this._findStartXref();
    if (start < 0) throw new Error('no startxref');
    this._readXrefSection(start);
  }

  _findStartXref() {
    const b = this.bytes;
    // startxref 关键字在文件尾部（PDF 规范：最后 2048 字节内）
    const tailStart = Math.max(0, b.length - 2048);
    const tail = new Lexer(b, tailStart);
    // 反向查找最后一个 "startxref"
    let pos = b.length;
    while (pos > tailStart) {
      pos = lastIndexOfBytes(b, 'startxref'.split('').map(c => c.charCodeAt(0)), pos - 11);
      if (pos < 0) break;
      const lex = new Lexer(b, pos + 9);
      const kw = lex.readKeyword();
      if (/^\d+$/.test(kw)) return parseInt(kw, 10);
    }
    return -1;
  }

  /** 读一段 xref（经典表或流），并递归跟随 /Prev */
  _readXrefSection(offset, depth = 0) {
    if (depth > 64) return; // 防御：损坏文件造成环
    const b = this.bytes;
    if (offset < 0 || offset >= b.length) return;

    // 跳过前面的空白，探测类型
    const probe = new Lexer(b, offset);
    probe.skipWhite();
    if (b[probe.pos] === 0x78 && !this._looksLikeClassicXref(offset)) {
      // 以 'x' 开头 -> 一定是 xref 流（'xref' 也是 x，先排除经典表）
    }
    if (this._looksLikeClassicXref(offset)) {
      this._lastSectionPrev = this._readClassicXref(offset);
    } else {
      this._lastSectionPrev = this._readXrefStream(offset);
    }

    // 用**本段自己的** /Prev 继续回溯。
    // 关键：不能读 this.trailer.get('Prev') —— trailer 是跨段落合并的，
    // 里面存的是最新一段的 Prev，在深层递归时会重复指向同一位置，
    // 表现为遍历 2 层后 xref 里只剩最近的几个对象、链路断裂。
    const myPrev = this._lastSectionPrev;
    this._lastSectionPrev = undefined;

    // 跟随 /Prev —— 增量更新的核心。
    // 语义：**新**段落优先于**旧**段落。
    //   1. 存下本段（最新）条目
    //   2. 递归读旧段（旧定义会写进 this.xref）
    //   3. 把新条目无条件覆盖回去
    if (typeof myPrev === 'number' && myPrev >= 0 && myPrev !== offset) {
      const newer = new Map(this.xref);
      this._readXrefSection(myPrev, depth + 1);
      for (const [k, v] of newer) this.xref.set(k, v);
    }

    // 混合引用文件：/XRefStm 指向另一个 xref 流（补充 ObjStm 条目）
    const xrefStm = this.trailer.get('XRefStm');
    if (typeof xrefStm === 'number' && !this._stmMerged) {
      this._stmMerged = true;
      this._readXrefStream(xrefStm, true);
    }
  }

  _looksLikeClassicXref(offset) {
    const b = this.bytes;
    const lex = new Lexer(b, offset);
    lex.skipWhite();
    return lex.readKeyword() === 'xref';
  }

  /** 经典交叉引用表: "xref" + 若干子表 + trailer */
  _readClassicXref(offset) {
    const b = this.bytes;
    const lex = new Lexer(b, offset);
    lex.readKeyword(); // 'xref'

    for (;;) {
      lex.skipWhite();
      // 子表头: "start count"
      const startKw = lex.readKeyword();
      if (!/^\d+$/.test(startKw)) {
        // 不是数字 -> 应该到 trailer 了
        lex.pos -= startKw.length; // 回退给 trailer 解析
        break;
      }
      const start = parseInt(startKw, 10);
      lex.skipWhite();
      const countKw = lex.readKeyword();
      if (!/^\d+$/.test(countKw)) { lex.pos -= countKw.length; break; }
      const count = parseInt(countKw, 10);

      // count 条 20 字节定长记录: "nnnnnnnnnn ggggg n \n"
      for (let i = 0; i < count; i++) {
        lex.skipWhite();
        const entryStart = lex.pos;
        const offKw = lex.readKeyword();
        lex.skipWhite();
        const genKw = lex.readKeyword();
        lex.skipWhite();
        const typeKw = lex.readKeyword();
        if (!/^\d+$/.test(offKw) || !/^\d+$/.test(genKw)) {
          lex.pos = entryStart;
          break;
        }
        const objNum = start + i;
        const type = typeKw === 'n' ? 1 : 0;
        // 关键：后续（更早的）xref 段落不能覆盖已有的条目，
        // 也不能覆盖 free 条目（对象已被删除）
        if (!this.xref.has(objNum) || type === 0) {
          if (type === 1) this.xref.set(objNum, new XrefEntry(1, parseInt(offKw, 10), parseInt(genKw, 10)));
          else this.xref.set(objNum, new XrefEntry(0, 0, parseInt(genKw, 10)));
        }
        // 兼容畸形文件：条目不是 20 字节定长时用固定偏移
        const expectNext = entryStart + 20;
        if (lex.pos < expectNext) lex.pos = expectNext;
        else if (lex.pos > expectNext) { /* 正常可能有空白 */ }
      }
    }

    // trailer 字典
    lex.skipWhite();
    const kw = lex.readKeyword();
    let sectionPrev;
    if (kw === 'trailer') {
      const dict = lex.parseDict(null);
      // 取本段自己的 /Prev：回溯必须用"本段的"，
      // 不能用合并后的 this.trailer（那里是最新一段的值）
      sectionPrev = dict.get('Prev');
      this._mergeTrailer(dict);
    }
    return sectionPrev;
  }

  /** 交叉引用流：xref 流对象本身是 "N G obj << ... >> stream" 形式，
   *  必须按间接对象解析（不能直接 parseObject，那只会读到裸数字 N）。 */
  _readXrefStream(offset, mergeOnly = false) {
    let stream = null;
    try {
      const parsed = this._parseIndirectAt(offset, -1);
      if (parsed instanceof PDFStream) stream = parsed;
    } catch { /* 落到下方回退 */ }

    if (!stream) {
      // 回退：扫描该对象之后第一个 stream
      const idx = indexOfKeyword(this.bytes, offset, 'obj');
      if (idx < 0) throw new Error('xref stream: no obj at ' + offset);
      const lex = new Lexer(this.bytes, idx + 3);
      const dict = lex.parseDict(this);
      stream = lex.tryParseStream(dict, lex.pos, this);
    }
    if (!stream) throw new Error('xref stream not found at ' + offset);

    const { data } = decodeStream(stream, (x) => this.resolve(x));
    const d = stream.dict;
    const wArr = (this.resolve(d.get('W')) || [1, 1, 1]).map((x) => Number(this.resolve(x)) || 0);
    const size = Number(this.resolve(d.get('Size'))) || 0;
    const indexArr = this.resolve(d.get('Index'));
    let sections;
    if (Array.isArray(indexArr) && indexArr.length >= 2) {
      sections = [];
      for (let i = 0; i + 1 < indexArr.length; i += 2) {
        sections.push([Number(this.resolve(indexArr[i])), Number(this.resolve(indexArr[i + 1]))]);
      }
    } else sections = [[0, size]];

    const totalW = wArr.reduce((a, b) => a + b, 0);
    let p = 0;
    for (const [start, count] of sections) {
      for (let i = 0; i < count; i++) {
        if (p + totalW > data.length) break;
        const fields = [];
        for (let k = 0; k < 3; k++) {
          let v = 0;
          for (let bIdx = 0; bIdx < wArr[k]; bIdx++) v = (v << 8) | data[p++];
          // w[k] == 0 表示该字段宽度为 0，其值有默认语义（type 缺省为 1）
          if (wArr[k] === 0) v = 0;
          fields.push(v);
        }
        const [type, f2, f3] = fields;
        const objNum = start + i;
        if (type === 1) {
          // type 1 = 普通对象（file offset）。已存在的条目可能来自更晚的
          // xref 段落，必须保留更晚的，所以只在缺失时写入。
          // 但 mergeOnly（/XRefStm）语义是"补充"，也要遵守同一优先级。
          if (!this.xref.has(objNum) || (mergeOnly && this.xref.get(objNum).type === 0)) {
            this.xref.set(objNum, new XrefEntry(1, f2, f3));
          }
        } else if (type === 2) {
          // type 2 = 对象位于某个 ObjStm 的第 f3 项
          if (!this.xref.has(objNum)) this.xref.set(objNum, new XrefEntry(2, f2, f3));
        }
        // type 0 = 空闲，不记录
      }
    }
    const sectionPrev = d.get('Prev');
    this._mergeTrailer(d, mergeOnly);
    return sectionPrev;
  }

  _mergeTrailer(dict, mergeOnly = false) {
    if (!dict) return;
    if (!mergeOnly) {
      for (const [k, v] of dict.entries()) {
        if (!this.trailer.has(k)) this.trailer.set(k, v);
      }
    } else {
      // XRefStm 只补充 Root/Info 等，不覆盖已有
      for (const [k, v] of dict.entries()) if (!this.trailer.has(k)) this.trailer.set(k, v);
    }
  }

  // ---- 暴力恢复 ----
  _recover() {
    this.xref.clear();
    const b = this.bytes;
    // 扫描所有 "N G obj" 出现位置，后出现的覆盖先出现的（增量更新语义）
    const pat = [0x6f, 0x62, 0x6a]; // 'obj'
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] !== pat[0] || b[i + 1] !== pat[1] || b[i + 2] !== pat[2]) continue;
      // 前一个字符必须是分隔符
      if (i > 0 && isRegularChar(b[i - 1])) continue;
      // 往前找 "G" 和 "N"
      let p = i - 1;
      while (p >= 0 && isWsChar(b[p])) p--;
      const genEnd = p;
      while (p >= 0 && b[p] >= 0x30 && b[p] <= 0x39) p--;
      if (p === genEnd) continue; // 没有 gen 数字
      while (p >= 0 && isWsChar(b[p])) p--;
      const numEnd = p;
      while (p >= 0 && b[p] >= 0x30 && b[p] <= 0x39) p--;
      if (p === numEnd) continue;
      const gen = parseInt(this.bytes2str(b.subarray(p + 1, genEnd + 1)), 10);
      const num = parseInt(this.bytes2str(b.subarray(p + 1, numEnd + 1)), 10);
      if (!isFinite(num) || !isFinite(gen)) continue;
      const objStart = p + 1;
      // 检查 obj 后面是否为分隔符
      if (i + 3 < b.length && isRegularChar(b[i + 3])) continue;
      this.xref.set(num, new XrefEntry(1, objStart, gen));
    }
    // 重建 trailer：找最后一个含 /Root 的字典
    this._recoverTrailer();
  }

  /**
   * 重建 trailer。两种来源：
   *  1) trailer 字典还在（但 xref 坏了）——扫描 "trailer" 关键字取 /Root
   *  2) trailer 也被破坏/丢失 —— **结构推断**：扫描所有对象，找
   *    /Type /Catalog 的那个，用它的对象号重建 /Root；再顺着
   *    /Pages -> /Kids 找到根页树节点，重建 /Root 的 Pages 指向。
   * 现实世界里大量损坏文件的 trailer 已不可信，结构推断是唯一出路。
   */
  _recoverTrailer() {
    const b = this.bytes;

    // --- 来源 1：扫描 trailer 关键字 ---
    let pos = 0, foundTrailer = false;
    while (pos < b.length) {
      const idx = indexOfKeyword(b, pos, 'trailer');
      if (idx < 0) break;
      const lex = new Lexer(b, idx + 7);
      const dict = lex.parseDict(null);
      if (dict.has('Root')) {
        for (const [k, v] of dict.entries()) if (!this.trailer.has(k)) this.trailer.set(k, v);
        foundTrailer = true;
      }
      pos = idx + 7;
    }
    if (this.trailer.has('Root')) {
      // 验证 Root 是否真的能用；不可用则继续走结构推断
      const cat = this.resolve(this.trailer.get('Root'));
      if (cat instanceof Dict && cat.has('Pages')) return;
      if (!foundTrailer) this.trailer.map.delete('Root');
    }

    // --- 来源 2：结构推断 catalog ---
    // 注意：catalog 可能被压缩在 ObjStm 里（xref type 2），所以不能只扫
    // 顶层对象，必须遍历所有已知的对象号并尝试解析。
    let catalogRef = null, catalogDict = null;
    for (const num of this.xref.keys()) {
      const d = this._peekDictAt(num);
      if (!d) continue;
      const t = this.resolve(d.get('Type'));
      if (t && t.name === 'Catalog') { catalogRef = new Ref(num, 0); catalogDict = d; break; }
    }
    if (!catalogDict) {
      this.warnings.push('恢复失败：未找到 /Type /Catalog 对象');
      return;
    }

    // catalog 里必须能找到 Pages；若 Pages 是引用但解析失败，则从页树反推
    let pagesRef = this.resolve(catalogDict.get('Pages'));
    if (!isDict(pagesRef)) {
      // 找 /Type /Pages 且没有 /Parent 的那个 —— 那就是根节点
      let rootPagesNum = -1;
      for (const num of this.xref.keys()) {
        const d = this._peekDictAt(num);
        if (!d) continue;
        const t = this.resolve(d.get('Type'));
        if (t && t.name === 'Pages' && !d.has('Parent')) { rootPagesNum = num; break; }
      }
      if (rootPagesNum >= 0) catalogDict.set('Pages', new Ref(rootPagesNum, 0));
    }

    this.trailer.set('Root', catalogRef);
    if (!this.trailer.has('Size')) {
      let maxNum = 0;
      for (const [num] of this.xref) if (num > maxNum) maxNum = num;
      this.trailer.set('Size', maxNum + 1);
    }
    this.warnings.push('trailer 已通过结构推断重建（Root=' + catalogRef.num + '）');
  }

  /** 读取某对象号处的字典（不产生流），用于结构扫描。
   *  type 1（顶层）和 type 2（ObjStm 内）都支持。 */
  _peekDictAt(num) {
    try {
      const entry = this.xref.get(num);
      if (!entry) return null;
      if (entry.type === 2) {
        // 压缩对象：直接向 getObject 要（它会走 ObjStm 解码路径）
        const o = this.getObject(num, 0);
        return isDict(o) ? o : null;
      }
      if (entry.type !== 1) return null;
      const lex = new Lexer(this.bytes, entry.a);
      lex.skipWhite();
      const a = lex.readKeyword();
      if (!/^\d+$/.test(a)) return null;
      lex.skipWhite();
      const g = lex.readKeyword();
      if (!/^\d+$/.test(g)) return null;
      lex.skipWhite();
      if (lex.readKeyword() !== 'obj') return null;
      lex.skipWhite();
      if (this.bytes[lex.pos] !== 0x3c) return null;
      return lex.parseDict(null);
    } catch { return null; }
  }

  _sanityCheck() {
    try {
      const cat = this.catalog();
      return !!(cat && this.resolve(cat.get('Pages')));
    } catch { return false; }
  }

  // ---- 对象解析 ----
  resolve(obj) {
    if (obj === null || obj === undefined) return obj;
    if (!isRefLike(obj)) return obj;
    return this.getObject(obj.num, obj.gen);
  }

  getObject(num, gen) {
    const key = num;
    if (this.cache.has(key)) return this.cache.get(key);
    // 先占位，防止循环引用导致无限递归
    this.cache.set(key, null);
    let result = null;
    const entry = this.xref.get(num);
    try {
      if (!entry) {
        // 该对象号未在 xref 中：可能是被 free 掉的，也可能在 ObjStm 里
        result = this._findInObjStm(num);
      } else if (entry.type === 1) {
        result = this._parseIndirectAt(entry.a, num);
      } else if (entry.type === 2) {
        result = this._parseFromObjStm(entry.a, entry.b, num);
      }
    } catch (e) {
      this.warnings.push(`对象 ${num} 解析失败: ${e.message}`);
    }
    this.cache.set(key, result);
    return result;
  }

  _parseIndirectAt(offset, expectNum) {
    const lex = new Lexer(this.bytes, offset);
    lex.skipWhite();
    const numKw = lex.readKeyword();
    lex.skipWhite();
    const genKw = lex.readKeyword();
    lex.skipWhite();
    const kw = lex.readKeyword();
    if (kw !== 'obj') {
      // 偏移不准：全文件回退搜索
      const found = this._scanForObj(expectNum);
      if (found >= 0) {
        lex.pos = found;
        lex.readKeyword(); lex.readKeyword(); lex.readKeyword();
      } else {
        throw new Error('expected "obj" at ' + offset);
      }
    }
    const obj = lex.parseObject(this);
    // 尝试读 stream
    const afterObj = lex.pos;
    lex.skipWhite();
    if (this._peekStream(lex)) {
      const st = lex.tryParseStream(obj instanceof Dict ? obj : new Dict(), lex.pos, this);
      if (st) return st;
    }
    lex.pos = afterObj;
    return obj;
  }

  _peekStream(lex) {
    const save = lex.pos;
    const kw = lex.readKeyword();
    lex.pos = save;
    return kw === 'stream';
  }

  _scanForObj(num) {
    const b = this.bytes;
    const pat = [0x6f, 0x62, 0x6a];
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] !== pat[0] || b[i + 1] !== pat[1] || b[i + 2] !== pat[2]) continue;
      if (i > 0 && isRegularChar(b[i - 1])) continue;
      let p = i - 1;
      while (p >= 0 && isWsChar(b[p])) p--;
      const genEnd = p;
      while (p >= 0 && b[p] >= 0x30 && b[p] <= 0x39) p--;
      if (p === genEnd) continue;
      while (p >= 0 && isWsChar(b[p])) p--;
      const numEnd = p;
      while (p >= 0 && b[p] >= 0x30 && b[p] <= 0x39) p--;
      if (p === numEnd) continue;
      const n = parseInt(this.bytes2str(b.subarray(p + 1, numEnd + 1)), 10);
      if (n === num) return p + 1;
    }
    return -1;
  }

  /** 解码一个对象流（/Type /ObjStm），解析其中的 N 个对象 */
  _parseObjStm(streamNum) {
    if (this.objStmCache.has(streamNum)) return this.objStmCache.get(streamNum);
    const st = this.resolve(new Ref(streamNum, 0));
    const result = new Map();
    this.objStmCache.set(streamNum, result);
    if (!(st instanceof PDFStream)) return result;

    const n = Number(this.resolve(st.dict.get('N'))) || 0;
    const first = Number(this.resolve(st.dict.get('First'))) || 0;
    let data;
    try { data = decodeStream(st, (x) => this.resolve(x)).data; }
    catch { return result; }

    // 前 N*2 字节是 "objnum offset" 对（十进制文本）
    const header = this.bytes2str(data.subarray(0, Math.min(first, data.length)));
    const nums = header.match(/\d+/g) || [];
    for (let i = 0; i < n; i++) {
      const objNum = parseInt(nums[i * 2], 10);
      const off = parseInt(nums[i * 2 + 1], 10);
      if (!isFinite(objNum) || !isFinite(off)) continue;
      if (result.has(objNum)) continue;
      try {
        const lex = new Lexer(data, first + off);
        result.set(objNum, lex.parseObject(this));
      } catch { /* 单个对象失败不影响其他 */ }
    }
    return result;
  }

  _parseFromObjStm(stmNum, idx, expectNum) {
    const map = this._parseObjStm(stmNum);
    if (map.has(expectNum)) return map.get(expectNum);
    // 索引可能不准：线性找同号
    if (map.has(idx)) return map.get(idx);
    return null;
  }

  _findInObjStm(num) {
    // 遍历所有已知的 ObjStm（从 trailer 之外的间接对象里找 Type/ObjStm）
    const b = this.bytes;
    const pat = [0x6f, 0x62, 0x6a];
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] !== pat[0] || b[i + 1] !== pat[1] || b[i + 2] !== pat[2]) continue;
      if (i > 0 && isRegularChar(b[i - 1])) continue;
      let p = i - 1;
      while (p >= 0 && isWsChar(b[p])) p--;
      const genEnd = p;
      while (p >= 0 && b[p] >= 0x30 && b[p] <= 0x39) p--;
      if (p === genEnd) continue;
      while (p >= 0 && isWsChar(b[p])) p--;
      const numEnd = p;
      while (p >= 0 && b[p] >= 0x30 && b[p] <= 0x39) p--;
      if (p === numEnd) continue;
      const stmNum = parseInt(this.bytes2str(b.subarray(p + 1, numEnd + 1)), 10);
      if (!isFinite(stmNum)) continue;
      let st;
      try { st = this.resolve(new Ref(stmNum, 0)); } catch { continue; }
      if (st instanceof PDFStream && st.dict.get('Type') === 'ObjStm') {
        const map = this._parseObjStm(stmNum);
        if (map.has(num)) return map.get(num);
      }
    }
    return null;
  }

  bytes2str(bytes) {
    let s = '';
    const CH = 4096;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return s;
  }

  _decryptInfo() {
    const enc = this.trailer.get('Encrypt');
    this._encrypted = !!enc;
    this._encryptRef = enc;
  }

  get encrypted() { return this._encrypted; }

  // ---- 高层结构 ----
  catalog() {
    const root = this.trailer.get('Root');
    if (!root) {
      // 恢复模式下再试一次
      const c = this.resolve(new Ref(1, 0));
      if (c instanceof Dict && c.has('Pages')) return c;
      return null;
    }
    return this.resolve(root);
  }

  pages() {
    const cat = this.catalog();
    if (!cat) return [];
    const rootPages = this.resolve(cat.get('Pages'));
    if (!(rootPages instanceof Dict)) return [];
    const out = [];
    const walk = (nodeRef, depth, inherited) => {
      if (depth > 64 || out.length > 20000) return; // 防御
      const node = this.resolve(nodeRef);
      if (!(node instanceof Dict)) return;
      const inh = { ...inherited };
      for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
        if (node.has(key)) inh[key] = node.get(key);
      }
      const type = node.get('Type');
      const kids = this.resolve(node.get('Kids'));
      if (type === 'Page' || (!Array.isArray(kids) && node.has('Contents'))) {
        out.push({ ref: nodeRef, dict: node, inherited: inh });
        return;
      }
      if (Array.isArray(kids)) {
        for (const kid of kids) walk(kid, depth + 1, inh);
      }
    };
    walk(this.resolve(cat.get('Pages')), 0, {});
    return out;
  }

  getObjectCount() { return this.xref.size; }
}

// ---- 小工具 ----
function isWsChar(c) { return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00; }
function isRegularChar(c) {
  return !(isWsChar(c) || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e ||
    c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25);
}
function isRefLike(o) { return o instanceof Ref; }

function lastIndexOfBytes(hay, needle, from) {
  outer: for (let i = Math.min(from, hay.length - needle.length); i >= 0; i--) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

export { XrefEntry };