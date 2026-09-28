// 版本号一致性检查：页面里的 BUILD、index.html 的入口脚本、以及所有 engine 导入的
// ?v= 必须完全一样。不一样 = 手机上的模块缓存会对不上（顶栏出来、谱面空白、按钮点不动）。
//
// 用法： node test/check-build.mjs

import fs from 'node:fs';
import path from 'node:path';

const house = path.resolve(process.cwd());
const buildSrc = fs.readFileSync(path.join(house, 'frontend/js/follow-score.js'), 'utf8');
const BUILD = (buildSrc.match(/const BUILD = '([^']+)'/) || [])[1];
if (!BUILD) { console.error('找不到 frontend/js/follow-score.js 里的 BUILD'); process.exit(1); }

const problems = [];
const seen = [];
const scan = (file, re) => {
  const t = fs.readFileSync(path.join(house, file), 'utf8');
  for (const m of t.matchAll(re)) {
    const v = m[1];
    seen.push(`${file} → ${v}`);
    if (v !== BUILD) problems.push(`${file}: ?v=${v}（应为 ${BUILD}）`);
  }
};

scan('frontend/index.html', /follow-score\.js\?v=([^"']+)/g);
// ⚠ 2026-09-28：老页面（main.js + judge/ui/state/exercises/follow/metronome 那几个）
//   已经被产品页取代、整簇删掉了，`frontend/test/practice.html` 也跟着删了 ——
//   这里原来会去读它，删完就 ENOENT。老页面不再有版本号要检查。
for (const f of fs.readdirSync(path.join(house, 'frontend/js'))) {
  if (f.endsWith('.js')) scan(`frontend/js/${f}`, /engine\/[a-z]+\.js\?v=([^'"]+)/g);
}
// ⚠ 2026-09-28：判定循环搬进了 frontend/js/app/judge-loop.js，它自己 import 了 engine/*，
//   所以 app/ 下的模块也要一起检查（原来只扫 frontend/js 顶层）。
const appDir = path.join(house, 'frontend/js/app');
for (const f of fs.readdirSync(appDir)) {
  if (f.endsWith('.js')) scan(`frontend/js/app/${f}`, /engine\/[a-z]+\.js\?v=([^'"]+)/g);
}
for (const f of fs.readdirSync(path.join(house, 'frontend/js/engine'))) {
  if (f.endsWith('.js')) scan(`frontend/js/engine/${f}`, /backend\/engine\/[a-z]+\.js\?v=([^'"]+)/g);
}

console.log(`BUILD = ${BUILD}｜带版本号的地址 ${seen.length} 处`);
// 每个前端 js 里指向 engine 的导入都必须带版本号
for (const f of fs.readdirSync(path.join(house, 'frontend/js'))) {
  if (!f.endsWith('.js')) continue;
  const t = fs.readFileSync(path.join(house, 'frontend/js', f), 'utf8');
  const bare = t.match(/from '\.\/engine\/[a-z]+\.js'/g) || [];
  if (bare.length) problems.push(`frontend/js/${f}: 有没带 ?v= 的 engine 导入 ${bare.length} 处`);
}
// app/ 下的模块用相对路径 import engine（../engine/…），检查口径同上
for (const f of fs.readdirSync(appDir)) {
  if (!f.endsWith('.js')) continue;
  const t = fs.readFileSync(path.join(appDir, f), 'utf8');
  const bare = t.match(/from '\.\.\/engine\/[a-z]+\.js'/g) || [];
  if (bare.length) problems.push(`frontend/js/app/${f}: 有没带 ?v= 的 engine 导入 ${bare.length} 处`);
}
if (problems.length) {
  console.log('❌ 不一致：');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('✅ 版本号一致（改代码时记得三处一起改：BUILD、index.html、engine 转接文件）');
