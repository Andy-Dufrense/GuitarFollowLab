// 诊断：和弦余响里弹低音弦，为什么会被判高一个八度？
//
// 直接打印判定时刻的频谱账：
//   · 每个候选音的谐波位置上，新出现的能量（novel）有多少
//   · 本底（已经被"吸收"的余响）有多少
// 如果某个候选的分数主要来自"本底残留"，那问题就在吸收速度上，不在打分函数上。
//
// 注意 hopMs：页面主循环约 60ms 跑一次分析，所以默认 60ms。
// 本底吸收是"每次调用吸多少"，跟循环频率绑在一起 —— 这里两种节奏都跑一遍，
// 就是为了看清这个耦合。
//
// 用法： node test/probe-octave.mjs

import { decimate, spectrumOf } from '../backend/engine/dsp.js';
import { track, novelSpectrum, matchNoteByCandidates, resetAnalysis } from '../backend/engine/analysis.js';
import { midiToHz, chordVoicing, midiToName } from '../backend/engine/data.js';

const SR = 48000;
const CAPTURE = 16384;
const DECIM = 4;

function phoneMic(x) {
  const fc = 150, rc = 1 / (2 * Math.PI * fc), dt = 1 / SR, a = rc / (rc + dt);
  let out = x;
  for (let pass = 0; pass < 2; pass++) {
    const y = new Float32Array(out.length);
    let yPrev = 0, xPrev = 0;
    for (let i = 0; i < out.length; i++) {
      const v = a * (yPrev + out[i] - xPrev);
      y[i] = v; yPrev = v; xPrev = out[i];
    }
    out = y;
  }
  return out;
}

