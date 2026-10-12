// 光栅器与几何层测试：用解析可验证的几何图形检查像素级正确性
import { Matrix, Path } from '../src/geometry.js';
import { Rasterizer, Color, clipMaskFromPaths } from '../src/raster.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };

function makeCanvas(w, h, bg = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = bg[3];
  }
  return { width: w, height: h, data };
}
const px = (c, x, y) => {
  const i = (y * c.width + x) * 4;
  return [c.data[i], c.data[i + 1], c.data[i + 2], c.data[i + 3]];
};

console.log('\n=== 矩阵 ===');
{
  const m = new Matrix(1, 0, 0, 1, 10, 20);
  ok('平移', JSON.stringify(m.apply(0, 0)) === '[10,20]');
  const inv = m.invert();
  ok('求逆还原', Math.abs(inv.apply(10, 20)[0]) < 1e-9 && Math.abs(inv.apply(10, 20)[1]) < 1e-9);
  const s = new Matrix(2, 0, 0, 3, 0, 0);
  ok('缩放', s.apply(2, 2)[0] === 4 && s.apply(2, 2)[1] === 6);
  ok('行列式', new Matrix(2, 0, 0, 3, 0, 0).determinant() === 6);
  ok('奇异矩阵求逆返回单位阵', Math.abs(new Matrix(0, 0, 0, 0, 5, 5).invert().determinant() - 1) < 1e-9);
  // multiply 语义：this.multiply(o) 表示"先施加 this，再施加 o"
  const A = new Matrix(1, 0, 0, 1, 100, 0);   // 平移 100
  const B = new Matrix(2, 0, 0, 2, 0, 0);     // 缩放 2
  // (1,1) -> 平移 -> (101,1) -> 缩放 -> (202,2)
  ok('乘法顺序：先 this 后 o', A.multiply(B).apply(1, 1)[0] === 202 && A.multiply(B).apply(1, 1)[1] === 2,
    JSON.stringify(A.multiply(B).apply(1, 1)));
  // 反过来：先缩放后平移 (1,1) -> (2,2) -> (102,2)
  ok('乘法顺序：反向', B.multiply(A).apply(1, 1)[0] === 102, JSON.stringify(B.multiply(A).apply(1, 1)));
  // 旋转 90 度
  const r = Matrix.identity().rotate(Math.PI / 2);
  const [rx, ry] = r.apply(1, 0);
  ok('旋转 90°', Math.abs(rx) < 1e-9 && Math.abs(ry - 1) < 1e-9, `${rx},${ry}`);
}

console.log('\n=== 覆盖填充：轴对齐矩形（红色填充）===');
{
  const c = makeCanvas(20, 20);
  const r = new Rasterizer(20, 20, c.data);
  const p = new Path().moveTo(5, 5).lineTo(15, 5).lineTo(15, 15).lineTo(5, 15).close();
  r.fillPath(p, Color.rgb(255, 0, 0), 'nonzero');
  // 红色填充在白底上：R 始终 255，要看 G/B 通道判断是否被覆盖
  ok('矩形内部为红色(G=0)', px(c, 10, 10)[1] < 5 && px(c, 10, 10)[0] > 250, JSON.stringify(px(c, 10, 10)));
  ok('矩形外部仍是白色', px(c, 2, 2)[1] > 250 && px(c, 2, 2)[2] > 250, JSON.stringify(px(c, 2, 2)));
  ok('矩形左边界在 x=5..6 之间', px(c, 4, 10)[1] > 250 && px(c, 6, 10)[1] < 10,
    `x4=${px(c, 4, 10)[1]} x6=${px(c, 6, 10)[1]}`);
  ok('矩形右边界在 x=14..16 之间', px(c, 14, 10)[1] < 10 && px(c, 16, 10)[1] > 250,
    `x14=${px(c, 14, 10)[1]} x16=${px(c, 16, 10)[1]}`);
  ok('矩形上下边界正确', px(c, 10, 4)[1] > 250 && px(c, 10, 16)[1] > 250);
}

console.log('\n=== 抗锯齿：边缘像素应为中间灰 ===');
{
  const c = makeCanvas(20, 20);
  const r = new Rasterizer(20, 20, c.data);
  // 左边界正好落在 x=5.5 -> 像素 5 应恰好覆盖一半
  const p = new Path().moveTo(5.5, 5).lineTo(15.5, 5).lineTo(15.5, 15).lineTo(5.5, 15).close();
  r.fillPath(p, Color.rgb(0, 0, 0), 'nonzero');
  const edge = px(c, 5, 10)[0];
  ok('半覆盖边缘像素约 50% 灰', edge > 100 && edge < 160, `got ${edge}`);
  ok('完全覆盖像素接近黑', px(c, 10, 10)[0] < 10, `got ${px(c, 10, 10)[0]}`);
  ok('未覆盖像素接近白', px(c, 3, 10)[0] > 245, `got ${px(c, 3, 10)[0]}`);
}

