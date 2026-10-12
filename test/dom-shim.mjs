// ============================================================================
// dom-shim.mjs — 最小 DOM / Canvas 垫片
// 只实现 app.js 真正用到的那部分接口，但**语义要真**：
// createImageData 返回带真实 data 缓冲的对象，putImageData 记录内容，
// getContext 返回可测量、可绘制的 2D 上下文。
// 这样 ui.test.mjs 才能对"页面上到底画了什么像素"做断言。
// ============================================================================

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...cs) { for (const c of cs) this.set.add(c); this._sync(); }
  remove(...cs) { for (const c of cs) this.set.delete(c); this._sync(); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { if (on === undefined) { if (this.set.has(c)) this.remove(c); else this.add(c); } else if (on) this.add(c); else this.remove(c); }
  get value() { return [...this.set].join(' '); }
  _sync() { this.el._className = [...this.set].join(' '); }
}

class Node_ {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList(this);
    this._listeners = {};
    this._text = '';
    this.disabled = false;
    this.value = '';
    this.files = [];
    this._className = '';
    this.width = 300; this.height = 150;
  }
  set className(v) {
    this._className = String(v);
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return this.classList.set.size ? [...this.classList.set].join(' ') : this._className;
  }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join('');
    return this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._text; }
  set id(v) { this.attributes.id = v; this._id = v; this.dataset.id = v; }
  get id() { return this._id || this.attributes.id || ''; }
  appendChild(c) {
    if (c instanceof Node_) { c.parentNode = this; this.children.push(c); }
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  contains(n) {
    if (n === this) return true;
    return this.children.some(c => c.contains && c.contains(n));
  }
  setAttribute(k, v) { this.attributes[k] = v; if (k.startsWith('data-')) this.dataset[k.slice(5)] = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) {
    if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter(f => f !== fn);
  }
  dispatchEvent(e) {
    // 允许传字符串（等价于 { type }），浏览器里 click() 也是这么用的
    if (typeof e === 'string') e = { type: e };
    if (!e.target) e.target = this;
    e.preventDefault = e.preventDefault || (() => { });
    e.stopPropagation = e.stopPropagation || (() => { });
    // 冒泡到父链
    let n = this;
    while (n) {
      const ls = n._listeners[e.type] || [];
      for (const fn of ls) fn(e);
      n = n.parentNode;
    }
    return true;
  }
  click() { this._clicked = true; }
  setPointerCapture() { }
  releasePointerCapture() { }
  get clientWidth() { return 1000; }
  get clientHeight() { return 800; }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width, height: this.height, right: this.width, bottom: this.height };
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (match(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function match(el, sel) {
  if (typeof sel !== 'string') return false;
  sel = sel.trim();
  if (!sel) return false;
  // 逗号分隔：任一匹配即可
  if (sel.includes(',')) return sel.split(',').some(s => match(el, s));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('[')) {
    // [data-tool="x"]
    const m = /\[data-(\w+)="?([^\]"]*)"?\]/.exec(sel);
    return !!m && el.dataset[m[1]] === m[2];
  }
  return el.tagName === sel.toUpperCase();
}

/** 真实语义的 2D 上下文：记录最后一次 putImageData 的像素 */
class Ctx2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000'; this.strokeStyle = '#000';
    this.lineWidth = 1; this.globalAlpha = 1;
    this.lineCap = 'butt'; this.lineJoin = 'miter';
    this.__lastImageData = null;
  }
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  getImageData(x, y, w, h) {
    const src = this.__lastImageData;
    const out = this.createImageData(w, h);
    if (src) {
      for (let r = 0; r < h; r++) {
        const si = ((y + r) * src.width + x) * 4;
        const di = r * w * 4;
        for (let k = 0; k < w * 4; k++) out.data[di + k] = src.data[si + k];
      }
    }
    return out;
  }
  putImageData(img) { this.__lastImageData = img; this.canvas._last = img; }
  clearRect() { }
  fillRect() { }
  strokeRect() { }
  beginPath() { }
  moveTo() { }
  lineTo() { }
  stroke() { }
  fill() { }
  save() { }
  restore() { }
  translate() { }
  scale() { }
  setTransform() { }
  drawImage() { }
  measureText(t) { return { width: String(t).length * 6 }; }
}

