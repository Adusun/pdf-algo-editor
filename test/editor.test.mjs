// 编辑器测试：注释、页面操作、增量保存，以及"保存后能被自己重新解析"
import { PDFEditor, writeObj } from '../src/editor.js';
import { PDFDocument } from '../src/xref.js';
import { Dict, Name, Ref, PDFStream, isDict } from '../src/lexer.js';
import { interpretContent, extractPageText } from '../src/content.js';
import { makeClassicPDF, makeIncrementalPDF } from './make-fixtures.mjs';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const dec = (s) => new TextEncoder().encode(s);
const txt = (bytes) => new TextDecoder('latin1').decode(bytes);

console.log('\n=== 对象序列化 ===');
{
  const d = new Dict();
  d.set('Type', new Name('Annot'));
  d.set('C', [1, 0, 0]);
  d.set('NM', new Name('X-1'));
  d.set('Sub', new Ref(5, 0));
  const s = writeObj(d);
  ok('字典序列化', s === '<< /Type /Annot /C [1 0 0] /NM /X-1 /Sub 5 0 R >>', s);
  ok('数组序列化', writeObj([1, 2.5, -3]) === '[1 2.5 -3]', writeObj([1, 2.5, -3]));
  ok('字符串转义括号', writeObj('a(b)c') === '(a\\(b\\)c)', writeObj('a(b)c'));
  ok('数字去掉浮点尾数', writeObj(0.1 + 0.2) === '0.3', writeObj(0.1 + 0.2));
}

console.log('\n=== 高亮注释 ===');
{
  const doc = new PDFDocument(new Uint8Array(makeClassicPDF())).parse();
  const ed = new PDFEditor(doc);
  const r = ed.addHighlight(0, [[10, 20, 100, 40]]);
  ok('返回注释引用', !!r && r.annotRef instanceof Ref);
  ok('分配了对象号', r.annotRef.num > 5, `num=${r.annotRef.num}`);
  const d = ed.pending.get(r.annotRef.num);
  ok('Subtype = Highlight', d.get('Subtype')?.name === 'Highlight');
  ok('Rect 已设置', Array.isArray(d.get('Rect')) && d.get('Rect').length === 4);
  ok('QuadPoints 4 组坐标', String(d.get('QuadPoints')).split(/\s+/).length === 8,
    String(d.get('QuadPoints')));
  ok('有外观流 AP', !!d.get('AP'));
  // /AP /N 必须是**间接引用**（PDF 规范不允许内联 stream），
  // 测试要像真实阅读器那样先解析引用再取流。
  const apRef = d.get('AP').get('N');
  ok('AP/N 是间接引用', apRef instanceof Ref, typeof apRef);
  const ap = ed.pending.get(apRef.num);
  ok('AP/N 是流对象', ap instanceof PDFStream);
  ok('AP 内容包含 re f', txt(ap.raw).includes('re f'), JSON.stringify(txt(ap.raw).slice(0, 60)));
  ok('外观流已登记为独立对象（保存时才不会丢失）', ed.pending.has(apRef.num));
  ok('页面记录了 Annots', ed.pageAnnotsPending.size === 1);
}
{
  // 多行矩形求并集
  const doc = new PDFDocument(new Uint8Array(makeClassicPDF())).parse();
  const ed = new PDFEditor(doc);
  ed.addHighlight(0, [[10, 20, 100, 40], [10, 50, 80, 70]]);
  const r = ed.addHighlight(0, [[200, 10, 300, 30]]);
  const d = ed.pending.get(r.annotRef.num);
  const rect = d.get('Rect');
  ok('并集 Rect 覆盖两块', rect[0] === 200 && rect[1] === 10 && rect[2] === 300 && rect[3] === 30,
    JSON.stringify(rect));
}

