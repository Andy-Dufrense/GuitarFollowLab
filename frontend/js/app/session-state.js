// ── 会话状态（唯一真相）────────────────────────────────────────────────────
//
// 按 `frontend/js/结构.md` §4 第 1 步立的模块。这是**开张**，不是完工：
// 会话状态散在 follow-score.js 里的有 ~40 个，一次搬完风险太大（`micTickBody` 一个函数
// 就摸到 71 个顶层量），所以按"一次一个、每步过四道门"的节奏往里加。
//
// 现在只有第一个：
//   countinPeaks —— 倒数四拍里"听见几声响"的计数。
//     用途是**自听检测**：这四拍用户还在等，如果他没在弹而麦克风却听见了三下以上清楚的响动，
//     那就是手机外放被自己收进去了（那种情况下判定一定全错）。原来它是 follow-score.js 的
//     一个模块级 let，在三个地方被读写。
//
// 之后往里搬的顺序（见结构.md）：wrongList / wrongNoted / missNoted →
//   good / bad / missed / unclearCount / earlyCount / lateCount / timingDevs →
//   noteIdx / userPickedStart / holdUntilMs → （最后才是）判定链上那些。

export function createSessionState() {
  let countinPeaks = 0;        // 倒数四拍里听见的响动数

  return {
    get countinPeaks() { return countinPeaks; },
    resetCountinPeaks() { countinPeaks = 0; },
    bumpCountinPeaks() { countinPeaks++; },
    /** 四拍里听见三下以上 = 麦克风收到了外放（自听） */
    get selfListenDetected() { return countinPeaks >= 3; },
  };
}
