// 诊断真机录音：每一次起音的瞬间，目标音的谐波位置到底"抬头"了没有。
//
// 这是"抬头率"这条路能不能走通的判据：
//   · 目标音的谐波位置抬头率 > 1（刚拨的往上跳）→ 判据可用，问题在阈值
//   · 抬头率 ≈ 1 或 < 1（没抬）→ 说明抓取的时刻不对，或者手机录的起音太缓/被 AGC 压平
//
// 用法： node test/probe-onset.mjs sound_data/f32/Em-T3231323.f32 E2 G3 B3 G3 E4 G3 B3 G3

import fs from 'node:fs';
import { rms, spectrumOf } from '../backend/engine/dsp.js';
import { FLUX_N } from '../backend/engine/config.js';
import { midiToHz, midiToName, NOTE_NAMES } from '../backend/engine/data.js';

const SR = 48000, CAPTURE = 16384;
const file = process.argv[2];
const names = process.argv.slice(3);
const namesToMidi = (n) => {
  const m = /^([A-G]#?)(-?\d)$/.exec(n);
  return NOTE_NAMES.indexOf(m[1]) + (Number(m[2]) + 1) * 12;
};
const expect = names.map(namesToMidi);

const raw = fs.readFileSync(file);
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
console.log(`${file}：${(audio.length / SR).toFixed(1)}s，期望音符 ${names.join(' ')}`);

// 抬头率用**短窗**：10.7ms（512 点）。而通量那个 FLUX_N=2048 是 43ms 的窗 ——
// 帧间隔 16ms，43ms 的窗跟上一帧重叠 27ms，起音被稀释掉了（实测很多音抬头率只有 0.9~1.0）。
// 512 点的窗跟上一帧完全不重叠，才是干净的"这一小段 vs 上一小段"。
const RISE_N = 512;
const riseBinHz = SR / RISE_N;
let prevSpec = null;
let floor = 0.001, gate = 0.01, frames = 0;
const hist = [];
let lastOnsetMs = -1e9;
let k = 0;
const found = [];

for (let end = CAPTURE; end <= audio.length; end += Math.round(0.016 * SR)) {
  const buf = audio.subarray(end - CAPTURE, end);
  const lv = rms(buf, buf.length - 1024, 1024);
  frames++;
  if (frames <= 30) floor += (Math.min(lv, 0.05) * 0.9 - floor) * 0.3;
  else if (lv < floor) floor = floor * 0.9 + lv * 0.1;
  else floor = Math.min(floor * 1.0003 + 1e-7, 0.06);
  floor = Math.max(floor, 0.0005);
  gate = Math.max(0.0035, floor * 4);

  const seg = buf.subarray(buf.length - RISE_N);
  const mags = spectrumOf(seg);
  let flux = 0, total = 0;
  const rise = new Float32Array(mags.length);
  for (let i = 0; i < mags.length; i++) {
    const prev = prevSpec && prevSpec.length === mags.length ? prevSpec[i] : 0;
    const d = mags[i] - prev;
    if (d > 0) flux += d;
    total += mags[i];
    rise[i] = mags[i] / (prev + 1e-9);
  }
  prevSpec = mags;
  const fluxRel = total > 1e-9 ? flux / total : 0;

  const lagged = hist.length >= 3 ? hist[hist.length - 3] : 0;
  const rising = lv > lagged * 1.6;
  const fluxOnset = fluxRel > 0.16 && lv > lagged * 1.15;
  const nowMs = (end / SR) * 1000;
  if (lv > gate && (rising || fluxOnset) && nowMs - lastOnsetMs > 90) {
    lastOnsetMs = nowMs;
    found.push({ ms: Math.round(nowMs), rise, expect: expect[k] });
    k++;
  }
  hist.push(lv);
  if (hist.length > 8) hist.shift();
}

console.log(`\n检出 ${found.length} 次起音（期望 ${expect.length} 个音）\n`);
console.log('  时间     期望音   峰值电平   该音谐波位置的抬头率（k=1..5）');
for (const f of found) {
  const vals = [];
  if (f.expect != null) {
    for (let h = 1; h <= 5; h++) {
      const hz = midiToHz(f.expect) * h;
      const idx = Math.round(hz / riseBinHz);
      vals.push(idx >= 0 && idx < f.rise.length ? f.rise[idx].toFixed(2) : '--');
    }
  }
  console.log(`  ${String(f.ms).padStart(5)}ms  ${(f.expect != null ? midiToName(f.expect) : '?').padEnd(5)}`
    + `   ${String(f.rise.reduce((a, b) => Math.max(a, b), 0)).slice(0, 0)}          ${vals.join('  ')}`);
}
