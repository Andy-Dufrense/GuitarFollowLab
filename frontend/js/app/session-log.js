// ── 会话日志（每次跟弹的三本账）──────────────────────────────────────────
//
// 2026-09-28 从 follow-score.js 搬出来的第一片"会话状态"。这三本账原来是模块级
// 的三个数组，散在十几个地方 push / 读 / 清空；搬出来之后它们只有一个入口。
//
//   sessions    原 sessionLog：每次判定的逐音记录 —— 「导出记录」按钮存的就是它
//   onsets      原 onsetLog：每次起音的时刻（离线分析、对号用）
//   nearMisses  原 nearMissLog：没被认成起音的那些帧（排查"为什么漏了"用，只留最近 120 条）
//
// 语义与搬之前**完全一致**，包括：
//   · reset() 只清 sessions 和 onsets —— nearMisses 不清（原来就是这样）
//   · nearMisses 超过 120 条丢最老的
//   · 对外给的是**同一个数组引用**（window.__vcSessionLog 等钩子靠它）

export function createSessionLog() {
  let sessions = [];
  let onsets = [];
  let nearMisses = [];

  return {
    get sessions() { return sessions; },
    get onsets() { return onsets; },
    get nearMisses() { return nearMisses; },

    session(rec) { sessions.push(rec); },
    onset(rec) { onsets.push(rec); },
    nearMiss(rec) {
      nearMisses.push(rec);
      if (nearMisses.length > 120) nearMisses.shift();
    },
    capNearMiss() { if (nearMisses.length > 120) nearMisses.shift(); },
    lastOnset() { return onsets[onsets.length - 1]; },
    reset() { sessions = []; onsets = []; },
  };
}
