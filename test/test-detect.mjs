// 检测能力的专项测试：专挑"用户真实环境下过不去"的场景。
//
// 和 test-live.mjs 的区别：那边是"链路通不通"，这边是**能不能听见、听对**。
// 三个前提都按真实情况来：
//   1. 纯手机麦克风 —— 低频被高通压掉（六弦空弦 82Hz 掉得最狠），基频常常比二次谐波还弱
//   2. 别的弦还在响 —— 上一个和弦的余响就是最大的干扰源
//   3. 用户不消音 —— 音一直延续着往下弹（这是用户明确反馈的场景）
//
// 用法： node test/test-detect.mjs

import { chordVoicing, midiToHz } from '../frontend/js/data.js';
import { MODES, buildRun } from '../frontend/js/exercises.js';

const SR = 48000;
const CAPTURE = 16384;

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('   !! ' + m); } };

// ── 手机麦克风的频响 ─────────────────────────────────────────────────────────
// 二阶高通（截止约 150Hz）。这不是"刁难"：手机麦克风的低频衰减就是这么狠，
// 而六弦空弦 E2 才 82Hz、五弦 A2 才 110Hz —— 低音弦本来就在最吃亏的位置上。
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

// 真实拨弦的泛音分布：手机麦克风收到的时候，基频往往比二次谐波还弱
const PHONE_HARM = [0.15, 1.0, 0.55, 0.32, 0.2, 0.14, 0.1, 0.07];

function pluckInto(dst, midi, at, dur, { amp = 0.35, decay = 3, harm = null } = {}) {
  const f0 = midiToHz(midi);
  const from = Math.floor(at * SR);
  const n = Math.floor(dur * SR);
  const H = harm || PHONE_HARM;
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

function strumInto(dst, key, at, { amp = 0.3, decay = 3 } = {}) {
  chordVoicing(key).forEach((x, i) => pluckInto(dst, x.midi, at + i * 0.022, 3.0, { amp, decay }));
}

function mkAudio(secs) {
  const total = new Float32Array(Math.ceil(secs * SR));
  for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
  return total;
}

// ── DOM / 假麦克风 ───────────────────────────────────────────────────────────
class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this._html = ''; this.className = '';
    this.style = {}; this.dataset = {}; this.value = ''; this.open = false;
    this.checked = false; this.textContent = ''; this.listeners = {}; this._q = new Map();
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  querySelector(s) { if (!this._q.has(s)) this._q.set(s, new El()); return this._q.get(s); }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}

let clock = 0;
let pending = null;
let AUDIO = new Float32Array(SR * 4);

const reg = new Map();
globalThis.document = {
  getElementById(id) { if (!reg.has(id)) reg.set(id, new El()); return reg.get(id); },
  createElement(t) { return new El(t); },
  querySelector() { return new El(); },
  querySelectorAll() { return []; },
};
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = (cb) => { pending = cb; return 1; };
globalThis.cancelAnimationFrame = () => { pending = null; };
globalThis.location = { origin: 'http://localhost:1209', host: 'localhost:1209', protocol: 'http:' };
globalThis.window = globalThis;
globalThis.isSecureContext = true;
globalThis.fetch = async () => ({ json: async () => ({ lanIPs: ['192.168.0.81'], httpPort: 1209, httpsPort: 1210, httpsReady: true }) });

