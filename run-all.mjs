// 一键运行全部测试：node run-all.mjs
import { spawnSync } from 'node:child_process';

const suites = ['codec', 'parser', 'raster', 'font', 'content', 'editor', 'e2e', 'ui'];
let total = 0, failed = 0;

for (const s of suites) {
  const r = spawnSync(process.execPath, [`test/${s}.test.mjs`], { encoding: 'utf8' });
  const out = r.stdout || '';
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const p = m ? +m[1] : 0;
  const f = m ? +m[2] : 1;
  total += p; failed += f;
  console.log(`${f === 0 ? 'OK  ' : 'FAIL'} ${s.padEnd(9)} ${p} passed${f ? `, ${f} FAILED` : ''}`);
  if (f) {
    for (const line of out.split('\n')) if (line.includes('FAIL')) console.log('       ' + line.trim());
  }
}
console.log(`\n合计 ${total} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);