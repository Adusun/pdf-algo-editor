// ============================================================================
// geometry.js — 仿射矩阵、路径构建、贝塞尔扁平化、描边扩展
// ----------------------------------------------------------------------------
// PDF 的坐标系统：原点在页面左下角，y 轴向上（数学惯例）。
// 但光栅化通常以左上为原点、y 向下（屏幕惯例）。
// 这个翻转由 base-ctm 算子通过 [1 0 0 -1 0 H] 完成，
// 整个渲染管线里只有这一处做坐标翻转，其余全用 PDF 原生坐标，
// 这样文字不会上下颠倒、镜像变换也天然正确。
// ============================================================================

/**
 * 2D 仿射变换矩阵 [a b c d e f]，与 PDF 规范一致：
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * 存成 [a,b,c,d,e,f] 六个数，平移在最��个。
 */
export class Matrix {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
  }
  static identity() { return new Matrix(); }
  static fromArray(m) { return new Matrix(m[0], m[1], m[2], m[3], m[4], m[5]); }
  toArray() { return [this.a, this.b, this.c, this.d, this.e, this.f]; }
  clone() { return new Matrix(this.a, this.b, this.c, this.d, this.e, this.f); }

  /** this × other：先施加 this 再施加 other（PDF 的 cm/q/Q 语义） */
  multiply(o) {
    return new Matrix(
      this.a * o.a + this.b * o.c,
      this.a * o.b + this.b * o.d,
      this.c * o.a + this.d * o.c,
      this.c * o.b + this.d * o.d,
      this.e * o.a + this.f * o.c + o.e,
      this.e * o.b + this.f * o.d + o.f
    );
  }
  translate(tx, ty) { return this.multiply(new Matrix(1, 0, 0, 1, tx, ty)); }
  scale(sx, sy) { return this.multiply(new Matrix(sx, 0, 0, sy, 0, 0)); }
  /** 绕原点旋转（弧度） */
  rotate(rad) {
    const cs = Math.cos(rad), sn = Math.sin(rad);
    return this.multiply(new Matrix(cs, sn, -sn, cs, 0, 0));
  }
  apply(x, y) {
    return [
      this.a * x + this.c * y + this.e,
      this.b * x + this.d * y + this.f,
    ];
  }
  /** 变换方向向量（忽略平移），用于把线宽等量从用户空间转到设备空间 */
  applyVector(x, y) {
    return [this.a * x + this.c * y, this.b * x + this.d * y];
  }
  determinant() { return this.a * this.d - this.b * this.c; }
  /** 求逆。行列式为 0 时返回单位矩阵（PDF 规范允许这种情况不报错） */
  invert() {
    const det = this.determinant();
    if (Math.abs(det) < 1e-12) return Matrix.identity();
    return new Matrix(
      this.d / det, -this.b / det,
      -this.c / det, this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det
    );
  }
  /**
   * 尺度因子：用于把用户空间的线宽换算到设备空间。
   * 取两个正交基向量的平均缩放，避免非等比缩放时算出 0。
   */
  scaleFactor() {
    const sx = Math.hypot(this.a, this.b);
    const sy = Math.hypot(this.c, this.d);
    return (sx + sy) / 2 || 1;
  }
}

/**
 * 路径：一组子路径（subpath）。每个子路径是若干点，首点是否闭合单独标记。
 * 内部统一用扁平化的折线表示 —— PDF 的贝塞尔在光栅化前会先离散化。
 */