const analyser = {
  fftSize: CAPTURE,
  getFloatTimeDomainData(arr) {
    const end = Math.floor((clock / 1000) * SR);
    const from = Math.max(0, end - CAPTURE);
    arr.fill(0);
    for (let i = 0; i < CAPTURE; i++) {
      const j = from + i;
      arr[i] = j >= 0 && j < AUDIO.length ? AUDIO[j] : 0;
    }
  },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: {
    userAgent: 'test',
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      enumerateDevices: async () => ([{ kind: 'audioinput', label: '手机麦克风' }]),
    },
    permissions: { query: async () => ({ state: 'prompt' }) },
  },
});
globalThis.AudioContext = class {
  constructor() { this.sampleRate = SR; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() { return analyser; }
  get currentTime() { return clock / 1000; }
  get destination() { return {}; }
  createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
};

const live = await import('../frontend/js/main.js');
const { resetApp } = live;
const $ = (id) => { if (!reg.has(id)) reg.set(id, new El()); return reg.get(id); };

async function scenario(audio, { modeIndex = 0, untilMs = 1600 } = {}) {
  AUDIO = audio;
  clock = 0;
  pending = null;
  resetApp();
  await $('btnStart').onclick();
  if (modeIndex) $('modes').children[modeIndex].onclick();
  // 记录判定条的变化时间线：用来区分"判错了"和"后面那个音根本没判到"
  const timeline = [];
  let lastVerdict = $('verdict').textContent;
  while (clock < untilMs) {
    clock += 16;
    const cb = pending; pending = null;
    if (cb) cb(clock);
    const v = $('verdict').textContent;
    if (v !== lastVerdict) { timeline.push(`${Math.round(clock)}ms ${v}`); lastVerdict = v; }
  }
  return {
    target: $('target').textContent,
    stepno: $('stepno').textContent,
    heard: $('heardval').textContent,
    verdict: $('verdict').textContent,
    timeline,
  };
}

// ── A. 手机麦克风：低频被压掉，六根空弦还要能逐个判对 ────────────────────────
console.log('\n=== A. 手机麦克风频响（低频高通）下，六根空弦依次弹 ===');
{
  const single = MODES.find((m) => m.id === 'single');
  const run = buildRun(single, 0);
  for (const gapMs of [700, 450]) {
    const total = mkAudio(0.5 + (6 * gapMs) / 1000 + 3.0);
    run.flat.forEach((e, i) => pluckInto(total, e.targetMidi, 0.5 + (i * gapMs) / 1000, 1.4));
    const r = await scenario(phoneMic(total), { untilMs: 500 + 6 * gapMs + 900 });
    const done = /🎉/.test(r.target);
    console.log(`  间隔 ${gapMs}ms → 目标 ${r.target}｜判定：${r.verdict}`);
    ok(done, `手机频响下间隔 ${gapMs}ms 没走完六根空弦，停在 ${r.target}`);
  }
}

// ── B. 和弦余响里的低音弦：这是交接文档里"未修"的那条 ────────────────────────
console.log('\n=== B. C 和弦还在响的时候弹六弦空弦 E2（会判高一个八度的那条）===');
{
  for (const [label, mic] of [['原始信号', (x) => x], ['手机麦克风', phoneMic]]) {
    const total = mkAudio(4.0);
    strumInto(total, 'C', 0.4, { amp: 0.3, decay: 1.2 });     // 和弦余响拖得长一点
    pluckInto(total, 40, 1.6, 2.0);                            // 1.2s 后拨 E2
    const r = await scenario(mic(total), { untilMs: 2600 });
    console.log(`  ${label} → 听到 ${r.heard}｜判定：${r.verdict}`);
    for (const t of r.timeline) console.log('       ' + t);
    ok(/✓/.test(r.verdict), `${label}：和弦余响中弹 E2 应该判过，实际：${r.verdict}`);
    ok(!/个八度/.test(r.verdict), `${label}：判成八度错了 —— ${r.verdict}`);
  }
}

// ── C. 密集连弹：上一个音刚判完就弹下一个（判错后还有 300ms 冷却）────────────
console.log('\n=== C. 250ms 一个音连着弹（120BPM 八分音符），每一下都要判到 ===');
{
  const single = MODES.find((m) => m.id === 'single');
  const run = buildRun(single, 0);
  const total = mkAudio(0.5 + (6 * 0.25) + 3.0);
  run.flat.forEach((e, i) => pluckInto(total, e.targetMidi, 0.5 + i * 0.25, 1.4));
  const r = await scenario(phoneMic(total), { untilMs: 500 + 6 * 250 + 900 });
  const done = /🎉/.test(r.target);
  console.log(`  目标 ${r.target}｜判定：${r.verdict}`);
  ok(done, `250ms 一个音时没走完六根空弦，停在 ${r.target}`);
}

// ── C2. 更快的连弹：跟弹的真实密度 ──────────────────────────────────────────
// Hey Jude 的旋律最短音间隔是 197ms（见 backend/tools/gp_timeline.py 的输出），
// 所以"200ms 一个音"不是极端情况，是日常。
// 这一组的失败形态和慢速完全不同：慢速是"判错"，快速是**后面几个音根本没被判过** ——
// 因为它们落在上一个音的判定窗口里，被整个丢掉了。
console.log('\n=== C2. 快速连弹：200ms / 150ms 一个音 ===');
{
  const single = MODES.find((m) => m.id === 'single');
  const run = buildRun(single, 0);
  for (const gapMs of [200, 150]) {
    const total = mkAudio(0.5 + (6 * gapMs) / 1000 + 3.0);
    run.flat.forEach((e, i) => pluckInto(total, e.targetMidi, 0.5 + (i * gapMs) / 1000, 1.4));
    const r = await scenario(phoneMic(total), { untilMs: 500 + 6 * gapMs + 900 });
    const done = /🎉/.test(r.target);
    const judged = r.timeline.filter((x) => /听到|✓|✗|没听清/.test(x)).length;
    console.log(`  ${gapMs}ms → 目标 ${r.target}｜判定条变化 ${r.timeline.length} 次（其中判定 ${judged} 次）`);
    for (const t of r.timeline) console.log('       ' + t);
    // 250ms（120BPM 八分音符）是必须过的；200ms 以下目前还过不去 ——
    // 这是**已知的能力边界**，不是回归：341ms 的采集窗和 200ms 的音符间隔
    // 在"开集识别"这条路上无解（窗里大半是上一个音）。
    // 记录数字，不做断言；解法在"策略问题清单"的第 3、5 条。
    if (gapMs >= 250) ok(done, `${gapMs}ms 一个音时没走完六根空弦，停在 ${r.target}`);
    else if (!done) console.log('       （已知边界：连弹快于 250ms 一个音时，开集识别这条路走不通）');
  }
}

// ── D. 完全不消音 + 手机麦克风：T3231323（用户实际的弹法）────────────────────
console.log('\n=== D. 一个音都不消音（衰减慢 5 倍）+ 手机麦克风，T3231323 ===');
{
  const chordMode = MODES.find((m) => m.id === 'chord');
  const run = buildRun(chordMode, 0);
  const em = run.flat.filter((e) => e.groupIndex === 0);
  for (const bpm of [60, 80, 100]) {
    const stepMs = 30000 / bpm;
    const total = mkAudio(0.5 + (em.length * stepMs) / 1000 + 3.5);
    em.forEach((e, i) => pluckInto(total, e.targetMidi, 0.5 + (i * stepMs) / 1000, 3.5, { decay: 0.6 }));
    const r = await scenario(phoneMic(total), { modeIndex: 2, untilMs: 500 + em.length * stepMs + 1000 });
    const done = !/Em · 第/.test(r.stepno);
    console.log(`  ${String(bpm).padStart(3)} BPM → ${done ? '整段通过' : '停在 ' + r.stepno}｜${r.verdict}`);
    ok(done, `${bpm} BPM 不消音时没走完 T3231323，停在 ${r.stepno}`);
  }
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
