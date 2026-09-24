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
scan('frontend/test/practice.html', /main\.js\?v=([^"']+)/g);
for (const f of fs.readdirSync(path.join(house, 'frontend/js'))) {
  if (f.endsWith('.js')) scan(`frontend/js/${f}`, /engine\/[a-z]+\.js\?v=([^'"]+)/g);
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
if (problems.length) {
  console.log('❌ 不一致：');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('✅ 版本号一致（改代码时记得三处一起改：BUILD、index.html、engine 转接文件）');
