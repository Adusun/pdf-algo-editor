// ============================================================================
// raster.js — 扫描线光栅器：覆盖率抗锯齿 + 裁剪 + 图像采样
// ----------------------------------------------------------------------------
// 原理：把多边形与水平扫描线的交点按 x 排序，区间内的像素被认为"在内部"。
// 朴素做法只在像素中心采样一个点（1 bit），边缘会有明显锯齿。
//
// 抗锯齿的关键：用"像素面积覆盖率"替代"是否命中"。
//   - 纵向：每条扫描线拆成 SUB 条子扫描线（vertical subsampling）
//   - 横向：每个像素的覆盖量 = 子扫描线在该像素内的水平跨度累加
// 这样边缘像素能取到 0~1 的小数灰度，视觉上就是平滑过渡。
//
// 填充规则（PDF 两种）：
//   - nonzero：环绕数 != 0 即填充。用于字形、渐变，通常是正确的选择
//   - evenodd：穿越次数为奇数才填充。用于带洞的形状、自交路径
// ============================================================================

import { Matrix } from './geometry.js';

/** RGBA 颜色，0-255 */
export class Color {
  constructor(r = 0, g = 0, b = 0, a = 1) {
    this.r = r; this.g = g; this.b = b; this.a = a;
  }
  static rgb(r, g, b) { return new Color(r, g, b, 1); }
  static gray(v) { return new Color(v, v, v, 1); }
  static cmyk(c, m, y, k) {
    return new Color(
      Math.round(255 * (1 - Math.min(1, c + k))),
      Math.round(255 * (1 - Math.min(1, m + k))),
      Math.round(255 * (1 - Math.min(1, y + k))),
      1
    );
  }
}

/**
 * 覆盖率光栅器。渲染目标是一个 RGBA Uint8ClampedArray（即 ImageData）。
 *
 * @param {object} opts
 *   width, height   画布尺寸（像素）
 *   data            Uint8ClampedArray RGBA
 *   background      底色（不透明时所有区域先铺一遍）
 */
export class Rasterizer {
  constructor(width, height, data, opts = {}) {
    this.width = width;
    this.height = height;
    this.data = data;
    this.SUB = opts.subSamples || 5;       // 每像素纵向子扫描线数
    this.clipCoverage = null;              // 当前裁剪覆盖率（Uint8，0-255）
    this.fillColor = new Color(0, 0, 0, 1);
    this.blend = opts.blend || 'src-over';
  }

  /** 设置裁剪区域：由 clip 路径生成覆盖率掩膜 */
  setClipMask(mask) { this.clipCoverage = mask; }

  /**
   * 填充路径。
   * @param {Path} path 已变换到设备空间的路径
   * @param {Color} color 填充色
   * @param {'nonzero'|'evenodd'} rule
   */
  fillPath(path, color, rule = 'nonzero') {
    if (!path || path.subpaths.length === 0) return;
    path.normalize();

    // ---- 1. 建立边表 (Edge Table) ----
    // 每条边记: x0,y0,x1,y1,dy,dxdy(斜率), dir(上下方向)
    // 扫描线算法按 y 递增遍历，用活动边表避免每行重扫所有边。
    const edges = [];
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;

    for (const sp of path.subpaths) {
      const p = sp.pts;
      const n = p.length / 2;
      if (n < 2) continue;
      // normalize() 已把闭合路径的首点补到末尾，所以线性配对即可。
      // 关键：不能再用 (i+1)%n 额外闭合一次 —— 那会产生一条零长边，
      // 它的 dir 参与环绕数累加，导致 nonzero 判定错误、填充整体失效。
      for (let i = 0; i < n - 1; i++) {
        const j = i + 1;
        const x0 = p[i * 2], y0 = p[i * 2 + 1];
        const x1 = p[j * 2], y1 = p[j * 2 + 1];
        if (y0 === y1) continue;                 // 水平边不参与扫描
        if (x0 === x1 && y0 === y1) continue;   // 跳过重复点产生的零长边
        // 保证 y0 < y1，dir 记录原来的方向（向上为 +1）
        const dir = y0 < y1 ? 1 : -1;
        const ay = dir === 1 ? y0 : y1;
        const ax = dir === 1 ? x0 : x1;
        edges.push({ x: ax, y0: ay, y1: dir === 1 ? y1 : y0, dxdy: (x1 - x0) / (y1 - y0), dir });
        if (ay < minY) minY = ay;
        if ((dir === 1 ? y1 : y0) > maxY) maxY = dir === 1 ? y1 : y0;
        if (Math.min(x0, x1) < minX) minX = Math.min(x0, x1);
        if (Math.max(x0, x1) > maxX) maxX = Math.max(x0, x1);
      }
    }
    if (edges.length === 0 || minY === Infinity) return;

    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height - 1, Math.ceil(maxY));
    if (yStart > yEnd) return;

    // 每像素行的水平覆盖率累加器
    const rowCoverage = new Float32Array(this.width);

