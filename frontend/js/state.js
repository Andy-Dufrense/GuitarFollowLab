// ─────────────────────────────────────────────────────────────────────────────
// 全局可变状态。整个应用只有一个 S，各模块共享。
//
// 这里只放"跨模块都要看的东西"：进度、当前阶段、电平/门限、节拍器状态。
// 算法内部自己的状态（噪声谱、上一帧频谱）放在 analysis.js 里，不往这里塞。
// ─────────────────────────────────────────────────────────────────────────────

import { MODES, buildRun } from './exercises.js';

export const S = {
  // 练习进度
  modeIndex: 0,
  levelIndex: 0,
  run: null,
  pos: 0,
  results: [],
  log: [],

  // 判定状态机：idle | waiting | settling | cooldown | done
  phase: 'idle',
  onsetAt: 0,
  lastOnsetAt: -1e9,
  measureTries: 0,
  trajectory: [],
  onsetAudioMs: 0,

  // 电平与起音
  hist: null,
  histIdx: 0,
  floor: 0.001,
  gate: 0.01,
  level: 0,
  frames: 0,
  fluxRel: 0,
  lastAnalysisAt: 0,

  // 运行状态
  running: false,
  lastError: null,

  // 节拍器
  metro: {
    on: false, bpm: 80, beat: 0, nextTime: 0, sound: false,
    marks: [],   // 最近排出去的拍子（音频时钟 ms）
    devs: [],    // 最近几次判定的偏差（ms）
  },
};

export const mode = () => MODES[S.modeIndex];
export const step = () => (S.run ? S.run.flat[S.pos] : null);

export function newRun() {
  S.run = buildRun(mode(), S.levelIndex);
  S.pos = 0;
  S.results = new Array(S.run.flat.length).fill(null);
  S.log = [];
}
