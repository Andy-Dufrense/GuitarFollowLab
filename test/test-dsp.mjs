// DSP 内核测试：用合成信号验证 YIN 单音检测和 Chroma 和弦识别。
// 用法： node test-dsp.mjs

import {
  decimate, yinPitch, spectrumOf, chromaFromSpectrum, matchChordIn, observedPitchClasses,
  hzToMidi,
} from '../frontend/js/dsp.js';
import { refineBySpectrum } from '../frontend/js/analysis.js';
import { chordVoicing, midiToHz, OPEN_STRING_MIDI } from '../frontend/js/data.js';
import { LIVE_CHORDS } from '../frontend/js/exercises.js';

const SR = 48000;
const DECIM = 4;            // 降采样到 12kHz
const SR2 = SR / DECIM;
// 低音弦必须用长窗：12kHz 下 1024 点 FFT 的 bin 宽是 11.7Hz，
// 而 A2=110Hz 处一个半音才 6.5Hz，窗短了低音会直接差一个半音。
const FFT_N = 4096;

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log('   !! ' + msg); } };

// 合成一个拨弦音：8 个谐波，幅度 1/k，指数衰减
function pluck(midi, durSec, amp = 1) {
  const n = Math.floor(durSec * SR);
  const out = new Float32Array(n);
  const f0 = midiToHz(midi);
  for (let k = 1; k <= 8; k++) {
    const f = f0 * k * (1 + 0.0002 * k * k);   // 琴弦刚性带来的轻微非谐性
    if (f > SR / 2 - 100) break;
    const a = amp / k;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] += a * Math.exp(-t * (3 + k * 0.6)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
    }
  }
  return out;
}

function mix(...buffers) {
  const n = Math.max(...buffers.map((b) => b.length));
  const out = new Float32Array(n);
  for (const b of buffers) for (let i = 0; i < b.length; i++) out[i] += b[i];
  return out;
}

function addAt(base, buf, offsetSamples) {
  for (let i = 0; i < buf.length; i++) {
    const j = offsetSamples + i;
    if (j >= 0 && j < base.length) base[j] += buf[i];
  }
  return base;
}

// 扫弦：逐弦拨，低音弦先响
function strum(chordKey, spreadMs = 22) {
  const v = chordVoicing(chordKey);
  const total = new Float32Array(Math.floor(1.2 * SR));
  v.forEach((x, idx) => addAt(total, pluck(x.midi, 1.0, 0.9), Math.floor((idx * spreadMs / 1000) * SR)));
  return total;
}

// buf 要正好是"想分析的那一段"：取最后 1204 点算音高、最后 4096 点算 Chroma
function analyze(buf) {
  const dec = decimate(buf, DECIM);
  let pitch = yinPitch(dec.subarray(Math.max(0, dec.length - 1204)), SR2,
    { window: 1024, minHz: 65, maxHz: 1400 });
  const seg = dec.subarray(Math.max(0, dec.length - FFT_N));
  const mags = spectrumOf(seg);
  // 页面里判定前还会用频谱把音高修准（治琴弦刚性带来的偏高），这里跟上，
  // 否则测出来的精度不代表实际效果。
  if (pitch.hz > 0) {
    const f = refineBySpectrum(mags, SR2, FFT_N, pitch.hz);
    if (Math.abs(1200 * Math.log2(f / pitch.hz)) < 120) {
      pitch = { ...pitch, hz: f, midi: hzToMidi(f) };
    }
  }
  const chroma = chromaFromSpectrum(mags, SR2, FFT_N);
  return { pitch, chroma };
}

// ── 1. 单音 ─────────────────────────────────────────────────────────────────
console.log('\n=== 单音音高检测（YIN）===');
const singleTests = [
  [6, 0], [5, 0], [4, 0], [3, 0], [2, 0], [1, 0],   // 六根空弦
  [5, 3], [4, 2], [3, 5], [2, 1], [3, 7],            // 几个按弦音
];
for (const [string, fret] of singleTests) {
  const midi = OPEN_STRING_MIDI[string] + fret;
  const r = analyze(pluck(midi, 0.45));
  const dev = r.pitch.midi ? (r.pitch.midi - midi) * 100 : NaN;
  const good = r.pitch.midi && Math.abs(dev) < 8;
  const name = String(midi);
  console.log(`  ${string}弦${fret}品  检测 ${(r.pitch.hz || 0).toFixed(2).padStart(8)}Hz  ` +
    `偏差 ${dev.toFixed(1).padStart(6)} 音分  清晰度 ${r.pitch.clarity.toFixed(2)}  ${good ? 'OK' : '!!'}`);
  ok(good, `弦${string}品${fret} (midi ${name}) 检测失败`);
}

// ── 2. 抗噪 ─────────────────────────────────────────────────────────────────
console.log('\n=== 加房间底噪 ===');
for (const noise of [0.02, 0.06, 0.12]) {
  const sig = pluck(40, 0.45);
  const n = new Float32Array(sig.length);
  for (let i = 0; i < n.length; i++) n[i] = (Math.random() * 2 - 1) * noise;
  const r = analyze(mix(sig, n));
  const dev = r.pitch.midi ? (r.pitch.midi - 40) * 100 : NaN;
  const good = r.pitch.midi && Math.abs(dev) < 15;
  console.log(`  噪声 ${noise.toFixed(2)}  检测 ${(r.pitch.hz || 0).toFixed(2).padStart(8)}Hz  ` +
    `偏差 ${dev.toFixed(1).padStart(6)} 音分  清晰度 ${r.pitch.clarity.toFixed(2)}  ${good ? 'OK' : '!!'}`);
  ok(good, `噪声 ${noise} 下 E2 检测失败`);
}