    for (let py = yStart; py <= yEnd; py++) {
      rowCoverage.fill(0);
      let rowUsed = false;

      // ---- 2. 纵向子扫描 ----
      for (let s = 0; s < this.SUB; s++) {
        const sy = py + (s + 0.5) / this.SUB;   // 子扫描线的 y 位置

        // 3. 收集与该扫描线相交的边（活动边表筛选）
        const xs = [];
        for (const e of edges) {
          if (sy < e.y0 || sy >= e.y1) continue;
          xs.push({ x: e.x + (sy - e.y0) * e.dxdy, dir: e.dir });
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a.x - b.x);

        // 4. 按填充规则配对，得到内部区间
        //    nonzero: 用累积环绕数，|winding| != 0 则在内部
        //    evenodd: 每经过一条边就翻转，inside = !inside
        const spans = [];
        if (rule === 'nonzero') {
          let winding = 0;
          for (let i = 0; i < xs.length - 1; i++) {
            winding += xs[i].dir;
            if (winding !== 0) {
              pushSpan(spans, xs[i].x, xs[i + 1].x);
            }
          }
        } else {
          let inside = false;
          for (let i = 0; i < xs.length - 1; i++) {
            inside = !inside;
            if (inside) pushSpan(spans, xs[i].x, xs[i + 1].x);
          }
        }

        // 5. 区间转为像素覆盖率（横向解析式面积积分）
        for (const [xa, xb] of spans) {
          if (xb <= 0 || xa >= this.width || xb <= xa) continue;
          addSpanCoverage(rowCoverage, Math.max(xa, 0), Math.min(xb, this.width), 1 / this.SUB, this.width);
          rowUsed = true;
        }
      }

      if (!rowUsed) continue;
      // 6. 把覆盖率混合到画布
      this._compositeRow(py, rowCoverage, color);
    }
  }

  /** 描边：转换成填充路径后按 nonzero 填充 */
  strokePath(path, color, lineWidth, opts = {}) {
    const outline = path.strokeToPath(lineWidth);
    this.fillPath(outline, color, 'nonzero');
  }

  /** 单行混合：coverage(0~1) × color over 背景 */
  _compositeRow(py, coverage, color) {
    const { data, width, clipCoverage } = this;
    const rowStart = py * width * 4;
    for (let x = 0; x < width; x++) {
      let cov = coverage[x];
      if (cov <= 0.0005) continue;
      if (cov > 1) cov = 1;
      if (clipCoverage) {
        cov *= clipCoverage[py * width + x] / 255;
        if (cov <= 0.0005) continue;
      }
      const i = rowStart + x * 4;
      blendPixel(data, i, color, cov, this.blend);
    }
  }
}

/** 合并相邻/重叠的区间，避免重复混合 */
function pushSpan(spans, xa, xb) {
  if (xb - xa < 1e-9) return;
  if (spans.length) {
    const last = spans[spans.length - 1];
    if (xa <= last[1] + 1e-9) { if (xb > last[1]) last[1] = xb; return; }
  }
  spans.push([xa, xb]);
}

/**
 * 区间 [xa,xb] 对像素覆盖率的贡献（面积积分，精确到解析式）。
 * 不用逐像素采样：对每个相交的像素，累加它被覆盖的实际宽度。
 */
function addSpanCoverage(row, xa, xb, weight, width) {
  if (xb <= xa) return;
  let p = Math.floor(xa);
  const end = Math.floor(xb - 1e-12);
  if (p === end) {
    // 区间完全落在单个像素内
    row[p] += (xb - xa) * weight;
    return;
  }
  // 第一个像素：右边界截断
  row[p] += (p + 1 - xa) * weight;
  // 中间完整像素
  for (let x = p + 1; x < end; x++) row[x] += weight;
  // 最后一个像素：左边界截断
  row[end] += (xb - end) * weight;
}

/** src-over 像素混合（premultiplied 简化为直接 alpha 混合） */
function blendPixel(data, i, color, cov, mode) {
  const a = Math.min(1, cov * (color.a ?? 1));
  if (a <= 0.0005) return;
  const sr = color.r, sg = color.g, sb = color.b;

  if (mode === 'multiply') {
    // 近似：用于 /BM /Multiply
    data[i] = lerp(data[i], (data[i] * sr) / 255, a);
    data[i + 1] = lerp(data[i + 1], (data[i + 1] * sg) / 255, a);
    data[i + 2] = lerp(data[i + 2], (data[i + 2] * sb) / 255, a);
    return;
  }
  const ia = 1 - a;
  data[i] = sr * a + data[i] * ia;
  data[i + 1] = sg * a + data[i + 1] * ia;
  data[i + 2] = sb * a + data[i + 2] * ia;
  data[i + 3] = Math.min(255, (a * 255 + data[i + 3] * ia));
}
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 由裁剪路径生成覆盖率掩膜（0-255）。
 * 多个裁剪路径求交：逐个路径算掩膜再取最小值（覆盖率乘积近似）。
 */
