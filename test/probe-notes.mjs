// 离线探针：测量层到底能不能「听出弹错」。
//
// 背景：产品页现在的量音高是**锚在谱面那个音上**搜（在期望音 ±80 音分内找谐波峰），
// 所以弹成隔壁半音它也会在范围里捡个峰、报回期望音 —— 「弹错判对」这条缺口就是这么来的。
//
// 这个探针在同一份真机录音上比几套「谱 × 判据」组合，并且加了一列关键对照：
// **把整段录音按 ±1/±2 半音重采样**（真音色、真余响，音高真的变了）。
// 能听出弹错的判据必须跟着移调走；锚在答案上的尺子会一直报谱面音（听不出）。
// 合成信号骗过我们四次（只有一根弦在响），所以这条判断只用真机录音。
//
// 用法：
//   node test/probe-notes.mjs <onsets.json> [--shift=-1,+1,+2]
//   VC_DETAIL=1 VC_DETAIL_SHIFT=-1 node test/probe-notes.mjs <onsets.json>
//
// onsets.json 由 test-follow-real.mjs 的 VC_ONSET_OUT 产出：
//   set VC_ONSET_OUT=out\onsets.json && node test/test-follow-real.mjs sound_data\f32\hey_jude.f32

import fs from 'node:fs';

const M = 'file:///E:/GuitarFollowLab/frontend/js/';
const { spectrumOf, spectralMagAt } = await import(M + 'dsp.js');
const { estimateF0Near, estimateF0ByPeaks, matchNoteByCandidates, verifyExpectedNote, diffMags } =
  await import(M + 'analysis.js');

const SR = 48000;
const input = process.argv[2];
if (!input) { console.error('用法： node test/probe-notes.mjs <onsets.json> [--shift=-1,+1,+2]'); process.exit(2); }
const shiftsArg = process.argv.find((a) => a.startsWith('--shift='));
const SHIFTS = shiftsArg ? shiftsArg.split('=')[1].split(',').map(Number) : [0, -1, 1, -2, 2];

const { audio: wavPath, onsets, notes } = JSON.parse(fs.readFileSync(input, 'utf8'));
const raw = fs.readFileSync(wavPath);
const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);
const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
const cents = (hz, midi) => 1200 * Math.log2(hz / hzOf(midi));
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

// ── 取一段音频；ratio>1 = 读得快 = 音高升高 ratio 倍（时间不变，用来模拟「弹错了」）──
function seg(startSec, N, ratio = 1) {
  const from = startSec * SR;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = from + i * ratio;
    const j = Math.floor(x), f = x - j;
    if (j < 0 || j + 1 >= A.length) { out[i] = 0; continue; }
    out[i] = A[j] * (1 - f) + A[j + 1] * f;
  }
  return out;
}

// ── 谱的取法（每种都返回 {mags, N}）─────────────────────────────────────────
//   snap        起音前 170ms（产品判定现在用的那张快照）
//   judge       结束于起音+90ms 的 170ms 窗（产品「听到」那一栏用的）
//   attack170   起音后 170ms − 起音前 170ms（差分谱的方向）
//   attack50    起音后 50ms − 起音前 50ms（短窗差分：把上一个音的余响切干净）
const SPECTRA = {
  'snap 起音前170ms': (t, ratio) => ({ mags: spectrumOf(seg(t - 170 / 1000, 8192, ratio)), N: 8192 }),
  'judge 结束于起音+90ms': (t, ratio) => ({ mags: spectrumOf(seg(t + (90 - 170) / 1000, 8192, ratio)), N: 8192 }),
  'attack170 差分(前后各170ms)': (t, ratio) => {
    const N = 8192;
    const post = spectrumOf(seg(t, N, ratio));
    const pre = spectrumOf(seg(t - N / SR, N, ratio));
    return { mags: diffMags(post, pre), N };
  },
  'attack50 短窗差分(前后各50ms)': (t, ratio) => {
    const N = 4096;
    const post = spectrumOf(seg(t, N, ratio));
    const pre = spectrumOf(seg(t - N / SR, N, ratio));
    return { mags: diffMags(post, pre), N };
  },
  // 老页面的做法：用**起音那一刻**前后错开 16ms 的两张谱算"每个频点抬了多少头"，
  // 再把判定窗的谱按抬头率加权 —— 还在响的上一个音不抬头（rise≈1），贡献被压掉。
  'fresh 判定窗×起音抬头率': (t, ratio) => {
    const N = 8192;
    const judge = spectrumOf(seg(t + (90 - 170) / 1000, N, ratio));
    const a = spectrumOf(seg(t - N / SR, N, ratio));
    const b = spectrumOf(seg(t - 16 / 1000 - N / SR, N, ratio));
    const out = new Float32Array(judge.length);
    for (let i = 0; i < out.length; i++) {
      const r = b[i] > 1e-12 ? a[i] / b[i] : 1;
      out[i] = judge[i] * Math.min(4, Math.max(0, r - 1));
    }
    return { mags: out, N };
  },
};

