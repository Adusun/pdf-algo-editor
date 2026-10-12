// ============================================================================
// content.js — 内容流解释器：把内容流字节变成"显示列表"
// ----------------------------------------------------------------------------
// 内容流不是程序，而是一串"操作符 + 操作数"。解释器维护一个图形状态栈：
//   q  压栈快照        Q  弹栈恢复      cm  变换矩阵（乘到 CTM）
//   颜色: rg RG k K cs CS sc scn SCN G g
//   路径: m l c v y h re + 路径绘制
//   裁剪: W W*（把当前路径变成裁剪区）
//   文本: BT ET Tf Td TD Tm T* Tj TJ ' " Tc Tw Tz TL Ts Tr
//
// 输出的"显示列表"是一串 {op, ...} 记录，渲染器按序执行。
// 分离解释与渲染的好处：可以只跑解释器做文本提取，不必光栅化。
// ============================================================================

import { Lexer, Dict, Name, isDict, isName } from './lexer.js';
import { decodeStream } from './filters.js';
import { Matrix, Path } from './geometry.js';
import { Font } from './font.js';

/** 图形状态（PDF 32000-1 §9.4） */
class GState {
  constructor() {
    this.ctm = Matrix.identity();
    // 颜色：按空间分量保存 [0..1]
    this.fillCS = 'DeviceGray';
    this.strokeCS = 'DeviceGray';
    this.fillColor = [0];
    this.strokeColor = [0];
    // 线条
    this.lineWidth = 1;
    this.lineCap = 0;      // 0 butt, 1 round, 2 square
    this.lineJoin = 0;     // 0 miter, 1 round, 2 bevel
    this.miterLimit = 10;
    this.dash = null;
    // 文本
    this.font = null;
    this.fontSize = 0;
    this.charSpacing = 0;
    this.wordSpacing = 0;
    this.horizontalScale = 1;
    this.leading = 0;
    this.renderMode = 0;
    this.rise = 0;
    // 文本矩阵与行矩阵（文本状态机核心）
    this.textMatrix = Matrix.identity();
    this.lineMatrix = Matrix.identity();
    // 透明度与混合
    this.fillAlpha = 1;
    this.strokeAlpha = 1;
  }
  clone() {
    const g = new GState();
    Object.assign(g, this);
    g.ctm = this.ctm.clone();
    g.textMatrix = this.textMatrix.clone();
    g.lineMatrix = this.lineMatrix.clone();
    g.fillColor = this.fillColor.slice();
    g.strokeColor = this.strokeColor.slice();
    g.dash = this.dash ? this.dash.slice() : null;
    return g;
  }
}

/**
 * 解释一个页面的内容流，产出显示列表。
 * @param {Uint8Array} content 解码后的内容流字节
 * @param {object} resources 页面 /Resources 字典
 * @param {(x)=>any} resolve 解析间接引用
 * @returns {{ops: Array, textItems: Array}}
 */
