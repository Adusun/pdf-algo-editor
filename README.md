# PDF 算法编辑器

一个**不使用任何 PDF 第三方库**的 PDF 编辑器。DEFLATE 解压、xref 链解析、字体轮廓提取、抗锯齿光栅化全部从零实现，代码约 5700 行，321 项测试全部通过（含用 DOM 垫片真实执行 app.js 的 UI 测试）。

直接用浏览器打开 `index.html` 即可（需通过 HTTP 服务，因为用了 ES module）：

```bash
cd pdf-algo-editor
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

跑测试（8 个套件）：

```bash
node run-all.mjs
```

```
OK   codec     32 passed      编解码与滤镜
OK   parser    35 passed      对象模型、xref 链、暴力恢复
OK   raster     55 passed      矩阵、贝塞尔、抗锯齿光栅化
OK   font       25 passed      TrueType / CFF / 编码映射
OK   content    49 passed      图形状态机、文本状态机
OK   editor     59 passed      注释、页面操作、增量保存
OK   e2e        29 passed      端到端像素级验证
OK   ui         37 passed      app.js 在 DOM 垫片上真实执行
合计 321 项通过
```

---

## 一、为什么要自己写

PDF 的表面是"版式文件"，实际是一套**自描述的字节码系统**：

- 正文不是文字，是一段小程序（内容流），操作符 + 操作数构成
- 图像不是"一张图"，是压缩后的采样数组 + 颜色空间 + 预测器
- 文字不是 Unicode，是"字节 → 编码表 → 字形编号 → 轮廓"的三重映射
- 文件结构靠 xref 表互相引用，而 xref 可以损坏

任何一层偷懒（比如用浏览器 `DecompressionStream`、用 Canvas 画矩形代替解析轮廓），后面所有能力都建不起来。

---

## 二、六层架构

```
字节流
  │
  ├─ 1. 编解码层  inflate.js / filters.js
  │     DEFLATE(zlib) · LZW · ASCII85 · ASCIIHex · RunLength
  │     PNG/TIFF 预测器反滤波
  │     ↓ 逻辑字节
  ├─ 2. 对象模型  lexer.js / xref.js
  │     8 种基本对象 · 间接引用 · 流
  │     经典 xref 表 / xref 流 / ObjStm / /Prev 增量链 / 暴力恢复
  │     ↓ 对象图
  ├─ 3. 几何层  geometry.js
  │     仿射矩阵 · 三次贝塞尔自适应扁平化 · 描边轮廓化
  │     ↓ 路径轮廓
  ├─ 4. 光栅层  raster.js
  │     扫描线 · 覆盖率抗锯齿 · nonzero/evenodd · 裁剪掩膜
  │     ↓ RGBA 像素
  ├─ 5. 字体层  font.js（横跨 3、4 层）
  │     TrueType glyf/loca/cmap · CFF Type2 charstring 解释器
  │     Encoding /Differences · ToUnicode CMap
  │     ↓ 字形轮廓
  ├─ 6. 编辑层  editor.js
        注释（高亮/下划线/墨迹/便签）+ 外观流
        页面旋转/插入/删除 · 内容流追加 · 增量保存
