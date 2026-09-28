// ── 会话状态（唯一真相）────────────────────────────────────────────────────
//
// 按 `frontend/js/结构.md` §4 第 1 步立的模块。这是**开张**，不是完工：
// 会话状态散在 follow-score.js 里的有 ~40 个，一次搬完风险太大（`micTickBody` 一个函数
// 就摸到 71 个顶层量），所以按"一次一个、每步过四道门"的节奏往里加。
//
// 已经搬进来的：
//   countinPeaks —— 倒数四拍里"听见几声响"的计数。
//     用途是**自听检测**：这四拍用户还在等，如果他没在弹而麦克风却听见了三下以上清楚的响动，
//     那就是手机外放被自己收进去了（那种情况下判定一定全错）。原来它是 follow-score.js 的
//     一个模块级 let，在三个地方被读写。
//   wrongNoted —— "这个音已经记过错了吗"。同一个音只记第一次错，停了重弹的那几次不再累加，
//     否则一声咳嗽 / 一次听不准就能把错误数刷到十几。读用 .has(i)、记用 .add(i)。
//   missNoted —— "这个音已经记过漏拍/换和弦不流畅了吗"（只记一次，存的是第几个音，-1 = 没记过）。
//   wrongList —— 弹错清单（每条一句人话）。收尾时"要改的地方"就是它（slice 0..5）。
//
// 之后往里搬的顺序（见结构.md）：
//   good / bad / missed / unclearCount / earlyCount / lateCount / timingDevs →
//   noteIdx / userPickedStart / holdUntilMs → （最后才是）判定链上那些。

export function createSessionState() {
  let countinPeaks = 0;        // 倒数四拍里听见的响动数
  let wrongNoted = new Set();  // 已经记过错的音（同一个音只记第一次错）
  let missNoted = -1;          // 这个音已经记过"漏拍/换和弦不流畅"了吗（只记一次）
  let wrongList = [];          // 弹错清单（每条一句人话，收尾时取前 5 条给用户看）

  return {
    get countinPeaks() { return countinPeaks; },
    resetCountinPeaks() { countinPeaks = 0; },
    bumpCountinPeaks() { countinPeaks++; },
    /** 四拍里听见三下以上 = 麦克风收到了外放（自听） */
    get selfListenDetected() { return countinPeaks >= 3; },

    /** 已经记过错的音：读 .has(i)、记 .add(i)；换一遍 / 换起点时整体清空 */
    get wrongNoted() { return wrongNoted; },
    resetWrongNoted() { wrongNoted = new Set(); },

    /** 漏拍 / 换和弦不流畅：只记一次，记的是"第几个音" */
    get missNoted() { return missNoted; },
    markMissed(idx) { missNoted = idx; },

    /** 弹错清单：读 .length / .join / .slice；记一条用 noteWrong() */
    get wrongList() { return wrongList; },
    resetWrongList() { wrongList = []; },
    noteWrong(text) { wrongList.push(text); },
  };
}
