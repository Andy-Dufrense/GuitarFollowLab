// 测量："同一个音，我们的音高估计差多少音分" —— 判定准不准的地基。
//
// 目的：一个半音是 100 音分。要把"按低一品/按高一品"判出来，估计的散布必须
// 明显小于 100 音分（目标：95% 落在 ±50 音分内）。这个脚本就是拿来量散布的。
//
// 输入是一份真机录音的**起音表**（test-follow-real.mjs 用 VC_ONSET_OUT=... 导出）：
//   · 起音时刻（判定链路自己检出来的）
//   · 谱面音符表（这里的"标准答案"= 谱面第 i 个音配第 i 个起音；
//     用户录的是照谱弹的，所以这一列当基准近似成立 —— 它是标定用的，不是断言）
//
// 用法： node test/probe-accuracy.mjs <onsets.json> [模式]
//   模式： all（默认，全部窗口策略对比） | best（只跑选中的那一种）
//
// 每种"窗口策略"都回答同一个问题：在**哪一段音频**上量音高最准。

import fs from 'node:fs';

const M = 'file:///E:/GuitarFollowLab/backend/engine/';
const { estimateF0Near } = await import(M + 'analysis.js');
const { spectrumOf } = await import(M + 'dsp.js');

const SR = 48000;
const file = process.argv[2];
if (!file) { console.error('用法： node test/probe-accuracy.mjs <onsets.json>'); process.exit(2); }
const { audio: wavPath, onsets, notes } = JSON.parse(fs.readFileSync(file, 'utf8'));
const raw = fs.readFileSync(wavPath);
const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

// 从录音里取 [startSec, startSec+lenSec] 这一段（不足补 0）
function seg(startSec, lenSamples) {
  const from = Math.round(startSec * SR);
  const out = new Float32Array(lenSamples);
  for (let i = 0; i < lenSamples; i++) {
    const j = from + i;
    if (j >= 0 && j < A.length) out[i] = A[j];
  }
  return out;
}

const cents = (hz, midi) => 1200 * Math.log2(hz / (440 * Math.pow(2, (midi - 69) / 12)));

// 窗口策略：都是"从起音后多久开始、量多长"
const STRATEGIES = {
  'A 起音前170ms（现在的峰值快照）': { endAt: 0, ms: 170 },  // 旧：窗口结束于起音那一刻
  'B 起音那一刻起 170ms': { at: 0, ms: 170 },               // 需要等 170ms 才有数据
  'C 起音后 30ms 起 170ms': { at: 30, ms: 170 },
  'D 起音后 30ms 起 85ms': { at: 30, ms: 85 },              // 判定那一刻（+90ms）就能拿到
  'E 起音后 0ms 起 85ms': { at: 0, ms: 85 },
  'F 起音后 60ms 起 85ms': { at: 60, ms: 85 },
  'G 结束于起音后 100ms（170ms）': { endAt: 100, ms: 170 },
  'H 结束于起音后 150ms（170ms）': { endAt: 150, ms: 170 },
  'I 结束于起音后 250ms（170ms）': { endAt: 250, ms: 170 },
};

const stats = (arr) => {
  const a = arr.slice().sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  return { mean, p50: q(0.5), p90: q(0.9), max: a[a.length - 1], min: a[0] };
};

console.log(`录音 ${wavPath}：${(A.length / SR).toFixed(1)}s，起音 ${onsets.length} 个`);
console.log('（基准 = 谱面第 i 个音配第 i 个起音；量的是"估计值 − 谱面值"的音分）\n');

const rows = [];
const detail = [];
for (const [name, s] of Object.entries(STRATEGIES)) {
  const errs = [];
  for (let i = 0; i < onsets.length && i < notes.length; i++) {
    const t0 = onsets[i] + s.at / 1000;
    const t0b = onsets[i] + (s.endAt != null ? (s.endAt - s.ms) / 1000 : 0);
    const n = Math.round((s.ms / 1000) * SR);
    const N = 1 << Math.floor(Math.log2(n));
    const mags = spectrumOf(seg(s.endAt != null ? t0b : t0, N));
    const e = estimateF0Near(mags, SR, N, notes[i].midi, { rangeCents: 80, tolCents: 15 });
    if (e.score > 0 && e.f0 > 40) errs.push(cents(e.f0, notes[i].midi));
    if (process.env.VC_DETAIL && s.at === 0 && s.ms === 170) {
      detail.push(`#${i + 1} 期望${notes[i].midi} 实测${e.f0.toFixed(1)}Hz ${Math.round(cents(e.f0, notes[i].midi))}c`);
    }
  }
  const st = stats(errs);
  const within50 = errs.filter((x) => Math.abs(x) <= 50).length;
  const within30 = errs.filter((x) => Math.abs(x) <= 30).length;
  rows.push({ name, n: errs.length, ...st, within30, within50 });
}

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(pad('窗口策略', 34) + pad('样本', 6) + pad('中位', 8) + pad('90分位', 8)
  + pad('最小', 8) + pad('最大', 8) + pad('±30内', 8) + '±50内');
for (const r of rows) {
  console.log(pad(r.name, 34) + pad(r.n, 6) + pad(Math.round(r.p50), 8) + pad(Math.round(r.p90), 8)
    + pad(Math.round(r.min), 8) + pad(Math.round(r.max), 8)
    + pad(`${Math.round((r.within30 / r.n) * 100)}%`, 8) + `${Math.round((r.within50 / r.n) * 100)}%`);
}

console.log('\n判据：一个半音 = 100 音分。±50 音分内的比例越高，'
  + '"按错一品"才越可能被判出来。');
if (process.env.VC_DETAIL) console.log('\n策略 B 的逐音：\n  ' + detail.join('\n  '));
