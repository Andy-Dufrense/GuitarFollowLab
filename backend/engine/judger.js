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
  rivalOffsets: [1, 2],
  // 低八度守卫：用户"全弹 5弦3品(C3)"那一遍里，很多期望 C4 的音被**判成对**——
  // 因为 C4 的基频正好是 C3 的 2 次谐波，C3 的能量把 C4 的谐波位置全填满了。
  // 所以"弹对"还要多问一句：**低八度那个音是不是明显更像**（失配好 ≥80 音分才算明显）。
  // 80 这个数是量出来的：真机录音里弹对的 40 个拨弦，低八度"赢"的 7 个差距只有
  // 0/3/7/10/11/20/51 音分（打平或擦边），没有一个够 80 → 不会误伤弹对的。
  octaveGuardCents: 80,
};

// match: matchNoteByCandidates(...) 的返回值
export function decideByCandidates(match, opts = {}) {
  const fitMax = opts.fitMax == null ? JUDGE.fitMax : opts.fitMax;
  const ranked = (match && match.ranked) || [];
  const self = ranked.find((x) => x.offset === 0) || null;
  const rival = ranked
    .filter((x) => x.offset !== 0 && JUDGE.rivalOffsets.includes(Math.abs(x.offset)))
    .sort((a, b) => b.score - a.score)[0] || null;
  const best = ranked[0] || null;
  const pass = !!(self && self.mismatch < fitMax && (!rival || self.score > rival.score));
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
  const match = matchNoteByCandidates(spec, sampleRate, fftSize, expectedMidi);
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