export function clipMaskFromPaths(paths, width, height, subsamples = 5) {
  if (!paths.length) return null;
  const mask = new Uint8Array(width * height);
  const acc = new Float32Array(width);
  let pathIndex = 0;   // 已处理的路径数，用来区分"首个路径"与"求交"

  for (const p of paths) {
    p.normalize();
    const edges = [];
    let minY = Infinity, maxY = -Infinity;
    for (const sp of p.subpaths) {
      const q = sp.pts;
      const n = q.length / 2;
      // 与 fillPath 一致：normalize() 已补齐闭合点，线性配对避免零长边
      for (let i = 0; i < n - 1; i++) {
        const x0 = q[i * 2], y0 = q[i * 2 + 1];
        const x1 = q[(i + 1) * 2], y1 = q[(i + 1) * 2 + 1];
        if (y0 === y1) continue;
        if (x0 === x1 && y0 === y1) continue;
        const dir = y0 < y1 ? 1 : -1;
        edges.push({
          x: dir === 1 ? x0 : x1,
          y0: Math.min(y0, y1), y1: Math.max(y0, y1),
          dxdy: (x1 - x0) / (y1 - y0), dir,
        });
        if (Math.min(y0, y1) < minY) minY = Math.min(y0, y1);
        if (Math.max(y0, y1) > maxY) maxY = Math.max(y0, y1);
      }
    }
    if (!edges.length) {
      // 该路径没有任何边（例如退化路径）-> 与它求交的结果应全为 0
      if (pathIndex === 0) mask.fill(0);
      else for (let i = 0; i < mask.length; i++) mask[i] = 0;
      pathIndex++;
      continue;
    }

    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(height - 1, Math.ceil(maxY));
    // 关键：必须遍历**所有**行，而不只是本路径 bbox 内的行。
    // 否则后续路径 bbox 之外的行会保留上一个路径的结果，
    // 求交退化成"最后一个覆盖到的路径说了算"。
    for (let py = 0; py < height; py++) {
      if (py < yStart || py > yEnd) {
        // 该行不在本路径范围内 -> 本路径覆盖率为 0，求交结果必为 0
        for (let x = 0; x < width; x++) mask[py * width + x] = 0;
        continue;
      }
      acc.fill(0);
      for (let s = 0; s < subsamples; s++) {
        const sy = py + (s + 0.5) / subsamples;
        const xs = [];
        for (const e of edges) {
          if (sy < e.y0 || sy >= e.y1) continue;
          xs.push({ x: e.x + (sy - e.y0) * e.dxdy, dir: e.dir });
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a.x - b.x);
        let winding = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          winding += xs[i].dir;
          if (winding !== 0) addSpanCoverage(acc, Math.max(0, xs[i].x), Math.min(width, xs[i + 1].x), 1 / subsamples, width);
        }
      }
      for (let x = 0; x < width; x++) {
        const v = Math.min(255, Math.round(acc[x] * 255));
        const idx = py * width + x;
// 多路径求交：必须与已有覆盖率相乘（近似"同时被覆盖"）。
      // 不能用 mask[idx]===0 判断"是否首个路径"——因为首个路径在
      // 区域外的值本来就是 0，会被误判为"还没写入"从而覆盖掉后续结果，
      // 导致求交退化成"最后一个路径说了算"。
        if (pathIndex === 0) {
          mask[idx] = v;
        } else {
          mask[idx] = Math.round((mask[idx] * v) / 255);
        }
      }
    }
    pathIndex++;
  }
  return mask;
}

/**
 * 图像绘制：把采样数据按仿射矩阵贴到画布上。
 * 步骤：算出目标区域的像素中心 -> 反变换回源图像空间 -> 最近邻/双线性采样。
 * 图像 XObject 自带 /Matrix 表示放置变换，所以这里是 (dst -> src) 的逆映射。
 */
export function drawImage(target, img, dstRect, invMatrix, alpha = 1) {
  const { data: td, width: tw, height: th } = target;
  const { data: sd, width: sw, height: sh, channels } = img;
  const [dx0, dy0, dx1, dy1] = dstRect;
  const py0 = Math.max(0, Math.floor(dy0));
  const py1 = Math.min(th - 1, Math.ceil(dy1));
  const px0 = Math.max(0, Math.floor(dx0));
  const px1 = Math.min(tw - 1, Math.ceil(dx1));

  for (let py = py0; py <= py1; py++) {
    for (let px = px0; px <= px1; px++) {
      const cx = px + 0.5, cy = py + 0.5;
      const [sx, sy] = invMatrix.apply(cx, cy);
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
      const ix = Math.min(sw - 1, Math.floor(sx));
      const iy = Math.min(sh - 1, Math.floor(sy));
      const si = (iy * sw + ix) * channels;
      let r, g, b;
      if (channels >= 3) { r = sd[si]; g = sd[si + 1]; b = sd[si + 2]; }
      else { r = g = b = sd[si]; }
      const di = (py * tw + px) * 4;
      const a = alpha * (sd.length > sw * sh * channels ? sd[si + channels] / 255 : 1);
      blendPixel(td, di, { r, g, b, a }, 1, 'src-over');
    }
  }
}