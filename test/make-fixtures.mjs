// 生成测试用 PDF：覆盖经典 xref / xref stream / ObjStm / 增量更新 等真实场景
import zlib from 'node:zlib';
import fs from 'node:fs';

/** 经典 xref + 显式对象的最小 PDF */
export function makeClassicPDF() {
  const objs = [];
  const add = (num, body) => objs.push({ num, body });
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  const content = 'BT /F1 24 Tf 20 40 Td (Hello Classic) Tj ET\n0 0 1 rg 10 10 50 30 re f\n';
  add(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  add(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) {
    offsets[o.num] = out.length;
    out += `${o.num} 0 obj\n${o.body}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * xref stream (PDF 1.5) 风格的 PDF，含 ObjStm。
 * 关键：用 Buffer 累加并按字节记录 offsets —— 之前用 JS 字符串拼接二进制，
 * 长度与字节数不一致导致偏移错位（这是 fixture 自身的 bug，不是被测代码的）。
 */
export function makeXrefStreamPDF() {
  const parts = [];          // Buffer 片段
  let len = 0;               // 已写入字节数
  const offsets = {};
  const push = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1');
    parts.push(b); len += b.length;
  };
  const mark = (num) => { offsets[num] = len; };

  const content = 'BT /F1 18 Tf 15 60 Td (XRef Stream Test) Tj ET\n';
  const contentComp = zlib.deflateSync(Buffer.from(content, 'latin1'));

  // 对象 1=Catalog, 2=Pages, 3=Page, 4=Contents stream, 5=Font, 6=ObjStm(含1,2,3,5)
  const objStmInner = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
  ];
  const ids = [1, 2, 3, 5];
  let header = '', body = '';
  objStmInner.forEach((s, i) => {
    header += `${ids[i]} ${body.length} `;
    body += s + ' ';
  });
  const objStmRaw = Buffer.from(header + body, 'latin1');
  const objStmComp = zlib.deflateSync(objStmRaw);

  push('%PDF-1.5\n');

  // 4: 内容流
  mark(4);
  push(`4 0 obj\n<< /Length ${contentComp.length} /Filter /FlateDecode >>\nstream\n`);
  push(contentComp);
  push('\nendstream\nendobj\n');

  // 6: ObjStm
  mark(6);
  push(`6 0 obj\n<< /Type /ObjStm /N 4 /First ${header.length} /Length ${objStmComp.length} /Filter /FlateDecode >>\nstream\n`);
  push(objStmComp);
  push('\nendstream\nendobj\n');

  // 7: xref stream
  // W = [1 3 2] -> 每条记录 6 字节: type(1) + field2(3) + field3(2)
  const be3 = (v) => Buffer.from([(v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const be2 = (v) => Buffer.from([(v >> 8) & 255, v & 255]);
  const t1 = (off, gen) => Buffer.concat([Buffer.from([1]), be3(off), be2(gen)]);
  const t2 = (stm, idx) => Buffer.concat([Buffer.from([2]), be3(stm), be2(idx)]);
  const entries = [
    t1(0, 65535),      // 0: free
    t2(6, 0),          // 1
    t2(6, 1),          // 2
    t2(6, 2),          // 3
    t1(offsets[4], 0), // 4
    t2(6, 3),          // 5
    t1(offsets[6], 0), // 6
  ];
  const xrefData = Buffer.concat(entries);   // 7 * 6 = 42 字节
  const xrefComp = zlib.deflateSync(xrefData);

  const xrefPos = len;
  push(`7 0 obj\n<< /Type /XRef /Size 8 /W [1 3 2] /Root 1 0 R /Filter /FlateDecode /Length ${xrefComp.length} >>\nstream\n`);
  push(xrefComp);
  push(`\nendstream\nendobj\nstartxref\n${xrefPos}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** 增量更新：先写 v1（红色方块），再追加 v2（把它改成蓝色方块 + 加第二页） */
export function makeIncrementalPDF() {
  let pdf = makeClassicPDF();
  // --- 追加一次更新：替换对象 4 的内容流 ---
  const newContent = 'BT /F1 12 Tf 20 70 Td (Incremental v2) Tj ET\n0 0 1 rg 10 10 50 30 re f\n';
  const prevXref = pdf.length - pdf.toString('latin1').lastIndexOf('startxref');
  const startxrefVal = parseInt(pdf.toString('latin1').slice(pdf.toString('latin1').lastIndexOf('startxref') + 9).trim(), 10);

  let out = pdf.toString('latin1');
  const obj4Off = out.length;
  out += `4 0 obj\n<< /Length ${newContent.length} >>\nstream\n${newContent}endstream\nendobj\n`;
  // 新增对象 6: 第二页
  const page2Content = 'BT /F1 12 Tf 20 40 Td (Page Two Added) Tj ET\n';
  const obj6Off = out.length;
  out += `6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`;
  const obj7Off = out.length;
  out += `7 0 obj\n<< /Length ${page2Content.length} >>\nstream\n${page2Content}endstream\nendobj\n`;
  const obj2Off = out.length;
  out += `2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>\nendobj\n`;

  const xrefPos = out.length;
  out += `xref\n0 1\n0000000000 65535 f \n`;
  out += `2 1\n${String(obj2Off).padStart(10, '0')} 00000 n \n`;
  out += `4 1\n${String(obj4Off).padStart(10, '0')} 00000 n \n`;
  out += `6 2\n${String(obj6Off).padStart(10, '0')} 00000 n \n${String(obj7Off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 8 /Root 1 0 R /Prev ${startxrefVal} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * 故意写坏 xref offset，测试"偏移不准时的全文件回退搜索"路径。
 * 注意：这种损坏仍能被正确解析 —— 解析器在偏移失效时会自动扫描 "N G obj"，
 * 所以这是**韧性测试**而不是恢复模式测试。
 */
export function makeBrokenXrefPDF() {
  let s = makeClassicPDF().toString('latin1');
  const idx = s.indexOf('xref\n');
  const tail = s.slice(idx);
  // 破坏所有 n 条目的偏移
  s = s.slice(0, idx) + tail.replace(/\d{10} 00000 n/g, '9999999999 00000 n ');
  return Buffer.from(s, 'latin1');
}

/**
 * 彻底损坏：删掉 xref 段和 trailer，并让 startxref 指向垃圾。
 * 解析器必须靠暴力扫描重建索引。
 */
export function makeUnrecoverableXrefPDF() {
  let s = makeClassicPDF().toString('latin1');
  const idx = s.indexOf('xref\n');
  // 保留所有对象体，砍掉整个 xref + trailer，startxref 指向文件末尾之后的非法位置
  s = s.slice(0, idx) + 'startxref\n999999999\n%%EOF\n';
  return Buffer.from(s, 'latin1');
}

// 直接写文件方便调试
if (process.argv[1] && process.argv[1].endsWith('make-fixtures.mjs')) {
  const dir = new URL('./fixtures/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(new URL('classic.pdf', dir), makeClassicPDF());
  fs.writeFileSync(new URL('xrefstream.pdf', dir), makeXrefStreamPDF());
  fs.writeFileSync(new URL('incremental.pdf', dir), makeIncrementalPDF());
  fs.writeFileSync(new URL('broken.pdf', dir), makeBrokenXrefPDF());
  fs.writeFileSync(new URL('unrecoverable.pdf', dir), makeUnrecoverableXrefPDF());
  console.log('fixtures written to test/fixtures/');
}