console.log('\n=== 填充规则：nonzero vs evenodd ===');
{
  // 外圈 (2,2)→(18,2)→(18,18)→(2,18) 有向面积 = +256
  // 内圈用同样的顶点顺序 (8,8)→(16,8)→(16,16)→(8,16)，面积 = +64（同向）
  // 这样 nonzero 的绕数在中心处叠加为 2（非 0），而 evenodd 穿越 2 次（偶数）
  function donutPath() {
    const p = new Path();
    p.moveTo(2, 2).lineTo(18, 2).lineTo(18, 18).lineTo(2, 18).close();
    p.moveTo(8, 8).lineTo(16, 8).lineTo(16, 16).lineTo(8, 16).close();
    return p;
  }
  const c1 = makeCanvas(20, 20);
  const r1 = new Rasterizer(20, 20, c1.data);
  r1.fillPath(donutPath(), Color.rgb(0, 0, 0), 'nonzero');
  const c2 = makeCanvas(20, 20);
  const r2 = new Rasterizer(20, 20, c2.data);
  r2.fillPath(donutPath(), Color.rgb(0, 0, 0), 'evenodd');
  // 同向嵌套：nonzero 绕数=2（非 0）-> 填满；evenodd 穿越 2 次（偶数）-> 挖空
  ok('同向嵌套 nonzero: 中心填满', px(c1, 12, 12)[0] < 20, `got ${px(c1, 12, 12)[0]}`);
  ok('同向嵌套 evenodd: 中心挖空', px(c2, 12, 12)[0] > 240, `got ${px(c2, 12, 12)[0]}`);
  ok('同向嵌套: 外环区两规则都填', px(c1, 5, 5)[0] < 20 && px(c2, 5, 5)[0] < 20);
}
{
  // 内圈顶点倒序 -> 有向面积为负，与外圈(+64)反向，即"环形/甜甜圈"
  const p = new Path();
  p.moveTo(2, 2).lineTo(18, 2).lineTo(18, 18).lineTo(2, 18).close();   // area +256
  p.moveTo(8, 8).lineTo(8, 16).lineTo(16, 16).lineTo(16, 8).close();   // area -64，反向
  const cN = makeCanvas(20, 20);
  new Rasterizer(20, 20, cN.data).fillPath(p, Color.rgb(0, 0, 0), 'nonzero');
  const cE = makeCanvas(20, 20);
  new Rasterizer(20, 20, cE.data).fillPath(p, Color.rgb(0, 0, 0), 'evenodd');
  // 反向嵌套 = 甜甜圈：中心处 nonzero 绕数为 0、evenodd 穿越 2 次，两者都不填
  ok('反向嵌套(甜甜圈): nonzero 挖空中心', px(cN, 12, 12)[0] > 240, `got ${px(cN, 12, 12)[0]}`);
  ok('反向嵌套(甜甜圈): evenodd 挖空中心', px(cE, 12, 12)[0] > 240, `got ${px(cE, 12, 12)[0]}`);
  ok('反向嵌套: 外环区两种规则都填', px(cN, 5, 5)[0] < 20 && px(cE, 5, 5)[0] < 20,
    `N=${px(cN, 5, 5)[0]} E=${px(cE, 5, 5)[0]}`);
}

