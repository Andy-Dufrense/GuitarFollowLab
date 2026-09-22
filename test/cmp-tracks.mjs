// 核对：我们判定用的时间轴（frontend/data/hey_jude.json，来自 Python 解析）
// 和谱面渲染/试听用的谱（alphaTab 解析同一份 .gp3）**是不是同一串音**。
// 如果两串不一致，就会出现"用户跟着试听弹对了、判定却全错"。

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
require('../frontend/vendor/alphaTab.min.js');
const alphaTab = globalThis.alphaTab;
const settings = new alphaTab.Settings();
settings.core.fontDirectory = './frontend/vendor/font/';
const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
  new Uint8Array(fs.readFileSync('frontend/data/hey_jude.gp3')), settings);

console.log('声部：' + score.tracks.map((t, i) => `${i}:${t.name}`).join('  '));
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nm = (m) => names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

const seqOf = (trackIndex) => {
  const out = [];
  const stave = score.tracks[trackIndex].staves[0];
  for (const bar of stave.bars) for (const v of bar.voices) for (const b of v.beats) {
    for (const n of b.notes) out.push(n.realValue);
  }
  return out;
};

const js = seqOf(0);                        // alphaTab 解析的 Voice 轨
const py = JSON.parse(fs.readFileSync('frontend/data/hey_jude.json', 'utf8')).notes.map((n) => n.midi);

console.log(`alphaTab Voice 轨：${js.length} 个音`);
console.log(`我们的时间轴    ：${py.length} 个音`);
console.log('\n前 24 个逐个对照（alphaTab | 时间轴）：');
let diff = 0;
for (let i = 0; i < 24; i++) {
  const a = js[i], b = py[i];
  const same = a === b;
  if (!same) diff++;
  console.log(`  ${String(i + 1).padStart(2)}. ${(a != null ? nm(a) : '—').padEnd(4)} | ${(b != null ? nm(b) : '—').padEnd(4)} ${same ? '' : '  ← 不一致'}`);
}
console.log(`\n前 24 个里有 ${diff} 个不一致`);
const n = Math.min(js.length, py.length);
let allDiff = 0;
for (let i = 0; i < n; i++) if (js[i] !== py[i]) allDiff++;
console.log(`全部 ${n} 个音里共有 ${allDiff} 个不一致`);
