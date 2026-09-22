// 诊断工具：看一个音的**起音前后音高怎么走**。
//
// 用途：判定说是"弹错了"或"没听清"时，用这个看那一下到底是
//   · 手指还在移动（音高一路往谱面那个音收敛）—— 抓早了，不是弹错；
//   · 稳稳按在别的品上（音高不动）—— 真弹错了。
// 用的是产品页同一个估计器（analysis.js 的 estimateF0Near），所以量出来的
// 就是判定当时"看到的"那个东西。
//
// 用法： node test/probe-settle.mjs <录音.f32> <判定时刻秒> <期望MIDI> [更多 秒/MIDI...]
// 例：   node test/probe-settle.mjs sound_data/f32/hey_jude.f32 9.28 62 13.344 64
// （判定时刻和期望音从 VC_DUMP=1 的逐音记录里抄）

import fs from 'node:fs';

const M = new URL('../frontend/js/', import.meta.url);
const { estimateF0Near } = await import(new URL('analysis.js', M));
const { spectrumOf } = await import(new URL('dsp.js', M));

const SR = 48000, N = 8192;
const file = process.argv[2];
if (!file) { console.error('用法： node test/probe-settle.mjs <录音.f32> <秒> <MIDI> [...]'); process.exit(2); }
const raw = fs.readFileSync(file);
const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

const specAt = (endSec) => {
  const end = Math.round(endSec * SR);
  return spectrumOf(A.subarray(Math.max(0, end - N), Math.max(0, end)));
};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nm = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

const args = process.argv.slice(3).map(Number);
for (let k = 0; k < args.length; k += 2) {
  const t = args[k], expMidi = args[k + 1];
  console.log(`\n=== 期望 ${nm(expMidi)}(${expMidi})  判定时刻 t=${t}s ===`);
  for (let dt = -0.16; dt <= 0.32; dt += 0.04) {
    const spec = specAt(t + dt);
    const e = estimateF0Near(spec, SR, N, expMidi, { rangeCents: 80, tolCents: 15 });
    console.log(`  ${(dt * 1000).toFixed(0).padStart(5)}ms  ${e.f0.toFixed(1).padStart(6)}Hz`
      + `  ${((e.cents > 0 ? '+' : '') + e.cents.toFixed(0)).padStart(5)}c`
      + `  期望音能量/最强邻音=${(e.energy / (e.rivalScore || 1e-9)).toFixed(2)}`);
  }
}
