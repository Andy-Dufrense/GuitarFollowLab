// 对比几种"音高估计器"的准度，用同一份真机录音的起音表来量。
//
// 为什么要做：一个半音 = 100 音分。现在用的是"在谱面那个音附近扫最佳基频，
// 每个谐波取 ±15 音分内**最高那根谱线**" —— 而 FFT 一根谱线在 260Hz 处就是 39 音分、
// 在 350Hz 处 29 音分。也就是说**量出来的音高本身是"一根谱线一根谱线"跳的**，
// 精度不够分辨 100 音分的一品之差（实测散布 ±80 音分）。
//
// 调音器的做法是**抛物线插值取次谱线精度**（对加窗后的 log 幅度谱在峰附近插值，
// 能到一根谱线的百分之几）。下面 E1/E2 就是这个思路。
//
// 用法： node test/probe-estimator.mjs <onsets.json>

import fs from 'node:fs';

const M = 'file:///E:/GuitarFollowLab/backend/engine/';
const { estimateF0Near } = await import(M + 'analysis.js');
const { estimateF0ByPeaks: estimateByPeaksReal } = await import(M + 'analysis.js');
const { spectrumOf } = await import(M + 'dsp.js');

const SR = 48000;
const input = process.argv[2];
if (!input) { console.error('用法： node test/probe-estimator.mjs <onsets.json>'); process.exit(2); }
const { audio: wavPath, onsets, notes } = JSON.parse(fs.readFileSync(input, 'utf8'));
const raw = fs.readFileSync(wavPath);
const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

function seg(startSec, lenSamples) {
  const from = Math.round(startSec * SR);
  const out = new Float32Array(lenSamples);
  for (let i = 0; i < lenSamples; i++) {
    const j = from + i;
    if (j >= 0 && j < A.length) out[i] = A[j];
  }
  return out;
}
const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);
const centsOf = (hz, midi) => 1200 * Math.log2(hz / hzOf(midi));

// ── 峰 + 抛物线插值 ────────────────────────────────────────────────────────
// 在 f 附近 ±tolCents 里找最高谱线，然后用 log 幅度做抛物线插值取次谱线精度。
function peakNear(mags, binHz, f, tolCents) {
  const lo = Math.max(1, Math.floor((f * Math.pow(2, -tolCents / 1200)) / binHz));
  const hi = Math.min(mags.length - 2, Math.ceil((f * Math.pow(2, tolCents / 1200)) / binHz));
  let bi = -1, bv = -1;
  for (let i = lo; i <= hi; i++) if (mags[i] > bv) { bv = mags[i]; bi = i; }
  if (bi <= 0 || bi >= mags.length - 1 || bv <= 0) return null;
  const a = Math.log(mags[bi - 1] + 1e-15), b = Math.log(mags[bi] + 1e-15), c = Math.log(mags[bi + 1] + 1e-15);
  const den = a - 2 * b + c;
  const d = den !== 0 ? 0.5 * (a - c) / den : 0;
  return { hz: (bi + Math.max(-0.5, Math.min(0.5, d))) * binHz, mag: bv };
}

// ── E1：谐波峰 + 抛物线插值 + 加权最小二乘（带弦刚性 B）──────────────────────
// 模型 f_k = k·f0·sqrt(1 + B·k²)（真实琴弦的谐波会随 k 越走越高，不建这个模型
// 就会把"谐波偏高"错算成"基频偏高"）。
const BETAS = [0, 0.00002, 0.00005, 0.0001, 0.0002, 0.0004, 0.0008, 0.0016];
function estimateByPeaks(mags, sr, fftSize, expectedMidi, opts = {}) {
  const binHz = sr / fftSize;
  const maxHarm = opts.maxHarm ?? 12;
  const tolCents = opts.tolCents ?? 60;      // 找峰的范围放宽（我们是在找"峰"，不是"判定"）
  const f0c = hzOf(expectedMidi);
  const Nyq = sr / 2 - 200;
  // 先按期望音找一遍谐波峰
  const peaks = [];
  for (let k = 1; k <= maxHarm; k++) {
    const f = f0c * k;
    if (f > Nyq) break;
    const p = peakNear(mags, binHz, f, tolCents);
    if (p) peaks.push({ k, hz: p.hz, mag: p.mag });
  }
  if (peaks.length < 1) return { f0: f0c, cents: 0, score: 0, nHarm: 0, beta: 0, resid: Infinity };
  let best = null;
  for (const B of BETAS) {
    // 两轮：第一轮用期望音附近的峰，第二轮按拟合出的 f0 重新找峰（防止峰被邻居抢走）
    let use = peaks;
    let f0 = f0c, wsum = 0;
    for (let pass = 0; pass < 3; pass++) {
      let num = 0, den = 0;
      const kept = [];
      for (const p of use) {
        const s = Math.sqrt(1 + B * p.k * p.k);      // f_k = k·f0·s
        const w = Math.min(1, p.mag);                // 峰越高越可信
        const dev = p.hz - p.k * f0 * s;
        if (pass > 0 && Math.abs(dev) > 2.5 * binHz * p.k) continue;   // 明显不是这一族的丢掉
        num += w * p.k * s * p.hz;
        den += w * (p.k * s) * (p.k * s);
        kept.push(p);
      }
      if (!den) break;
      f0 = num / den;
      wsum = kept.length;
      use = kept.length ? kept : use;
    }
    // 残差（音分）
    let r = 0;
    for (const p of use) r += Math.pow(1200 * Math.log2(p.hz / (p.k * f0 * Math.sqrt(1 + B * p.k * p.k))), 2);
    const resid = Math.sqrt(r / Math.max(1, use.length));
    const score = use.reduce((s, p) => s + p.mag, 0);
    if (!best || resid < best.resid - 0.5) best = { f0, beta: B, resid, nHarm: use.length, score };
  }
  return {
    f0: best.f0, cents: 1200 * Math.log2(best.f0 / f0c),
    score: best.score, nHarm: best.nHarm, beta: best.beta, resid: best.resid,
  };
}

