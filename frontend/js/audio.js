// ─────────────────────────────────────────────────────────────────────────────
// 麦克风采集层。
//
// 职责很窄：拿到麦克风、建好 AnalyserNode、对外提供"最近 341ms 的时域数据"，
// 以及查询权限状态。不掺任何判定逻辑，也不认识界面。
// ─────────────────────────────────────────────────────────────────────────────

import { CAPTURE, MIC_TIMEOUT_MS } from './config.js';

let audioCtx = null;
let analyser = null;
let stream = null;
let buf = null;
let decim = 4;
let sr2 = 12000;

export const getCtx = () => audioCtx;
export const getBuffer = () => buf;
export const getDecim = () => decim;
export const getRate = () => sr2;
export const isActive = () => !!(audioCtx && analyser && buf);

export function withTimeout(promise, ms = MIC_TIMEOUT_MS) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => {
    const e = new Error('超时'); e.name = 'TimeoutError'; rej(e);
  }, ms))]);
}

// 浏览器对这个站点的麦克风权限状态：granted / denied / prompt。
// 只能在 getUserMedia 失败之后才查——查它是异步的，
// 放在调用之前会把"用户手势"这条链断掉，iOS 上会直接拒绝。
export async function permissionState() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    const p = await navigator.permissions.query({ name: 'microphone' });
    return p.state;
  } catch (e) {
    return null;
  }
}

// 打开麦克风。失败时抛出的异常原样往外扔，由上层决定怎么说给用户听。
export async function acquire() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { const e = new Error('这个浏览器不支持 Web Audio'); e.name = 'NoWebAudio'; throw e; }

  // AudioContext 要在点击手势里同步建出来，否则可能被自动播放策略挂起
  audioCtx = new Ctx({ latencyHint: 'interactive' });

  try {
    try {
      stream = await withTimeout(navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      }));
    } catch (e) {
      if (e.name === 'TimeoutError') throw e;
      stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }));
    }
  } catch (e) {
    release();
    throw e;
  }

  await audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = CAPTURE;
  src.connect(analyser);

  decim = Math.max(1, Math.round(audioCtx.sampleRate / 12000));
  sr2 = audioCtx.sampleRate / decim;
  buf = new Float32Array(CAPTURE);
}

// 取一帧时域数据到 buf 里
export function readFrame() {
  if (analyser) analyser.getFloatTimeDomainData(buf);
  return buf;
}

export function release() {
  if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } }
  if (audioCtx) { try { audioCtx.close(); } catch (e) { /* ignore */ } }
  stream = null; audioCtx = null; analyser = null; buf = null;
}