export function interpretContent(content, resources, resolve) {
  const lex = new Lexer(content, 0);
  const ops = [];           // 显示列表
  const textItems = [];     // 提取出的文字（用于选择/搜索/复制）
  const warnings = [];

  let stack = [];           // 操作数栈
  let gs = new GState();        // 必须是 let：Q 算子要用 gs = gsStack.pop() 重新赋值
  const gsStack = [];
  let path = new Path();    // 当前路径
  let pathStarted = false;
  let pendingClip = null;   // W / W* 后的裁剪
  let inText = false;
  const fontCache = new Map();

  // 资源查找
  const resGet = (cat, name) => {
    if (!isDict(resources)) return null;
    const sub = resolve(resources.get(cat));
    if (!isDict(sub)) return null;
    return resolve(sub.get(name));
  };
  const getFont = (name) => {
    const key = String(name);
    if (fontCache.has(key)) return fontCache.get(key);
    const fd = resGet('Font', key);
    let f = null;
    if (isDict(fd)) {
      try { f = new Font(fd, resolve); }
      catch (e) { warnings.push(`字体 ${key} 加载失败: ${e.message}`); }
    }
    fontCache.set(key, f);
    return f;
  };
  /** 归一化颜色空间为一个"族名"字符串。
   *  入参可能是：Name 对象（来自 cs/CS）、普通字符串（我们内部存的就是字符串）、
   *  数组 [/Family /Hival /Lookup]（间接引用形式）。
   *  注意：字符串入参必须直接返回 —— 早期版本只处理 Name/数组，
   *  导致内部存的 'DeviceRGB' 退化成 'DeviceGray'，所有颜色都变黑。 */
  const colorSpaceOf = (cs) => {
    if (cs === null || cs === undefined) return 'DeviceGray';
    if (typeof cs === 'string') return cs;
    if (isName(cs)) return cs.name;
    if (Array.isArray(cs)) {
      const family = resolve(cs[0]);
      if (isName(family)) return family.name;
      if (typeof family === 'string') return family;
      return 'DeviceGray';
    }
    if (typeof cs === 'object' && 'name' in cs) return String(cs.name);
    return 'DeviceGray';
  };
  // 组件数（决定后面读几个操作数）
  const compsOf = (cs) => {
    switch (colorSpaceOf(cs)) {
      case 'DeviceGray': case 'CalGray': case 'G': return 1;
      case 'DeviceRGB': case 'CalRGB': case 'RGB': return 3;
      case 'DeviceCMYK': case 'CMYK': return 4;
      case 'Pattern': return 1;
      default: {
        // Indexed / Separation / DeviceN / ICCBased / Lab：从数组取名字
        if (Array.isArray(cs) && cs.length > 1) {
          const n = resolve(cs[1]);
          if (isName(n)) return n.name === 'DeviceN' ? (resolve(cs[2]) || []).length : 1;
        }
        return 1;
      }
    }
  };

  /**
   * 访问操作数。PDF 操作符的操作数从栈顶（末尾）往回取，
   * 所以统一用负下标：num(-1) 是最后一个，num(-3) 是倒数第三个。
   * 早期版本用 num(0)/num(1) 从栈底取，导致 rg 的 r/g/b 整体错位。
   */
  const num = (fromEnd) => {
    const v = stack[stack.length + fromEnd];   // fromEnd 为负数
    return typeof v === 'number' ? v : 0;
  };
  const pushOp = (o) => { ops.push(o); };
  /** 栈顶操作数（最后压入的那个） */
  const lastOperand = () => (stack.length ? stack[stack.length - 1] : undefined);

  // ---- 主循环：取操作数 / 执行操作符 ----
  for (;;) {
    lex.skipWhite();
    if (lex.pos >= content.length) break;
    const before = lex.pos;
    const obj = lex.parseObject(null);

    if (obj === null || obj === undefined) {
      if (lex.pos === before) lex.pos++;      // 防死循环
      continue;
    }
    if (typeof obj === 'number') { stack.push(obj); continue; }
    if (obj instanceof Uint8Array) { stack.push(obj); continue; }
    if (obj instanceof Name) { stack.push(obj); continue; }
    if (Array.isArray(obj)) { stack.push(obj); continue; }
    if (isDict(obj)) { stack.push(obj); continue; }
    if (obj && obj.__unknown !== undefined) {
      const op = obj.__unknown;
      try {
        executeOperator(op);
      } catch (e) {
        warnings.push(`操作符 ${op} 执行失败: ${e.message}`);
      }
      stack = [];
      continue;
    }
    if (lex.pos === before) lex.pos++;
  }

  function executeOperator(op) {
    switch (op) {
      // ---- 状态管理 ----
      case 'q': gsStack.push(gs.clone()); break;
      case 'Q': if (gsStack.length) gs = gsStack.pop(); break;
      case 'cm': {
        const m = new Matrix(num(-6), num(-5), num(-4), num(-3), num(-2), num(-1));
        gs.ctm = m.multiply(gs.ctm);   // cm 后置：CTM = M × CTM
        break;
      }

      // ---- 颜色 ----
      case 'g': gs.fillCS = 'DeviceGray'; gs.fillColor = [num(-1)]; break;
      case 'G': gs.strokeCS = 'DeviceGray'; gs.strokeColor = [num(-1)]; break;
      case 'rg': gs.fillCS = 'DeviceRGB'; gs.fillColor = [num(-3), num(-2), num(-1)]; break;
      case 'RG': gs.strokeCS = 'DeviceRGB'; gs.strokeColor = [num(-3), num(-2), num(-1)]; break;
      case 'k': gs.fillCS = 'DeviceCMYK'; gs.fillColor = [num(-4), num(-3), num(-2), num(-1)]; break;
      case 'K': gs.strokeCS = 'DeviceCMYK'; gs.strokeColor = [num(-4), num(-3), num(-2), num(-1)]; break;
      case 'cs': {
const csn = lastOperand();
        gs.fillCS = colorSpaceOf(csn);
        gs.fillColor = new Array(compsOf(csn)).fill(0);
        break;
      }
      case 'CS': {
      const csn = lastOperand();
     gs.strokeCS = colorSpaceOf(csn);
      gs.strokeColor = new Array(compsOf(csn)).fill(0);
        break;
      }
      case 'sc': gs.fillColor = stack.slice(-compsOf(gs.fillCS)).map((v) => (typeof v === 'number' ? v : 0)); break;
      // SCN / scn 见下方
      case 'scn': {
        const pat = stack.find((s) => isName(s));
        gs.fillColor = stack.filter((v) => typeof v === 'number');
        if (pat) gs.fillPattern = pat.name;
        break;
      }
      case 'SC': gs.strokeColor = stack.slice(-compsOf(gs.strokeCS)).map((v) => (typeof v === 'number' ? v : 0)); break;
      case 'SCN': {
        const pat = stack.find((s) => isName(s));
        gs.strokeColor = stack.filter((v) => typeof v === 'number');
        if (pat) gs.strokePattern = pat.name;
        break;
      }

      // ---- 路径构建 ----
      case 'm': path.moveTo(num(-2), num(-1)); pathStarted = true; break;
      case 'l': path.lineTo(num(-2), num(-1)); break;
      case 'c': path.curveTo(num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)); break;
      case 'v': path.curveTo(num(-4), num(-3), num(-2), num(-1), num(-2), num(-1)); break;
      case 'y': path.curveTo(num(-4), num(-3), num(-2), num(-1), num(-2), num(-1)); break;
      case 'h': path.close(); break;
      case 're': {
   // re 的操作数是 x y w h，从栈顶往回取
        const x = num(-4), y = num(-3), w = num(-2), h = num(-1);
        path.moveTo(x, y);
        path.lineTo(x + w, y);
        path.lineTo(x + w, y + h);
        path.lineTo(x, y + h);
        path.close();
        pathStarted = true;
        break;
      }

      // ---- 路径绘制 ----
      case 'n': path = new Path(); pathStarted = false; pendingClip = null; break;
      case 'f': case 'F': finishPath('fill', 'nonzero'); break;
      case 'f*': finishPath('fill', 'evenodd'); break;
      case 'S': finishPath('stroke', null); break;
      case 's': finishPath('stroke', null, true); break;
      case 'B': finishPath('fill-stroke', 'nonzero'); break;
      case 'B*': finishPath('fill-stroke', 'evenodd'); break;
      case 'b': finishPath('fill-stroke', 'nonzero', true); break;
      case 'b*': finishPath('fill-stroke', 'evenodd', true); break;

      // ---- 裁剪 ----
      case 'W': pendingClip = 'nonzero'; break;
      case 'W*': pendingClip = 'evenodd'; break;

      // ---- 线条属性 ----
      case 'w': gs.lineWidth = num(-1); break;
      case 'J': gs.lineCap = Math.round(num(-1)); break;
      case 'j': gs.lineJoin = Math.round(num(-1)); break;
      case 'M': gs.miterLimit = num(-1); break;
      case 'd': gs.dash = stack.filter((v) => typeof v === 'number').slice(); break;

      // ---- 文本 ----
      case 'BT':
        inText = true;
        gs.textMatrix = Matrix.identity();
        gs.lineMatrix = Matrix.identity();
        break;
      case 'ET': inText = false; break;
      case 'Tf': {
        // 操作数是 "/F1 12"：字体名在栈底，字号在栈顶。
        // 必须用 stack.length-2 取名字、num(-1) 取字号。
        const fname = stack.length >= 2 && stack[stack.length - 2] instanceof Name
          ? stack[stack.length - 2].name : null;
        gs.font = fname ? getFont(fname) : null;
        gs.fontSize = num(-1);
        break;
      }
      case 'Td': {
  gs.lineMatrix = new Matrix(1, 0, 0, 1, num(-2), num(-1)).multiply(gs.lineMatrix);
        gs.textMatrix = gs.lineMatrix.clone();
        break;
      }
      case 'TD': {
     gs.leading = -num(-1);
        gs.lineMatrix = new Matrix(1, 0, 0, 1, num(-2), num(-1)).multiply(gs.lineMatrix);
        gs.textMatrix = gs.lineMatrix.clone();
        break;
      }
      case 'Tm': {
        gs.lineMatrix = new Matrix(num(-6), num(-5), num(-4), num(-3), num(-2), num(-1));
        gs.textMatrix = gs.lineMatrix.clone();
        break;
      }
      case 'T*': {
        nextLine();
        break;
      }
      case 'TL': gs.leading = num(-1); break;
      case 'Tc': gs.charSpacing = num(-1); break;
      case 'Tw': gs.wordSpacing = num(-1); break;
      case 'Tz': gs.horizontalScale = num(-1) / 100; break;
      case 'Ts': gs.rise = num(-1); break;
      case 'Tr': gs.renderMode = Math.round(num(-1)); break;
      // Tj 的字符串永远是栈顶最后压入的那个
      case 'Tj': if (lastOperand() instanceof Uint8Array) showText(lastOperand()); break;
      case "'": nextLine(); if (lastOperand() instanceof Uint8Array) showText(lastOperand()); break;
      case '"': {
        // "  操作数：aw ac string  ->  词间距 字间距 字符串
     gs.wordSpacing = num(-3); gs.charSpacing = num(-2);
        nextLine();
        if (lastOperand() instanceof Uint8Array) showText(lastOperand());
        break;
      }
      case 'TJ': {
        const arr = stack.find((s) => Array.isArray(s));
        if (arr) showTextArray(arr);
        break;
      }

      // ---- XObject ----
      case 'Do': {
   const nm = lastOperand() instanceof Name ? lastOperand().name : null;
        if (nm) drawXObject(nm);
        break;
      }
      case 'sh': { pushOp({ op: 'shading', name: 'sh', gs: gs.clone() }); break; }

      // ---- 内联图像 ----
      case 'BI': {
        parseInlineImage(lex);
        break;
      }

      // ---- 标记内容 ----
      case 'MP': case 'DP': break;   // 标记/附注点：不影响渲染

      // ---- 兼容标记 ----
      case 'BX': case 'EX': break;   // PDF/X 段落：忽略

      default:
        // 未知操作符：忽略（真实 PDF 里很常见）
        break;
    }
  }

  function nextLine() {
    gs.lineMatrix = new Matrix(1, 0, 0, 1, 0, -gs.leading).multiply(gs.lineMatrix);
    gs.textMatrix = gs.lineMatrix.clone();
  }

  /** 结束当前路径并生成绘制指令。
   *  关键（PDF 32000-1 §8.5.1）：**所有**绘制算子（f/S/B/b…）在执行前
   *  都会隐式闭合当前路径里所有未闭合的子路径。内容流里写
   *  "x y m x y l x y l f"（没有 h）是极常见的，缺了这步三角形会完全填不上。 */
  function finishPath(kind, rule, closeFirst = false) {
    if (closeFirst) path.close();
    // 隐式闭合：扫描线填充需要闭合轮廓
    for (const sp of path.subpaths) if (!sp.closed && sp.pts.length >= 4) sp.closed = true;

    if (pathStarted && path.subpaths.length) {
      const devicePath = new Path();
      for (const sp of path.subpaths) devicePath.subpaths.push({ pts: sp.pts.slice(), closed: sp.closed });
      devicePath.transform(gs.ctm);

      // 顺序很重要：W/W* 定义的裁剪区必须**先**于用这条路径的绘制生效。
      // PDF 规范里 "re W f" 的语义是"用这条路径裁剪并填充"，
      // 若先 push fill 再 push clip，渲染时会先画再裁，等于没裁。
      if (pendingClip) {
        pushOp({ op: 'clip', path: devicePath, rule: pendingClip });
      }
      if (kind.includes('fill')) {
        pushOp({
          op: 'fill', path: devicePath, rule,
          color: toRGB(gs.fillColor, gs.fillCS), alpha: gs.fillAlpha,
        });
      }
      if (kind.includes('stroke')) {
        pushOp({
          op: 'stroke', path: devicePath,
          color: toRGB(gs.strokeColor, gs.strokeCS), alpha: gs.strokeAlpha,
          lineWidth: gs.lineWidth * gs.ctm.scaleFactor(),
          lineCap: gs.lineCap, lineJoin: gs.lineJoin, miterLimit: gs.miterLimit,
        });
      }
    }
    path = new Path();
    pathStarted = false;
    pendingClip = null;
  }

  /** 分量数组 -> RGB（0..255） */
  function toRGB(comps, csName) {
    const c = (i) => (comps && comps.length > i ? Number(comps[i]) || 0 : 0);
    switch (colorSpaceOf(csName)) {
      case 'DeviceRGB': case 'CalRGB': case 'RGB':
        return { r: c(0) * 255, g: c(1) * 255, b: c(2) * 255, a: 1 };
      case 'DeviceCMYK': case 'CMYK': {
        const cc = c(0), m = c(1), y = c(2), k = c(3);
        return {
          r: 255 * (1 - Math.min(1, cc + k)),
          g: 255 * (1 - Math.min(1, m + k)),
          b: 255 * (1 - Math.min(1, y + k)),
          a: 1,
        };
      }
      case 'CalGray': case 'G':
        return { r: c(0) * 255, g: c(0) * 255, b: c(0) * 255, a: 1 };
      default:
        if (comps && comps.length >= 3) {
          return { r: c(0) * 255, g: c(1) * 255, b: c(2) * 255, a: 1 };
        }
        return { r: c(0) * 255, g: c(0) * 255, b: c(0) * 255, a: 1 };
    }
  }

  /**
   * 文字显示的核心。PDF 的文本定位不是简单地"往前走 w 像素"：
   * 每个字形的变换矩阵是
   *     Trm = [Tfs*Th, 0, 0, Tfs, 0, Ts] × Tm × CTM
   * 然后用 tx 推进文本矩阵。这样才能正确处理任意 Tm/CTM 组合。
   */
  function showText(bytes) {
    if (!gs.font) return;
    const chars = gs.font.decode(bytes);
    for (const ch of chars) {
      const w0 = gs.font.charWidth(ch.code) / 1000;
      const isSpaceByte = !gs.font.type0 && ch.code === 32;
      let tx = (w0 * gs.fontSize + gs.charSpacing + (isSpaceByte ? gs.wordSpacing : 0)) * gs.horizontalScale;

      // 文本渲染矩阵
      const trm = new Matrix(
        gs.fontSize * gs.horizontalScale, 0, 0, gs.fontSize, 0, gs.rise
      ).multiply(gs.textMatrix).multiply(gs.ctm);

// 记录文字项（供选择/搜索），坐标为设备空间。
      // 注意：空格也要记录 —— 它没有字形轮廓，但复制文本时必须保留，
      // 否则 "Hello Classic" 会被拼成 "HelloClassic"。
      if (ch.unicode && ch.unicode.length) {
     // 关键：必须取**当前字形原点**，也就是 textMatrix 作用在 (0,0) 上，
        // 而不是字形包围盒的左上角 —— 否则每个字符的 x 都相同，无法排序与选中。
        const [bx, by] = gs.textMatrix.apply(0, 0);
        const [dx, dy] = gs.ctm.apply(bx, by);
        const scale = gs.ctm.scaleFactor();
        const sizeApprox = Math.abs(gs.fontSize * scale);
        const adv = w0 * gs.fontSize * gs.horizontalScale * scale;
        textItems.push({
          unicode: ch.unicode,
x: dx, y: dy,
          // 前进宽度：用字体的实际宽度，而不是矩阵推出的近似值
     width: Math.abs(adv) || sizeApprox * 0.5,
    height: sizeApprox,
          fontSize: sizeApprox,
   isSpace: !ch.unicode.trim(),
// 变换矩阵：字形轮廓需要用它变换
          trm: trm.clone(),
          page: null,
        });
      }

      // 渲染字形轮廓
      if (gs.renderMode !== 3 && gs.renderMode !== 7) {
        const gp = gs.font.glyphPath(ch.code);
        if (gp && gp.subpaths.length) {
          const glyphDevice = new Path();
          for (const sp of gp.subpaths) glyphDevice.subpaths.push({ pts: sp.pts.slice(), closed: sp.closed });
          // 字形坐标是 1000 em 单位，需除以 1000 再乘文本矩阵
          glyphDevice.transform(new Matrix(1 / 1000, 0, 0, 1 / 1000, 0, 0));
          glyphDevice.transform(trm);
          pushOp({
            op: 'fill', path: glyphDevice, rule: 'nonzero',
            color: toRGB(gs.fillColor, gs.fillCS),
            alpha: gs.fillAlpha * (gs.renderMode === 7 ? 0 : 1),
            isText: true,
          });
        }
      }

      // 推进文本矩阵
      gs.textMatrix = new Matrix(1, 0, 0, 1, tx, 0).multiply(gs.textMatrix);
    }
  }

  /** TJ 数组：字符串之间穿插数值，数值是额外的字间距（千分之一 em） */
  function showTextArray(arr) {
    for (const item of arr) {
      if (item instanceof Uint8Array) {
        showText(item);
      } else if (typeof item === 'number') {
        const tx = (-item / 1000) * gs.fontSize * gs.horizontalScale;
        gs.textMatrix = new Matrix(1, 0, 0, 1, tx, 0).multiply(gs.textMatrix);
      }
    }
  }

  /** 绘制 XObject（表单或图像） */
  function drawXObject(name) {
    const xo = resGet('XObject', name);
    if (!isDict(xo)) return;
    const st = resolve(xo.get('Subtype'));
    const subtype = isName(st) ? st.name : null;

    if (subtype === 'Form') {
      // 表单 XObject：建立新 CTM，然后递归解释其内容流
      const matrix = resolve(xo.get('Matrix'));
      const inner = resolve(xo.get('Resources')) || resources;
      const contentRef = resolve(xo.get('Contents'));
      let innerContent = null;
      if (Array.isArray(contentRef)) {
        const parts = [];
        for (const r of contentRef) {
          const s = resolve(r);
          if (s && s.raw !== undefined) {
            try { parts.push(decodeStream(s, resolve).data); } catch { }
          }
        }
        innerContent = concatBytes(parts);
      } else if (contentRef && contentRef.raw !== undefined) {
        try { innerContent = decodeStream(contentRef, resolve).data; } catch { }
      }
      if (!innerContent) return;

      const savedGs = gs;
      let newCtm = gs.ctm;
      if (Array.isArray(matrix) && matrix.length === 6) {
        newCtm = new Matrix(
          Number(resolve(matrix[0])), Number(resolve(matrix[1])),
          Number(resolve(matrix[2])), Number(resolve(matrix[3])),
          Number(resolve(matrix[4])), Number(resolve(matrix[5]))
        ).multiply(gs.ctm);
      }
      const sub = interpretContent(innerContent, inner, resolve);
      // 子结果里的坐标已经是新 CTM 下的，直接并入
      ops.push(...sub.ops);
      textItems.push(...sub.textItems.map(t => ({ ...t })));
      gs = savedGs;
      pushOp({ op: 'xobject-begin', name, ctm: newCtm });
      return;
    }

    if (subtype === 'Image') {
      pushOp({
        op: 'image', name,
        stream: xo,
        ctm: gs.ctm.clone(),
        resources,
      });
    }
  }

  /** 内联图像 BI ... ID <bytes> EI */
  function parseInlineImage(lex) {
    // 简化处理：跳过内联图像内容（真实场景少见）
    const idx = indexOfBytes(content, lex.pos, 'EI');
    if (idx > 0) lex.pos = idx + 2;
  }

  return { ops, textItems, warnings };
}

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