// ── 评估 ───────────────────────────────────────────────────────────────────
// ── E3：先"粗找基频"（谐波积谱 HPS，范围放宽到 ±3 个半音），再用谐波峰最小二乘细化 ──
// 为什么必须放宽：E1 是"在**期望音**周围找它的谐波"，搜索范围 ±60 音分 ——
// 一旦用户弹的是隔壁半音（差 100 音分），真谐波落在搜索范围外，
// E1 只会在范围里随便捡一个峰，读数被拉回期望音附近。判定要能说"你弹的是隔壁那个音"，
// 就必须先**独立地把真实音高量出来**，再问它离谱面有多远。
function magAt(mags, binHz, hz) {
  const x = hz / binHz;
  const i = Math.floor(x);
  if (i < 1 || i >= mags.length - 2) return 0;
  const t = x - i;
  return mags[i] * (1 - t) + mags[i + 1] * t;
}
function hpsF0(mags, sr, fftSize, expectedMidi, spreadSemis = 3) {
  const binHz = sr / fftSize;
  const f0c = hzOf(expectedMidi);
  const lo = f0c * Math.pow(2, -spreadSemis / 12);
  const hi = f0c * Math.pow(2, spreadSemis / 12);
  const nyq = sr / 2 - 200;
  let best = null;
  for (let f = lo; f <= hi; f *= Math.pow(2, 3 / 1200)) {   // 3 音分一步
    let s = 0, n = 0;
    for (let k = 1; k <= 5; k++) {
      const fk = f * k;
      if (fk > nyq) break;
      s += Math.log(magAt(mags, binHz, fk) + 1e-9) / k;
      n++;
    }
    if (!n) continue;
    const v = s / n;
    if (!best || v > best.v) best = { f0: f, v };
  }
  return best ? best.f0 : f0c;
}
function estimateWide(mags, sr, fftSize, expectedMidi, opts = {}) {
  const f0c = hzOf(expectedMidi);
  const binHz = sr / fftSize;
  const f0s = hpsF0(mags, sr, fftSize, expectedMidi, opts.spreadSemis ?? 3);
  // 用粗值当锚，重找一遍谐波峰（容差按"这根弦的谐波有多宽"给，±60 音分）
  const maxHarm = opts.maxHarm ?? 12;
  const peaks = [];
  for (let k = 1; k <= maxHarm; k++) {
    const f = f0s * k;
    if (f > sr / 2 - 200) break;
    const p = peakNear(mags, binHz, f, 60);
    if (p) peaks.push({ k, hz: p.hz, mag: p.mag });
  }
  if (!peaks.length) return { f0: f0s, cents: 1200 * Math.log2(f0s / f0c), score: 0, nHarm: 0, beta: 0, resid: Infinity };
  let best = null;
  for (const B of BETAS) {
    let use = peaks, f0 = f0s;
    for (let pass = 0; pass < 3; pass++) {
      let num = 0, den = 0;
      const kept = [];
      for (const p of use) {
        const s = Math.sqrt(1 + B * p.k * p.k);
        const dev = p.hz - p.k * f0 * s;
        if (pass > 0 && Math.abs(dev) > 2.5 * binHz * p.k) continue;
        const w = Math.min(1, p.mag);
        num += w * p.k * s * p.hz; den += w * (p.k * s) * (p.k * s);
        kept.push(p);
      }
      if (!den) break;
      f0 = num / den;
      if (kept.length) use = kept;
    }
    let r = 0;
    for (const p of use) r += Math.pow(1200 * Math.log2(p.hz / (p.k * f0 * Math.sqrt(1 + B * p.k * p.k))), 2);
    const resid = Math.sqrt(r / Math.max(1, use.length));
    const score = use.reduce((s, p) => s + p.mag, 0);
    if (!best || resid < best.resid - 0.5) best = { f0, beta: B, resid, nHarm: use.length, score };
  }
  return { f0: best.f0, cents: 1200 * Math.log2(best.f0 / f0c), score: best.score,
    nHarm: best.nHarm, beta: best.beta, resid: best.resid };
}

