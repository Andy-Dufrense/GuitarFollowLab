// 批量评分：把真机录音丢进来，一命令出一张表。
//
// 这是给"真机测试"用的入口 —— 录一段，跑一下，看：
//   · 对/错/测不准/漏 各几个（同一段录音反复跑，数字变了就是改动把东西弄坏了）
//   · 每一处"错"的量到值（哪些音被读成了什么）
//   · 逐音明细写成 JSON，给后续调参留底
//
// 用法：
//   node test/grade.mjs                          # 跑 sound_data/f32/*.f32
//   node test/grade.mjs a.f32 b.f32               # 跑指定的几段
//   node test/grade.mjs --json                   # 只看 JSON（给脚本用）
//
// 注意：每段录音起一个**独立进程**跑 test-follow-real.mjs —— 判定链路有模块级状态，
// 同进程连着跑会串味（谱面、噪声地板、音准基线都会带过去）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const args = process.argv.slice(2).filter((a) => a !== '--json');
const onlyJson = process.argv.includes('--json');

const all = process.argv.includes('--all');
let files = args;
if (!files.length) {
  const dir = path.join(root, 'sound_data', 'f32');
  const allFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.f32')) : [];
  // 评分要拿**对应的谱面时间轴**来对号 —— 现在只有 Hey Jude 那份。
  // 默认只跑它；要跑别的（比如和弦练习录音，跟这份谱面对不上）得自己点名 + --all，
  // 而且那种情况下出来的数字本身没有意义，只是看看判定链路跑不跑得起来。
  files = (all ? allFiles : allFiles.filter((f) => /hey_jude/i.test(f))).map((f) => path.join(dir, f));
  if (!files.length) {
    console.error('sound_data/f32/ 里没有和谱面对得上的录音（现在只认 hey_jude）。'
      + '直接给路径可以强制跑：node test/grade.mjs --all');
    process.exit(2);
  }
}

function runOne(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, 'test-follow-real.mjs'), file],
      { cwd: root, env: { ...process.env, VC_JSON: '1' } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (!line) return resolve({ file, error: (err || out).slice(-400) });
      try { resolve(JSON.parse(line.slice(7))); } catch (e) { resolve({ file, error: String(e) }); }
    });
  });
}

const results = [];
for (const f of files) {
  const abs = path.resolve(root, f);
  process.stderr.write(`跑 ${path.basename(abs)} …`);
  const r = await runOne(abs);
  process.stderr.write(r.error ? ' 失败\n' : ' ok\n');
  results.push(r);
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const outPath = path.join(root, `grade-${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify(results.map((r) => ({
  file: r.file, error: r.error, onsets: r.onsets, good: r.good, bad: r.bad,
  unclear: r.unclear, missed: r.missed, wrongs: r.wrongs, log: r.log,
})), null, 1));

if (onlyJson) { console.log(JSON.stringify(results)); process.exit(0); }

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('\n（评分 = 拿谱面时间轴一个音一个音对号；录音必须和这份谱面对得上，'
  + '否则"对/错"没有意义。现在只有 hey_jude 那份谱面。）');
console.log('\n录音'.padEnd(30) + pad('起音', 6) + pad('对', 5) + pad('错', 5) + pad('测不准', 8) + pad('漏', 5) + '判错的地方');
for (const r of results) {
  const name = path.basename(String(r.file)).slice(0, 28);
  if (r.error) { console.log(pad(name, 30) + '跑不起来：' + r.error.split('\n')[0].slice(0, 70)); continue; }
  console.log(pad(name, 30) + pad(r.onsets, 6) + pad(r.good, 5) + pad(r.bad, 5) + pad(r.unclear, 8) + pad(r.missed, 5)
    + (r.wrongs || '（无）').replace(/^弹错：/, '').slice(0, 80));
}
console.log(`\n逐音明细写到 ${path.relative(root, outPath)}`);
console.log('怎么用：同一段录音跑两次，数字应该完全一样；改完代码再跑一遍，数字变了就是这次改动的影响。');