function pluckInto(dst, midi, at, dur, { amp = 0.35, decay = 3, harm = null } = {}) {
  const f0 = midiToHz(midi);
  const from = Math.floor(at * SR);
  const n = Math.floor(dur * SR);
  const H = harm || [0.15, 1.0, 0.55, 0.32, 0.2, 0.14, 0.1, 0.07];
  for (let k = 1; k <= H.length; k++) {
    const f = f0 * k * (1 + 0.0002 * k * k);
    if (f > SR / 2 - 100) break;
    const a = amp * H[k - 1];
    for (let i = 0; i < n; i++) {
      const j = from + i;
      if (j < 0 || j >= dst.length) continue;
      const t = i / SR;
      dst[j] += a * Math.exp(-t * (decay + k * 0.6)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
    }
  }
}

function strumInto(dst, key, at, { amp = 0.3, decay = 1.2 } = {}) {
  chordVoicing(key).forEach((x, i) => pluckInto(dst, x.midi, at + i * 0.022, 3.0, { amp, decay }));
}

function peakNear(mags, sr, fftSize, hz, cents = 40) {
  const binHz = sr / fftSize;
  const lo = Math.max(1, Math.floor((hz * Math.pow(2, -cents / 1200)) / binHz));
  const hi = Math.min(mags.length - 2, Math.ceil((hz * Math.pow(2, cents / 1200)) / binHz));
  let m = 0;
  for (let i = lo; i <= hi; i++) if (mags[i] > m) m = mags[i];
  return m;
}

// 跑到 judgeMs 这个时刻，把当时的频谱账打出来
function run(label, audio, judgeMs, candidates, hopMs = 60) {
  resetAnalysis();
  const sr2 = SR / DECIM;
  const end = Math.floor((judgeMs / 1000) * SR);
  // 1) 按页面的节奏跑 track()，让本底（bg）长成它该有的样子
  for (let t = CAPTURE; t <= end; t += Math.round((hopMs / 1000) * SR)) {
    track(audio.subarray(t - CAPTURE, t), DECIM, sr2);
  }
  // 2) 判定那一刻的频谱是**现算**的（页面里 analyze() 就是这么干的），
  //    只有本底是上一帧留下的 —— 这一步必须和页面一致，否则量出来的是假象
  const buf = audio.subarray(end - CAPTURE, end);
  const dec = decimate(buf, DECIM);
  const fftN = 1 << Math.floor(Math.log2(dec.length));
  const mags = spectrumOf(dec);
  const novel = novelSpectrum(mags);
  const bg = new Float32Array(mags.length);
  for (let i = 0; i < bg.length; i++) bg[i] = mags[i] - novel[i];

  console.log(`\n===== ${label}（第 ${judgeMs}ms，每 ${hopMs}ms 分析一次）=====`);
  for (const midi of candidates) {
    let line = `  ${midiToName(midi).padEnd(4)}`;
    for (let k = 1; k <= 5; k++) {
      const f = midiToHz(midi) * k;
      const n = peakNear(novel, sr2, fftN, f);
      const b = peakNear(bg, sr2, fftN, f);
      line += ` k${k}: ${n.toFixed(2)}/${b.toFixed(2)} (${b > 1e-9 ? Math.round((b / (n + b)) * 100) : 0}%)`;
    }
    console.log(line);
  }
  const res = matchNoteByCandidates(novel, sr2, fftN, candidates[0]);
  console.log('  排名：' + res.ranked.map((x) => `${midiToName(x.midi)} ${x.score.toFixed(3)}`).join(' | '));
  console.log(`  结论：目标 ${midiToName(candidates[0])} ${res.ok ? '判过' : '判错'}`
    + `（领先次优 ${res.margin.toFixed(2)} 倍，失配 ${res.ranked[0].mismatch.toFixed(1)} 音分）`);
  // 失配的账：P2O（预测的谐波没找到）和 O2P（观测到的峰解释不了）各占多少
  const show = ['E2', 'E3'];
  for (const r of res.ranked) {
    if (!show.includes(midiToName(r.midi))) continue;
    console.log(`    ${midiToName(r.midi)}: P2O ${r.detail.p2o.toFixed(1)} + O2P ${r.detail.o2p.toFixed(1)}`
      + ` = ${r.mismatch.toFixed(1)} 音分`);
  }
  const pk = res.peaks.map((p) => `${(p.bin * (sr2 / fftN)).toFixed(0)}Hz`).join(' ');
  console.log(`    观测到的峰（${res.peaks.length} 个）：${pk}`);
  return res;
}

// 场景：C 和弦（0.4s 扫响，余响长）→ 1.6s 弹六弦空弦 E2
const total = new Float32Array(Math.ceil(4 * SR));
for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
strumInto(total, 'C', 0.4);
pluckInto(total, 40, 1.6, 2.0);
const withPhone = phoneMic(total);

// 60ms = 页面主循环的真实节奏；16ms 是"如果分析跑得更勤"的对照
run('原始信号 · 60ms 节奏', total, 1660, [40, 52, 64], 60);
run('手机麦克风 · 60ms 节奏', withPhone, 1660, [40, 52, 64], 60);
run('手机麦克风 · 16ms 节奏（对照）', withPhone, 1660, [40, 52, 64], 16);
// C 和弦刚扫完那一下：目标是 E2，但实际响的是 C 和弦 —— 这一步必须判错（不能假通过）
run('C 和弦刚扫完 · 起音后 60ms（必须判错）', total, 460, [40, 52, 64], 60);
run('C 和弦刚扫完 · 起音后 140ms（必须判错）', total, 540, [40, 52, 64], 60);

// 对照：安静环境下单独弹 E2（没有和弦余响）
{
  const clean = new Float32Array(Math.ceil(3 * SR));
  for (let i = 0; i < clean.length; i++) clean[i] = (Math.random() * 2 - 1) * 0.0008;
  pluckInto(clean, 40, 1.0, 2.0);
  run('对照：安静环境单独弹 E2', clean, 1060, [40, 52, 64], 60);
}

// 延音场景里，**真音**的失配是多少？用来校准"像不像"的下限（FIT_MAX_CENTS）。
// 这一步照抄 test-detect D 组的合成方式：T3231323（Em 的八个音），衰减慢 5 倍 + 手机频响。
{
  const seq = [40, 55, 59, 55, 64, 55, 59, 55];      // E2 G3 B3 G3 E4 G3 B3 G3
  const stepMs = 300;                                 // 100 BPM 的八分音符
  const sustain = new Float32Array(Math.ceil((0.5 + (seq.length * stepMs) / 1000 + 3.5) * SR));
  for (let i = 0; i < sustain.length; i++) sustain[i] = (Math.random() * 2 - 1) * 0.0008;
  seq.forEach((midi, i) => pluckInto(sustain, midi, 0.5 + (i * stepMs) / 1000, 3.5, { decay: 0.6 }));
  const mic = phoneMic(sustain);
  console.log('\n===== 延音场景（T3231323 @100BPM，衰减慢 5 倍 + 手机频响）：真音的失配 =====');
  seq.forEach((midi, i) => {
    const at = Math.round((0.5 + (i * stepMs) / 1000 + 0.06) * 1000);
    const res = run(`真音第 ${i + 1} 个（${midiToName(midi)}）`, mic, at, [midi], 60);
    console.log(`    → 第 ${i + 1} 个音 ${midiToName(midi)}：失配 ${res.ranked[0].mismatch.toFixed(1)} 音分`
      + `（门槛现在是 75）`);
  });
}