class Canvas extends Node_ {
  constructor() { super('canvas'); this._ctx = new Ctx2D(this); }
  getContext() { return this._ctx; }
}

class Blob_ {
  constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; this.size = parts.reduce((s, p) => s + (p.length || 0), 0); }
}

class ImageData_ {
  constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
}

export const JSDOMLike = {
  async create() {
    const doc = new Node_('body');
    doc.body = doc;      // app.js 会设置 document.body.style.cursor

    doc.createElement = (tag) => {
      const t = String(tag).toLowerCase();
      return t === 'canvas' ? new Canvas() : new Node_(t);
    };
    // index.html 里的元素按 id/class 预置
    const mk = (tag, id, text, extra) => {
      const n = new Node_(tag);
      if (id) { n.id = id; n.dataset.id = id; }
      if (text) n.textContent = text;
      if (extra) Object.assign(n, extra);
      doc.appendChild(n);
      return n;
    };
    mk('input', 'file');
    mk('button', 'btnDemo', '载入内置示例');
    mk('div', 'drop');
    mk('button', 'btnSave', '保存（增量）');
    mk('button', 'btnFull', '另存为（重写）');
    const toolbar = mk('div', 'toolbar');
    const tools = [
      ['none', '浏览'], ['highlight', '高亮'], ['underline', '下划线'],
      ['ink', '墨迹'], ['note', '便签'],
    ];
    for (const [t, label] of tools) {
      const b = new Node_('button');
      b.className = 'tool';
      b.dataset.tool = t;
      b.textContent = label;
      toolbar.appendChild(b);
    }
    const pages = mk('div', 'pages');
    mk('div', 'empty');
    // 侧栏
    for (const id of ['iPages', 'iObjs', 'iSize', 'iMode', 'textout', 'iAnnots']) {
      const n = mk('div', id, id.startsWith('i') ? '—' : '');
      n.textContent = id.startsWith('i') ? '—' : '—';
    }
    mk('div', 'log');
    mk('span', 'zoomVal', '100%');
    mk('div', 'widthVal', '2');
    mk('input', 'color');
    mk('input', 'range', '');
    const rangeNode = doc.children[doc.children.length - 1];
    rangeNode.id = 'width';
    // 附加按钮
    // app.js 里通过 $('#btnXxx') 直接取用的按钮，id 必须齐全
    mk('button', 'btnRotL', '左转 90°');
    mk('button', 'btnRotR', '右转 90°');
    mk('button', 'btnDel', '删除页');
    mk('button', 'btnAdd', '插入空白页');
    mk('button', 'btnZoomOut', '−');
    mk('button', 'btnZoomIn', '+');
    mk('button', 'btnFit', '适应宽度');
    // 再补几个纯文本按钮（app.js 用 textContent 查找）
    const extra = ['−', '+', '适应宽度', '左转 90°', '右转 90°', '删除页', '插入空白页'];
    for (const label of extra) mk('button', '', label);

    // pages 需要能查询到 .page-wrap / canvas / .page-no / .tool
    doc.querySelectorAll = (sel) => Node_.prototype.querySelectorAll.call(doc, sel);

    const window = {
      devicePixelRatio: 1,
      addEventListener: doc.addEventListener.bind(doc),
      removeEventListener: doc.removeEventListener.bind(doc),
    };
    return {
      document: doc, window,
      performance: { now: () => Date.now() },
      Blob: Blob_, ImageData: ImageData_,
      cleanup() { },
    };
  },
};

// Node_ 导出以便测试里 instanceof 判断
export { Node_, Canvas };