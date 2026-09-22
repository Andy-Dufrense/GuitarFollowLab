// 节拍器核心的回归：拍点必须**不累积抖动**，起振必须是软的。
//
// 为什么值得测：
//   · 排程用的是"每 25ms 往未来看 200ms"那套标准做法，但参数或写法一改就可能退化成
//     "每拍现算现在+间隔" —— 那样定时器的抖动会一路累积进节奏里（听感就是越走越飘）。
//   · 起振软硬直接决定"节拍器会不会被麦克风当成一次拨弦"——这是这个项目独有的坑。
//
// 用法： node test/metro.mjs

import { createMetro, LOOKAHEAD_MS, TICK_MS } from '../frontend/js/metro-core.js';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('   !! ' + m); } };

// 假 AudioContext：时钟手动推，记下所有排程出去的拍点
const clicks = [];
let nowSec = 0;
function fakeCtx() {
  return {
    get currentTime() { return nowSec; },
    get destination() { return {}; },
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; },
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    },
  };
}
// 用真的 ctx 接口，但把"什么时候响"记下来 —— 通过 createOscillator.start 抓
const realCreate = fakeCtx;
function ctxWithLog() {
  const c = realCreate();
  const click = { t: 0 };
  c.createOscillator = () => ({
    type: '', frequency: { value: 0 }, connect() {},
    start(t) { click.t = t; }, stop() {},
  });
  return c;
}

console.log('\n=== 1. 拍点不累积抖动 ===');
{
  const marks = [];
  const ctx = {
    get currentTime() { return nowSec; },
    get destination() { return {}; },
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start(t) {}, stop() {} }; },
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; },
  };
  const m = createMetro({ getCtx: () => ctx, timers: { set: () => 1, clear: () => {} } });
  m.start({ bpm: 120, sound: false });
  // 每 30ms 推一次时钟（模拟定时器有抖动：25ms 定时器被主线程拖成 30ms）
  for (let i = 0; i < 200; i++) { nowSec += 0.03; m.schedule(); }
  const ms = m.st.marks.map((x) => x.t);
  ok(ms.length > 8, `应该排出去不少拍点，实际 ${ms.length} 个`);
  // 每个拍点间隔必须是 500ms（120BPM），误差不超过 1e-6 —— 因为它是在累加，不是在重算
  let worst = 0;
  for (let i = 1; i < ms.length; i++) worst = Math.max(worst, Math.abs((ms[i] - ms[i - 1]) - 500));
  ok(worst < 0.001, `拍点间隔必须严格 500ms，实际最大误差 ${worst.toFixed(4)}ms`);
}

console.log('\n=== 2. 主线程卡住之后不"补响一串" ===');
{
  const m = createMetro({ getCtx: () => ({
    get currentTime() { return nowSec; }, get destination() { return {}; },
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; },
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; },
  }), timers: { set: () => 1, clear: () => {} } });
  m.start({ bpm: 60, sound: false });
  m.schedule();
  const before = m.st.marks.length;
  nowSec += 5;                       // 主线程卡了 5 秒
  m.schedule();
  const after = m.st.marks.length;
  // 卡 5 秒本来"欠"5 拍：正确做法是对齐到现在、只排接下来这一两拍，不是一次放 5 个
  ok(after - before <= 2, `卡住之后不该一口气补响一串（欠 5 拍），实际补了 ${after - before} 个`);
  const last = m.st.marks[m.st.marks.length - 1];
  ok(last.t / 1000 >= nowSec, `重新排的拍点必须在"现在"之后（不能排到过去），实际 ${(last.t / 1000).toFixed(2)}s vs 现在 ${nowSec.toFixed(2)}s`);
}

console.log('\n=== 3. 起振是软的（别让麦克风当成拨弦）===');
{
  let attackMs = null, decayMs = null;
  const ctx = {
    currentTime: 0, destination: {},
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; },
    createGain() {
      return { gain: {
        setValueAtTime() {},
        exponentialRampToValueAtTime(v, t) { if (attackMs == null) attackMs = t * 1000; else decayMs = t * 1000; },
      }, connect() {} };
    },
  };
  const m = createMetro({ getCtx: () => ctx, timers: { set: () => 1, clear: () => {} } });
  m.start({ bpm: 120 });
  ok(attackMs != null && attackMs >= 15,
    `起振爬升至少要 15ms（拨弦的起振在 5ms 以内，硬起振会被起音检测当成拨弦），实际 ${attackMs}ms`);
  ok(decayMs != null && decayMs > attackMs, `要有衰减段，实际 attack=${attackMs} decay=${decayMs}`);
}

console.log('\n=== 4. 停止之后不再排新拍 ===');
{
  const ctx = { get currentTime() { return nowSec; }, destination: {},
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; },
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } };
  const m = createMetro({ getCtx: () => ctx, timers: { set: () => 1, clear: () => {} } });
  m.start({ bpm: 120, sound: false });
  m.stop();
  const n = m.st.marks.length;
  nowSec += 2; m.schedule();
  ok(m.st.marks.length === n, `停了就不该再排拍，实际多了 ${m.st.marks.length - n} 个`);
}

console.log(`\n参数：往未来看 ${LOOKAHEAD_MS}ms，定时器 ${TICK_MS}ms 一次`);
console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
