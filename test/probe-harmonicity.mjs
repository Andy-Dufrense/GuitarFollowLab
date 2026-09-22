// 诊断：怎么区分"真的拨了一下弦"和"一声噪声"。
//
// 背景（手机实测）：任何音都被判"对"，一阵风过去能过两三个音。
// 查下来是：**只要有起音，宽带噪声也能在"谱面那个音"的谐波位置上凑出一串峰**，
// 于是谐波梳子的残差、谐波个数、能量比全都分不开 —— 实测噪声的残差 41 音分，
// 真音 40 音分，一模一样。
//
// 真正分得开的是**谐噪比**：每个谐波位置"峰的幅度"比"它两侧（挖掉峰本身）的中位幅度"。
// 关键在挖多宽：挖窄了（±25 音分）落在峰自己的裙边里，比值就只有 2 左右，什么也分不出；
// 挖到 ±120 音分才是真正的"谐波之间的谷"。
//
// 用法： node test/probe-harmonicity.mjs [onsets.json]

import fs from 'node:fs';

const M = 'file:///E:/GuitarFollowLab/frontend/js/';
const { spectrumOf } = await import(M + 'dsp.js');

const SR = 48000, N = 8192, binHz = SR / N;
const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);

// 谐噪比：各谐波 峰/两侧中位 的中位数。excludeCents = 峰周围挖掉多少（别挖窄了）
export function harmonicity(mags, f0, excludeCents = 120, maxHarm = 8) {
  const out = [];
  for (let k = 1; k <= maxHarm; k++) {
    const f = k * f0;
    if (f > SR / 2 - 500) break;
    const c = f / binHz;
    const lo = Math.max(1, Math.floor(c * Math.pow(2, -25 / 1200)));
    const hi = Math.min(mags.length - 2, Math.ceil(c * Math.pow(2, 25 / 1200)));
    let pk = 0;
    for (let i = lo; i <= hi; i++) if (mags[i] > pk) pk = mags[i];
    const blo = Math.max(1, Math.floor(c * Math.pow(2, -250 / 1200)));
    const bhi = Math.min(mags.length - 2, Math.ceil(c * Math.pow(2, 250 / 1200)));
    const exLo = Math.floor(c * Math.pow(2, -excludeCents / 1200));
    const exHi = Math.ceil(c * Math.pow(2, excludeCents / 1200));
    const side = [];
    for (let i = blo; i <= bhi; i++) { if (i >= exLo && i <= exHi) continue; side.push(mags[i]); }
    if (side.length < 3) continue;
    side.sort((a, b) => a - b);
    out.push(pk / (side[Math.floor(side.length / 2)] + 1e-12));
  }
  out.sort((a, b) => a - b);
  return out.length ? out[Math.floor(out.length / 2)] : 0;
}

const stats = (a, label) => {
  const s = a.slice().sort((x, y) => x - y);
  console.log(label.padEnd(28)
    + ' p10=' + s[Math.floor(s.length * 0.1)].toFixed(1).padStart(8)
    + ' p50=' + s[Math.floor(s.length * 0.5)].toFixed(1).padStart(8)
    + ' 最小=' + s[0].toFixed(1).padStart(8)
    + ' 最大=' + s[s.length - 1].toFixed(1).padStart(9));
};

// 合成一段拨弦（和 test-follow-page 里同一个生成器形状）
function pluck(midi, decay = 3) {
  const b = new Float32Array(N), f0 = hzOf(midi);
  for (let k = 1; k <= 8; k++) {
    const f = f0 * k * (1 + 0.0002 * k * k);
    if (f > SR / 2 - 100) break;
    const a = 0.35 / k;
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      b[i] += a * Math.exp(-t * decay) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
    }
  }
  return b;
}
function noise(kind) {
  const b = new Float32Array(N);
  let s = 7, lp = 0;
  for (let i = 0; i < N; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    let w = (s / 0x7fffffff) * 2 - 1;
    if (kind === 'pink') { lp += (w - lp) * 0.03; w = lp * 4; }
    if (kind === 'tap') { w *= Math.exp(-(i / SR) / 0.05); }
    b[i] = w * 0.3;
  }
  return b;
}

console.log('\n=== 合成对照：谱里的"谐波墙"有多高 ===');
for (const [label, buf] of [
  ['干净拨弦 C4', pluck(60)],
  ['干净拨弦 E4', pluck(64)],
  ['长余响拨弦 C4', pluck(60, 0.8)],
  ['白噪声', noise('white')],
  ['粉噪声/风', noise('pink')],
  ['一声啪', noise('tap')],
]) {
  const v = hzOf(60);
  stats([harmonicity(spectrumOf(buf), v), harmonicity(spectrumOf(buf), hzOf(64))], label);
}

const file = process.argv[2] || (process.env.TEMP ? process.env.TEMP + '/vc_onsets.json' : null);
if (file && fs.existsSync(file)) {
  const { audio, onsets, notes } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = fs.readFileSync(audio);
  const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const at = (t) => {
    const from = Math.round(t * SR);
    const o = new Float32Array(N);
    for (let i = 0; i < N; i++) { const j = from + i; if (j >= 0 && j < A.length) o[i] = A[j]; }
    return o;
  };
  const onNote = [], between = [];
  for (let k = 0; k < onsets.length && k < notes.length; k++) {
    onNote.push(harmonicity(spectrumOf(at(onsets[k] - 0.08)), hzOf(notes[k].midi)));
    between.push(harmonicity(spectrumOf(at(onsets[k] - 0.28)), hzOf(notes[k].midi)));
  }
  console.log('\n=== 真机录音 ===');
  stats(onNote, '拨弦那一刻（真音）');
  stats(between, '音符之间（没在弹）');
}

console.log('\n用法上的意思：谐噪比是"这一下像不像一根弦在振"的尺子。');
console.log('真音的谐波墙比它两侧的谷高几个数量级；噪声两者差不多（≈1~2）。');
