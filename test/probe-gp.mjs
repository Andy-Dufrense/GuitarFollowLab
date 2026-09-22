// 不靠浏览器：直接在 Node 里用 alphaTab 解析 .gp3，顺便把技巧标记统计出来。
//
// 这一步能回答两个问题：
//   1. 谱面文件本身能不能解析（如果 Node 里都解析不出来，浏览器里当然也是空白）
//   2. 谱子上到底有哪些技巧标记（弯音/滑音/击勾弦/泛音/闷音…），哪些可能是错的
//
// 用法： node test/probe-gp.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const mod = require('../frontend/vendor/alphaTab.min.js');
// UMD 包在 Node 里可能把东西挂到 globalThis 上，也可能导出成 module.exports。
const alphaTab = (mod && Object.keys(mod).length) ? mod : (globalThis.alphaTab || mod || {});
console.log('require 结果键数：' + Object.keys(mod || {}).length
  + '｜globalThis.alphaTab：' + (globalThis.alphaTab ? '有' : '无')
  + '｜AlphaTabApi：' + (typeof alphaTab.AlphaTabApi));

console.log('alphaTab 导出：' + Object.keys(alphaTab).slice(0, 24).join(', '));
console.log('版本：' + (alphaTab.version || alphaTab.AlphaTabApi?.version || '?'));

const bytes = new Uint8Array(fs.readFileSync('frontend/data/hey_jude.gp3'));
console.log(`文件 ${bytes.length} 字节`);

// 低层 API：不用 DOM，直接解析成 Score
const settings = new alphaTab.Settings();
settings.core.fontDirectory = './frontend/vendor/font/';
const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);

console.log(`\n解析成功：${score.title} — ${score.artist}｜速度 ${score.tempo}｜小节 ${score.masterBars.length}｜声部 ${score.tracks.length}`);

const counter = {};
const bump = (k) => { counter[k] = (counter[k] || 0) + 1; };
const hammerList = [];

for (const track of score.tracks) {
  let notes = 0;
  const per = {};
  const add = (k) => { per[k] = (per[k] || 0) + 1; bump(`${track.name}:${k}`); };
  for (const bar of track.staves[0].bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const note of beat.notes) {
          notes++;
          if (note.isHammerPullOrigin) add('击勾弦起点');
          if (note.isHammerPullOrigin && track.name === 'Voice') {
            hammerList.push(`第${bar.index + 1}小节 ${note.string}弦${note.fret}品`);
          }
          if (note.slideInType && note.slideInType !== 0) add('滑入');
          if (note.slideOutType && note.slideOutType !== 0) add('滑出');
          if (note.bendType && note.bendType !== 0) add('推弦/弯音');
          if (note.harmonicType && note.harmonicType !== 0) add('泛音');
          if (note.isPalmMute) add('闷音');
          if (note.isDead) add('死音');
          if (note.vibrato && note.vibrato !== 0) add('揉弦');
          if (note.isGhost) add('幽灵音');
          if (note.isStaccato) add('顿音');
        }
      }
    }
  }
  const summary = Object.entries(per).map(([k, v]) => `${k}×${v}`).join(' ') || '（没有技巧标记）';
  console.log(`  声部「${track.name}」：${notes} 个音，${summary}`);
}

console.log('\n全部技巧标记统计：');
const all = Object.entries(counter);
if (!all.length) console.log('  （一个都没有）');
for (const [k, v] of all) console.log(`  ${k}：${v}`);

if (hammerList.length) {
  console.log('\n旋律轨上那 10 个"击勾弦"标记的位置（你看看是不是编配里真有的）：');
  hammerList.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
}
