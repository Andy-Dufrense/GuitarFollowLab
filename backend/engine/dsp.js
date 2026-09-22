// ─────────────────────────────────────────────────────────────────────────────
// 实时识别用的信号处理内核。纯函数，不碰 DOM，所以能在 Node 里用合成信号直接测。
//
//   YIN 自相关      → 单音音高（吉他最低的 E2 只有 82.41Hz，FFT 分辨率不够）
//   FFT + Chroma    → 和弦/扫弦的音级指纹
//
// 采样率按 12kHz 左右设计：吉他基频最高到 1.3kHz，12kHz 完全够，
// 而且降采样之后自相关的计算量能省 4 倍。
// ─────────────────────────────────────────────────────────────────────────────

import { CHORD_LIB, chordVoicing, midiToName, midiToPC, pcName } from './data.js';

export const MIDI_A4 = 69;
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export { midiToName, pcName };

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── 降采样：滑动平均 + 抽取，相当于一个粗糙的抗混叠低通 ──────────────────────
export function decimate(input, factor) {
  if (factor <= 1) return Float32Array.from(input);
  const n = Math.floor(input.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += input[base + k];
    out[i] = sum / factor;
  }
  return out;
}

export function rms(buf, start = 0, len = buf.length - start) {
  const end = Math.min(buf.length, start + len);
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i] * buf[i];
  const n = Math.max(1, end - start);
  return Math.sqrt(sum / n);
}

// 去掉"衰减偏置"：算差分之前先把信号按包络归一化。
// YIN 的差分函数在衰减信号上会偏向更短的滞后（短滞后处跨过的衰减更小），
// 读出来偏高。归一化相当于把衰减去掉。
export function removeDecayBias(buf, sampleRate, winMs = 20) {
  const n = buf.length;
  const w = Math.max(8, Math.round((sampleRate * winMs) / 1000));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + Math.abs(buf[i]);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    const env = (pre[b] - pre[a]) / (b - a);
    out[i] = env > 1e-9 ? buf[i] / env : buf[i];
  }
  return out;
}

// ── YIN ──────────────────────────────────────────────────────────────────────
// 返回 { hz, midi, clarity }。clarity 1 = 非常确定，0 = 完全听不出周期。
export function yinPitch(buf, sampleRate, opts = {}) {
  // 按包络归一化，去掉"衰减偏置"。
  //
  // 【不要】在 YIN 前面加低通。试过：压掉高频确实能减轻亮音色（比如一弦）
  // 偏高 25~30 音分的问题，但代价太贵——在"上一个音还在响"的混合信号里，
  // 低通会把相位关系搅乱，实测直接把 A3 判成了 D2（差 3 个半音）。
  // 3 个半音的错比那 25 音分的偏移严重得多，所以低通这条路放弃。
  // 亮音色残留的那点偏高在 50 音分以内，按音名判定本来就是通过。
  const x = opts.removeBias === false ? buf : removeDecayBias(buf, sampleRate, opts.envMs ?? 20);

  const minHz = opts.minHz ?? 65;
  const maxHz = opts.maxHz ?? 1400;
  const W = Math.min(opts.window ?? 1024, Math.floor(x.length / 2));
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(sampleRate / minHz), x.length - W - 1);
  if (W < 64 || tauMax <= tauMin) return { hz: 0, midi: 0, clarity: 0 };

  // 1) 差分函数
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const diff = x[j] - x[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // 2) 累积均值归一化
  const cmnd = new Float64Array(tauMax + 1);
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    cmnd[tau] = run === 0 ? 1 : (d[tau] * tau) / run;
  }

  // 3) 找第一个低于阈值的局部极小；找不到就退回全局最小
  const threshold = opts.threshold ?? 0.15;
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = Infinity;
    for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < best) { best = cmnd[t]; tau = t; }
    if (tau < 0 || best > 0.75) return { hz: 0, midi: 0, clarity: 0 };
  }

  // 这里【不要】加"如果 τ/2 处也不差就把音高翻倍"的修补。
  // 真实拨弦的二次谐波常常比基频还强，那个判据会把六弦空弦 E2(82Hz)
  // 读成高八度的 E3、把四弦空弦 D3(147Hz) 读成 D4 —— 实测就是这么卡的。
  // 八度归属交给上层去判：那里有频谱，可以查"低八度那个音的基频到底存不存在"。

  // 落在搜索范围最边上的一律不采信。
  // 信号里混了别的东西（比如上一个和弦还在响）时，归一化差分函数常常会在最长的那个
  // 滞后上凑出一个假的极小值，读出来就是"刚好 65Hz"这种边界值。
  if (tau >= tauMax - 2) return { hz: 0, midi: 0, clarity: 0 };

  // 4) 抛物线插值，把整数滞后修成小数
  let tauEst = tau;
  let bestVal = cmnd[tau];
  if (tau > tauMin && tau + 1 <= tauMax) {
    const s0 = cmnd[tau - 1], s1 = cmnd[tau], s2 = cmnd[tau + 1];
    const a = (s0 + s2) / 2 - s1;
    const b = (s2 - s0) / 2;
    if (Math.abs(a) > 1e-12) {
      const delta = -b / (2 * a);
      if (Math.abs(delta) <= 1) {
        tauEst = tau + delta;
        bestVal = a * delta * delta + b * delta + s1;
      }
    }
  }

  const hz = sampleRate / tauEst;
  if (!Number.isFinite(hz) || hz < minHz * 0.8 || hz > maxHz * 1.2) {
    return { hz: 0, midi: 0, clarity: 0 };
  }
  return { hz, midi: hzToMidi(hz), clarity: clamp(1 - bestVal, 0, 1) };
}

