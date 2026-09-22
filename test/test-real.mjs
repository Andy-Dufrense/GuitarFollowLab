// 真机录音跑真实页面逻辑。
//
// 合成信号再像也不是真琴：麦克风的频响、房间、手指的力度、弦的余响长度
// 都会不一样。这个脚本把手机录的音频（先用 ffmpeg 转成 48k 单声道 f32：
// sound_data/f32/*.f32）喂给真实的 main.js，看判定条一路发生什么。
//
// 用法：
//   node test/test-real.mjs sound_data/f32/Em-T3231323.f32 2
//                                            ^音频        ^模式（2 = 和弦模式）
// 模式：0 单音 / 1 技巧 / 2 和弦 / 3 扫弦 / 4 转换

import fs from 'node:fs';

const SR = 48000;
const CAPTURE = 16384;
const file = process.argv[2];
const modeIndex = Number(process.argv[3] || 0);
if (!file) { console.error('用法：node test/test-real.mjs <xxx.f32> [模式]'); process.exit(2); }

const raw = fs.readFileSync(file);
const AUDIO = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
console.log(`音频 ${file}：${(AUDIO.length / SR).toFixed(1)}s`);

let clock = 0;
let pending = null;
class El {
  constructor() {
    this.children = []; this._html = ''; this.style = {}; this.dataset = {};
    this.value = ''; this.open = false; this.checked = false; this.textContent = '';
    this.listeners = {}; this._q = new Map();
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
  createElement: () => new El(), querySelector: () => new El(), querySelectorAll: () => [],
};
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = (cb) => { pending = cb; return 1; };
globalThis.cancelAnimationFrame = () => { pending = null; };
globalThis.location = { origin: 'http://localhost:1209', host: 'localhost:1209', protocol: 'http:' };
globalThis.window = globalThis;
globalThis.isSecureContext = true;
globalThis.fetch = async () => ({ json: async () => ({ lanIPs: [], httpPort: 1209, httpsPort: 1210, httpsReady: true }) });
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
    userAgent: 'real-file-test',
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      enumerateDevices: async () => ([{ kind: 'audioinput', label: '手机录音' }]),
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
const $ = (id) => reg.get(id) || document.getElementById(id);
await $('btnStart').onclick();
if (modeIndex) $('modes').children[modeIndex].onclick();

console.log(`模式：${$('modes').children[modeIndex] ? '已切换' : '默认'}｜起始目标：${$('target').textContent}`);
let last = $('verdict').textContent;
const total = Math.ceil((AUDIO.length / SR) * 1000);
while (clock < total) {
  clock += 16;
  const cb = pending; pending = null;
  if (cb) cb(clock);
  const v = $('verdict').textContent;
  if (v !== last) {
    console.log(`  ${String(Math.round(clock)).padStart(5)}ms  ${v}`);
    last = v;
  }
}
console.log(`结束：${$('stepno').textContent}｜目标 ${$('target').textContent}`);
console.log(`最终判定条：${$('verdict').textContent}`);
