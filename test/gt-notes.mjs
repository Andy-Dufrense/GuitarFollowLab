// 真音色 · 音高已知 · 两向验收：测量层该用的验收回路。
//
// 为什么不用 sound_data/f32/hey_jude.f32 当基准：那份录音和谱面时间轴对不上
// （每个起音"最像"的谱面音是乱的、音级命中只有 4/35），拿它当基准等于在测错东西。
//
// 这里用另外 6 段录音（2弦1品=C4 / 2弦2品=C#4 / 2弦3品=D4 / 1弦0品=E4），做法是：
//   1) 能量包络找拨弦（跳变 > 1.5 倍且电平够）；
//   2) 每个拨弦**不看答案**地量一次基频（最强峰 + 它的 2 次/3 次谐波都在 → 认它是基频；
//      如果它自己可能是更低那根的谐波，就不认），得到"真正弹了什么音"；
//   3) 用文件名里的音级做交叉校验，只保留两边一致的样本；
//   4) 每个样本问两遍：谱面**该弹** e、录音里**真的弹了** p
//        · e == p         → 判据必须判"对"
//        · e == p±1 / p±2 → 判据必须判"错"
//
// 合成信号不算数（骗过四次），所以只用真机录音。用法： node test/gt-notes.mjs

import fs from 'node:fs';
import path from 'node:path';

const M = 'file:///E:/GuitarFollowLab/backend/engine/';
const { spectrumOf } = await import(M + 'dsp.js');
const { estimateF0Near, estimateF0ByPeaks, matchNoteByCandidates, verifyExpectedNote } =
  await import(M + 'analysis.js');

const SR = 48000;
const DIR = 'sound_data/f32';
// 文件名 → 这段里出现过哪些音级（用来交叉校验，不用来定标签）
const CLIPS = [
  ['2弦1品拨一下.f32', [0]],
  ['2弦1品拨两次.f32', [0]],
  ['2弦1品拨两次 很快.f32', [0]],
  ['2弦1品-1弦0品.f32', [0, 4]],
  ['2弦1品-2弦3品.f32', [0, 2]],
  ['2弦2品-2弦1品.f32', [1, 0]],
];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nm = (m) => NOTE[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);
const centsOf = (hz, midi) => 1200 * Math.log2(hz / hzOf(midi));
const pcOf = (hz) => ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;

function readF32(file) {
  const raw = fs.readFileSync(file);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}
function seg(A, startSec, N, ratio = 1) {
  const from = startSec * SR;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = from + i * ratio, j = Math.floor(x), f = x - j;
    out[i] = (j >= 0 && j + 1 < A.length) ? A[j] * (1 - f) + A[j + 1] * f : 0;
  }
  return out;
}
// 谱峰（同一个峰附近只留最高的那根线）
function peakList(mags, binHz, loHz = 55, hiHz = 5000) {
  const lo = Math.max(2, Math.floor(loHz / binHz));
  const hi = Math.min(mags.length - 3, Math.ceil(hiHz / binHz));
  const raw = [];
  for (let i = lo; i <= hi; i++) {
    if (mags[i] > mags[i - 1] && mags[i] >= mags[i + 1]) raw.push({ hz: i * binHz, mag: mags[i] });
  }
  raw.sort((a, b) => b.mag - a.mag);
  const keep = [];
  for (const p of raw) {
    if (keep.every((q) => Math.abs(1200 * Math.log2(p.hz / q.hz)) > 70)) keep.push(p);
  }
  return keep;
}
function magNear(mags, binHz, hz, tolCents) {
  const lo = Math.max(1, Math.floor(hz * Math.pow(2, -tolCents / 1200) / binHz));
  const hi = Math.min(mags.length - 2, Math.ceil(hz * Math.pow(2, tolCents / 1200) / binHz));
  let m = 0;
  for (let i = lo; i <= hi; i++) if (mags[i] > m) m = mags[i];
  return m;
}
// 不看答案地量基频：最强峰里挑第一个"自己带 2 次、3 次谐波"、而且不是更低那根谐波的
function fundamentalOf(mags, N) {
  const binHz = SR / N;
  const peaks = peakList(mags, binHz);
  if (!peaks.length) return null;
  const gmax = peaks[0].mag;
  for (const p of peaks) {
    if (p.mag < 0.04 * gmax) break;
    if (p.hz < 70 || p.hz > 1200) continue;
    // 它自己会不会是更低那根的谐波？（低八度位置有强峰 → 不当基频）
    const sub = Math.max(magNear(mags, binHz, p.hz / 2, 40), magNear(mags, binHz, p.hz / 3, 40));
    if (sub > 0.35 * p.mag) continue;
    const h2 = magNear(mags, binHz, p.hz * 2, 45);
    const h3 = magNear(mags, binHz, p.hz * 3, 45);
    if (h2 > 0.12 * p.mag && h3 > 0.05 * p.mag) {
      return { hz: p.hz, mag: p.mag, h2: h2 / p.mag, h3: h3 / p.mag };
    }
  }
  return null;
}
function findPlucks(A) {
  const hop = Math.round(0.01 * SR);
  const rms = [];
  for (let i = 0; i + hop < A.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += A[j] * A[j];
    rms.push(Math.sqrt(s / hop));
  }
  const out = [];
  for (let i = 1; i < rms.length; i++) {
    const jump = rms[i] / (rms[i - 1] + 1e-6);
    if (jump > 1.5 && rms[i] > 0.05) out.push({ t: i * 0.01, level: rms[i], jump });
  }
  const merged = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && c.t - last.t < 0.15) { if (c.level > last.level) merged[merged.length - 1] = c; }
    else merged.push(c);
  }
  return merged;
}