function evalEstimator(label, fn, windowCfg) {
  if (windowCfg.two) return evalTwo(label, fn, windowCfg);
  if (windowCfg.multi) return evalMulti(label, fn, windowCfg.multi);
  const errs = [];
  const rows = [];
  for (let i = 0; i < onsets.length && i < notes.length; i++) {
    const { at = 0, endAt = null, ms } = windowCfg;
    const start = onsets[i] + (endAt != null ? (endAt - ms) / 1000 : at / 1000);
    const N = 1 << Math.floor(Math.log2((ms / 1000) * SR));
    const mags = spectrumOf(seg(start, N));
    const r = fn(mags, SR, N, notes[i].midi);
    if (!r || !(r.score > 0) || !(r.f0 > 40)) continue;
    const c = centsOf(r.f0, notes[i].midi);
    errs.push(c);
    rows.push({ i: i + 1, exp: notes[i].midi, hz: r.f0, c, nHarm: r.nHarm, resid: r.resid });
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const q = (p) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))];
  const mean = errs.reduce((s, x) => s + x, 0) / errs.length;
  // 再算一遍"按弦音准校正之后"的散布 —— 产品里有这一步（同弦中位数，向全局收缩），
  // 它能把"这把琴/这根弦整体偏高偏低"消掉，判定用的是校正后的值。
  const devByString = {}, devAll = [];
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const fixed = [];
  for (const r of rows) {
    const str = (notes[r.i - 1] && notes[r.i - 1].string) || 0;
    const arr = devByString[str] || [];
    const globalMed = devAll.length >= 5 ? med(devAll) : 0;
    const tuning = arr.length >= 5 ? 0.5 * med(arr) + 0.5 * globalMed : globalMed;
    fixed.push(r.c - tuning);
    devAll.push(r.c); devByString[str] = arr.concat([r.c]);
  }
  const af = fixed.map(Math.abs).sort((a, b) => a - b);
  const qf = (p) => af[Math.min(af.length - 1, Math.floor(af.length * p))];
  return {
    label, n: errs.length, mean, p50: q(0.5), p90: q(0.9), max: abs[abs.length - 1],
    within20: abs.filter((x) => x <= 20).length / errs.length,
    within30: abs.filter((x) => x <= 30).length / errs.length,
    within50: abs.filter((x) => x <= 50).length / errs.length,
    f: { mean: fixed.reduce((s, x) => s + x, 0) / fixed.length, p50: qf(0.5), p90: qf(0.9), max: af[af.length - 1],
      within30: af.filter((x) => x <= 30).length / af.length,
      within50: af.filter((x) => x <= 50).length / af.length },
    rows,
  };
}

// 多窗取中位：同一个音在几个窗口各量一次，取中位数
function evalMulti(label, fn, ends) {
  const errs = [], rows = [];
  for (let i = 0; i < onsets.length && i < notes.length; i++) {
    const vals = [];
    for (const endMs of ends) {
      const N = 8192;
      const mags = spectrumOf(seg(onsets[i] + (endMs - 170) / 1000, N));
      const r = fn(mags, SR, N, notes[i].midi);
      if (r && r.f0 > 40) vals.push(r.f0);
    }
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    const f0 = vals[Math.floor(vals.length / 2)];
    const c = centsOf(f0, notes[i].midi);
    errs.push(c); rows.push({ i: i + 1, exp: notes[i].midi, hz: f0, c, nHarm: vals.length, resid: null });
  }
  return summarize(label, errs, rows, notes);
}