console.log('\n=== 描边 ===');
{
  const c = makeCanvas(30, 30);
  const r = new Rasterizer(30, 30, c.data);
  const p = new Path().moveTo(5, 15).lineTo(25, 15);
  r.strokePath(p, Color.rgb(0, 0, 255), 3);
  // 蓝色填充 (0,0,255)：白底时 R=255，被覆盖后 R 下降。用 R 通道判断。
  ok('水平线描边在线上(R=0)', px(c, 15, 15)[0] < 20, `R=${px(c, 15, 15)[0]}`);
  // 3px 宽、中心 y=15 -> 覆盖 y=13.5..16.5：
  // y=14/15 满覆盖(R≈0)，y=13 与 y=16 各约半覆盖(R 在 0~255 之间)
  ok('描边向上半覆盖行', px(c, 15, 13)[0] > 20 && px(c, 15, 13)[0] < 250, `y13 R=${px(c, 15, 13)[0]}`);
  ok('描边核心行满覆盖', px(c, 15, 14)[0] < 20 && px(c, 15, 15)[0] < 20, `y14=${px(c, 15, 14)[0]} y15=${px(c, 15, 15)[0]}`);
  ok('描边向下半覆盖行', px(c, 15, 16)[0] > 20 && px(c, 15, 16)[0] < 250, `y16 R=${px(c, 15, 16)[0]}`);
  ok('描边边界外无覆盖', px(c, 15, 17)[0] > 250 && px(c, 15, 12)[0] > 250, `y17=${px(c, 15, 17)[0]} y12=${px(c, 15, 12)[0]}`);
  ok('线外区域未绘制', px(c, 15, 8)[2] > 240);
  ok('线外区域未绘制', px(c, 15, 8)[2] > 240, `got ${px(c, 15, 8)[2]}`);
}

console.log('\n=== 裁剪掩膜 ===');
{
  const clip = new Path().moveTo(5, 5).lineTo(15, 5).lineTo(15, 15).lineTo(5, 15).close();
  const mask = clipMaskFromPaths([clip], 20, 20);
  ok('掩膜内为 255', mask[10 * 20 + 10] === 255, `got ${mask[10 * 20 + 10]}`);
  ok('掩膜外为 0', mask[10 * 20 + 1] === 0, `got ${mask[10 * 20 + 1]}`);
  // 用掩膜裁剪一个大矩形 -> 只有交集被填充
  const c = makeCanvas(20, 20);
  const r = new Rasterizer(20, 20, c.data);
  r.setClipMask(mask);
  r.fillPath(new Path().moveTo(0, 0).lineTo(20, 0).lineTo(20, 20).lineTo(0, 20).close(), Color.rgb(0, 0, 0), 'nonzero');
  ok('裁剪后交集内被填', px(c, 10, 10)[0] < 20, `got ${px(c, 10, 10)[0]}`);
  ok('裁剪后交集外未填', px(c, 2, 2)[0] > 240, `got ${px(c, 2, 2)[0]}`);
  // 多个裁剪区域求交
  const clip2 = new Path().moveTo(10, 10).lineTo(20, 10).lineTo(20, 20).lineTo(10, 20).close();
  const mask2 = clipMaskFromPaths([clip, clip2], 20, 20);
  // clip1 = [5,15]², clip2 = [10,20]²，真实交集是 [10,15]²
  ok('多裁剪求交：重叠区中心 255', mask2[12 * 20 + 12] === 255, `got ${mask2[12 * 20 + 12]}`);
  ok('多裁剪求交：重叠区边界 255', mask2[14 * 20 + 14] === 255, `got ${mask2[14 * 20 + 14]}`);
  // (7,7) 只在 clip1 内 -> 求交后必须为 0（这是曾经的 bug：退化成"最后一个说了算"）
  ok('多裁剪求交：仅属第一个区域处为 0', mask2[7 * 20 + 7] === 0, `got ${mask2[7 * 20 + 7]}`);
  // (17,17) 只在 clip2 内 -> 也必须为 0
  ok('多裁剪求交：仅属第二个区域处为 0', mask2[17 * 20 + 17] === 0, `got ${mask2[17 * 20 + 17]}`);
  ok('多裁剪求交：两区外为 0', mask2[2 * 20 + 2] === 0, `got ${mask2[2 * 20 + 2]}`);
}

console.log('\n=== 贝塞尔扁平化 ===');
{
  // 真正共线的控制点：整条曲线是直线，应只产生 1 段
  const p = new Path().moveTo(0, 0).curveTo(10, 10, 20, 20, 30, 30);
  ok('共线控制点不产生冗余点', p.cur.pts.length === 4, `pts=${p.cur.pts.length / 2}`);
  // 非共线的浅弧需要适度细分，但不应爆炸
  const pShallow = new Path().moveTo(0, 0).curveTo(10, 10, 20, 10, 30, 0);
  ok('浅弧细分受控(<=48段)', pShallow.cur.pts.length / 2 <= 49, `pts=${pShallow.cur.pts.length / 2}`);
  // 强弯曲曲线应细分
  const p2 = new Path().moveTo(0, 0).curveTo(0, 100, 100, 100, 100, 0);
  ok('强弯曲曲线被细分', p2.cur.pts.length > 8, `pts=${p2.cur.pts.length / 2}`);
  // 曲线应始终在控制点包围盒内
  let inBox = true;
  const q = p2.cur.pts;
  for (let i = 0; i < q.length; i += 2) {
    if (q[i] < -1 || q[i] > 101 || q[i + 1] < -1 || q[i + 1] > 101) inBox = false;
  }
  ok('曲线点落在包围盒内', inBox);
}

