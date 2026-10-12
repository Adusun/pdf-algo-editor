// 编解码层测试：用 Node 原生 zlib 生成真数据，验证我们手写的 inflate 结果一致
import { inflate, inflateRaw, deflateStored } from '../src/inflate.js';
import { ascii85Decode, asciiHexDecode, runLengthDecode, lzw, undoPredictor } from '../src/filters.js';
import zlib from 'node:zlib';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

console.log('\n=== inflate ===');
const cases = [
  ['empty', Buffer.alloc(0)],
  ['short literal', Buffer.from('Hello World')],
  ['repetitive (LZ77 heavy)', Buffer.from('ABCABCABCABC'.repeat(200))],
  ['random-ish 64KB', Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 37 + (i >> 8) * 11) & 0xff))],
];
for (const [name, buf] of cases) {
  for (const level of [0, 1, 6, 9]) {
    const comp = zlib.deflateSync(buf, { level });
    const r = inflate(new Uint8Array(comp));
    const got = Buffer.from(r.data);
    const expect = buf;
    const same = got.length === expect.length && got.equals(expect);
    ok(`zlib level=${level} "${name}" (${buf.length}B -> ${comp.length}B)`, same && !r.error,
      `err=${r.error} got=${got.length} want=${expect.length}`);
  }
}

// 截断流容错：解压一半的数据必须返回已解出的部分，而不是抛异常
{
  const big = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(500));
  const comp = zlib.deflateSync(big, { level: 9 });
  const cut = new Uint8Array(comp.subarray(0, Math.floor(comp.length * 0.6)));
  let r = null, threw = false;
  try { r = inflate(cut); } catch (e) { threw = true; }
  ok('truncated stream: no throw, returns partial data', !threw && r && r.data.length > 100,
    `threw=${threw} len=${r ? r.data.length : 0}`);
  ok('truncated stream: partial data is a prefix of truth',
    r && Buffer.from(big.subarray(0, r.data.length)).equals(Buffer.from(r.data)));
}

// 裸 deflate（无 zlib 头）
{
  const src = Buffer.from('bare deflate test '.repeat(100));
  const comp = zlib.deflateRawSync(src);
  const r = inflateRaw(new Uint8Array(comp));
  ok('raw deflate (no zlib header)', Buffer.from(r.data).equals(src) && !r.error, `err=${r.error}`);
}

// 自写的 stored deflate 必须能被 zlib 解回来（写出侧的合法性验证）
{
  const src = Buffer.from(Array.from({ length: 200000 }, (_, i) => i & 0xff));
  const mine = deflateStored(new Uint8Array(src));
  let back;
  try { back = zlib.inflateSync(Buffer.from(mine)); } catch (e) { back = null; }
  ok('our deflateStored is decodable by Node zlib', back !== null && back.equals(src),
    back ? `len mismatch ${back.length} vs ${src.length}` : 'inflate failed');
}

console.log('\n=== base filters ===');
{
  // A85 往返测试：测试内自己实现参考编码器，避免硬编码向量写错
  function refA85Encode(bytes) {
    let s = '', i = 0;
    for (; i + 4 <= bytes.length; i += 4) {
      let t = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
      const chunk = [];
      for (let k = 0; k < 5; k++) { chunk.unshift(String.fromCharCode(33 + (t % 85))); t = Math.floor(t / 85); }
      s += chunk.join('');
    }
    const rem = bytes.length - i;
    if (rem > 0) {
      let t = 0;
      for (let k = 0; k < 4; k++) t = (t << 8) | (k < rem ? bytes[i + k] : 0);
      const chunk = [];
      for (let k = 0; k < 5; k++) { chunk.unshift(String.fromCharCode(33 + (t % 85))); t = Math.floor(t / 85); }
      s += chunk.slice(0, rem + 1).join('');
    }
    return s + '~>';
  }
  for (const msg of ['Hello', 'Man ', 'abcde', 'x', 'The quick brown fox']) {
    const enc = refA85Encode(Buffer.from(msg));
    const dec = ascii85Decode(new TextEncoder().encode(enc));
    ok(`ASCII85Decode round-trip "${msg}"`, Buffer.from(dec).toString('latin1') === msg,
      `enc=${enc} got=${JSON.stringify(Buffer.from(dec).toString('latin1'))}`);
  }
  const h = asciiHexDecode(new TextEncoder().encode('48656C6C6F>'));
  ok('ASCIIHexDecode', Buffer.from(h).toString() === 'Hello');
  const rl = runLengthDecode(new Uint8Array([2, 65, 66, 67, 254, 88, 128]));
  ok('RunLengthDecode', Buffer.from(rl).equals(Buffer.from('ABCXXX')), JSON.stringify(Buffer.from(rl).toString()));
}

console.log('\n=== predictors ===');
{
  // PNG Up predictor: 编码行 = raw - prior，上一行 prior=0 时等于原值
  const enc = new Uint8Array([2, 10, 20, 30]);
  const dec = undoPredictor(enc, 12, 1, 8, 3);
  ok('PNG Up predictor (ft byte stripped)', Buffer.from(dec).equals(Buffer.from([10, 20, 30])),
    JSON.stringify([...dec]));
  // Sub predictor: 差分
  const sub = new Uint8Array([1, 5, 5, 5]);
  const d2 = undoPredictor(sub, 12, 1, 8, 3);
  ok('PNG Sub predictor', Buffer.from(d2).equals(Buffer.from([5, 10, 15])), JSON.stringify([...d2]));
  // Paeth
  const pae = new Uint8Array([4, 5, 5, 5]);
  const d3 = undoPredictor(pae, 12, 1, 8, 3);
  ok('PNG Paeth predictor', Buffer.from(d3).equals(Buffer.from([5, 10, 15])), JSON.stringify([...d3]));
  // 多行 Up：row0 编码 [1,1,1] prior=0 -> [1,1,1]；row1 编码 [2,4,4,4] + prior [1,1,1] -> [3,5,5]
  const two = new Uint8Array([2, 1, 1, 1, 2, 2, 4, 4]);
  const d4 = undoPredictor(two, 12, 1, 8, 3);
  ok('PNG Up multi-row', Buffer.from(d4).equals(Buffer.from([1, 1, 1, 3, 5, 5])), JSON.stringify([...d4]));
  // TIFF predictor 2 (左邻居累加，无 ft 字节)
  const tiff = new Uint8Array([5, 5, 5]);
  const d5 = undoPredictor(tiff, 2, 1, 8, 3);
  ok('TIFF predictor 2', Buffer.from(d5).equals(Buffer.from([5, 10, 15])), JSON.stringify([...d5]));
}

console.log(`\n---- codec: ${pass} passed, ${fail} failed ----`);
if (fail) process.exit(1);