// 每个判据返回产品要的那个结论：这个起音判**对**还是判**错**。
// 判对的口径：量到的音落在谱面音 75 音分以内（用户定的线：比半音窄，比"手感差一点"宽）。
const PASS_CENTS = 75;
// 「有没有证据」的门槛：estimateF0ByPeaks 找不到谐波峰时返回 score=0、nHarm=0、cents=0
// —— 那是个空结果，绝不能当成"音准完美"。候选比较时必须先把空结果挡掉。
const hasEvidence = (r) => !!(r && r.score > 0 && (r.nHarm ?? 0) >= 2);

// ── 梳齿采样：在候选音的谐波**精确位置**上取谱值（线性插值），按 1/k 加权平均 ──
// 为什么不是"在 ±60 音分里取最高那根线"：那个问法里每个候选都能找到点东西，
// 于是每个候选都"自证"（锚在答案上的搜索就是这么骗人的）。
// 精确位置采样是**对称**的：真音的那族谐波上到处是峰，隔壁半音的网格上就落在谷里。
// 归一化（除以权重和 + 限制到 3kHz）是为了不让"更低的音谐波更多"白占便宜。
const COMB_BETAS = [0, 0.0001, 0.0002, 0.0004];
const COMB_MAX_HZ = 3000;
function combScoreOf(mags, N, midi, opts = {}) {
  const binHz = SR / N;
  const wPow = opts.wPow ?? 1;          // w_k = 1/k^wPow
  const f0c = hzOf(midi);
  let best = 0;
  for (const B of COMB_BETAS) {
    let s = 0, wSum = 0;
    for (let k = 1; k <= 14; k++) {
      const f = f0c * k * Math.sqrt(1 + B * k * k);
      if (f > COMB_MAX_HZ || f > SR / 2 - 300) break;
      const w = 1 / Math.pow(k, wPow);
      s += w * spectralMagAt(mags, SR, N, f);
      wSum += w;
    }
    if (wSum > 0 && s / wSum > best) best = s / wSum;
  }
  return best;
}

const METHODS = {
  '① 锚答案 Near(±80)（产品现状）': (mags, N, exp) => {
    const r = estimateF0Near(mags, SR, N, exp, { rangeCents: 80, tolCents: 15 });
    if (!r || !(r.f0 > 40)) return null;
    return { pass: Math.abs(r.cents) <= PASS_CENTS, midi: Math.round(midiOf(r.f0)), cents: r.cents };
  },
  '② 锚答案 ByPeaks': (mags, N, exp) => {
    const r = estimateF0ByPeaks(mags, SR, N, exp, {});
    if (!hasEvidence(r)) return null;
    return { pass: Math.abs(r.cents) <= PASS_CENTS, midi: Math.round(midiOf(r.f0)), cents: r.cents };
  },
  // ③ 轮流把每个候选当期望音，看哪个候选「量出来最贴它自己」——同一把尺子、对称比较，
  //    不偏向任何候选（这就是"不看答案"的那一次量）。
  '③ 挑候选 ByPeaks': (mags, N, exp) => {
    let best = null;
    for (let m = exp - 3; m <= exp + 3; m++) {
      const r = estimateF0ByPeaks(mags, SR, N, m, {});
      if (!hasEvidence(r)) continue;
      const off = Math.abs(r.cents);
      if (!best || off < best.off) best = { midi: m, off, r };
    }
    if (!best) return null;
    const pass = best.midi === exp && best.off <= PASS_CENTS;
    return { pass, midi: best.midi, cents: cents(best.r.f0, exp) };
  },
  // ④ 同上，但用 ±80 的 Near 尺子（产品判定现在那把）
  '④ 挑候选 Near(±80)': (mags, N, exp) => {
    let best = null;
    for (let m = exp - 3; m <= exp + 3; m++) {
      const r = estimateF0Near(mags, SR, N, m, { rangeCents: 80, tolCents: 15 });
      if (!r || !(r.f0 > 40) || !(r.score > 0)) continue;
      const off = Math.abs(r.cents);
      if (!best || off < best.off) best = { midi: m, off, r };
    }
    if (!best) return null;
    const pass = best.midi === exp && best.off <= PASS_CENTS;
    return { pass, midi: best.midi, cents: cents(best.r.f0, exp) };
  },
  '⑤ 候选重排 ok（不看答案）': (mags, N, exp) => {
    const r = matchNoteByCandidates(mags, SR, N, exp);
    const top = r.ranked && r.ranked[0];
    if (!top) return null;
    return { pass: !!r.ok, midi: top.midi, cents: cents(hzOf(top.midi), exp), margin: r.margin };
  },
  '⑥ 验证式 领先≥1.5': (mags, N, exp) => {
    const vb = verifyExpectedNote(mags, null, SR, N, exp, null, 0);
    return { pass: vb.ratio >= 1.5, midi: exp, cents: 0, margin: vb.ratio };
  },
  // ⑦ 梳齿采样（±4 个半音里挑分数最高的）；得分最高的就是量到的音
  '⑦ 梳齿采样(w=1/k)': (mags, N, exp) => {
    let bestM = exp, bestS = -1, expS = 0;
    for (let m = exp - 4; m <= exp + 4; m++) {
      const s = combScoreOf(mags, N, m, { wPow: 1 });
      if (m === exp) expS = s;
      if (s > bestS) { bestS = s; bestM = m; }
    }
    const pass = bestM === exp;
    return { pass, midi: bestM, cents: cents(hzOf(bestM), exp), margin: expS > 0 ? expS / bestS : 0 };
  },
  '⑧ 梳齿采样(w=1/√k)': (mags, N, exp) => {
    let bestM = exp, bestS = -1, expS = 0;
    for (let m = exp - 4; m <= exp + 4; m++) {
      const s = combScoreOf(mags, N, m, { wPow: 0.5 });
      if (m === exp) expS = s;
      if (s > bestS) { bestS = s; bestM = m; }
    }
    const pass = bestM === exp;
    return { pass, midi: bestM, cents: cents(hzOf(bestM), exp), margin: expS > 0 ? expS / bestS : 0 };
  },
};

