// ─────────────────────────────────────────────────────────────────────────────
// 全部可调参数和常量，集中在这里。
// 页面上的滑块改的就是 CFG 里的字段（键名和 index.html 里 id 的后缀一致）。
// ─────────────────────────────────────────────────────────────────────────────

export const CFG = {
  toleranceCents: 45,     // 音准容差。只影响提示语，不决定过不过（过不过看音名）
  onsetSensitivity: 4.0,  // 门限 = 噪声地板 × 这个倍数。调高 = 更不容易被环境噪声误触发
  settleMs: 60,           // 起音到测量之间的等待。每弹一个音都要付这个时间，越小越跟手
  chordThreshold: 0.72,   // 和弦指纹相似度门限
  absFloor: 0.0035,       // 绝对门限，安静时也不能低于它
  minGapMs: 90,           // 两次起始之间最小间隔
  techExtraCents: 25,     // 技巧类练习额外放宽的音分
  capo: 0,                // 变调夹品位
};

export const CAPTURE = 16384;       // 采集长度。48k 下 341ms——低音弦需要这么长的窗
export const CHORD_SETTLE_MS = 300; // 和弦要等满一个分析窗才测
export const FLASH_MS = 700;        // 判定结果在条上停留多久（只是显示，不挡流程）
export const YIN_SAMPLES = 1204;    // 音高分析用的采样点数
export const MIC_TIMEOUT_MS = 8000; // 等授权的最长时间
export const FLUX_N = 2048;         // 频谱通量的窗口（48k 下约 43ms，bin 宽 23Hz）
