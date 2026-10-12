import { PDFDocument } from '../src/xref.js';
import { decodeStream } from '../src/filters.js';
import { Dict, PDFStream, Name, isDict, isStream } from '../src/lexer.js';
import { makeClassicPDF, makeXrefStreamPDF, makeIncrementalPDF, makeBrokenXrefPDF, makeUnrecoverableXrefPDF } from './make-fixtures.mjs';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const bytesOf = (doc, obj) => decodeStream(obj, (x) => doc.resolve(x)).data;
const textOf = (doc, obj) => new TextDecoder('latin1').decode(bytesOf(doc, obj));

console.log('\n=== 经典 xref ===');
{
  const doc = new PDFDocument(new Uint8Array(makeClassicPDF())).parse();
  ok('未触发恢复', !doc.recovered, doc.warnings.join('; '));
  const pages = doc.pages();
  ok('页数 = 1', pages.length === 1, `got ${pages.length}`);
  const cat = doc.catalog();
  ok('catalog 是 Dict', isDict(cat) && cat.get('Type')?.name === 'Catalog');
  const pg = doc.resolve(pages[0].ref);
  ok('page dict 存在', isDict(pg) && pg.get('Type')?.name === 'Page');
  const content = textOf(doc, doc.resolve(pg.get('Contents')));
  ok('内容流解码正确', content.includes('Hello Classic') && content.includes(' re f'),
    JSON.stringify(content.slice(0, 60)));
  const mb = doc.resolve(pg.get('MediaBox'));
  ok('MediaBox = [0 0 200 100]', Array.isArray(mb) && mb[2] === 200 && mb[3] === 100, JSON.stringify(mb));
}

console.log('\n=== xref stream + ObjStm ===');
{
  const doc = new PDFDocument(new Uint8Array(makeXrefStreamPDF())).parse();
  ok('未触发恢复', !doc.recovered, doc.warnings.join('; '));
  const pages = doc.pages();
  ok('页数 = 1 (对象来自 ObjStm)', pages.length === 1, `got ${pages.length}`);
  if (pages.length) {
    const pg = doc.resolve(pages[0].ref);
    ok('Page dict 从 ObjStm 正确取出', isDict(pg) && pg.get('Type')?.name === 'Page');
    const c = textOf(doc, doc.resolve(pg.get('Contents')));
    ok('内容流解压正确', c.includes('XRef Stream Test'), JSON.stringify(c.slice(0, 50)));
    const font = doc.resolve(doc.resolve(pg.get('Resources')).get('Font').get('F1'));
    ok('字体从 ObjStm 取出 (Type1/BaseFont)', isDict(font) && font.get('BaseFont')?.name === 'Times-Roman');
  }
}

console.log('\n=== 增量更新 ===');
{
  const doc = new PDFDocument(new Uint8Array(makeIncrementalPDF())).parse();
  ok('未触发恢复', !doc.recovered, doc.warnings.join('; '));
  const pages = doc.pages();
  ok('页数 = 2 (增量加了第 2 页)', pages.length === 2, `got ${pages.length}`);
  let foundV2 = false, foundPage2 = false;
  for (const p of pages) {
    const c = textOf(doc, doc.resolve(p.dict.get('Contents')));
    if (c.includes('Incremental v2')) foundV2 = true;
    if (c.includes('Page Two Added')) foundPage2 = true;
  }
  ok('对象 4 采用了增量更新版本 (v2 内容)', foundV2);
  ok('新增页内容可读', foundPage2);
  const p2 = doc.resolve(pages.find(p => textOf(doc, doc.resolve(p.dict.get('Contents'))).includes('Page Two'))?.ref);
  ok('新增页 Parent 指向正确', isDict(p2) && p2.get('Parent')?.num === 2);
}

console.log('\n=== 偏移不准时的韧性（不进入恢复模式）===');
{
  const doc = new PDFDocument(new Uint8Array(makeBrokenXrefPDF())).parse();
  ok('偏移全错也能靠全文件扫描解析，无需恢复模式', !doc.recovered, doc.warnings.join('; '));
  const pages = doc.pages();
  ok('仍能拿到页', pages.length === 1, `got ${pages.length}`);
  if (pages.length) {
    const c = textOf(doc, doc.resolve(pages[0].dict.get('Contents')));
    ok('内容流正确', c.includes('Hello Classic'), JSON.stringify(c.slice(0, 40)));
  }
}