// ── FFT（迭代版 radix-2）─────────────────────────────────────────────────────
export function fftMagnitudes(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < N; i += len) {
      let cwr = 1, cwi = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const mags = new Float32Array(N >> 1);
  for (let i = 0; i < (N >> 1); i++) mags[i] = Math.hypot(re[i], im[i]);
  return mags;
}

export function spectrumOf(buf) {
  const N = 1 << Math.floor(Math.log2(buf.length));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); // Hann
    re[i] = buf[i] * w;
  }
  return fftMagnitudes(re, im);
}

// 查频谱上某个频率处的幅度（线性插值）
export function spectralMagAt(mags, sampleRate, fftSize, hz) {
  const binHz = sampleRate / fftSize;
  const k = hz / binHz;
  const k0 = Math.floor(k);
  if (k0 < 1 || k0 + 1 >= mags.length) return 0;
  const f = k - k0;
  return mags[k0] * (1 - f) + mags[k0 + 1] * f;
}

// ── Chroma（HPCP，谐波求和）──────────────────────────────────────────────────
// 不能直接把每个频率 bin 折算成音级——那样子每个音级都会分到能量，12 个音级全亮。
// 正确做法是反过来问：假设某个音级在这个八度上存在，它的第 1~5 次谐波位置上有多少能量？
// 能量都落在谐波位置上的音级才是真的存在。
export function chromaFromSpectrum(mags, sampleRate, fftSize, opts = {}) {
  const minMidi = opts.minMidi ?? 28;   // E1，给降弦留余量
  const maxMidi = opts.maxMidi ?? 88;   // E6
  const harmonics = opts.harmonics ?? 5;
  const nyq = sampleRate / 2;
  const chroma = new Array(12).fill(0);

  for (let midi = minMidi; midi <= maxMidi; midi++) {
    const f0 = midiToHz(midi);
    let salience = 0;
    for (let h = 1; h <= harmonics; h++) {
      const f = f0 * h;
      if (f > nyq - 200) break;
      salience += spectralMagAt(mags, sampleRate, fftSize, f) / (h * h);
    }
    chroma[((midi % 12) + 12) % 12] += salience;
  }
  return chroma;
}

// 观测到的 Chroma → 音级集合（相对最大值，低于门限的当作没响）
export function toPitchClassSet(chroma, presence = 0.2) {
  const max = Math.max(...chroma);
  const out = new Array(12).fill(0);
  if (max <= 0) return out;
  for (let i = 0; i < 12; i++) out[i] = chroma[i] / max >= presence ? 1 : 0;
  return out;
}

function bassBoost(vec, pc, weight) {
  const out = vec.slice();
  if (pc != null && weight > 0) out[pc] *= 1 + weight;
  return out;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < 12; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 和弦模板：按实际按弦生成，带上低音信息
const TEMPLATES = {};
for (const key of Object.keys(CHORD_LIB)) {
  const v = chordVoicing(key);
  const chroma = new Array(12).fill(0);
  let lowest = null;
  for (const x of v) {
    chroma[midiToPC(x.midi)] = 1;
    if (!lowest || x.midi < lowest.midi) lowest = x;
  }
  TEMPLATES[key] = { label: CHORD_LIB[key].label, chroma, bassPc: midiToPC(lowest.midi) };
}

export function chordTemplateKeys() { return Object.keys(TEMPLATES); }
export function chordLabel(key) { return TEMPLATES[key] ? TEMPLATES[key].label : key; }

export function matchChord(chroma, bassPc, opts = {}) {
  const bassWeight = opts.bassWeight ?? 1.2;
  // 用余弦相似度而不是集合重合：吉他和弦的泛音会让个别音级"虚高"，
  // 集合类的度量一漏一多就掉得很快，余弦对这种溢出宽容得多。
  const observed = bassBoost(chroma, bassPc, bassWeight);
  const ranked = Object.keys(TEMPLATES).map((key) => {
    const t = TEMPLATES[key];
    const score = cosine(observed, bassBoost(t.chroma, t.bassPc, bassWeight));
    return { key, label: t.label, score };
  }).sort((a, b) => b.score - a.score);
  return ranked;
}

// 只在一组和弦里挑：实时页里都是原位和弦，不需要靠低音分辨转位，
// 把不在集合里的模板滤掉能避免 C 被 C/G 抢走这种误判。
export function matchChordIn(chroma, keys, opts = {}) {
  const all = matchChord(chroma, opts.bassPc ?? null, { bassWeight: opts.bassWeight ?? 0 });
  const allowed = new Set(keys);
  return all.filter((x) => allowed.has(x.key));
}

export function observedPitchClasses(chroma, presence = 0.35) {
  return toPitchClassSet(chroma, presence).map((v, i) => (v ? pcName(i) : null)).filter(Boolean);
}