console.log('\n=== 下划线 / 墨迹 / 便签 ===');
{
  const doc = new PDFDocument(new Uint8Array(makeClassicPDF())).parse();
  const ed = new PDFEditor(doc);
  const u = ed.addUnderline(0, [10, 20, 100, 40]);
  const ud = ed.pending.get(u.annotRef.num);
  ok('下划线 Subtype', ud.get('Subtype')?.name === 'Underline');
  const uap = ed.pending.get(ud.get('AP').get('N').num);
  ok('下划线外观含 S 描边', txt(uap.raw).includes(' S'), JSON.stringify(txt(uap.raw).slice(0, 50)));

  const ink = ed.addInk(0, [[[10, 10], [20, 20], [30, 15]], [[50, 50], [60, 60]]], [1, 0, 0], 2);
  const id = ed.pending.get(ink.annotRef.num);
  ok('墨迹 Subtype = Ink', id.get('Subtype')?.name === 'Ink');
  ok('InkList 两条折线', Array.isArray(id.get('InkList')) && id.get('InkList').length === 2);
  ok('InkList 每条 6 个数', String(id.get('InkList')[0]).split(/\s+/).length === 6,
    String(id.get('InkList')[0]));
  const r = id.get('Rect');
  ok('墨迹 Rect 覆盖全部笔迹', r[0] <= 10 && r[1] <= 10 && r[2] >= 60 && r[3] >= 60, JSON.stringify(r));

  const note = ed.addTextNote(0, 100, 100, '这是批注内容', '标题');
  const nd = ed.pending.get(note.annotRef.num);
  ok('便签 Subtype = Text', nd.get('Subtype')?.name === 'Text');
  ok('便签有 Contents', nd.get('Contents') === '这是批注内容');
  ok('便签有标题 T', nd.get('T') === '标题');
}

console.log('\n=== 页面旋转 ===');
{
  const doc = new PDFDocument(new Uint8Array(makeClassicPDF())).parse();
  const ed = new PDFEditor(doc);
  const pages = doc.pages();
  ok('rotatePage 成功', ed.rotatePage(0, 90) === true);
  const pd = ed.pending.get(pages[0].ref.num);
  ok('Rotate = 90', pd.get('Rotate') === 90, `got ${pd.get('Rotate')}`);
  ed.rotatePage(0, 450);
  ok('旋转规范化到 90', ed.pending.get(pages[0].ref.num).get('Rotate') === 90);
  ed.rotatePage(0, -90);
  ok('负角规范化到 270', ed.pending.get(pages[0].ref.num).get('Rotate') === 270,
    `got ${ed.pending.get(pages[0].ref.num).get('Rotate')}`);
  ed.rotatePage(0, 360);
  ok('360 归零', ed.pending.get(pages[0].ref.num).get('Rotate') === 0);
}

console.log('\n=== 追加内容到页面 ===');
{
  const doc = new PDFDocument(new Uint8Array(makeClassicPDF())).parse();
  const ed = new PDFEditor(doc);
  ok('appendToPageContent 成功', ed.appendToPageContent(0, '0 1 0 rg 0 0 50 50 re f') === true);
  const pages = doc.pages();
  const pd = ed.pending.get(pages[0].ref.num);
  const cref = pd.get('Contents');
  ok('Contents 指向新流', cref instanceof Ref);
  const stream = ed.pending.get(cref.num);
  const body = txt(stream.raw);
  ok('新流包含原内容', body.includes('Hello Classic'), JSON.stringify(body.slice(0, 50)));
  ok('新流包含追加内容', body.includes('0 1 0 rg'));
}

console.log('\n=== 增量保存与重新解析（关键闭环）===');
{
  const original = new Uint8Array(makeClassicPDF());
  const doc = new PDFDocument(new Uint8Array(original)).parse();
  const ed = new PDFEditor(doc);
  ed.addHighlight(0, [[10, 20, 100, 40]]);
  ed.addUnderline(0, [10, 60, 100, 80]);
  ed.rotatePage(0, 90);

  const saved = await ed.saveIncremental(original);
  ok('文件已增长', saved.length > original.length, `${original.length} -> ${saved.length}`);
  ok('原字节被完整保留', saved.slice(0, original.length).every((b, i) => b === original[i]));
  const s = txt(saved);
  ok('含 startxref', s.lastIndexOf('startxref') > 0);
  ok('含 %%EOF', s.trimEnd().endsWith('%%EOF'));
  ok('trailer 含 /Prev', s.slice(s.lastIndexOf('trailer')).includes('/Prev'));

  // 关键：用我们自己的解析器重新打开
  const doc2 = new PDFDocument(saved.slice()).parse();
  ok('重新解析未进入恢复模式', !doc2.recovered, doc2.warnings.join('; '));
  ok('重新解析仍有 1 页', doc2.pages().length === 1, `got ${doc2.pages().length}`);

  const pages2 = doc2.pages();
  const pd2 = doc2.resolve(pages2[0].ref);
  ok('页面仍有 Annots', !!pd2.get('Annots'), JSON.stringify([...pd2.keys()]));
  const annots = doc2.resolve(pd2.get('Annots'));
  ok('Annots 有 2 个注释', Array.isArray(annots) && annots.length === 2,
    `got ${Array.isArray(annots) ? annots.length : 'not array'}`);
  if (Array.isArray(annots) && annots.length === 2) {
    const a1 = doc2.resolve(annots[0]);
    const a2 = doc2.resolve(annots[1]);
    ok('注释1 是 Highlight', a1?.get('Subtype')?.name === 'Highlight', a1?.get('Subtype')?.name);
    ok('注释2 是 Underline', a2?.get('Subtype')?.name === 'Underline', a2?.get('Subtype')?.name);
    const ap = doc2.resolve(a1.get('AP'));
    ok('重新解析后 AP 仍可取到', !!ap);
  }
  // 原文字内容仍可读
  const text = extractPageText(doc2, 0).map(t => t.unicode).join('');
  ok('原文字仍可提取', text.includes('Hello Classic'), JSON.stringify(text));
}

