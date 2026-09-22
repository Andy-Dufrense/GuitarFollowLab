// 诊断：音准偏离半个音的时候，失配是什么样？
//
// 判定要说的是三种不同的话：
//   · 弹的就是这个音（可能琴略微不准）→ 判过
//   · 音准正好卡在两个半音中间      → "弦没调准，先调一下"
//   · 弹的是别的音                  → 判错
// 这里把目标的失配和"目标挪半个音之后"的失配摆在一起比，看能不能分开。
//
// 用法： node test/probe-flat.mjs

import { decimate, spectrumOf } from '../frontend/js/dsp.js';
import { track, novelSpectrum, resetAnalysis, candidateMismatch } from '../frontend/js/analysis.js';
import { midiToHz, midiToName } from '../frontend/js/data.js';

const SR = 48000, CAPTURE = 16384, DECIM = 4;

function pluckInto(dst, midi, at, dur, amp = 0.35) {
  const f0 = midiToHz(midi), from = Math.floor(at * SR), n = Math.floor(dur * SR);
  const H = [0.15, 1.0, 0.55, 0.32, 0.2, 0.14, 0.1, 0.07];
  for (let k = 1; k <= H.length; k++) {
    const f = f0 * k * (1 + 0.0002 * k * k);
    if (f > SR / 2 - 100) break;
    const a = amp * H[k - 1];
    for (let i = 0; i < n; i++) {
      const j = from + i; if (j < 0 || j >= dst.length) continue;
      const t = i / SR;
      dst[j] += a * Math.exp(-t * (3 + k * 0.6)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
    }
  }
}

function measure(centsOff) {
  const total = new Float32Array(Math.ceil(3 * SR));
  for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
  pluckInto(total, 40 + centsOff / 100, 1.0, 2.0);
  resetAnalysis();
  const sr2 = SR / DECIM, end = Math.floor(1.06 * SR);
  for (let t = CAPTURE; t <= end; t += Math.round(0.06 * SR)) {
    track(total.subarray(t - CAPTURE, t), DECIM, sr2);
  }
  const dec = decimate(total.subarray(end - CAPTURE, end), DECIM);
  const fftN = 1 << Math.floor(Math.log2(dec.length));
  const novel = novelSpectrum(spectrumOf(dec));
  const line = [];
  for (const d of [-1, -0.5, -0.25, 0, 0.25, 0.5, 1]) {
    const m = candidateMismatch(novel, sr2, fftN, 40 + d);
    line.push(`${d > 0 ? '+' : ''}${d}:${m.toFixed(0)}`);
  }
  console.log(`  偏低 ${String(centsOff).padStart(3)} 音分 → 失配（候选偏移：值）  ${line.join('  ')}`);
}

console.log('\n=== 六弦空弦 E2 的音准偏离，看失配怎么变（数值越小 = 越像）===');
for (const c of [0, -20, -35, -48, -55, -70]) measure(c);
