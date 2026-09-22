// ─────────────────────────────────────────────────────────────────────────────
// 节拍器。
//
// 用 Web Audio 自己的时钟排拍子（不是 setTimeout），这样节奏是稳的：
// 每 25ms 往未来看 200ms，把该响的拍子预约出去。
// 音频时钟和识别用的是同一个 AudioContext，所以"你偏了多少毫秒"能对得上。
// ─────────────────────────────────────────────────────────────────────────────

import { CFG } from './config.js';
import { S } from './state.js';
import { getCtx } from './audio.js';
import { $, setVerdict, paintBeats } from './ui.js';
import { createMetro } from './metro-core.js';

// 排程/发声/拍点记录都在 metro-core.js 里（产品页用同一份），这里只管界面和状态。
const metro = createMetro({ getCtx });

export function startMetro() {
  const ctx = getCtx();
  if (!ctx) {
    setVerdict('warn', '先点「开始」把麦克风打开——节拍器和识别要用同一个音频时钟，不然对不齐');
    return;
  }
  const m = S.metro;
  m.devs = [];
  metro.start({ bpm: m.bpm, sound: m.sound !== false });
  m.on = metro.st.on;
  m.marks = metro.st.marks;
  $('btnMetro').textContent = '停止';
  setVerdict('listening', '跟着节拍器弹，我来看看你偏多少');
}

export function stopMetro() {
  S.metro.on = false;
  metro.stop();
  // 别的模块（main.js 复位、paintCurrentBeat）读的是 S.metro.marks，
  // 而拍点是核心模块在维护 —— 这里把引用同步回去，别让它读到上一次的数组。
  S.metro.marks = metro.st.marks;
  $('btnMetro').textContent = '开始';
  paintBeats(-1);
}

// 主循环每帧调它，把当前拍子高亮出来
export function paintCurrentBeat() {
  const ctx = getCtx();
  if (!S.metro.on || !ctx) return;
  const nowMs = ctx.currentTime * 1000;
  const spb = 60000 / S.metro.bpm;
  let cur = -1;
  for (const mk of S.metro.marks) if (mk.t <= nowMs && nowMs - mk.t < spb * 0.9) cur = mk.idx;
  if (cur !== S.metro.shown) { S.metro.shown = cur; paintBeats(cur); }
}

// 某一时刻离最近的拍子差多少毫秒
export function beatDeviation(audioMs) {
  return metro.deviationAt(audioMs);
}

export function reportTiming(dev) {
  const m = S.metro;
  m.devs.push(dev);
  if (m.devs.length > 8) m.devs.shift();
  const avg = m.devs.reduce((a, b) => a + b, 0) / m.devs.length;
  const spread = Math.max(...m.devs) - Math.min(...m.devs);
  $('metrostat').innerHTML =
    `最近 ${m.devs.length} 个音：${m.devs.map((d) => (d > 0 ? '+' : '') + Math.round(d)).join(' ')} ms<br>`
    + `平均 <b>${avg > 0 ? '偏晚' : '偏早'} ${Math.abs(avg).toFixed(0)} ms</b> · 抖动 ${spread.toFixed(0)} ms`;
  return dev;
}

// 跟着 BPM 自动调判定参数：快曲子音符间隔短，等待和最小间隔都得跟着缩
export function autoFit() {
  if (!$('c-autofit').checked) return;
  const noteMs = 30000 / S.metro.bpm;        // 按八分音符算
  CFG.settleMs = Math.round(Math.min(130, Math.max(60, noteMs * 0.35)));
  CFG.minGapMs = Math.round(Math.min(140, Math.max(60, noteMs * 0.4)));
  $('autofit-note').textContent = `判定等待 ${CFG.settleMs}ms · 最小间隔 ${CFG.minGapMs}ms`
    + `（八分音符间隔 ${Math.round(noteMs)}ms）`;
  $('s-set').value = CFG.settleMs;
  $('o-set').textContent = CFG.settleMs + ' ms';
}