function run(shift, specFn, method) {
  const ratio = Math.pow(2, shift / 12);
  const rows = [];
  for (let i = 0; i < onsets.length && i < notes.length; i++) {
    const { mags, N } = specFn(onsets[i], ratio);
    const exp = notes[i].midi;
    const r = method(mags, N, exp);
    if (r) rows.push({ i: i + 1, exp, shift, ...r });
  }
  // 弹对（shift=0）判对才算对；弹错（shift≠0）判错才算对
  const right = rows.filter((r) => (shift === 0 ? r.pass : !r.pass)).length;
  return { rows, n: rows.length, right };
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const SHIFTLABEL = (s) => (s === 0 ? '弹对' : `${s > 0 ? '+' : ''}${s}半音`);
console.log(`录音 ${wavPath}：起音 ${onsets.length} 个（基准 = 谱面第 i 个音配第 i 个起音）`);
console.log('读数 = 判对了的比例：第一列是你弹对了（要判对），后面几列是你弹错了（要判错）\n');
console.log(pad('谱 / 判据', 44) + SHIFTS.map((s) => pad(SHIFTLABEL(s), 9)).join('') + ' 最差');

const summary = [];
for (const [sname, specFn] of Object.entries(SPECTRA)) {
  for (const [mname, fn] of Object.entries(METHODS)) {
    const cells = [];
    let worst = 2;
    for (const s of SHIFTS) {
      const r = run(s, specFn, fn);
      cells.push(`${r.right}/${r.n}`);
      worst = Math.min(worst, r.n ? r.right / r.n : 0);
    }
    summary.push({ name: `${sname} / ${mname}`, cells, worst });
  }
}
summary.sort((a, b) => b.worst - a.worst);
for (const r of summary) {
  console.log(pad(r.name, 44) + r.cells.map((c) => pad(c, 9)).join('') + ` ${Math.round(r.worst * 100)}%`);
}

if (process.env.VC_DETAIL) {
  const sname = process.env.VC_DETAIL_SPEC || 'snap 起音前170ms';
  const shift = Number(process.env.VC_DETAIL_SHIFT || 0);
  const specFn = SPECTRA[sname];
  const ratio = Math.pow(2, shift / 12);
  console.log(`\n逐音（${sname}，移调 ${shift}）：  号 谱面 ｜ ①Near ｜ ②ByPeaks ｜ ③挑候选Peaks ｜ ④挑候选Near`);
  for (let i = 0; i < onsets.length && i < notes.length; i++) {
    const { mags, N } = specFn(onsets[i], ratio);
    const exp = notes[i].midi;
    const cell = (r) => pad(r ? `${midiName(r.midi)}(${Math.round(r.cents)}c)${r.pass ? '✓' : '✗'}` : '—', 16);
    console.log(`  #${String(i + 1).padStart(2)} ${pad(midiName(exp), 4)} ｜ `
      + cell(METHODS['① 锚答案 Near(±80)（产品现状）'](mags, N, exp)) + '｜ '
      + cell(METHODS['② 锚答案 ByPeaks'](mags, N, exp)) + '｜ '
      + cell(METHODS['③ 挑候选 ByPeaks'](mags, N, exp)) + '｜ '
      + cell(METHODS['④ 挑候选 Near(±80)'](mags, N, exp)));
  }
}