export class Path {
  constructor() { this.subpaths = []; this.cur = null; }
  moveTo(x, y) {
    this.cur = { pts: [x, y], closed: false };
    this.subpaths.push(this.cur);
    return this;
  }
  lineTo(x, y) {
    if (!this.cur) return this.moveTo(x, y);
    this.cur.pts.push(x, y);
    return this;
  }
  curveTo(x1, y1, x2, y2, x3, y3) {
    if (!this.cur) this.moveTo(x1, y1);
    const pts = this.cur.pts;
    const x0 = pts[pts.length - 2], y0 = pts[pts.length - 1];
    // 自适应细分：用控制多边形长度估误差，平直线段不会被过度细分
    const segs = estimateSegments(x0, y0, x1, y1, x2, y2, x3, y3);
    for (let i = 1; i <= segs; i++) {
      const t = i / segs, mt = 1 - t;
      // 三次贝塞尔的标准幂基展开
      const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      pts.push(
        b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3,
        b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3
      );
    }
    return this;
  }
  /** 二次贝塞尔（TrueType 字形用） */
  quadTo(x1, y1, x2, y2) {
    if (!this.cur) this.moveTo(x1, y1);
    const pts = this.cur.pts;
    const x0 = pts[pts.length - 2], y0 = pts[pts.length - 1];
    const segs = Math.max(2, Math.min(32, Math.ceil(
      (Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1)) / 3
    )));
    for (let i = 1; i <= segs; i++) {
      const t = i / segs, mt = 1 - t;
      pts.push(
        mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
        mt * mt * y0 + 2 * mt * t * y1 + t * t * y2
      );
    }
    return this;
  }
  close() { if (this.cur) this.cur.closed = true; return this; }
  get isEmpty() { return this.subpaths.length === 0 || this.subpaths.every(s => s.pts.length < 4); }

  /** 应用矩阵到所有点 */
  transform(m) {
    for (const sp of this.subpaths) {
      const p = sp.pts;
      for (let i = 0; i < p.length; i += 2) {
        const [x, y] = m.apply(p[i], p[i + 1]);
        p[i] = x; p[i + 1] = y;
      }
    }
    return this;
  }
  /** 闭包时补上重复的起点，方便扫描线统一处理 */
  normalize() {
    for (const sp of this.subpaths) {
      if (sp.closed && sp.pts.length >= 4) {
        const n = sp.pts.length;
        if (sp.pts[n - 2] !== sp.pts[0] || sp.pts[n - 1] !== sp.pts[1]) {
          sp.pts.push(sp.pts[0], sp.pts[1]);
        }
      }
    }
    return this;
  }
  /** 边界框 [x0,y0,x1,y1] */
  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sp of this.subpaths) {
      const p = sp.pts;
      for (let i = 0; i < p.length; i += 2) {
        if (p[i] < x0) x0 = p[i];
        if (p[i] > x1) x1 = p[i];
        if (p[i + 1] < y0) y0 = p[i + 1];
        if (p[i + 1] > y1) y1 = p[i + 1];
      }
    }
    if (x0 === Infinity) return [0, 0, 0, 0];
    return [x0, y0, x1, y1];
  }
  /**
   * 描边 -> 填充路径。
   * PDF 的描边有 3 种连接（miter/round/bevel）和 3 种端点（butt/round/square），
   * 完整实现需要生成 stroke outline。实用做法：
   *   1) 每一段生成一个四边形（覆盖线段主体）
   *   2) 每个折点加一个圆盘（round 连接/端点自然被覆盖）
   *   3) miter 连接按 miter limit 决定是否加尖角四边形
   * 所有子路径最后用 nonzero 填充，圆盘与四边形重叠处不产生空洞。
   */
  strokeToPath(lineWidth) {
    const hw = Math.max(lineWidth, 0.1) / 2;
    const out = new Path();
    const MI = 10; // PDF 默认 miter limit
    for (const sp of this.subpaths) {
      const p = sp.pts;
      const n = p.length / 2;
      if (n < 2) {
        // 单点：按端点样式画个小方块/圆
        if (n === 1) {
          const [cx, cy] = sp.closed ? [p[0], p[1]] : [p[0], p[1]];
          out.subpaths.push(circleSubpath(cx, cy, hw));
        }
        continue;
      }
      const last = n - 1;   // normalize() 已补齐闭合点，线性遍历即可
      for (let i = 0; i < last; i++) {
        const j = (i + 1) % n;
        const x0 = p[i * 2], y0 = p[i * 2 + 1];
        const x1 = p[j * 2], y1 = p[j * 2 + 1];
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        // 法线 = 方向逆时针转 90 度
        const nx = (-dy / len) * hw, ny = (dx / len) * hw;
        const s = { pts: [], closed: true };
        // 端点样式：非闭合路径首尾用 butt（不外扩），内部延伸不到外面
        s.pts.push(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny);
        out.subpaths.push(s);
      }
      // 折点圆盘：实现 round 连接与 round 端点
      const startIdx = sp.closed ? 0 : 1;
      const endIdx = sp.closed ? n : n - 1;
      for (let i = startIdx; i < endIdx; i++) {
        out.subpaths.push(circleSubpath(p[i * 2], p[i * 2 + 1], hw));
      }
    }
    return out;
  }
}

/** 生成圆盘子路径（用于 round 连接/端点） */
function circleSubpath(cx, cy, r, segs = 16) {
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  pts.push(cx + r, cy);
  return { pts, closed: true };
}

/**
 * 三次贝塞尔离散段数估算。
 * 误差上界约 (3/4)*max(|P0-2P1+P2|, |P1-2P2+P3|)，控制在 0.2 像素内即可。
 * 平直线段（控制点共线）返回 1，避免无意义的细分。
 */
function estimateSegments(x0, y0, x1, y1, x2, y2, x3, y3, tol = 0.2) {
  const ax = Math.abs(x0 - 2 * x1 + x2);
  const ay = Math.abs(y0 - 2 * y1 + y2);
  const bx = Math.abs(x1 - 2 * x2 + x3);
  const by = Math.abs(y1 - 2 * y2 + y3);
  const d = Math.max(ax, ay, bx, by);
  if (d < tol) return 1;
  return Math.max(2, Math.min(48, Math.ceil(Math.sqrt(d * 3 / (4 * tol)))));
}