// ─────────────────────────────────────────────────────────────────────────────
// 节拍器核心（不认界面、不认状态，两个页面共用一份）。
//
// 做法是业界标准那套 **lookahead scheduler**（Chris Wilson《A Tale of Two Clocks》，
// Tone.js 的 Transport 也是同一套）：定时器只负责"往未来看"，
// 真正的拍点用 **Web Audio 的时钟**预约出去。定时器被主线程拖一下不影响节奏，
// 因为拍点的绝对时刻早就定死了。
//
// 参数沿用这份项目里原来就有的那份实现（frontend/js/metronome.js）：
//   每 25ms 往未来看 200ms。
//
// 两个容易踩的点，都写在参数里：
//   1) **起振要软**（20ms 爬升，不是"啪"的一下）。拨弦的起振在 5ms 以内，
//      而节拍器的响声会被麦克风收进去 —— 硬起振容易被起音检测当成一次拨弦。
//   2) 拍点要**累加**（nextTime += 每拍秒数），不能每拍重新算"现在 + 间隔"，
//      后者会把定时器的抖动累积到节奏里。
// ─────────────────────────────────────────────────────────────────────────────

export const LOOKAHEAD_MS = 200;   // 往未来看多远（预约窗口）
export const TICK_MS = 25;         // 定时器多久醒一次
const SOFT_ATTACK_MS = 20;         // 起振爬升（见上：软起振，别让麦克风当成拨弦）

export function createMetro({ getCtx, timers = {} }) {
  const setT = timers.set || ((fn, ms) => setInterval(fn, ms));
  const clearT = timers.clear || ((id) => clearInterval(id));
  const st = {
    on: false, bpm: 120, nextTime: 0, beat: 0, accentEvery: 4,
    sound: true, marks: [], timer: 0,
  };

  function clickAt(t, accent) {
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 2100 : 1500;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.18 : 0.09, t + SOFT_ATTACK_MS / 1000);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  // 往未来看窗口里该响的拍子，全预约出去。测试可以直接调它（不用真定时器）。
  function schedule() {
    const ctx = getCtx();
    if (!st.on || !ctx) return;
    const spb = 60 / st.bpm;
    // 落后超过一拍（后台标签页被降频、主线程卡住）：**不要**把错过的拍子一口气全放出来
    // ——那会变成一串挤在一起的"啪啪啪"。节拍器要的是当前这一拍，直接对齐到现在往后。
    if (st.nextTime < ctx.currentTime - spb) {
      st.nextTime = ctx.currentTime + LOOKAHEAD_MS / 1000;
    }
    // <= 而不是 < ：否则第一拍要等下一次定时器醒（多 25ms），起始会慢半拍
    while (st.nextTime <= ctx.currentTime + LOOKAHEAD_MS / 1000) {
      if (st.sound) clickAt(st.nextTime, st.beat % st.accentEvery === 0);
      // 记下真实拍点（音频时钟，毫秒）—— 判定"你偏了多少"要用它当基准
      st.marks.push({ t: st.nextTime * 1000, idx: st.beat % st.accentEvery });
      if (st.marks.length > 32) st.marks.shift();
      st.beat++;
      st.nextTime += spb;
    }
  }

  function start({ bpm, fromBeat = 0, leadMs = 200, sound = true, accentEvery = 4 } = {}) {
    stop();
    const ctx = getCtx();
    if (!ctx) return false;
    st.on = true;
    st.bpm = bpm || 120;
    st.beat = fromBeat;
    st.sound = sound;
    st.accentEvery = accentEvery;
    st.marks = [];
    st.nextTime = ctx.currentTime + leadMs / 1000;
    st.timer = setT(schedule, TICK_MS);
    schedule();
    return true;
  }

  function stop() {
    st.on = false;
    if (st.timer) clearT(st.timer);
    st.timer = 0;
  }

  // 某一时刻（音频时钟毫秒）离最近的那个拍点差多少毫秒。
  // 太远说明没跟着拍子弹，返回 null —— 不要拿它去报数。
  function deviationAt(audioMs, maxMs = 800) {
    if (!st.marks.length) return null;
    let bd = Infinity;
    for (const mk of st.marks) {
      const d = audioMs - mk.t;
      if (Math.abs(d) < Math.abs(bd)) bd = d;
    }
    return Math.abs(bd) > maxMs ? null : bd;
  }

  return { st, start, stop, schedule, deviationAt };
}
