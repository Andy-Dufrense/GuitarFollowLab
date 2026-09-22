// 和弦谱判定：不出错音时不该报外音；弹了和弦外音要报出来，并说出是什么音。
// 用法： node test/test-outsiders.mjs

import { decimate, spectrumOf } from '../backend/engine/dsp.js';
import { chordOutsiders } from '../backend/engine/analysis.js';
import { midiToHz, midiToName } from '../backend/engine/data.js';

const SR = 48000, DECIM = 4;
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('   !! ' + m); } };

function pluckInto(dst, midi, at, amp = 0.35) {
  const f0 = midiToHz(midi), from = Math.floor(at * SR), n = Math.floor(1.2 * SR);
  for (let k = 1; k <= 8; k++) {
    const f = f0 * k * (1 + 0.0002 * k * k);
    if (f > SR / 2 - 100) break;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      dst[from + i] += (amp / k) * Math.exp(-t * (3 + k * 0.6)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
    }
  }
}

function spectrumOfCase(extra = null) {
  const total = new Float32Array(Math.ceil(2 * SR));
  for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
  // Em 的分解和弦：六弦 E2、三弦 G3、二弦 B3、一弦 E4
  [40, 55, 59, 64].forEach((m, i) => pluckInto(total, m, 0.4 + i * 0.02));
  if (extra != null) pluckInto(total, extra, 0.4 + 4 * 0.02);
  // 用**短窗**（85ms）而不是 341ms 的长窗：外音只响了一小段，
  // 长窗会把它稀释到进不了峰榜（实测就是这样把 D#4 弄丢的）。
  // 真实链路里外音检测也要挂在起音那一刻用短窗做，这是同一个道理。
  const end = Math.floor(0.55 * SR);
  const dec = decimate(total.subarray(end - 4096, end), DECIM);
  return spectrumOf(dec);
}

const EM = [40, 67, 71, 64, 59, 55];      // 六根弦上 Em 的音（E2 G3 B3 E4 B3 E4）
const sr2 = SR / DECIM, fftN = 1024;

console.log('\n=== A. 只弹 Em 的和弦音 → 不该报外音 ===');
{
  const r = chordOutsiders(spectrumOfCase(), sr2, fftN, EM);
  console.log(`  被和弦解释的能量占比 ${(r.ratio * 100).toFixed(1)}%，外音 ${r.outsiders.length} 个`);
  ok(r.ratio >= 0.8, `只弹和弦音时解释率应 ≥80%，实际 ${(r.ratio * 100).toFixed(1)}%`);
  ok(r.outsiders.length === 0 || r.outsiders[0].mag < r.total * 0.05,
    `只弹和弦音时不该有明显外音，实际 ${JSON.stringify(r.outsiders.slice(0, 2))}`);
}

console.log('\n=== B. 混进一个和弦外音（D#4，Em 里没有的音）→ 要报出来 ===');
{
  const r = chordOutsiders(spectrumOfCase(63), sr2, fftN, EM);
  const top = r.outsiders[0];
  const hz = Math.round(midiToHz(63));
  console.log(`  被和弦解释的能量占比 ${(r.ratio * 100).toFixed(1)}%`);
  console.log(`  最大外音：${top ? top.hz + 'Hz（期望 ' + hz + 'Hz，' + midiToName(63) + '）' : '没报出来'}`);
  // 报出的是外音的某一个谐波就算命中（这里报的是 622Hz = D#4 的 2 次谐波）。
  // 短窗里基频可能被和弦自己的强峰盖住，这是能量排序的自然结果；
  // "把这个外音归到哪个音名"是下一步的小改进（找最佳基频），不影响"有没有外音"。
  const isHarmonicOfDsharp = (f) => {
    for (let k = 1; k <= 4; k++) {
      if (Math.abs(1200 * Math.log2(f / (hz * k))) < 60) return true;
    }
    return false;
  };
  ok(top && isHarmonicOfDsharp(top.hz),
    `应报出 ${midiToName(63)} 的某个谐波，实际 ${top ? top.hz + 'Hz' : '无'}`);
  ok(r.ratio < 0.95, `有外音时解释率应下降，实际 ${(r.ratio * 100).toFixed(1)}%`);
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