console.log('\n=== xref 彻底损坏 -> 暴力恢复 ===');
{
  const doc = new PDFDocument(new Uint8Array(makeUnrecoverableXrefPDF())).parse();
  ok('进入恢复模式', doc.recovered === true);
  ok('重建出 trailer/Root', doc.trailer.has('Root'));
  const pages = doc.pages();
  ok('恢复后拿到页', pages.length === 1, `got ${pages.length}`);
  if (pages.length) {
    const c = textOf(doc, doc.resolve(pages[0].dict.get('Contents')));
    ok('恢复后内容流正确', c.includes('Hello Classic'), JSON.stringify(c.slice(0, 40)));
  }
}

console.log('\n=== 对象/语法细节 ===');
{
  const doc = new PDFDocument(new Uint8Array(makeClassicPDF())).parse();
  // Name 转义
  const { Lexer, Name, parsePDFNumber } = await import('../src/lexer.js');
  const l1 = new Lexer(new TextEncoder().encode('/A#20B'));
  const n1 = l1.parseObject(null);
  ok('Name 的 #xx 转义', n1 instanceof Name && n1.name === 'A B', n1?.name);
  // 字面字符串转义: (a\(b\)c\n\101\t)
  // -> a,(,b,),c,LF,'A',TAB  共 8 字节
  //    索引  0  1  2  3  4   5   6   7
  const l2 = new Lexer(new TextEncoder().encode('(a\\(b\\)c\\n\\101\\t)'));
  const s2 = l2.parseObject(null);
  ok('字面字符串转义 (\\n \\ddd \\()', s2 instanceof Uint8Array &&
    s2.length === 8 && s2[0] === 97 && s2[1] === 40 && s2[2] === 98 && s2[3] === 41 &&
    s2[4] === 99 && s2[5] === 10 && s2[6] === 65 && s2[7] === 9, JSON.stringify([...s2]));
  // hex 字符串奇数位补 0: <48656C6C6> = 9 nibble -> 5 字节，末位 0x60
  const l3 = new Lexer(new TextEncoder().encode('<48656C6C6>'));
  const s3 = l3.parseObject(null);
  ok('hex 字符串奇数位补 0', s3.length === 5 && s3[0] === 0x48 && s3[3] === 0x6c && s3[4] === 0x60,
    JSON.stringify([...s3]));
  // 畸形数字
  ok('数字 ".5" = 0.5', parsePDFNumber('.5') === 0.5);
  ok('数字 "-.002" = -0.002', Math.abs(parsePDFNumber('-.002') + 0.002) < 1e-9);
  ok('畸形 "--5" 容错', parsePDFNumber('--5') === 5);
  ok('数字 "34.5" = 34.5', parsePDFNumber('34.5') === 34.5);
  // 嵌套数组/字典: [1 2 << /K [3 (x)] >> 4] -> 4 个元素，字典在 index 2
  const l4 = new Lexer(new TextEncoder().encode('[1 2 << /K [3 (x)] >> 4]'));
  const a4 = l4.parseObject(null);
  ok('嵌套结构解析', Array.isArray(a4) && a4.length === 4 &&
    a4[0] === 1 && a4[1] === 2 && isDict(a4[2]) && a4[3] === 4,
    `len=${Array.isArray(a4) ? a4.length : 'n/a'}`);
  // 字典内的数组值保留字符串元素
  const inner = a4[2]?.get('K');
  ok('嵌套数组保留字符串元素', Array.isArray(inner) && inner.length === 2 &&
    inner[0] === 3 && inner[1] instanceof Uint8Array && inner[1].length === 1 && inner[1][0] === 120,
    JSON.stringify(inner));
  // dict 的 key 必须是 name：'<< /A 1 /B 2 >>'
  const l5b = new Lexer(new TextEncoder().encode('<< /A 1 /B 2 >>'));
  const d5b = l5b.parseObject(null);
  ok('字典键值对解析', isDict(d5b) && d5b.get('A') === 1 && d5b.get('B') === 2);
  // parseDict 前有空白也必须能工作（xref 的 "trailer" 后就是这种情况）
  const l5c = new Lexer(new TextEncoder().encode('\n<< /Root 1 0 R >>'));
  const d5c = l5c.parseObject(null);
  ok('parseDict 前置空白容错', isDict(d5c) && d5c.get('Root')?.num === 1);
  // 注释与空字节空白
  const l5 = new Lexer(new Uint8Array([0x00, 0x25, 0x63, 0x6f, 0x6d, 0x0a, 0x34, 0x32])); // "\0%comment\n42"
  ok('\\0 视为空白 + % 注释', l5.parseObject(null) === 42);
}

console.log(`\n---- parser: ${pass} passed, ${fail} failed ----`);
if (fail) process.exit(1);