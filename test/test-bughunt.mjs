// 挖 bug 用的测试：专挑 test-live.mjs 没覆盖到的地方。
//
// 一个功能写了但没测过，等于没写。这份专门补上：
//   A. 变调夹 —— 加了功能但从没验证过判定
//   B. 技巧模式 —— 只验过标签，没验过判定
//   C. 转换模式 —— 完全没测过
//   D. 静音 —— 没人弹的时候会不会乱动
//   E. 环境噪声 —— 噪声会不会把进度推着走
//   F. 练完的状态 —— 最后一步走完是什么样
//
// 用法： node test-bughunt.mjs

import { midiToHz, chordVoicing } from '../backend/engine/data.js';
import { MODES, buildRun } from '../frontend/js/exercises.js';

const SR = 48000;
const CAPTURE = 16384;

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('   !! ' + m); } };

// ── 合成 ─────────────────────────────────────────────────────────────────────
function pluckInto(dst, midi, startSec, durSec, amp = 0.35) {
  const f0 = midiToHz(midi);
  const from = Math.floor(startSec * SR);
  const n = Math.floor(durSec * SR);
  for (let k = 1; k <= 8; k++) {
    const f = f0 * k * (1 + 0.0002 * k * k);
    if (f > SR / 2 - 100) break;
    const a = amp / k;
    for (let i = 0; i < n; i++) {
      const j = from + i;
      if (j < 0 || j >= dst.length) continue;
      const t = i / SR;
      dst[j] += a * Math.exp(-t * (3 + k * 0.6)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
    }
  }
}

function strumInto(dst, key, startSec, amp = 0.3) {
  chordVoicing(key).forEach((x, idx) => pluckInto(dst, x.midi, startSec + idx * 0.022, 1.2, amp));
}

function audioOf(events, secs = 5) {
  const real = events.filter(Boolean);
  const last = real.reduce((a, e) => Math.max(a, e.at), 0);
  const total = new Float32Array(Math.ceil(Math.max(secs, last + 2.5) * SR));
  for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
  for (const e of real) {
    if (e.chord) strumInto(total, e.chord, e.at);
    else pluckInto(total, e.midi, e.at, 1.0);
  }
  return total;
}

// ── DOM / 麦克风 桩 ──────────────────────────────────────────────────────────
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

// ── 环境（只搭一次）─────────────────────────────────────────────────────────
// 拆模块之后状态住在 state.js 里，?case=X 只能让入口重新加载，state.js 是共享的。
// 所以这里只 import 一次，场景之间靠 resetApp() 复位。
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
      enumerateDevices: async () => ([{ kind: 'audioinput', label: '假麦克风' }]),
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
const fire = (id, type) => {
  const el = $(id);
  (el.listeners[type] || []).forEach((f) => f({ target: el }));
};

async function scenario(tag, audio, opts = {}) {
  AUDIO = audio;
  clock = 0;
  pending = null;
  resetApp();
  // 变调夹属于"用户设置"，resetApp 按设计不清它（真实使用中换过变调夹，
  // 复位进度不该把它清掉）。所以测试自己要记得归零，否则会漏到下一个场景。
  $('s-capo').value = '0';
  fire('s-capo', 'input');
  await $('btnStart').onclick();
  if (opts.modeIndex) $('modes').children[opts.modeIndex].onclick();
  if (opts.setup) opts.setup($, fire);

  const until = opts.untilMs || 1800;
  while (clock < until) {
    clock += 16;
    const cb = pending; pending = null;
    if (cb) cb(clock);
  }
  return {
    $, fire,
    target: $('target').textContent,
    stepno: $('stepno').textContent,
    verdict: $('verdict').textContent,
    heard: $('heardval').textContent,
  };
}

const modeIndex = (id) => MODES.findIndex((m) => m.id === id);

// ── A. 变调夹 ────────────────────────────────────────────────────────────────
console.log('\n=== A. 变调夹 ===');
console.log('  单音第一关目标是六弦空弦 E2(82.4Hz)。夹 2 品之后实际该响的是 F#2(92.5Hz)。');
{
  // 夹 2 品，弹没夹之前的音高（E2）—— 应该判错
  const r1 = await scenario('capo-wrong', audioOf([{ midi: 40, at: 0.4 }]), {
    setup: ($, fire) => { $('s-capo').value = '2'; fire('s-capo', 'input'); },
    untilMs: 1500,
  });
  console.log('  夹 2 品却弹 E2   → 目标显示 ' + r1.target + '｜' + r1.verdict);
  ok(/F#2/.test(r1.target), '夹 2 品后目标应该显示 F#2，实际 ' + r1.target);
  ok(!/✓/.test(r1.verdict), '夹 2 品时弹没夹的音高不该判过');

  // 夹 2 品，弹 F#2 —— 应该判过
  const r2 = await scenario('capo-ok', audioOf([{ midi: 42, at: 0.4 }]), {
    setup: ($, fire) => { $('s-capo').value = '2'; fire('s-capo', 'input'); },
    untilMs: 1500,
  });
  console.log('  夹 2 品弹 F#2   → 目标显示 ' + r2.target + '｜' + r2.verdict);
  ok(/✓/.test(r2.verdict), '夹 2 品时弹 F#2 应该判过，实际 ' + r2.verdict);
}

// ── B. 技巧模式的判定 ───────────────────────────────────────────────────────
console.log('\n=== B. 技巧模式（只验过标签，没验过判定）===');
{
  const r = await scenario('tech-judge', audioOf([{ midi: 50, at: 0.4 }]), {
    modeIndex: modeIndex('tech'), untilMs: 2000,
  });
  console.log('  滑音落点 D3 → ' + r.target + '｜' + r.verdict);
  // 2026-09-20 改：滑音改成判**过程**了，所以"只弹落点"必须不给过 ——
  // 这正是原来漏掉的那个 bug（只弹尾音也给过）。真滑过去的用例在 test-live 第 5 组。
  ok(!/✓/.test(r.verdict) && /滑/.test(r.verdict),
    '只弹落点不该给过（滑音要判过程），实际 ' + r.verdict);

  // 击弦（第二关，目标 F3=53）
  const r2 = await scenario('tech-hammer', audioOf([{ midi: 50, at: 0.4 }, { midi: 53, at: 1.2 }]), {
    modeIndex: modeIndex('tech'), untilMs: 2200,
  });
  console.log('  第二关击弦落点 F3 → ' + r2.target + '｜' + r2.verdict);
  ok(/✓/.test(r2.verdict), '击弦落点 F3 应该判过，实际 ' + r2.verdict);
}

// ── C. 转换模式 ──────────────────────────────────────────────────────────────
console.log('\n=== C. 转换模式（完全没测过）===');
{
  const r = await scenario('change', audioOf([{ chord: 'C', at: 0.4 }]), {
    modeIndex: modeIndex('change'), untilMs: 2200,
  });
  console.log('  第一关 C → 目标 ' + r.target + '｜' + r.verdict);
  ok(r.target === 'G' || r.target === 'C', '转换模式第一个目标应该是 C，实际 ' + r.target);
  ok(/✓/.test(r.verdict), '扫对 C 应该判过，实际 ' + r.verdict);
}

// ── D. 静音 ──────────────────────────────────────────────────────────────────
console.log('\n=== D. 全程静音（没人弹）===');
{
  const r = await scenario('silence', audioOf([null], 4));
  console.log('  4 秒静音 → ' + r.stepno + '｜' + r.verdict);
  // 单音模式的进度显示是音名本身，所以用"目标还是不是第一关"来判断有没有推进
  ok(r.target === 'E2', '静音不该推进进度，实际目标已经变成 ' + r.target);
  ok(!/✓/.test(r.verdict), '静音不该出现"判过"');
}

// ── E. 环境噪声 ──────────────────────────────────────────────────────────────
console.log('\n=== E. 只有环境噪声（没有琴声）===');
{
  const secs = 4;
  const noise = new Float32Array(secs * SR);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.02;
  const r = await scenario('noise', noise, { untilMs: secs * 1000 });
  console.log(`  只有噪声（幅度 0.02）→ ${r.stepno}｜${r.verdict}`);
  ok(r.target === 'E2', '纯噪声不该推进进度，实际目标已经变成 ' + r.target);
  ok(!/没听清/.test(r.verdict), '纯噪声不该触发判定（会出现莫名其妙的"没听清"）');
}

// ── F. 练完的状态 ────────────────────────────────────────────────────────────
console.log('\n=== F. 六根空弦全弹完 ===');
{
  const run = buildRun(MODES.find((m) => m.id === 'single'), 0);
  const evs = run.flat.map((e, i) => ({ midi: e.targetMidi, at: 0.4 + i * 0.6 }));
  const r = await scenario('finish', audioOf(evs, 6), { untilMs: 400 + 6 * 600 + 800 });
  console.log('  目标 = ' + r.target + '｜' + r.verdict);
  ok(/🎉/.test(r.target), '六关走完应该显示 🎉，实际 ' + r.target);
}

// ── G. 音色无关性：同一段琶音，几种完全不同的音色都要过 ────────────────────
// 这是实测卡住一弦空弦 E4 的原因：
// 钢弦有刚性，第 k 次谐波实际是 k·f0·√(1+B·k²)，比整数倍略高一点点。
// 音色越亮（高次谐波越强）YIN 越会被这些偏高的谐波带着走，读数偏高。
// 实测 B=0.0006 时 E4 偏高 37 音分，B=0.001 时偏高 46 音分——
// 正好卡在 50 音分那条线上，一取整就变成 F4，判定成"高了 1 个半音"，永远过不去。
console.log('\n=== G. 音色无关性：同一段 T3231323，换几种完全不同的音色 ===');
console.log('  这一组是"不预设音色"的验收标准。用户手上的琴千差万别，');
console.log('  判定只能依赖"谐波出现在整数倍位置上"这件物理事实，不能依赖某种音色。');
{
  const chordMode = MODES.find((m) => m.id === 'chord');
  const em = buildRun(chordMode, 0).flat.filter((e) => e.groupIndex === 0);

  // B: 琴弦刚性系数。fund: 基频相对幅度（1 = 正常，0.1 = 基频极弱，手机麦克风常见）。
  // bright: 高次谐波权重（true = 亮音色，一弦那种）。
  const TIMBRES = [
    { name: '理想弦      ', B: 0,      fund: 1.0, bright: false },
    { name: '亮音色      ', B: 0.0005, fund: 1.0, bright: true },
    { name: '基频极弱    ', B: 0.0003, fund: 0.10, bright: true },
    { name: '强非谐性    ', B: 0.0015, fund: 1.0, bright: true },
    { name: '闷音色      ', B: 0.0008, fund: 1.0, bright: false },
  ];

  const pluckTimbre = (dst, midi, at, T, amp = 0.35) => {
    const f0 = midiToHz(midi);
    const from = Math.floor(at * SR);
    const n = Math.floor(1.5 * SR);
    for (let k = 1; k <= 14; k++) {
      const f = f0 * k * Math.sqrt(1 + T.B * k * k);
      if (f > SR / 2 - 100) break;
      const a = k === 1 ? amp * T.fund : amp / Math.sqrt(k) * (T.bright ? 1.6 : 0.7);
      for (let i = 0; i < n; i++) {
        const j = from + i;
        if (j < 0 || j >= dst.length) continue;
        const t = i / SR;
        dst[j] += a * Math.exp(-t * (3 + k * 0.35)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
      }
    }
  };

  for (const T of TIMBRES) {
    const stepMs = 30000 / 80;   // 80BPM 八分音符
    const total = new Float32Array(Math.ceil((0.5 + (em.length * stepMs) / 1000 + 2.5) * SR));
    for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
    em.forEach((e, i) => pluckTimbre(total, e.targetMidi, 0.5 + (i * stepMs) / 1000, T));
    const r = await scenario('timbre' + T.name.trim(), total, {
      modeIndex: modeIndex('chord'), untilMs: 500 + em.length * stepMs + 900,
    });
    const done = !/Em · 第/.test(r.stepno);
    console.log(`  ${T.name} → ${done ? '整段通过' : '停在 ' + r.stepno}｜${r.verdict}`);
    ok(done, `音色"${T.name}"下没走完 Em 这一段，停在 ${r.stepno}`);
  }
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