// ── 3. 和弦 ─────────────────────────────────────────────────────────────────
console.log('\n=== 和弦识别（Chroma + 余弦）===');
for (const key of LIVE_CHORDS) {
  const sig = strum(key);
  // 扫完立刻取 350ms 的窗口，真实系统用的就是这一段
  const a = Math.floor(0.11 * SR);
  const r = analyze(sig.subarray(a, a + Math.floor(0.35 * SR)));
  const ranked = matchChordIn(r.chroma, LIVE_CHORDS);
  const top = ranked[0];
  const good = top.key === key && top.score > 0.7;
  console.log(`  ${key.padEnd(3)} 识别 ${top.label.padEnd(3)} ${top.score.toFixed(3)}  ` +
    `音级 [${observedPitchClasses(r.chroma).join(' ')}]  ` +
    `候选 ${ranked.slice(0, 3).map((x) => x.label + ' ' + x.score.toFixed(2)).join(' / ')}  ${good ? 'OK' : '!!'}`);
  ok(good, `${key} 识别失败`);
}

// ── 4. 弹错和弦的时候要报错，不能乱通过 ─────────────────────────────────────
console.log('\n=== 目标 Em，实际扫 C ===');
{
  const sig = strum('C');
  const a = Math.floor(0.11 * SR);
  const r = analyze(sig.subarray(a, a + Math.floor(0.35 * SR)));
  const ranked = matchChordIn(r.chroma, LIVE_CHORDS);
  console.log(`  最像 ${ranked[0].label} ${ranked[0].score.toFixed(3)}`);
  ok(ranked[0].key !== 'Em', '弹 C 却认成了 Em');
}

// ── 5. 真实拨弦的泛音结构：二次谐波比基频强时，低音不能被读高一个八度 ──────
// 这是实测踩到的坑：真实吉他拨弦的二次谐波常常比基频还强，
// 六弦空弦 E2(82Hz) 被读成 E3(165Hz)、四弦空弦 D3(147Hz) 被读成 D4。
// 原因是在滞后域加了"τ/2 处也不差就把音高翻倍"的修补，被强泛音骗了。
// 现在八度归属交给上层用频谱判（查低八度的基频存不存在），这里守住 YIN 本身。
console.log('\n=== 泛音结构下的低音检测（不能读高八度）===');
{
  // 谐波幅度：二次谐波最强，接近真实拨弦
  const pluckStrong2nd = (midi, durSec, amp = 1) => {
    const n = Math.floor(durSec * SR);
    const out = new Float32Array(n);
    const f0 = midiToHz(midi);
    const harm = [0.45, 1.0, 0.55, 0.32, 0.2, 0.14, 0.1, 0.07];
    for (let k = 1; k <= harm.length; k++) {
      const f = f0 * k * (1 + 0.0002 * k * k);
      if (f > SR / 2 - 100) break;
      const a = amp * harm[k - 1];
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        out[i] += a * Math.exp(-t * (3 + k * 0.6)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
      }
    }
    return out;
  };
  for (const [midi, label] of [[40, '六弦空弦 E2'], [50, '四弦空弦 D3'], [45, '五弦空弦 A2'], [55, '三弦空弦 G3']]) {
    const r = analyze(pluckStrong2nd(midi, 0.45));
    const dev = r.pitch.midi ? (r.pitch.midi - midi) * 100 : NaN;
    const good = r.pitch.midi && Math.abs(dev) < 20;
    console.log(`  ${label.padEnd(12)} 检测 ${(r.pitch.hz || 0).toFixed(2).padStart(8)}Hz  `
      + `偏差 ${dev.toFixed(1).padStart(6)} 音分  ${good ? 'OK' : '!! 读成了别的八度'}`);
    ok(good, `${label} 在强二次谐波下读错八度`);
  }

  // 一弦最细最亮，高次谐波特别多 —— 换成"高次谐波为主"的音色再验一遍。
  // 之前那版在滞后域里加了"τ/2 处也不差就把音高翻倍"的修补，
  // 一弦 E4(330Hz) 的 τ/2 对应 E5(660Hz)，会被它往上翻一个八度。
  const pluckBright = (midi, durSec, amp = 1) => {
    const n = Math.floor(durSec * SR);
    const out = new Float32Array(n);
    const f0 = midiToHz(midi);
    for (let k = 1; k <= 14; k++) {
      const f = f0 * k * (1 + 0.0002 * k * k);
      if (f > SR / 2 - 100) break;
      const a = amp * (0.35 + 0.65 * (k / 14));      // 越高的谐波反而越突出
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        out[i] += a * Math.exp(-t * (3 + k * 0.35)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
      }
    }
    return out;
  };
  // 亮音色下 YIN 会偏高几十音分（琴弦刚性让高次谐波略高，YIN 被它们带着走）。
  // 页面里判定前会用频谱把音高修准，这里也跟上了，所以偏差应该回到个位数。
  console.log('  --- 换成高次谐波为主的一弦音色（判定前有频谱修正）---');
  for (const [midi, label] of [[64, '一弦空弦 E4'], [59, '二弦空弦 B3'], [67, '一弦 3 品 G4']]) {
    const r = analyze(pluckBright(midi, 0.4));
    const dev = r.pitch.midi ? (r.pitch.midi - midi) * 100 : NaN;
    const good = r.pitch.midi && Math.abs(dev) < 10;
    console.log(`  ${label.padEnd(12)} 检测 ${(r.pitch.hz || 0).toFixed(2).padStart(8)}Hz  `
      + `偏差 ${dev.toFixed(1).padStart(6)} 音分  ${good ? 'OK' : '!! 读成了别的八度'}`);
    ok(good, `${label} 在高次谐波音色下读错八度`);
  }
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
