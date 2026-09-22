// 用真机录音跑**产品页**的跟弹逻辑（不开浏览器）。
//
// 做法：DOM 桩 + 假麦克风（把 .f32 录音按帧喂进去），点「跟弹」，
// 推进假时钟走完整段录音，最后看判定统计和逐音结果。
//
// 用法： node test/test-follow-real.mjs sound_data/f32/hey_jude.f32

import fs from 'node:fs';

const SR = 48000, CAPTURE = 16384;
const file = process.argv[2];
if (!file) { console.error('用法：node test/test-follow-real.mjs <xxx.f32>'); process.exit(2); }
const raw = fs.readFileSync(file);
const AUDIO = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const pr = Number(process.env.VC_PASS_RATIO || 0);
if (pr) globalThis.__passRatio = pr;
// 判定用哪一份谱：差分谱（默认）还是老的起音快照。A/B 对照用。
if (process.env.VC_JUDGE_DIFF != null) globalThis.__judgeDiff = Number(process.env.VC_JUDGE_DIFF);
console.log(`音频 ${file}：${(AUDIO.length / SR).toFixed(1)}s`);

let clock = 0;
let pending = null;
class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this._html = ''; this.className = '';
    this.style = {}; this.dataset = {}; this.value = ''; this.open = false; this.checked = false;
    this.textContent = ''; this.listeners = {}; this.onclick = null;
    this.clientWidth = 390; this.clientHeight = 300;
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}
const reg = new Map();
globalThis.document = {
  getElementById(id) { if (!reg.has(id)) reg.set(id, new El()); return reg.get(id); },
  createElement: (t) => new El(t), querySelector: () => new El(), querySelectorAll: () => [],
};
globalThis.window = globalThis;
globalThis.innerWidth = 390;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.location = { search: '', protocol: 'https:', origin: 'https://localhost:1210' };
globalThis.isSecureContext = true;
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = (cb) => { pending = cb; return 1; };
globalThis.cancelAnimationFrame = () => { pending = null; };
// 用真的谱面时间轴；VC_SHIFT 用来整体平移（检验"是不是差一个音"的假设）
const SHIFT = Number(process.env.VC_SHIFT || 0);
const ALL_NOTES = JSON.parse(fs.readFileSync('frontend/data/hey_jude.json', 'utf8')).notes.slice(0, 60);
// VC_TIMELINE=<path>：用自定义的音符表跑（离线复现"某几个音"的场景用，比如 1弦1品 F4 连弹）
const TIMELINE = process.env.VC_TIMELINE
  ? JSON.parse(fs.readFileSync(process.env.VC_TIMELINE, 'utf8')) : null;
globalThis.fetch = async (u) => {
  const isChord = String(u).includes('chord');
  const payload = isChord
    ? JSON.parse(fs.readFileSync('frontend/data/chord_practice.json', 'utf8'))
    : {
      meta: TIMELINE ? TIMELINE.meta : { title: 'Hey Jude', tempo: 76 },
      notes: TIMELINE ? TIMELINE.notes : ALL_NOTES.slice(SHIFT, SHIFT + 55),
    };
  return { ok: true, status: 200, json: async () => payload, blob: async () => ({ size: 1 }) };
};