// 汇总（原样从 evalEstimator 搬出来，供 multi 用）
function summarize(label, errs, rows, notes) {
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const q = (p) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))];
  const mean = errs.reduce((s, x) => s + x, 0) / errs.length;
  const devByString = {}, devAll = [];
  const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const fixed = [];
  for (const r of rows) {
    const str = (notes[r.i - 1] && notes[r.i - 1].string) || 0;
    const arr = devByString[str] || [];
    const globalMed = devAll.length >= 5 ? med(devAll) : 0;
    const tuning = arr.length >= 5 ? 0.5 * med(arr) + 0.5 * globalMed : globalMed;
    fixed.push(r.c - tuning);
    devAll.push(r.c); devByString[str] = arr.concat([r.c]);
  }
  const af = fixed.map(Math.abs).sort((a, b) => a - b);
  const qf = (p) => af[Math.min(af.length - 1, Math.floor(af.length * p))];
  return {
    label, n: errs.length, mean, p50: q(0.5), p90: q(0.9), max: abs[abs.length - 1],
    within20: abs.filter((x) => x <= 20).length / errs.length,
    within30: abs.filter((x) => x <= 30).length / errs.length,
    within50: abs.filter((x) => x <= 50).length / errs.length,
    f: { mean: fixed.reduce((s, x) => s + x, 0) / fixed.length, p50: qf(0.5), p90: qf(0.9), max: af[af.length - 1],
      within30: af.filter((x) => x <= 30).length / af.length,
      within50: af.filter((x) => x <= 50).length / af.length },
    rows,
  };
}

// 两个窗口一起用：起音快照（w1）+ 判定那一刻的平窗（w2），都是 170ms。
// 两者差得不多就取平均（两次独立测量，噪声降一半）；差得多就信拟合残差小的那个。
function evalTwo(label, fn, cfg) {
  const errs = [], rows = [];
  for (let i = 0; i < onsets.length && i < notes.length; i++) {
    const N = 8192;
    const a = fn(spectrumOf(seg(onsets[i] - 170 / 1000, N)), SR, N, notes[i].midi);
    const b = fn(spectrumOf(seg(onsets[i] + (90 - 170) / 1000, N)), SR, N, notes[i].midi);
    if (!a || !b || !(a.f0 > 40) || !(b.f0 > 40)) continue;
    const d = 1200 * Math.log2(a.f0 / b.f0);
    let f0;
    if (Math.abs(d) <= 25) f0 = Math.sqrt(a.f0 * b.f0);          // 差得少 → 取平均
    else f0 = (a.resid <= b.resid) ? a.f0 : b.f0;                // 差得多 → 信残差小的
    const c = centsOf(f0, notes[i].midi);
    errs.push(c); rows.push({ i: i + 1, exp: notes[i].midi, hz: f0, c, nHarm: a.nHarm, resid: Math.min(a.resid, b.resid) });
  }
  const abs = errs.map(Math.abs).sort((x, y) => x - y);
  const q = (p) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))];
  const mean = errs.reduce((s, x) => s + x, 0) / errs.length;
  const devByString = {}, devAll = [];
  const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const fixed = [];
  for (const r of rows) {
    const str = (notes[r.i - 1] && notes[r.i - 1].string) || 0;
    const arr = devByString[str] || [];
    const globalMed = devAll.length >= 5 ? med(devAll) : 0;
    const tuning = arr.length >= 5 ? 0.5 * med(arr) + 0.5 * globalMed : globalMed;
    fixed.push(r.c - tuning);
    devAll.push(r.c); devByString[str] = arr.concat([r.c]);
  }
  const af = fixed.map(Math.abs).sort((x, y) => x - y);
  const qf = (p) => af[Math.min(af.length - 1, Math.floor(af.length * p))];
  return {
    label, n: errs.length, mean, p50: q(0.5), p90: q(0.9), max: abs[abs.length - 1],
    within20: abs.filter((x) => x <= 20).length / errs.length,
    within30: abs.filter((x) => x <= 30).length / errs.length,
    within50: abs.filter((x) => x <= 50).length / errs.length,
    f: { mean: fixed.reduce((s, x) => s + x, 0) / fixed.length, p50: qf(0.5), p90: qf(0.9), max: af[af.length - 1],
      within30: af.filter((x) => x <= 30).length / af.length,
      within50: af.filter((x) => x <= 50).length / af.length },
    rows,
  };
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const WINDOWS = {
  'w1 起音前170ms（旧快照）': { endAt: 0, ms: 170 },
  'w2 结束于起音+90ms（判定那一刻）': { endAt: 90, ms: 170 },
  'w3 结束于起音+150ms': { endAt: 150, ms: 170 },
  'w4 起音后30ms起170ms': { at: 30, ms: 170 },
  'w5 起音后30ms起85ms': { at: 30, ms: 85 },
};

