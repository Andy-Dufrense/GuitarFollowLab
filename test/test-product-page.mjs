// 产品页自检：不开浏览器，用 DOM 桩把 frontend/js/follow-score.js 真加载一遍。
//
// 为什么需要它：页面上"按钮点不了"最常见的根因是 —— 模块里**前面某处抛异常**，
// 后面挂按钮事件的代码根本没执行（整个模块死掉，但页面看起来是"活的"）。
// 这个测试就是来抓这个的：模块必须加载成功，而且每个按钮都必须真的挂上函数。
//
// 用法： node test/test-product-page.mjs

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('   !! ' + m); } };

// alphaTab 本体只允许在浏览器里构造 AlphaTabApi（Node 里会直接抛），
// 所以这里用一个"记录型桩"：只验证**我们的模块**有没有正确装配。
// alphaTab 自己能不能解析谱面，由 test/probe-gp.mjs 单独验证。
function evt() { const fns = []; return { on: (f) => fns.push(f), fire: (...a) => fns.forEach((f) => f(...a)) }; }
function FakeApi() {
  this.settings = { display: { scale: 1, layoutMode: 'page' } };
  this.playerState = 0; this.isLooping = false; this.tickPosition = 0; this.timePosition = 0;
  this.played = 0;
  for (const k of ['error', 'scoreLoaded', 'playerStateChanged', 'playerPositionChanged',
    'soundFontLoaded', 'renderFinished', 'playerReady', 'beatMouseDown']) this[k] = evt();
  this.score = null;
  this.playPause = () => { this.playerState = this.playerState === 1 ? 0 : 1; this.played++; this.playerStateChanged.fire({ state: this.playerState }); };
  this.changeTrackMute = () => {}; this.changeTrackVolume = () => {}; this.render = () => {};
}
FakeApi.prototype.setTrackVolumes = function () {};
const tracks = [
  { name: 'Voice', playbackInfo: { isMute: false }, staves: [{ bars: [] }] },
  { name: 'Piano', playbackInfo: { isMute: false }, staves: [{ bars: [] }] },
];
FakeApi.prototype.loadScore = function () {
  this.score = { title: 'Hey Jude', artist: 'The Beatles', tempo: 76, tracks, masterBars: new Array(24).fill({}) };
  this.scoreLoaded.fire(this.score);
};
globalThis.__FakeTracks = tracks;

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
const ids = ['title', 'play', 'mic', 'song', 'track', 'speed', 'loop', 'selftest',
  'scoreWrap', 'score', 'chords', 'pos', 'heard', 'good', 'bad', 'verdict', 'err'];
globalThis.document = {
  getElementById(id) { if (!reg.has(id)) reg.set(id, new El()); return reg.get(id); },
  createElement: (t) => new El(t), querySelector: () => new El(), querySelectorAll: () => [],
};
globalThis.window = globalThis;
globalThis.innerWidth = 390;                       // 按手机宽度加载
globalThis.addEventListener = () => {};             // 浏览器里一定有，桩里补上
globalThis.removeEventListener = () => {};
globalThis.location = { search: '' };
globalThis.performance = { now: () => Date.now() };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.setTimeout = (f) => { try { f(); } catch (e) { console.log('   （定时器里报错：' + e.message + '）'); } return 1; };
const CHORD_DATA = { meta: { title: '和弦练习', tempo: 76, kind: 'chords' }, chords: [
  { name: 'C', midis: [48, 52, 55, 60, 64], voicing: '5弦3品 → 1弦空弦' },
  { name: 'Am', midis: [45, 50, 52, 57, 60], voicing: '5弦空弦' },
  { name: 'F', midis: [41, 48, 53, 57, 60], voicing: '大横按' },
  { name: 'G', midis: [43, 47, 50, 55, 59], voicing: '6弦3品' },
] };
const NOTE_DATA = { meta: { title: 'Hey Jude', tempo: 76 }, notes: [
  { t: 0.79, dur: 0.79, midi: 60, string: 2, fret: 1 }, { t: 1.58, dur: 1.58, midi: 57, string: 3, fret: 2 },
] };
globalThis.fetch = async (u) => ({
  ok: true, status: 200,
  json: async () => (String(u).includes('chord') ? CHORD_DATA : NOTE_DATA),
  blob: async () => ({ size: 10 }),
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { userAgent: 'test', permissions: { query: async () => ({ state: 'prompt' }) } },
});
globalThis.AudioContext = class { constructor() { this.currentTime = 0; this.sampleRate = 48000; } resume() {} createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } createBiquadFilter() { return { frequency: {}, connect() {} }; } get destination() { return {}; } };

globalThis.alphaTab = { AlphaTabApi: FakeApi, version: 'stub' };

console.log('\n=== 加载产品页脚本（手机宽度 390px）===');
let loadError = null;
try {
  await import('../frontend/js/follow-score.js');
} catch (e) {
  loadError = e;
}
ok(!loadError, '模块加载失败：' + (loadError && loadError.message));

if (!loadError) {
  const need = { play: 'onclick', mic: 'onclick', song: 'onchange', speed: 'onchange', loop: 'onclick', selftest: 'onclick' };
  for (const [id, ev] of Object.entries(need)) {
    const el = reg.get(id);
    ok(el && typeof el[ev] === 'function', `#${id} 没有挂上 ${ev}（点了当然没反应）`);
  }
  // 曲目切换/点击主按钮不能抛异常
  try { reg.get('song').value = 'chords'; await reg.get('song').onchange(); } catch (e) { ok(false, '切到和弦练习时抛错：' + e.message); }
  try { await reg.get('play').onclick(); } catch (e) { ok(false, '点试听时抛错：' + e.message); }
  try { await reg.get('mic').onclick(); } catch (e) { ok(false, '点跟弹时抛错：' + e.message); }
  try { await reg.get('selftest').onclick(); } catch (e) { ok(false, '点自检时抛错：' + e.message); }
  console.log('   自检输出：' + String(reg.get('err').textContent).slice(0, 200));
  console.log('   判定行：' + String(reg.get('verdict').textContent).slice(0, 120));
}

const scoreInner = reg.get('score') ? reg.get('score').innerHTML.length : 0;
console.log(`   谱面容器内容长度：${scoreInner}`);

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
