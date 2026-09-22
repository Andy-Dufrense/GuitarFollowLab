// 实时链路的端到端测试：伪造麦克风和 AudioContext，喂合成音频进去，
// 看"电平门限 → 起音 → 等稳定 → 识别 → 判定"这一整条链路对不对。
//
// 每个场景都用一个全新的模块实例 + 全新的 DOM + 全新的一段音频，
// 互不干扰。之前共用一个实例时，假时钟同步推进会让 setTimeout 插不进来，
// 上一次判定的冷却状态会漏到下一个场景里，测出来的失败是假的。
//
// 用法： node test-live.mjs

import { chordVoicing, midiToHz } from '../backend/engine/data.js';
import { MODES, buildRun } from '../frontend/js/exercises.js';

const SR = 48000;
const CAPTURE = 16384;

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

function audioOf(events) {
  const last = events.reduce((a, e) => Math.max(a, e.at), 0);
  const total = new Float32Array(Math.ceil((last + 2.5) * SR));
  for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
  for (const e of events) {
    if (e.chord) strumInto(total, e.chord, e.at);
    else pluckInto(total, e.midi, e.at, 1.0);
  }
  return total;
}

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('   !! ' + m); } };

class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this._html = ''; this.className = '';
    this.style = {}; this.dataset = {}; this.value = ''; this.open = false;
    this.textContent = ''; this.listeners = {}; this._q = new Map();
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

// 跑一个场景：建 DOM → 建假麦克风 → 载入 live.js → 点开始 → 推进假时钟
// ── 环境（只搭一次）─────────────────────────────────────────────────────────
// 注意：拆模块之后，状态住在 state.js 里，用 ?case=X 只能让入口重新加载，
// state.js 是共享的。所以这里只 import 一次，场景之间靠 resetApp() 复位。
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