```

---

## 三、每层的核心算法

### 3.1 DEFLATE 解码（inflate.js）

DEFLATE 的整数是 **LSB-first 位打包**，与常规大端直觉相反。解码三步：

1. **比特流读取器**：`bits(n)` 逐位取，低位先出
2. **canonical Huffman**：统计各长度码字数量 → 算下一个码值 → 展开成线性表，解码时逐位比对
3. **LZ77 回溯**：`(dist, len)` 把已输出窗口的字节拷到当前位置

三个块类型：`stored(00)` 原始字节 / `fixed(01)` 固定表 / `dynamic(10)` 动态表。

**为什么不能用浏览器的 `DecompressionStream`**：PDF 允许流被截断后提前 `endstream`，也允许单个流里拼接多个 deflate 块并忽略尾部垃圾。需要容错式解压——遇到截断时返回已解出的部分并回滚到最后一个可信位置，而不是抛异常。

### 3.2 预测器反滤波（filters.js）

PNG 预测器是"编码端预变换"，解码端要做逆运算：

| 过滤器 | 逆运算 |
|---|---|
| Sub (1) | `raw[i] += raw[i - bpp]` |
| Up (2) | `raw[i] += prior[i]` |
| Average (3) | `raw[i] += (left + up) / 2` |
| Paeth (4) | 用左/上/左上三者中"距离预测值最近"的那个 |

关键：**输出必须剥离每行开头的 filter-type 字节**，否则每行错位 1 字节。

### 3.3 xref 链与增量更新（xref.js）

PDF 的核心设计是**间接更新**：保存修改不重写文件，而是在尾部追加新对象 + 新 xref，trailer 用 `/Prev` 指向前一段。

解析必须**从最后一段开始向前回溯，且新段落优先**。三处易错：

- `/Prev` 要取**本段 trailer 自己的**值，不能读合并后的 `this.trailer`（那里是最新一段的）
- 老段落定义的**对象类型 0（free）** 不能覆盖新段落
- 混合引用文件（`/XRefStm`）要额外读 xref 流补 ObjStm 条目

最后必须有**暴力恢复**：全文件扫描 `N G obj` 重建索引。Adobe Reader 也这么做——现实中大量 PDF 的 xref 是坏的。trailer 也丢失时要**结构推断**：扫描所有对象找 `/Type /Catalog`。

### 3.4 抗锯齿光栅化（raster.js）

朴素扫描线只在像素中心采样一个点，边缘锯齿明显。改用**覆盖率**：

- 纵向：每条扫描线拆成 5 条子扫描线
- 横向：对区间 `[xa, xb]` 做**解析式面积积分**，逐像素累加实际覆盖宽度

这样边缘像素能取到 0~1 的小数灰度。

两种填充规则：
- **nonzero**：累积环绕数，`|winding| != 0` 则在内部（字形、渐变通常用这个）
- **evenodd**：穿越次数为奇数才填充（带洞形状、自交路径）

扫描线实现有个隐蔽陷阱：闭合路径时若用 `(i+1)%n` 额外闭合一次，会产生一条**零长边**，它的 `dir` 参与环绕数累加，导致 nonzero 判定错误、填充整体失效。

### 3.5 字体三重映射（font.js）

```
内容流字节 --Encoding--> Unicode --cmap--> gid --glyf/CFF--> 轮廓
                ↑                                    ↓
                └──────── ToUnicode ────────────────┘
```

选错映射，文字就变乱码或空白。Identity-H 编码（如中文）里字节本身就是 2 字节 gid；WinAnsi 里 `0x48` 才是 `'H'`。

**TrueType 轮廓**：`loca` 表给 gid→字节偏移，`glyf` 里是轮廓点 + on/off 曲线点标志。两个坑：

- `head` 表 `indexToLocFormat` 在**偏移 42**，`unitsPerEm` 在 18（写反会导致所有字形偏移全乱）
- `cmap` 是"顶层目录 + 子表"两层结构，子表**不在偏移 0 处**；format 4 里必须逐个读 `length`、`language`，漏读会让后续数组整体错位 4 字节

**CFF/Type2** 是栈式虚拟机，每个字形一段指令流（`rmoveto`/`rlineto`/`rrcurveto`/`callsubr`…），需要解释执行。

### 3.6 文本状态机（content.js）

文字定位不是"往前走 w 像素"。每个字形的变换矩阵是：

```
Trm = [Tfs·Th  0  0  Tfs  0  Ts] × Tm × CTM
```

然后用 `tx` 推进文本矩阵。三个矩阵各司其职：

- **Tm（文本矩阵）**：当前绘制位置
- **Tlm（行矩阵）**：`Td`/`TD`/`T*` 修改它，`Tm` 直接重置它
- **CTM**：页面 → 设备

`TJ` 数组里的数值是额外字间距：`tx = -n/1000 × fontsize`。

操作数从**栈顶往回取**：`num(-1)` 是最后一个，`num(-3)` 是倒数第三个。

### 3.7 增量保存（editor.js）

```
原字节（完整保留）
  + 改动过的对象（新的对象号）
  + 新 xref 段（只列改动对象）
  + trailer（/Prev 指向旧 xref）
