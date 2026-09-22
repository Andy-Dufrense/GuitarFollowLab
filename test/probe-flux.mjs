// 离线探针：用**短窗逐频点差分**（512 点 = 10.7ms，两帧错开 16ms）做一次不看答案的测量。
//
// 为什么是短窗：余响只会衰减、不会凭空产生新的频谱成分 —— 而"新拨的一下"会在自己的
// 谐波位置上冒出一整套新峰。用 170ms 长窗做差分时两个窗重叠 170ms，比值≈1，等于没做；
// 512 点（10.7ms）错开 16ms，新拨的那一下才"抬得起头"（老页面 fluxRelOf 的注释就是这么写的）。
// 代价是频率分辨率只有 93.8Hz —— 靠**多个谐波联合投票**把精度补回来。
//
// 验收（两向都要过）：
//   ① 弹对了 → 量到的音 = 谱面音；② 把真机录音整体移调 ±1/±2 半音（= 弹错了）→ 量到的音跟着走。
//
// 用法： node test/probe-flux.mjs <onsets.json> [--shift=0,-1,1,-2,2]

import fs from 'node:fs';

const M = 'file:///E:/GuitarFollowLab/backend/engine/';
const { spectrumOf } = await import(M + 'dsp.js');
const { estimateF0ByPeaks, matchNoteByCandidates, verifyExpectedNote } = await import(M + 'analysis.js');

const SR = 48000;
const input = process.argv[2];
if (!input) { console.error('用法： node test/probe-flux.mjs <onsets.json> [--shift=0,-1,1,-2,2]'); process.exit(2); }
const shiftsArg = process.argv.find((a) => a.startsWith('--shift='));
const SHIFTS = shiftsArg ? shiftsArg.split('=')[1].split(',').map(Number) : [0, -1, 1, -2, 2];

const { audio: wavPath, onsets, notes } = JSON.parse(fs.readFileSync(input, 'utf8'));
const raw = fs.readFileSync(wavPath);
const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);
const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
const cents = (hz, midi) => 1200 * Math.log2(hz / hzOf(midi));
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nm = (m) => NOTE[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

function seg(startSec, N, ratio = 1) {
  const from = startSec * SR;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = from + i * ratio, j = Math.floor(x), f = x - j;
    out[i] = (j >= 0 && j + 1 < A.length) ? A[j] * (1 - f) + A[j + 1] * f : 0;
  }
  return out;
}

// ── 谱：短窗逐频点差分（只留"新涨出来的"那一部分）──────────────────────────
// N=512（10.7ms）：now = [t-10.7ms, t]，prev = 再往前错开 16ms 的同长窗。
function fluxSpec(t, N, ratio, mode) {
  const now = spectrumOf(seg(t - N / SR, N, ratio));
  if (mode === 'now') return now;
  const prev = spectrumOf(seg(t - 16 / 1000 - N / SR, N, ratio));
  const out = new Float32Array(now.length);
  for (let i = 0; i < now.length; i++) {
    const d = now[i] - prev[i];
    out[i] = d > 0 ? d : 0;
  }
  return out;
}

// ── 梳齿投票：候选 f0 的每个谐波位置上有没有能量（±tolBins 根谱线里取最高），
//    按 1/k 加权平均 + 谐波数惩罚。短窗分辨率低，靠"很多根谐波一起投票"补精度。──
const BETAS = [0, 0.0001, 0.0002, 0.0004];
function combVote(mags, N, midi, opts = {}) {
  const binHz = SR / N;
  const wPow = opts.wPow ?? 1;
  const tolBins = opts.tolBins ?? 1;
  const maxHz = opts.maxHz ?? 3000;
  const maxHarm = opts.maxHarm ?? 10;
  const f0c = hzOf(midi);
  let best = null;
  for (const B of BETAS) {
    let s = 0, w = 0, used = 0;
    for (let k = 1; k <= maxHarm; k++) {
      const f = f0c * k * Math.sqrt(1 + B * k * k);
      if (f > maxHz || f > SR / 2 - 300) break;
      const c = f / binHz;
      const lo = Math.max(1, Math.floor(c - tolBins));
      const hi = Math.min(mags.length - 2, Math.ceil(c + tolBins));
      let m = 0;
      for (let i = lo; i <= hi; i++) if (mags[i] > m) m = mags[i];
      const wk = 1 / Math.pow(k, wPow);
      s += wk * m; w += wk; used++;
    }
    if (!w) continue;
    const v = s / w;
    if (!best || v > best.v) best = { v, nHarm: used, beta: B };
  }
  return best || { v: 0, nHarm: 0, beta: 0 };
}