console.log('\n=== 路径变换与边界框 ===');
{
  const p = new Path().moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).lineTo(0, 10).close();
  ok('边界盒', JSON.stringify(p.bounds()) === '[0,0,10,10]', JSON.stringify(p.bounds()));
  p.transform(new Matrix(1, 0, 0, 1, 5, 5));
  ok('变换后边界盒', JSON.stringify(p.bounds()) === '[5,5,15,15]', JSON.stringify(p.bounds()));
  const p3 = new Path().moveTo(0, 0).lineTo(4, 0).lineTo(4, 4).lineTo(0, 4).close();
  const stroke = p3.strokeToPath(2);
  ok('描边生成多个子路径', stroke.subpaths.length >= 4, `got ${stroke.subpaths.length}`);
  const [bx0, by0] = stroke.bounds();
  ok('描边轮廓向外扩展 1px', Math.abs(bx0 - (-1)) < 1e-6 && Math.abs(by0 - (-1)) < 1e-6,
    `min=${bx0},${by0} bounds=${JSON.stringify(stroke.bounds())}`);
}

console.log('\n=== 复杂路径：自交星形（evenodd）===');
{
  // 五角星的经典 evenodd 效果：中心是空的
  const c = makeCanvas(60, 60);
  const r = new Rasterizer(60, 60, c.data);
  const cx = 30, cy = 30, R = 25, rr = 10;
  const p = new Path();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : rr;
    const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
    i === 0 ? p.moveTo(x, y) : p.lineTo(x, y);
  }
  p.close();
  r.fillPath(p, Color.rgb(0, 0, 0), 'evenodd');
  // 注：正五角星的中心绕向为 1，evenodd 下中心被填充是正确行为
  // （五角星本身是"实心星"，不是环形）。尖端区域必然被填。
  ok('星形尖端被填', px(c, cx, 7)[0] < 100, `got ${px(c, cx, 7)[0]}`);
  // 实测 y=30 行的填充区间约为 x=18..43（左右两个尖角之间）
  ok('星形左侧被填', px(c, 20, 30)[0] < 100, `got ${px(c, 20, 30)[0]}`);
  ok('星形右侧被填', px(c, 41, 30)[0] < 100, `got ${px(c, 41, 30)[0]}`);
  ok("星形左右外侧未填", px(c, 12, 30)[0] > 250 && px(c, 48, 30)[0] > 250,
    `L=${px(c, 12, 30)[0]} R=${px(c, 48, 30)[0]}`);
  ok('星形之外未被填', px(c, 2, 2)[0] > 250, `got ${px(c, 2, 2)[0]}`);
  const c2 = makeCanvas(60, 60);
  new Rasterizer(60, 60, c2.data).fillPath(p, Color.rgb(0, 0, 0), 'nonzero');
  ok('星形 nonzero 中心被填', px(c2, cx, cy)[0] < 100, `got ${px(c2, cx, cy)[0]}`);

  // 真正的"甜甜圈"：两圈同向绕向 -> evenodd 挖洞，nonzero 填满
  const donut = new Path();
  donut.moveTo(10, 10).lineTo(50, 10).lineTo(50, 50).lineTo(10, 50).close();
  donut.moveTo(20, 20).lineTo(40, 20).lineTo(40, 40).lineTo(20, 40).close();
  const cE = makeCanvas(60, 60);
  new Rasterizer(60, 60, cE.data).fillPath(donut, Color.rgb(0, 0, 0), 'evenodd');
  const cN = makeCanvas(60, 60);
  new Rasterizer(60, 60, cN.data).fillPath(donut, Color.rgb(0, 0, 0), 'nonzero');
  ok('甜甜圈 evenodd 挖出中心', px(cE, 30, 30)[0] > 240, `got ${px(cE, 30, 30)[0]}`);
  ok('甜甜圈 evenodd 外环被填', px(cE, 13, 13)[0] < 100, `got ${px(cE, 13, 13)[0]}`);
  ok('甜甜圈 nonzero 同向时填满中心', px(cN, 30, 30)[0] < 100, `got ${px(cN, 30, 30)[0]}`);
}

console.log(`\n---- raster: ${pass} passed, ${fail} failed ----`);
if (fail) process.exit(1);