console.log(`录音 ${wavPath}：起音 ${onsets.length} 个（基准 = 谱面第 i 个音配第 i 个起音）\n`);
const out = [];
for (const [wname, wcfg] of Object.entries(WINDOWS)) {
  // 用**产品里那个函数**（不是本文件里抄的一份），否则测的不是同一个东西
  out.push(evalEstimator(`E1 产品估计器 / ${wname}`, estimateByPeaksReal, wcfg));
  out.push(evalEstimator(`E7 本文件旧副本(对照) / ${wname}`, estimateByPeaks, wcfg));
  // E8：把找峰范围放宽（±140 音分）—— 弹偏离超过一个半音时，真音才落在能找到的范围里。
  out.push(evalEstimator(`E8 产品估计器(找峰±140) / ${wname}`,
    (mags, sr, N, midi) => estimateByPeaksReal(mags, sr, N, midi, { tolCents: 140 }), wcfg));
  out.push(evalEstimator(`E6 峰插值(封顶权重=旧) / ${wname}`,
    (mags, sr, N, midi) => estimateByPeaks(mags, sr, N, midi, { magWeight: 'cap' }), wcfg));
  out.push(evalEstimator(`E4 峰插值(找峰±150音分) / ${wname}`,
    (mags, sr, N, midi) => estimateByPeaks(mags, sr, N, midi, { tolCents: 150 }), wcfg));
  out.push(evalEstimator(`E3 宽域HPS+细化 / ${wname}`, estimateWide, wcfg));
  out.push(evalEstimator(`E0 现估计器 / ${wname}`, (mags, sr, N, midi) =>
    estimateF0Near(mags, sr, N, midi, { rangeCents: 80, tolCents: 15 }), wcfg));
}
out.push(evalEstimator('E2 谐波峰插值 / 两窗合并(w1+w2)', estimateByPeaks, { two: true }));
// E5：同一个音在几个不同窗口各量一次，取**中位**。
// 动因：单窗口偶尔会跳掉（实测同一个音在 起音+90ms 的窗口读 -25 音分，
// 在 +96ms 的窗口读 -101 音分、谐波数还从 12 掉到 8）—— 窗口里混进一个瞬态就会这样。
// 中位数投票是最省事的抗跳法，代价是每个音多量几次（纯计算，几毫秒）。
out.push(evalEstimator('E5 多窗取中位(90/110/130/150ms)', estimateByPeaks, { multi: [90, 110, 130, 150] }));

console.log(pad('估计器 / 窗口', 40) + pad('样本', 6) + pad('平均偏差', 9) + pad('中位', 7)
  + pad('90分位', 8) + pad('最大', 7) + pad('±20', 7) + pad('±30', 7) + '±50');
for (const r of out) {
  console.log(pad(r.label, 40) + pad(r.n, 6) + pad(Math.round(r.mean), 9) + pad(Math.round(r.p50), 7)
    + pad(Math.round(r.p90), 8) + pad(Math.round(r.max), 7)
    + pad(`${Math.round(r.within20 * 100)}%`, 7) + pad(`${Math.round(r.within30 * 100)}%`, 7)
    + `${Math.round(r.within50 * 100)}%`);
}

console.log('\n按弦音准校正**之后**的散布（判定实际用的就是这个）：');
console.log(pad('估计器 / 窗口', 40) + pad('平均偏差', 9) + pad('中位', 7) + pad('90分位', 8)
  + pad('最大', 7) + pad('±30', 7) + '±50');
for (const r of out) {
  console.log(pad(r.label, 40) + pad(Math.round(r.f.mean), 9) + pad(Math.round(r.f.p50), 7)
    + pad(Math.round(r.f.p90), 8) + pad(Math.round(r.f.max), 7)
    + pad(`${Math.round(r.f.within30 * 100)}%`, 7) + `${Math.round(r.f.within50 * 100)}%`);
}

if (process.env.VC_DETAIL) {
  for (const r of out.filter((x) => x.label.startsWith('E1'))) {
    console.log(`\n${r.label} 逐音：  号 期望 实测Hz 音分 谐波数 残差`);
    for (const x of r.rows) {
      console.log(`   #${String(x.i).padStart(2)} ${x.exp} ${x.hz.toFixed(1).padStart(7)} `
        + `${String(Math.round(x.c)).padStart(5)} ${x.nHarm} ${x.resid != null ? x.resid.toFixed(1) : '—'}`);
    }
    break;
  }
}
