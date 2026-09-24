// ── 判定层（检测能力的核心）：这一下弹的是不是谱面要的那个音 ──────────────────
//
// 口径（2026-09-22 定版）：**对就是对、错就是错**，不要第三档"测不准"。
// 做法：把"新出现的这坨能量"拿去和候选音比 —— 候选只留用户真会弹错的方式：
// **本音、±1 品、±2 品**。
// 刻意**不放**低八度（低八度假设天生占便宜：它把本音每个谐波都当成自己的偶数次谐波）
// 也不放 ±5（那正好是"上一根弦还在响"的位置，等于自己把票投给对手）。
//
// 为什么不能用"在谱面那个音附近找峰"（产品页最早那套）：那个问法必然自证 ——
// 把整段真机录音升半音再跑，读数/谐波数/残差和原录音一模一样（见 test/probe-notes.mjs），
// 所以"弹错判对"不是阈值问题，是问法问题。
//
// 判过 = 本音失配够小 **且** 本音在 ±1/±2 里最像（第二条才是真干活的那条）。
// ⚠ 阈值收在这里。改判定只动这个文件。
import { matchNoteByCandidates } from './analysis.js';

export const JUDGE = {
  // 本音"失配"上限（analysis.js mismatchOf 那套双向失配，单位音分）。
  // 250 是照实测分布定的：弹对 118~195（1弦那种又细又轻的最松）、弹错 186~300、
  // 没证据（静音/噪声）300。原来写 190 —— 正好卡在 1 弦那批安静音的失配上，
  // 于是同一段里一半判对一半判错（用户报的"1弦1品不是每次都错"就是这个）。
  fitMax: 250,
  // 认音名时只在"差一品"的候选里比：±1、±2
  // ⚠ 2026-09-24 试过两轮"扩远端对手"（[1..7] 和"两级领先线 1.05/1.25"），都**没上线**：
  //   两轮都把"差 4~6 个半音"挡住了（对 0 ✅），但**弹对的音被掀翻** ——
  //   · 扩到 [1..7]：琶音可信尺子 对5/错0 → 对2/错2
  //   · 两级线：琶音 → 对0/错1，**gt-notes 也从 39/39 掉到 38/39**（它的标签来自文件名，绝对可信）
  //   → 结论（用户的理论反过来给了我们最重要的证据）：**问题不在规则，在证据** ——
  //     真机录音里本音在失配分数上并不占优（判定窗混着上一根弦的余响 + 拨弦闷响），
  //     所以任何"更严的规则"都会连弹对的音一起判错。要修的是**判定窗只属于这一下**
  //     （稳定段/差分），不是继续加对手。
  rivalOffsets: [1, 2, 3, 4, 5, 6, 7],
  // ⚠ 2026-09-24 试过"补候选表的洞 + 远端对手要'自己就很好'（fit<200/180）才准翻案"：
  //   · 差 4/5/6 半音 → **对 0** ✅（洞确实堵住了）
  //   · 四和弦琶音靶子 → 对 8/错 6（不变，没误杀）
  //   · **但 gt-notes 从 39/39 掉到 38/39，收紧到 180 反而 37/39** → **没上线**。
  //   原因（下一步要查的）：补 ±3..±7 的候选会**连带影响别处** —— `candBest` 现在可能落在远端，
  //   而"跳音分支"会拿它跟下一格比 → 触发更多"跳过去"，正确样本被带偏。
  //   结论同上：**判定窗的污染不解决，动候选表/对手集只会把别处弄坏。**
  // ⚠ 2026-09-24 试过把 ±5 加进对手集（它本来就在候选表里却没参与比较）：
  //   移调靶子（谱面比实弹高/低 4~6 个半音，共 6 个）**数字一个没变**（+4 对4、+5 对9、+6 对1），
  //   底线也都没动（gt-notes 39/39、琶音 对8/错6、follow-page 4 条）→ **零收益，已撤回**。
  //   ⚠ 但它给出了**机制上的关键信息**：既然加上 ±5 对手也不起作用，说明
  //   "判过"不是"没人跟本音比"，而是**本音（谱面那个音，即使你没弹）真的赢过了所有对手** ——
  //   因为这些假判过都发生在**和弦在响**的场合：谱面要的那个音常常正好是**已经在响的和弦音**，
  //   判定窗里现成的能量就"证明"了它在 → 本音得分高 → 判过。
  //   （这也同时解释了用户报的"一个 1弦空品能把所有和弦全过"。）
  //   ⇒ 下一步要试的是：**P2O 侧也要求"这一下新加进来的证据"**（即谱面音的基频/谐波要有抬头），
  //     且只对"响的音 + 3~6 弦"生效（1~2 弦基频天生弱，别误杀）—— 这正是今天上午那条
  //     "基频抬头守卫"的窄化版（那版是全局生效，误杀 4 个）。
  rivalOffsets: [1, 2],
  // 低八度守卫：用户"全弹 5弦3品(C3)"那一遍里，很多期望 C4 的音被**判成对**——
  // 因为 C4 的基频正好是 C3 的 2 次谐波，C3 的能量把 C4 的谐波位置全填满了。
  // 所以"弹对"还要多问一句：**低八度那个音是不是明显更像**（失配好 ≥80 音分才算明显）。
  // 80 这个数是量出来的：真机录音里弹对的 40 个拨弦，低八度"赢"的 7 个差距只有
  // 0/3/7/10/11/20/51 音分（打平或擦边），没有一个够 80 → 不会误伤弹对的。
  // ⚠ 2026-09-24：80 → **120**。用户 10:41 导出里 idx 82（4弦3品 F3）本音失配 199、
  //   领先邻居 1.24 倍 —— 按定义属于"弹对"那一档，却被低八度守卫（F2 更像）否掉，
  //   于是同一个音第一次判错、第二次判过（体验最差的那种）。
  //   守卫只在"低八度**明显**更像"时才该生效；80 音分太靠近测量散布（真机 ±50 音分的
  //   判据线），提到 120 仍小于一个半音，且 gt-notes 两向验收要重跑确认没放走真错音。
  octaveGuardCents: 120,
  // 邻居要"明显"更好才算翻案：差 3% 以内属于擦边（噪声级别），
  // 那条 F3 被判错的记录就是"邻居只好了 1.2%"（margin 0.988）被翻掉的。
  // ⚠ 2026-09-23 用户反馈："候选重排这个逻辑有点问题"——原来邻居只要领先 **3%** 就能翻案，
  //   导出里那一批"期待==听到却判错"（本音领先倍数 0.41~0.84 之外，还有 0.95~0.97 的擦边）
  //   就是这么被翻掉的。改成**邻居要明显更好（领先 ≥10%）才准翻案**（0.97 → 0.90）。
  rivalMargin: 0.90,
};