// ── 建样本：标签来自"不看答案的量音高"，音级再用文件名校验 ────────────────────
const samples = [];
for (const [name, knownPcs] of CLIPS) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) { console.log(`（缺 ${name}）`); continue; }
  const A = readF32(file);
  for (const p of findPlucks(A)) {
    const N = 8192;
    const mags = spectrumOf(seg(A, p.t + 0.02, N));
    const f = fundamentalOf(mags, N);
    if (!f) continue;
    const pc = pcOf(f.hz);
    const ok = knownPcs.includes(pc);
    if (!ok) continue;                       // 两边不一致的样本直接丢掉，不硬凑
    samples.push({ clip: name, at: p.t, level: p.level, played: Math.round(69 + 12 * Math.log2(f.hz / 440)), hz: f.hz });
  }
}
const byClip = {};
for (const s of samples) (byClip[s.clip] = byClip[s.clip] || []).push(`${s.at.toFixed(2)}s=${nm(s.played)}`);
console.log(`样本：${samples.length} 个拨弦（真机录音；标签=独立量出来的基频，音级经文件名校验）`);
for (const [k, v] of Object.entries(byClip)) console.log(`   ${k.padEnd(24)} ${v.join('  ')}`);
console.log('');

// ── 判据（都返回 pass = 判"对"）──────────────────────────────────────────────
const PASS_CENTS = 75;
const WINDOWS = {
  'snap 起音前170ms': (A, at) => ({ mags: spectrumOf(seg(A, at - 170 / 1000, 8192)), N: 8192 }),
  'judge 起音后20ms起170ms': (A, at) => ({ mags: spectrumOf(seg(A, at + 20 / 1000, 8192)), N: 8192 }),
  // 产品里真正用来判定的那扇窗：判定发生在"记录的起音时刻 + 90ms"，
  // 取的是那一刻往回 170ms —— 记录的起音时刻比真拨弦晚约 15ms，所以等于 [真起音-65ms, +105ms]。
  'prod 判定窗[真起音-65,+105]': (A, at) => ({ mags: spectrumOf(seg(A, at - 65 / 1000, 8192)), N: 8192 }),
  // 产品里另一份：起音那一刻的快照，按"这一帧比上一帧涨了几倍"逐频点加权
  // （还在衰减的旧谐波 rise<1 → 压成 0）。这就是"只看新拨进来的那部分"。
  'rise 起音快照(抬头加权)': (A, at) => {
    const N = 8192, RISE_N = 2048, t = at + 18 / 1000;     // 记录时刻≈真起音+18ms
    const snap = spectrumOf(seg(A, t - N / SR, N));
    const now2 = spectrumOf(seg(A, t - RISE_N / SR, RISE_N));
    const prev2 = spectrumOf(seg(A, t - 16 / 1000 - RISE_N / SR, RISE_N));
    const k = Math.round((SR / N) / (SR / RISE_N));
    const out = new Float32Array(snap.length);
    for (let i = 0; i < snap.length; i++) {
      const ri = i * k;
      const r = ri < now2.length && prev2[ri] > 1e-12 ? now2[ri] / prev2[ri] : 1;
      out[i] = snap[i] * Math.max(0, Math.min(3, r - 1));
    }
    return { mags: out, N };
  },
};
const METHODS = {
  '① 产品现状 Near(±80)+75音分': (mags, N, exp) => {
    const r = estimateF0Near(mags, SR, N, exp, { rangeCents: 80, tolCents: 15 });
    return { pass: !!(r && r.f0 > 40 && Math.abs(r.cents) <= PASS_CENTS), hz: r ? r.f0 : 0 };
  },
  '② 锚答案 ByPeaks+75音分': (mags, N, exp) => {
    const r = estimateF0ByPeaks(mags, SR, N, exp, {});
    return { pass: !!(r && r.score > 0 && Math.abs(r.cents) <= PASS_CENTS), hz: r ? r.f0 : 0 };
  },
  '③ 验证式 领先≥1.5': (mags, N, exp) => {
    const vb = verifyExpectedNote(mags, null, SR, N, exp, null, 0);
    return { pass: vb.ratio >= 1.5, hz: exp };
  },
  '④ 候选重排 ok': (mags, N, exp) => {
    const r = matchNoteByCandidates(mags, SR, N, exp);
    return { pass: !!r.ok, hz: r.ranked && r.ranked[0] ? hzOf(r.ranked[0].midi) : 0 };
  },
  // ④b：候选只留"差一品"的真实错法（不放低八度、不放 ±5），再看本音领先多少
  '④b 候选重排(只留±1±2)': (mags, N, exp) => {
    const r = matchNoteByCandidates(mags, SR, N, exp);
    const self = r.ranked.find((x) => x.offset === 0);
    const rivals = r.ranked.filter((x) => x.offset !== 0 && Math.abs(x.offset) <= 2);
    const rival = rivals.sort((a, b) => b.score - a.score)[0];
    if (!self || !rival) return { pass: false, hz: 0 };
    const margin = rival.score > 0 ? self.score / rival.score : 99;
    const marginOk = Number(process.env.VC_MARGIN || 1.02);
    const fitOk = Number(process.env.VC_FIT || 190);
    return { pass: margin > marginOk && self.mismatch < fitOk, hz: hzOf(self.midi), margin };
  },
  // ④c：现在产品里用的那条 —— 本音失配 < 250（照实测分布定的上限）且本音在 ±1/±2 里最像。
  '④c 候选重排（产品规则 fit<250）': (mags, N, exp) => {
    const r = matchNoteByCandidates(mags, SR, N, exp);
    const self = r.ranked.find((x) => x.offset === 0);
    const rival = r.ranked.filter((x) => x.offset !== 0 && Math.abs(x.offset) <= 2)
      .sort((a, b) => b.score - a.score)[0];
    if (!self) return { pass: false, hz: 0 };
    const pass = self.mismatch < 250 && (!rival || self.score > rival.score);
    return { pass, hz: hzOf(exp), midi: exp };
  },
};