```

未改动的字节（图片、字体）完全复用，零成本；文件只增长不缩小；任何第三方阅读器都能打开。

**两个容易犯的错**：

- PDF 源码是 **latin1 字节流**，不是 UTF-8。用 `TextEncoder` 会把 `>=128` 的字符编成 2 字节，导致数字 `0` 变成字节 `48`、`MediaBox` 变成 `[48,48,...]`
- `/Rect`、`/MediaBox` 必须是**数字数组**，提前 `fmt()` 成字符串会被写成 PDF 字符串 `"(0)"`，类型全错

### 3.8 注释外观流

注释要能被任何阅读器显示，必须带 `/AP`（appearance stream）——很多阅读器不自己画注释。

```pdf
<< /Type /Annot /Subtype /Highlight /Rect [50 10 350 50] /AP << /N 7 0 R >> >>
7 0 obj
<< /Type /XObject /Subtype /Form /BBox [50 10 350 50] /Length 38 >>
stream
q /GS gs 1 0 0 rg 50 10 300 40 re f Q
endstream
```

`/AP /N` 必须是**间接引用**——stream 对象不能内联在字典里。高亮用 `/BM /Multiply` 混合模式模拟。

---

## 四、抓到过的真实 bug

这些 bug 有一个共同点：**逻辑看起来对，但不检查具体字节/像素就发现不了**。

| # | bug | 症状 | 发现方式 |
|---|---|---|---|
| 1 | Huffman `offsets[k+1]` 应为 `offsets[k]` | 动态 Huffman 全乱 | 与 Node zlib 逐字节对比 |
| 2 | 位流越界后返回 0 比特 | LZ77 无限复制，CPU 打满 | 测试挂起 |
| 3 | `parseDict` 未跳前置空白 | `/Prev` 链断掉、trailer 全空 | 增量更新测试 |
| 4 | `String(Name)` → `"/FlateDecode"` | 所有流静默不解码 | 解压后长度不符 |
| 5 | 零长边参与环绕数累加 | nonzero 填充整体失效 | 逐像素检查 |
| 6 | `mask[idx]===0` 判断"首个路径" | 裁剪求交退化成"最后一个说了算" | 双矩形求交 |
| 7 | `head` 表偏移写成 18 | 长 loca 被当短表读 | 对照 spec |
| 8 | cmap format 4 漏读 length/language | idDelta 变 0，映射恒等 | 打印子表字节 |
| 9 | `this.pos = save; this.pos++` | **`rg` 被截成 `r` + `g`**，颜色全错 | **只在内容流暴露** |
| 10 | `num(0)` 从栈底取 | 操作数整体错位一位 | RGB 通道检查 |
| 11 | `const gs` 被 `Q` 重新赋值 | TypeError 被 try/catch 吞掉，q/Q 静默失效 | 检查 warnings |
| 12 | `TextEncoder` 编 latin1 源码 | `MediaBox` 变 `[48,48,...]` | 重新解析自己写的文件 |
| 13 | `rotatePage` 用旧字典 | 先加高亮再旋转，高亮消失 | 编辑叠加测试 |
| 14 | 读合并后的 `trailer.Prev` | 多次保存后 xref 链断，触发恢复 | 两次增量保存 |
| 15 | 绘制前未隐式闭合子路径 | **`f` 不带 `h` 的三角形完全填不上** | 端到端像素检查 |
| 16 | `/AP /N` 内联 stream | 非法语法，阅读器不显示 | 重新解析 |

### UI 层怎么测

浏览器自动化（Playwright/agent-browser）在受限网络环境下装不上 Chromium，
所以 `test/dom-shim.mjs` 实现了一个**最小但语义真实**的 DOM + Canvas 垫片：
`createImageData` 返回真实缓冲、`putImageData` 记录像素、`getContext` 可测量。

这样 `app.js` 的顶层代码会被**真正执行**——事件绑定、载入示例、渲染页面、
保存文件全走一遍，测试还能对"canvas 上到底画了什么像素"做断言。
比静态检查可靠，也不依赖外部工具。

### 关于测试的三条经验

1. **断言必须落到具体数值**。"没报错"不等于"对"——第 9、10、11、15 号 bug 全部逻辑正确、无异常、只是结果错
2. **注意颜色通道**。红色填充在白底上 R 恒为 255，要看 G/B；蓝色反之。我因此误判过好几次
3. **fixture 生成器自己也会错**。三次把 bug 误判成被测代码问题：sfnt 目录项漏 checkSum 字段、cmap 顶层 version 写错、用 JS 字符串拼二进制导致偏移错位。**修 fixture 前先确认被测代码是对的**

判断绕向用有向面积（`Σ(x_i·y_{i+1} - x_{i+1}·y_i)/2`）比肉眼看点顺序可靠。

---

## 五、功能

**浏览**：多页连续滚动、缩放、适应宽度、页面旋转/插入/删除、拖放载入

**标注**：高亮、下划线、墨迹（手绘）、便签——全部生成标准外观流

**文字**：逐字提取（保留坐标与宽度，含空格），侧栏可看可复制

**保存**：
- 增量保存——原字节保留，只追加改动，任何阅读器可开
- 完整重写——全部对象重新序列化，体积更小

**鲁棒性**：xref 偏移不准时自动全文件扫描恢复；xref 彻底损坏时结构推断重建 catalog；流被截断时返回已解部分

---

## 六、已知限制

- **未实现加密**（`/Encrypt`）——会提示但不解密
- **标准 14 字体无内嵌轮廓**——Helvetica 等没有内嵌字体程序时不绘制字形（文字位置仍正确，只是看不到字）
- **不支持 JPXDecode / JBIG2Decode** 图像
- **不递归嵌套 Form XObject 的变换栈**——只处理一层
- 多次增量保存会让文件膨胀（这是 PDF 格式的固有代价，`saveFull` 可解决）