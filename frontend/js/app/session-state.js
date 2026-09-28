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
//   good / bad / missed / unclearCount —— 这一段的对、错、漏、"测不准"四个计数。
//     "测不准"（最优解贴在搜索边界）不算弹错，单独一栏。
//   timingDevs / earlyCount / lateCount —— 跟节拍才有：每个音的偏差（ms，负=抢拍），
//     以及抢拍、拖拍各几处。不和音准合成一个"对/错"：用户被标红时要能看出错在音还是错在拍。
//
// 之后往里搬的顺序（见结构.md）：
//   noteIdx / userPickedStart / holdUntilMs → （最后才是）判定链上那些。

export function createSessionState() {
  let countinPeaks = 0;        // 倒数四拍里听见的响动数
  let wrongNoted = new Set();  // 已经记过错的音（同一个音只记第一次错）
  let missNoted = -1;          // 这个音已经记过"漏拍/换和弦不流畅"了吗（只记一次）
  let wrongList = [];          // 弹错清单（每条一句人话，收尾时取前 5 条给用户看）
  let good = 0, bad = 0;       // 这一段的对 / 错
  let missed = 0;              // 漏拍（时间窗过了没弹 / 跳过去了）
  let unclearCount = 0;        // "测不准"（最优解贴在搜索边界）——不算弹错
  let timingDevs = [];         // 每个音的偏差（ms，负 = 抢拍）
  let earlyCount = 0, lateCount = 0;

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

    /** 这一段的对 / 错（收尾算正确率用） */
    get good() { return good; },
    get bad() { return bad; },
    countGood() { good++; },
    countBad() { bad++; },
    resetScore() { good = 0; bad = 0; },                    // 开始新一遍时清

    get missed() { return missed; },
    countMissed() { missed++; },

    get unclearCount() { return unclearCount; },
    countUnclear() { unclearCount++; },
    resetMissCounts() { missed = 0; unclearCount = 0; },    // 点谱面换起点时清

    /** 节奏账：偏差直接 .push(...) 进来，抢拍/拖拍各记一处 */
    get timingDevs() { return timingDevs; },
    get earlyCount() { return earlyCount; },
    get lateCount() { return lateCount; },
    countEarly() { earlyCount++; },
    countLate() { lateCount++; },
    resetTiming() { timingDevs = []; earlyCount = 0; lateCount = 0; },   // 开始新一遍时清
  };
}