const OFFSETS = [0, -1, 1, -2, 2];
const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(pad('窗 / 判据', 32) + OFFSETS.map((d) => pad(d === 0 ? '弹对→判对' : `差${d > 0 ? '+' : ''}${d}→判错`, 11)).join(''));
const rows = [];
for (const [wname, winFn] of Object.entries(WINDOWS)) {
  for (const [mname, fn] of Object.entries(METHODS)) {
    const cells = [];
    let worst = 2;
    const detail = [];
    for (const d of OFFSETS) {
      let right = 0;
      for (const s of samples) {
        const A = readF32(path.join(DIR, s.clip));
        const { mags, N } = winFn(A, s.at);
        const r = fn(mags, N, s.played + d);
        const ok = d === 0 ? r.pass : !r.pass;
        if (ok) right++;
        if (d === 0) detail.push(`${nm(s.played)}${r.pass ? '对' : '错'}${r.hz ? '(' + Math.round(centsOf(r.hz, s.played)) + 'c)' : ''}`);
      }
      cells.push(`${right}/${samples.length}`);
      worst = Math.min(worst, right / samples.length);
    }
    rows.push({ name: `${wname} / ${mname}`, cells, worst, detail });
  }
}
rows.sort((a, b) => b.worst - a.worst);
for (const r of rows) {
  console.log(pad(r.name, 32) + r.cells.map((c) => pad(c, 11)).join('') + ` 最差 ${Math.round(r.worst * 100)}%`);
}
if (process.env.VC_DETAIL) {
  console.log('\n弹对那一路的逐样本（judge 窗）：');
  const row = rows.find((r) => r.name.includes('judge') && r.name.includes('④b'));
  samples.forEach((s, i) => console.log(`  ${pad(s.clip, 24)} @${s.at.toFixed(2)}s 真弹 ${nm(s.played).padEnd(4)} → ${row.detail[i]}`));
}