// match: matchNoteByCandidates(...) 的返回值
export function decideByCandidates(match, opts = {}) {
  // 允许测试用 globalThis.__fitMax / __rivalMargin 覆盖（扫阈值用；不设 = 用下面的默认值）
  const fitMax = opts.fitMax == null
    ? (globalThis.__fitMax == null ? JUDGE.fitMax : globalThis.__fitMax) : opts.fitMax;
  const rivalMargin = opts.rivalMargin != null ? opts.rivalMargin
    : (globalThis.__rivalMargin == null ? JUDGE.rivalMargin : globalThis.__rivalMargin);
  const ranked = (match && match.ranked) || [];
  const self = ranked.find((x) => x.offset === 0) || null;
  const rival = ranked
    .filter((x) => x.offset !== 0 && JUDGE.rivalOffsets.includes(Math.abs(x.offset)))
    .sort((a, b) => b.score - a.score)[0] || null;
  const rivalNeed = rivalMargin;
  const best = ranked[0] || null;
  const pass = !!(self && self.mismatch < fitMax && (!rival || self.score > rival.score * rivalNeed));
  return {
    pass, self, rival, best,
    // 给导出记录/诊断行用的证据
    fit: self ? self.mismatch : null,
    margin: self && rival && rival.score > 0 ? self.score / rival.score : null,
    heard: best ? best.midi : null,
  };
}

// 一次判定要用到的所有测量都在这里，页面只负责把窗给它
export function judgeNote({ spec, sampleRate, fftSize, expectedMidi, opts }) {
  const match = matchNoteByCandidates(spec, sampleRate, fftSize, expectedMidi, 0, opts);
  const out = { match, ...decideByCandidates(match, opts) };
  // 低八度守卫：期望音判过之后，再看一眼"低一个八度"是不是明显更像
  if (out.pass) {
    const low = matchNoteByCandidates(spec, sampleRate, fftSize, expectedMidi - 12);
    const lowSelf = low.ranked.find((x) => x.offset === 0) || null;
    if (lowSelf && out.self && lowSelf.mismatch + JUDGE.octaveGuardCents < out.self.mismatch) {
      out.pass = false;
      out.octaveBelow = { midi: expectedMidi - 12, mismatch: Number(lowSelf.mismatch.toFixed(0)) };
    }
  }
  return out;
}