console.log('\n=== 增量保存后再次编辑（多次追加）===');
{
  const original = new Uint8Array(makeClassicPDF());
  let bytes = original;
  // 第一次编辑
  {
    const doc = new PDFDocument(new Uint8Array(bytes)).parse();
    const ed = new PDFEditor(doc);
    ed.addTextNote(0, 10, 10, 'note1');
    bytes = await ed.saveIncremental(bytes);
  }
  // 第二次编辑
  {
    const doc = new PDFDocument(new Uint8Array(bytes)).parse();
    const ed = new PDFEditor(doc);
    ed.addTextNote(0, 100, 100, 'note2');
    bytes = await ed.saveIncremental(bytes);
  }
  ok('两次追加后文件更大', bytes.length > original.length * 1.9, `${bytes.length}`);
  const doc = new PDFDocument(bytes.slice()).parse();
  ok('多次追加后仍可解析', !doc.recovered, doc.warnings.join('; '));
  const pd = doc.resolve(doc.pages()[0].ref);
  const annots = doc.resolve(pd.get('Annots'));
  ok('两次追加后有 2 个便签', Array.isArray(annots) && annots.length === 2,
    `got ${Array.isArray(annots) ? annots.length : 'n/a'}`);
}

console.log('\n=== 未修改时不产生改动 ===');
{
  const original = new Uint8Array(makeClassicPDF());
  const doc = new PDFDocument(new Uint8Array(original)).parse();
  const ed = new PDFEditor(doc);
  const out = await ed.saveIncremental(original);
  ok('未修改时返回原字节', out.length === original.length);
}

console.log('\n=== 页面删除 ===');
{
  const original = new Uint8Array(makeIncrementalPDF());
  const doc = new PDFDocument(new Uint8Array(original)).parse();
  ok('原文档有 2 页', doc.pages().length === 2, `got ${doc.pages().length}`);
  const ed = new PDFEditor(doc);
  ok('deletePage 成功', ed.deletePage(0) === true);
  const saved = await ed.saveIncremental(original);
  const doc2 = new PDFDocument(saved.slice()).parse();
  ok('删除后仍可解析', !doc2.recovered, doc2.warnings.join('; '));
  ok('删除后剩 1 页', doc2.pages().length === 1, `got ${doc2.pages().length}`);
  const text = extractPageText(doc2, 0).map(t => t.unicode).join('');
  ok('保留的是第二页', text.includes('Page Two Added'), JSON.stringify(text));
}

console.log('\n=== 插入空白页 ===');
{
  const original = new Uint8Array(makeClassicPDF());
  const doc = new PDFDocument(new Uint8Array(original)).parse();
  const ed = new PDFEditor(doc);
  ed.insertBlankPage(1, 300, 300);
  const saved = await ed.saveIncremental(original);
  const doc2 = new PDFDocument(saved.slice()).parse();
  ok('插入后仍可解析', !doc2.recovered, doc2.warnings.join('; '));
  ok('插入后有 2 页', doc2.pages().length === 2, `got ${doc2.pages().length}`);
  const mb = doc2.resolve(doc2.pages()[1].ref).get('MediaBox');
  ok('新页尺寸正确', Array.isArray(mb) && mb[2] === 300 && mb[3] === 300, JSON.stringify(mb));
}

console.log(`\n---- editor: ${pass} passed, ${fail} failed ----`);
if (fail) process.exit(1);