// 假麦克风：每帧把"最近 16384 个采样"喂给分析
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
    userAgent: 'real-audio-test',
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      enumerateDevices: async () => ([{ kind: 'audioinput', label: '录音文件' }]),
    },
    permissions: { query: async () => ({ state: 'granted' }) },
  },
});
globalThis.AudioContext = class {
  constructor() { this.sampleRate = SR; this.currentTime = 0; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() { return analyser; }
  get destination() { return {}; }
  createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  createBiquadFilter() { return { frequency: {}, connect() {} }; }
};

// 记录型 alphaTab 桩（真 alphaTab 不允许在 Node 里构造 API）
function evt() { const fns = []; return { on: (f) => fns.push(f), fire: (...a) => fns.forEach((f) => f(...a)) }; }
function FakeApi() {
  this.settings = { display: {} }; this.playerState = 0; this.isLooping = false;
  this.tickPosition = 0; this.timePosition = 0;
  for (const k of ['error', 'scoreLoaded', 'playerStateChanged', 'playerPositionChanged',
    'soundFontLoaded', 'renderFinished', 'playerReady']) this[k] = evt();
  this.playPause = () => {}; this.changeTrackMute = () => {}; this.changeTrackVolume = () => {}; this.render = () => {};
  this.score = null;
}
globalThis.alphaTab = { AlphaTabApi: FakeApi, version: 'stub' };

await import('../frontend/js/follow-score.js');
if (process.env.VC_DEBUG) globalThis.__vcDebug = true;
if (process.env.VC_ONSET_DEBUG) globalThis.__vcOnsetDebug = true;
globalThis.__vcNotes = [];
globalThis.__onsetLog = [];
globalThis.__vcSession = [];
const $ = (id) => reg.get(id) || document.getElementById(id);

console.log('\n=== 点「跟弹」，用真实录音跑完整段 ===');
// VC_MODE=tempo：按"跟节拍"模式跑（默认是"等我弹"）
if (process.env.VC_MODE) document.getElementById('mode').value = process.env.VC_MODE;
await $('mic').onclick();                       // 取麦 + 四拍 + 开始
const totalMs = Math.ceil((AUDIO.length / SR) * 1000);
let frames = 0;
while (clock < totalMs) {
  clock += 16;
  const cb = pending; pending = null;
  if (cb) { cb(clock); frames++; }
}

console.log(`\n跑了 ${frames} 帧（${(totalMs / 1000).toFixed(1)}s 音频）`);
console.log(`对 ${$('good').textContent} 个 ｜ 错 ${$('bad').textContent} 个`
  + ` ｜ 漏 ${$('missed') ? $('missed').textContent : '?'} 个`
  + ` ｜ 测不准 ${$('unclear') ? $('unclear').textContent : '?'} 个`);
console.log(`错音清单：${$('wrongs').textContent || '（无）'}`);
console.log(`判定行：${$('verdict').textContent}`);
console.log(`下一个提示：${$('next').innerHTML}`);
console.log(`检出起音 ${globalThis.__onsetLog.length} 次：`
  + globalThis.__onsetLog.slice(0, 8).join('、') + ' …'
  + globalThis.__onsetLog.slice(-4).join('、'));
// VC_JSON=1：多打一行机器可读的结果，给 test/grade.mjs 批量评分用
if (process.env.VC_JSON) {
  console.log('RESULT ' + JSON.stringify({
    file,
    onsets: globalThis.__onsetLog.length,
    good: Number($('good').textContent) || 0,
    bad: Number($('bad').textContent) || 0,
    unclear: Number($('unclear') ? $('unclear').textContent : 0) || 0,
    missed: Number($('missed') ? $('missed').textContent : 0) || 0,
    wrongs: $('wrongs').textContent || '',
    log: (globalThis.__vcSessionLog && globalThis.__vcSessionLog()) || [],
    onsets2: (globalThis.__vcOnsetLog && globalThis.__vcOnsetLog()) || [],
  }));
}
// 把起音时刻和"起音→谱面第几个音"的对应写成 JSON，给 probe-accuracy.mjs 当输入
if (process.env.VC_ONSET_OUT) {
  fs.writeFileSync(process.env.VC_ONSET_OUT, JSON.stringify({
    audio: file, onsets: globalThis.__onsetLog, notes: ALL_NOTES.slice(SHIFT, SHIFT + 55),
  }, null, 1));
  console.log(`起音表已写到 ${process.env.VC_ONSET_OUT}`);
}

// VC_DUMP=1：把逐音记录整条打出来（判定证据：期望音/实测频率/邻音/是否贴边界）
if (process.env.VC_DUMP) {
  const log = (globalThis.__vcSessionLog && globalThis.__vcSessionLog()) || [];
  console.log('\n逐音记录（导出记录里的原文）：');
  for (const n of log) {
    console.log('  ' + [
      `#${String(n.no).padStart(3)}`,
      `t=${n.t}s`,
      `期望${n.expName}(${n.exp})${n.str != null ? ` ${n.str}弦${n.fret}品` : ''}`,
      n.prev != null ? `上一音${n.prev}${n.prevStr != null ? `(${n.prevStr}弦${n.prevFret}品)` : ''}` : '上一音—',
      `实测${n.f0}Hz`,
      `偏差${n.cents > 0 ? '+' : ''}${n.cents}c`,
      `校正${n.tuning}c`,
      `邻音${n.rival != null ? n.rival : '—'}`,
      `比${n.ratio}`,
      `clarity${n.clarity}`,
      `电平${n.level}`,
      n.atEdge ? '贴边界' : '',
      `复核${n.conf == null ? '—' : (n.conf > 0 ? '+' : '') + n.conf + 'c'}${n.confirmed ? '(靠它判过)' : ''}`,
      `→ ${n.result}`,
    ].filter(Boolean).join(' '));
  }
}

// 对不齐的定量检查：把"实测频率 → 最近的 MIDI 音"和"期望音"比，
// 看整体错开几个音时最吻合。若某个非零位移明显更好，说明是**对不上号**，不是判据问题。
{
  const log = (globalThis.__vcSession || []).filter((x) => x.f0);
  if (log.length) {
    const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
    const best = [];
    for (let shift = -3; shift <= 3; shift++) {
      let sum = 0, n = 0;
      for (let i = 0; i < log.length; i++) {
        const exp = log[i].exp + shift;
        const m = midiOf(log[i].f0);
        sum += Math.abs(m - exp) * 100; n++;
      }
      best.push({ shift, avgCents: Math.round(sum / n) });
    }
    best.sort((a, b) => a.avgCents - b.avgCents);
    console.log('\n对不齐检查（平均音分误差，越小越吻合）：'
      + best.map((b) => `${b.shift > 0 ? '+' : ''}${b.shift}:${b.avgCents}`).join('  '));
    console.log(`→ 最吻合的是位移 ${best[0].shift}（平均 ${best[0].avgCents} 音分）`);
  }
}

// 把"错的那些音被谁抢走了"归类 —— 不靠猜，按音程关系分：
//   ±1/±2 半音 = 差一个音（对齐问题）；±12/±24 = 八度（低音弦余响）；±5/±7 = 上一根弦那种
if (globalThis.__vcNotes.length) {
  const cls = { 差一个音: 0, 八度: 0, 四五度: 0, 其他: 0, 通过: 0 };
  const detail = [];
  for (const n of globalThis.__vcNotes) {
    if (n.ratio >= (Number(process.env.VC_PASS_RATIO) || 1.15)) { cls.通过++; continue; }
    const d = (n.rival != null) ? (n.rival - n.exp) : null;
    let k = '其他';
    if (d == null) k = '其他';
    else if (Math.abs(d) <= 2) k = '差一个音';
    else if (Math.abs(d) % 12 === 0) k = '八度';
    else if (Math.abs(d) === 5 || Math.abs(d) === 7) k = '四五度';
    cls[k]++;
    detail.push(`#${n.no} 期望${n.exp} 输给${n.rival}(${d > 0 ? '+' : ''}${d})`);
  }
  console.log('\n错音归类：' + JSON.stringify(cls));
  console.log('明细：' + detail.join('，'));
}