function indexOfBytes(hay, from, needle) {
  const n = new TextEncoder().encode(needle);
  for (let i = from; i <= hay.length - n.length; i++) {
    let match = true;
    for (let k = 0; k < n.length; k++) if (hay[i + k] !== n[k]) { match = false; break; }
    if (match) return i;
  }
  return -1;
}

/**
 * 提取页面全部文字（含位置），这是选中/搜索/复制的基础。
 * 单独包装一层便于按页调用。
 */
export function extractPageText(doc, pageIndex) {
  const pages = doc.pages();
  if (pageIndex < 0 || pageIndex >= pages.length) return [];
  const pg = doc.resolve(pages[pageIndex].ref);
  const inherited = pages[pageIndex].inherited || {};
  const res = doc.resolve(pg.get('Resources') || inherited.Resources);
  const contents = doc.resolve(pg.get('Contents'));

  let content = null;
  if (Array.isArray(contents)) {
    const parts = [];
    for (const r of contents) {
      const s = doc.resolve(r);
      if (s && s.raw !== undefined) {
        try { parts.push(decodeStream(s, (x) => doc.resolve(x)).data); } catch { }
      }
    }
    content = concatBytes(parts);
  } else if (contents && contents.raw !== undefined) {
    try { content = decodeStream(contents, (x) => doc.resolve(x)).data; } catch { }
  }
  if (!content) return [];

  const r = interpretContent(content, res, (x) => doc.resolve(x));
  return r.textItems.map(t => ({ ...t, page: pageIndex }));
}

