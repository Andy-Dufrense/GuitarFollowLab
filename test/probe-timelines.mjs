// 两份时间轴的对照：判定用的是 frontend/data/hey_jude.json，
// 谱面基准（PyGuitarPro 数出来的）放在 data/hey_jude.timeline.json。
// 跟弹页要求"谱面有 118 个要弹的音" —— 判定清单也得是这 118 个，且顺序一致。
//
// 用法： node test/probe-timelines.mjs

import fs from 'node:fs';

const a = JSON.parse(fs.readFileSync('frontend/data/hey_jude.json', 'utf8')).notes;
const b = JSON.parse(fs.readFileSync('data/hey_jude.timeline.json', 'utf8')).notes;

console.log(`判定用的清单 frontend/data/hey_jude.json：${a.length} 个音`);
console.log(`谱面基准 data/hey_jude.timeline.json：${b.length} 个音`);
console.log('判定清单第 1 个：', JSON.stringify(a[0]));
console.log('谱面基准第 1 个：', JSON.stringify(b[0]));

const n = Math.min(a.length, b.length);
let diff = 0;
let firstDiff = -1;
for (let i = 0; i < n; i++) {
  const same = a[i].midi === b[i].midi && a[i].fret === b[i].fret;
  if (!same) {
    diff++;
    if (firstDiff < 0) { firstDiff = i; console.log(`第一处不同 #${i + 1}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`); }
  }
}
console.log(`逐条比音高+品：${n} 条里 ${diff} 条不同（第一处 #${firstDiff + 1}）`);

// 弦号：判定清单里 string 是 GP 记法（1 = 最细）；谱面基准同样。
const strDiff = a.filter((x, i) => b[i] && x.string !== b[i].string).length;
console.log(`弦号不同的条数：${strDiff}`);