const METHODS = {
  // ① 全扫（E2..E6）：完全不知道谱面，纯看这扇窗最像哪个音 —— 这是"不看答案"的极限版本
  '全扫梳齿(E2..E6)': (mags, N) => {
    let bestM = null, bestV = -1;
    for (let m = 40; m <= 88; m++) {
      const r = combVote(mags, N, m);
      if (r.v > bestV) { bestV = r.v; bestM = m; }
    }
    return bestM == null ? null : { midi: bestM, v: bestV };
  },
  // ② 只用锚定音那把尺子的数值（在产品里它现在就在算），但喂给它的是差谱
  '锚答案 ByPeaks（差谱）': (mags, N, exp) => {
    const r = estimateF0ByPeaks(mags, SR, N, exp, {});
    if (!r || !(r.score > 0)) return null;
    return { midi: Math.round(midiOf(r.f0)), cents: r.cents };
  },
  '候选重排（差谱）': (mags, N, exp) => {
    const r = matchNoteByCandidates(mags, SR, N, exp);
    const top = r.ranked && r.ranked[0];
    if (!top) return null;
    return { midi: top.midi, margin: r.margin };
  },
  '验证式（差谱）': (mags, N, exp) => {
    const vb = verifyExpectedNote(mags, null, SR, N, exp, null, 0);
    return { midi: exp, ratio: vb.ratio };
  },
};

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(`录音 ${wavPath}：起音 ${onsets.length} 个`);
console.log('口径：量到的音和"真正弹的那个音"（谱面音+移调量）差 ≤50 音分 = 量对了\n');
for (const [mode, mlabel] of [['diff', '短窗差谱(512, 16ms)'], ['now', '短窗原谱(512)']]) {
  console.log(`── ${mlabel} ─────────────────────────────────────────`);
  console.log(pad('方法', 22) + SHIFTS.map((s) => pad(s === 0 ? '弹对' : `${s > 0 ? '+' : ''}${s}半音`, 10)).join(''));
  for (const [label, fn] of Object.entries(METHODS)) {
    const cells = [];
    for (const shift of SHIFTS) {
      let hit = 0, n = 0;
      for (let i = 0; i < onsets.length && i < notes.length; i++) {
        const truth = notes[i].midi + shift;
        const ratio = Math.pow(2, shift / 12);
        const mags = fluxSpec(onsets[i], 512, ratio, mode);
        const r = fn(mags, 512, notes[i].midi);
        n++;
        if (!r) continue;
        const hz = r.cents != null && r.midi === notes[i].midi ? hzOf(r.midi) * Math.pow(2, r.cents / 1200) : hzOf(r.midi);
        if (Math.abs(cents(hz, truth)) <= 50) hit++;
      }
      cells.push(`${hit}/${n}`);
    }
    console.log(pad(label, 22) + cells.map((c) => pad(c, 10)).join(''));
  }
  console.log('');
}

// 逐音明细（弹对那一路）
if (process.env.VC_DETAIL) {
  console.log('逐音（短窗差谱，移调 0）： 号 谱面 ｜ 全扫 ｜ 锚答案 ｜ 候选重排 ｜ 验证式');
  for (let i = 0; i < onsets.length && i < notes.length; i++) {
    const exp = notes[i].midi;
    const mags = fluxSpec(onsets[i], 512, 1, 'diff');
    const a = METHODS['全扫梳齿(E2..E6)'](mags, 512);
    const b = METHODS['锚答案 ByPeaks（差谱）'](mags, 512, exp);
    const c = METHODS['候选重排（差谱）'](mags, 512, exp);
    const d = METHODS['验证式（差谱）'](mags, 512, exp);
    console.log(`  #${String(i + 1).padStart(2)} ${pad(nm(exp), 4)} ｜ `
      + pad(a ? `${nm(a.midi)}(${cents(hzOf(a.midi), exp).toFixed(0)}c)` : '—', 12) + '｜ '
      + pad(b ? `${nm(b.midi)}(${b.cents.toFixed(0)}c)` : '—', 12) + '｜ '
      + pad(c ? `${nm(c.midi)}(领先${c.margin.toFixed(2)})` : '—', 16) + '｜ '
      + pad(d ? `${d.ratio.toFixed(2)}` : '—', 6));
  }
}