/** 把显示列表执行到光栅器/Canvas 上 */
export function renderOps(ops, target, opts = {}) {
  const { Rasterizer, clipMaskFromPaths, Color, drawImage } = opts;
  if (!Rasterizer) return;
  const raster = new Rasterizer(target.width, target.height, target.data, { subsamples: opts.quality || 5 });
  let clipMask = null;
  const clipStack = [];

  for (const o of ops) {
    switch (o.op) {
      case 'fill':
        raster.setClipMask(clipMask);
        raster.fillPath(o.path, new Color(o.color.r, o.color.g, o.color.b, (o.color.a ?? 1) * (o.alpha ?? 1)), o.rule);
        break;
      case 'stroke':
        raster.setClipMask(clipMask);
        raster.strokePath(o.path, new Color(o.color.r, o.color.g, o.color.b, (o.color.a ?? 1) * (o.alpha ?? 1)),
          Math.max(o.lineWidth, 0.1));
        break;
      case 'clip': {
        const m = clipMaskFromPaths([o.path], target.width, target.height, opts.quality || 5);
        if (clipMask && m) {
          // 裁剪求交
          for (let i = 0; i < clipMask.length; i++) clipMask[i] = Math.round((clipMask[i] * m[i]) / 255);
        } else clipMask = m;
        clipStack.push(clipMask);
        break;
      }
      case 'image':
        raster.setClipMask(clipMask);
        if (opts.drawImage && o.stream) {
          const img = opts.decodeImage(o.stream);
          if (img) {
            const [x0, y0, x1, y1] = o.path ? o.path.bounds() : [0, 0, target.width, target.height];
            drawImage(target, img, [x0, y0, x1, y1], o.ctm.invert(), o.alpha ?? 1);
          }
        }
        break;
    }
  }
}