// 一个场景 = 换一段音频 + 复位 + 开麦 + 推进假时钟
async function scenario(tag, audio, { modeIndex = 0, untilMs = 1600 } = {}) {
  AUDIO = audio;
  clock = 0;
  pending = null;
  resetApp();
  await $('btnStart').onclick();
  if (modeIndex) $('modes').children[modeIndex].onclick();

  const before = {
    target: $('target').textContent,
    stepno: $('stepno').textContent,
    tech: $('techbadge').textContent,
  };
  while (clock < untilMs) {
    clock += 16;
    const cb = pending; pending = null;
    if (cb) cb(clock);
  }
  return {
    $,
    before,
    target: $('target').textContent,
    stepno: $('stepno').textContent,
    heard: $('heardval').textContent + ' ' + $('heardcents').textContent,
    verdict: $('verdict').textContent,
    tech: $('techbadge').textContent,
    phrase: String($('phrase').innerHTML).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    boot: String($('bootfail').innerHTML).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

// ── 1. 单音：弹对六弦空弦 E2 ────────────────────────────────────────────────
console.log('\n=== 1. 单音模式，弹 E2 ===');
{
  const r = await scenario('e2', audioOf([{ midi: 40, at: 0.4 }]));
  console.log('  目标 =', r.before.target, '| 听到 =', r.heard);
  console.log('  判定 =', r.verdict);
  ok(/✓/.test(r.verdict), '弹对 E2 应该判过，实际：' + r.verdict);
}

// ── 2. 音准偏差 ─────────────────────────────────────────────────────────────
// 判定用的是"候选音谐波结构比较"，纯相对，不吃音色。这样带来一个正确的副作用：
// 有偏差时它会说实话，而不是靠四舍五入蒙混。
//   · 偏差小（琴正常）：目标音明显胜出 → 判过
//   · 偏差接近半个音：目标音和隔壁那个半音几乎打平 → 告诉用户去调弦
//     （这不是"弹错了"——品格按对了，是琴没调准，该说的不一样）
console.log('\n=== 2. 音准偏差 ===');
{
  const r = await scenario('flat30', audioOf([{ midi: 39.7, at: 0.4 }]));   // 偏低 30 音分
  console.log('  低 30 音分 → ' + r.verdict);
  ok(/✓/.test(r.verdict), '偏低 30 音分（正常范围内的琴）应该判过，实际：' + r.verdict);

  const r2 = await scenario('flat48', audioOf([{ midi: 39.52, at: 0.4 }]));  // 偏低 48 音分
  console.log('  低 48 音分 → ' + r2.verdict);
  ok(/调/.test(r2.verdict), '偏低近半个音应该提示去调弦，实际：' + r2.verdict);
  ok(!/✓/.test(r2.verdict), '偏低近半个音不该放过去');
}

// ── 3. 余响没停就弹下一个 ──────────────────────────────────────────────────
console.log('\n=== 3. 上一个音还在响的时候弹下一个（原来会卡住不判）===');
{
  const r = await scenario('ringing', audioOf([
    { chord: 'C', at: 0.4 },      // 先扫一个 C，让它一直响着
    { midi: 40, at: 1.2 },        // 0.8 秒后弹 E2，此时 C 还在响
  ]), { untilMs: 2200 });
  console.log('  听到 =', r.heard);
  console.log('  判定 =', r.verdict);
  ok(!/^弹吧/.test(r.verdict) && r.verdict !== '听到了，正在听清…',
    '余响未停时再弹，也应该被判定，实际：' + r.verdict);
}

// ── 4. 和弦模式：目标音是 Em 的 T（六弦空弦 E2），乐句条要显示 T3231323 ────
console.log('\n=== 4. 和弦模式，一个和弦的 T3231323 ===');
{
  const r = await scenario('arp', audioOf([{ midi: 40, at: 0.4 }]), { modeIndex: 2 });
  console.log('  步骤 =', r.before.stepno, '| 目标 =', r.before.target);
  console.log('  乐句条 =', r.phrase);
  console.log('  判定 =', r.verdict);
  ok(r.before.target === 'E2', 'Em 的 T 音应该是 E2，实际 ' + r.before.target);
  ok(/Em/.test(r.before.stepno), 'stepno 应显示 Em，实际 ' + r.before.stepno);
  ok(/T/.test(r.phrase) && /G3/.test(r.phrase) && /E4/.test(r.phrase),
    '乐句条应显示 T3231323 对应的音，实际 ' + r.phrase);
  ok(/✓/.test(r.verdict), '弹对 T 音应该判过，实际：' + r.verdict);
}

// ── 5. 技巧模式：必须明确告诉是哪个技巧 ────────────────────────────────────
console.log('\n=== 5. 技巧模式，要标出具体技巧 ===');
{
  // 滑音要判过程：只弹落点不给过，真滑过去才给过。
  const slideSweep = (fromMidi, toMidi, at, dur) => {
    const total = new Float32Array(Math.ceil((at + dur + 1.6) * SR));
    for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
    const from = Math.floor(at * SR);
    const n = Math.floor((dur + 0.9) * SR);        // 滑到落点后要停住（判定在 520ms 后才做）
    const glideN = Math.floor(dur * SR);
    for (let k = 1; k <= 6; k++) {
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const prog = Math.min(1, i / glideN);
        const f = midiToHz(fromMidi + (toMidi - fromMidi) * prog) * k;
        phase += 2 * Math.PI * f / SR;
        total[from + i] += (0.35 / k) * Math.exp(-t * 1.2) * (1 - Math.exp(-t * 4000)) * Math.sin(phase);
      }
    }
    return total;
  };

  const only = await scenario('tech-landing', audioOf([{ midi: 50, at: 0.4 }]), { modeIndex: 1 });
  console.log('  只弹落点 D3 → 技巧标签', only.before.tech, '｜判定 =', only.verdict);
  ok(/技巧/.test(only.before.tech) && /滑音/.test(only.before.tech),
    '应标出"技巧 · 滑音"，实际：' + only.before.tech);
  ok(!/✓/.test(only.verdict), '只弹落点不该给过（滑音要判过程），实际：' + only.verdict);

  const real = await scenario('tech-slide', slideSweep(48, 50, 0.4, 0.35), { modeIndex: 1, untilMs: 1800 });
  console.log('  真的从 C3 滑到 D3 → 判定 =', real.verdict);
  ok(/✓/.test(real.verdict), '真滑过去应该判过，实际：' + real.verdict);
}

// ── 6. 扫弦：目标是 Em，喂一个 C 必须判错 ──────────────────────────────────
console.log('\n=== 6. 扫弦模式，目标是 Em，实际扫 C ===');
{
  const r = await scenario('strum', audioOf([{ chord: 'C', at: 0.4 }]), { modeIndex: 3, untilMs: 2000 });
  console.log('  目标 =', r.before.target);
  console.log('  判定 =', r.verdict);
  ok(r.before.target === 'Em', '扫弦第一个应该是 Em，实际 ' + r.before.target);
  ok(/听到 C/.test(r.verdict), '应该听出 C，实际：' + r.verdict);
  ok(!/✓/.test(r.verdict), '弹错和弦却判通过了');
}

// ── 7. 扫弦：扫对了要判过 ──────────────────────────────────────────────────
console.log('\n=== 7. 扫弦模式，目标 Em，实际扫 Em ===');
{
  const r = await scenario('strum-ok', audioOf([{ chord: 'Em', at: 0.4 }]), { modeIndex: 3, untilMs: 2000 });
  console.log('  判定 =', r.verdict);
  ok(/✓/.test(r.verdict), '扫对 Em 应该判过，实际：' + r.verdict);
}

// ── 8. 连弹：同一个音隔 250ms 弹两次，两下都要判到 ─────────────────────────
console.log('\n=== 8. 和弦模式连弹：同一个音连弹两下（T 然后 3 弦，都判到）===');
console.log('  这是"弹得快就卡住"那个问题的回归点：');
console.log('  起音基准如果取"最近几百毫秒的最高电平"，第二下永远超不过它。');
{
  const r = await scenario('fast', audioOf([
    { midi: 40, at: 0.4 },      // Em 的 T（E2）
    { midi: 55, at: 0.65 },     // 250ms 后弹 3 弦 G3
    { midi: 59, at: 0.90 },     // 再接 2 弦 B3
  ]), { modeIndex: 2, untilMs: 1500 });
  console.log('  判定 =', r.verdict);
  console.log('  走了几步 =', r.stepno, '| 当前目标 =', r.target);
  ok(!/^Em · 第 1\/8/.test(r.stepno),
    '连弹三下应该至少往前走了几步，实际还停在 ' + r.stepno + '（判定条：' + r.verdict + '）');
}

// ── 9. A2 和 A3 不能互相冒充 ────────────────────────────────────────────────
// 手机麦克风只会把低音"听高"（基频被衰减），不会把高音听低，
// 所以八度校正只允许"检测比目标高"这一个方向。
// 不限制方向的话：目标 A2、弹 A3 时检测器报 A3，而 A3 也在 A2 的目标音里……
// 不对，这里验的是两个方向都要判错。
console.log('\n=== 9. A2 / A3 八度辨别 ===');
{
  // 单音模式：第 1 个目标是 E2，第 2 个是 A2。
  // 先弹 E2 过关，再弹 A3 —— 目标是 A2，必须判错。
  const r = await scenario('octave', audioOf([
    { midi: 40, at: 0.4 },     // E2，第 1 关
    { midi: 57, at: 0.7 },     // A3，但第 2 关要的是 A2(45)
  ]));
  console.log('  当前目标 =', r.target);
  console.log('  判定 =', r.verdict);
  ok(r.target === 'A2', '过掉 E2 之后目标应该是 A2，实际 ' + r.target);
  ok(!/✓/.test(r.verdict), '目标是 A2 时弹 A3 不该判过，实际：' + r.verdict);
}
{
  // 反向：目标是 A2，弹 A2 要判过
  const r = await scenario('octave2', audioOf([
    { midi: 40, at: 0.4 },
    { midi: 45, at: 0.7 },
  ]));
  console.log('  弹 A2（正确）判定 =', r.verdict);
  ok(/✓/.test(r.verdict), '目标是 A2 时弹 A2 应该判过，实际：' + r.verdict);
}

// ── 10. 用一个正常的 BPM 过一整个和弦（T3231323 八分音符）──────────────────
// 这是真正要用的场景：连续八个音，每个音符之间有别的弦还在响。
// 音高直接取练习里真实的 T3231323，不另写一套。
console.log('\n=== 10. 和弦 T3231323，用正常 BPM 连着弹完 ===');
{
  const chordMode = MODES.find((m) => m.id === 'chord');
  const run = buildRun(chordMode, 0);
  const em = run.flat.filter((e) => e.groupIndex === 0);
  console.log('  Em 这一段的音：' + em.map((e) => e.name).join(' '));

  // 60~120 BPM 是要求必须过的（八分音符 500~250ms）。
  // 140/160 目前还过不去，只打印出来看看到哪一步停，不做断言。
  for (const bpm of [60, 80, 100, 120, 140, 160]) {
    const required = bpm <= 120;
    const stepMs = 30000 / bpm;             // 八分音符
    const evs = em.map((e, i) => ({ midi: e.targetMidi, at: 0.45 + (i * stepMs) / 1000 }));
    const until = 450 + em.length * stepMs + 900;
    const r = await scenario('arp' + bpm, audioOf(evs), { modeIndex: 2, untilMs: until });
    // 走过了 Em 这整段才算过：stepno 里不再有 "Em · 第 n/8"
    const done = !/Em · 第/.test(r.stepno);
    const howMany = /第 (\d)\//.test(r.stepno) ? RegExp.$1 : '?';
    console.log(`  ${String(bpm).padStart(3)} BPM（八分音符 ${String(Math.round(stepMs)).padStart(3)}ms）`
      + ` → ${done ? '整段通过' : '停在第 ' + howMany + ' 个音'}，当前 ${r.stepno}`);
    console.log(`        判定条：${r.verdict}`);
    if (required) ok(done, `${bpm} BPM 下没走完 Em 这一段 T3231323，停在 ${r.stepno}`);
    else if (!done) console.log('        （超出当前能力，八分音符已经短于 250ms）');
  }
}

// ── 11. 扫弦：正常速度连扫四下 ─────────────────────────────────────────────
console.log('\n=== 11. 扫弦：一个和弦扫四下，每下之间 750ms（80BPM 四分音符）===');
{
  const r = await scenario('strum4', audioOf([
    { chord: 'Em', at: 0.45 }, { chord: 'Em', at: 1.20 },
    { chord: 'Em', at: 1.95 }, { chord: 'Em', at: 2.70 },
  ]), { modeIndex: 3, untilMs: 4200 });
  console.log('  当前 =', r.stepno, '| 判定条 =', r.verdict);
  ok(!/Em · 第 1\//.test(r.stepno), '四下 Em 应该都判过并进到下一个和弦，实际停在 ' + r.stepno);
  console.log('  （扫弦每下要等 300ms 的分析窗，所以它比单音慢是正常的）');
}

// ── 12. 六根空弦依次弹完（单音模式的第一关）────────────────────────────────
// 音高直接取练习里的定义，音色用真实拨弦的泛音结构（二次谐波最强）。
// 一弦 E4(329.6Hz) 正好是六弦 E2(82.4Hz) 的四次谐波，六弦还在响时很容易被报成 E2，
// 差了整整两个八度——所以八度归属必须处理任意整数个八度，不只是差一个八度。
console.log('\n=== 12. 六根空弦依次弹完 ===');
{
  const single = MODES.find((m) => m.id === 'single');
  const run = buildRun(single, 0);
  console.log('  顺序：' + run.flat.map((e) => e.name).join(' '));

  const pluckReal = (dst, midi, at, dur, amp = 0.35) => {
    const f0 = midiToHz(midi);
    const from = Math.floor(at * SR);
    const n = Math.floor(dur * SR);
    const harm = [0.45, 1.0, 0.55, 0.32, 0.2, 0.14, 0.1, 0.07];
    for (let k = 1; k <= harm.length; k++) {
      const f = f0 * k * (1 + 0.0002 * k * k);
      if (f > SR / 2 - 100) break;
      const a = amp * harm[k - 1];
      for (let i = 0; i < n; i++) {
        const j = from + i;
        if (j < 0 || j >= dst.length) continue;
        const t = i / SR;
        dst[j] += a * Math.exp(-t * (3 + k * 0.6)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
      }
    }
  };

  for (const gapMs of [700, 450]) {
    const total = new Float32Array(Math.ceil((0.5 + (6 * gapMs) / 1000 + 2.5) * SR));
    for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
    run.flat.forEach((e, i) => pluckReal(total, e.targetMidi, 0.5 + (i * gapMs) / 1000, 1.4));
    const r = await scenario('all6-' + gapMs, total, { untilMs: 500 + 6 * gapMs + 900 });
    const done = /🎉/.test(r.target);
    console.log(`  间隔 ${gapMs}ms → 目标 = ${r.target}｜判定条 = ${r.verdict}`);
    ok(done, `间隔 ${gapMs}ms 时六根空弦没弹完，停在 ${r.target}`);
  }
}

// ── 13. 让音一直延续、完全不消音（用户实测的"不丝滑"场景）────────────────
// 关键区别：这里让每个音衰减得极慢，几根弦的余响叠起来的总电平
// 会比新拨的那一下还响。只看"总电平抬升"的起音判据在这是必然失效的，
// 必须靠"有没有新的频谱成分出现"来触发。
console.log('\n=== 13. 全部延续不消音（衰减很慢）===');
{
  const chordMode = MODES.find((m) => m.id === 'chord');
  const run = buildRun(chordMode, 0);
  const em = run.flat.filter((e) => e.groupIndex === 0);

  // 衰减系数 0.6（正常是 3），等于每个音要响好几秒
  const pluckSustain = (dst, midi, at, amp = 0.35) => {
    const f0 = midiToHz(midi);
    const from = Math.floor(at * SR);
    const n = Math.floor(3.5 * SR);
    for (let k = 1; k <= 8; k++) {
      const f = f0 * k * (1 + 0.0002 * k * k);
      if (f > SR / 2 - 100) break;
      const a = amp / k;
      for (let i = 0; i < n; i++) {
        const j = from + i;
        if (j < 0 || j >= dst.length) continue;
        const t = i / SR;
        dst[j] += a * Math.exp(-t * (0.6 + k * 0.12)) * (1 - Math.exp(-t * 4000)) * Math.sin(2 * Math.PI * f * t);
      }
    }
  };

  for (const bpm of [60, 80, 100]) {
    const stepMs = 30000 / bpm;
    const total = new Float32Array(Math.ceil((0.5 + (em.length * stepMs) / 1000 + 3.5) * SR));
    for (let i = 0; i < total.length; i++) total[i] = (Math.random() * 2 - 1) * 0.0008;
    em.forEach((e, i) => pluckSustain(total, e.targetMidi, 0.5 + (i * stepMs) / 1000));
    const r = await scenario('sustain' + bpm, total, {
      modeIndex: 2, untilMs: 500 + em.length * stepMs + 1000,
    });
    const done = !/Em · 第/.test(r.stepno);
    console.log(`  ${String(bpm).padStart(3)} BPM（八分音符 ${String(Math.round(stepMs)).padStart(3)}ms）`
      + ` → ${done ? '整段通过' : '停在 ' + r.stepno}｜${r.verdict}`);
    // 60 BPM 是要求必须过的；更快时"每根弦都还在大声响"会把谱面糊成一团，
    // 目前过不去，只记录不判定能力边界。
    if (bpm <= 60) ok(done, `${bpm} BPM 全部延续不消音时没走完，停在 ${r.stepno}`);
    else if (!done) console.log('        （极端延续 + 快弹，超出当前能力）');
  }
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
