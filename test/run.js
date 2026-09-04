/* 一把跑完所有测试。用法：node test/run.js（在哪个目录下跑都行） */
const fs = require('fs'), path = require('path'), cp = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let pass = 0, fail = 0, broke = 0;
for (const f of files) {
  const r = cp.spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/);
  if (!m) {
    broke++;
    console.log('崩溃  ' + f);
    console.log(out.trim().split('\n').slice(-6).map((l) => '        ' + l).join('\n'));
    continue;
  }
  const [, p, x] = m;
  pass += Number(p); fail += Number(x);
  console.log((Number(x) ? '失败  ' : '通过  ') + f.padEnd(24) + p + ' 通过 / ' + x + ' 失败');
  if (Number(x)) console.log(out.split('\n').filter((l) => l.includes('FAIL')).map((l) => '      ' + l.trim()).join('\n'));
}

console.log('\n' + files.length + ' 个文件 · ' + pass + ' 通过 / ' + fail + ' 失败' + (broke ? ' / ' + broke + ' 个崩溃' : ''));
process.exit(fail || broke ? 1 : 0);
