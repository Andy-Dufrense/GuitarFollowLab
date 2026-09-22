// ─────────────────────────────────────────────────────────────────────────────
// 信号分析层：从一帧时域数据里提取"这次弹的是什么"。
//
// 里面全是纯函数式的算法，自己管自己的跨帧状态（噪声谱、上一帧频谱），
// 不认识界面、也不认识练习内容。上层给它 buffer，它还结果。
// ─────────────────────────────────────────────────────────────────────────────

import {
  decimate, yinPitch, spectrumOf, chromaFromSpectrum, midiToHz, hzToMidi,
} from './dsp.js';
import { OPEN_STRING_MIDI } from './data.js';
import { YIN_SAMPLES, FLUX_N } from './config.js';

// 跨帧状态（都在这里，不外泄）
let lastTrackMs = 0;       // 上一次分析的时刻（算本底吸收用了多少毫秒）
let noiseSpec = null;      // 本底噪声谱
let prevFluxSpec = null;   // 上一帧频谱，用来算通量
let beforeFluxSpec = null; // 再上一帧（通量对比的另一半），起音时当"起音前"基准
let lastMagsShort = null;  // 最近一次短窗频谱，起音时会被抓去做差分基准
let bgSpec = null;         // 逐频点"已经在那儿的能量"（余响会被吸进来）
let lastMagsFull = null;   // 最近一次整窗频谱（和判定用的那一份等长），起音时当差分基准
let lastFluxRise = null;   // 逐频点抬头率：当前帧/上一帧，用来分辨"新的"和"还在衰减的"
let prevRiseSpec = null;   // 抬头率用的"上一帧短窗"频谱
const RISE_N = 512;        // 抬头率的窗长：10.7ms @48k（必须短，理由见 fluxRelOf）

export function resetAnalysis() {
  noiseSpec = null;
  prevFluxSpec = null;
  lastMagsShort = null;
  bgSpec = null;
  lastMagsFull = null;
  lastTrackMs = 0;
  prevShapeSpec = null;      // 换一轮之后不能拿上一轮的频谱形状当基准
  prevHfSpec = null;
  prevRiseSpec = null;
}

// ── 逐频点本底：把"已经在那儿的能量"吸进去，剩下的就是新出现的 ──────────────
//
// 这是整套判定里最要紧的一步，也是最不怕换琴的一步——它只依赖一件事：
// 衰减中的余响只会往下走，新拨的一下会往上跳。这跟音色、麦克风、房间都无关。
//
// 上升慢、下降快：
//   · 余响在衰减 → 本底很快跟着降下去，贴着当前的余响水平
//   · 新拨一下猛地跳上来 → 本底挪得很慢，于是那一瞬间差值很大
//
// 上升速率是反复调出来的：0.02 太慢——上一个和弦响 800ms，本底才吸收了 23%，
// 剩下七成多的余响混进"新出现的能量"里，判定就会被带偏。
// 0.08 大约是 500ms 的时间常数：隔 800ms 能吸掉六成多，
// 而新音进来后 130ms（判定窗口）只被吸掉一成半，不影响判定。
// 上升速率是反复调出来的：0.02 太慢（余响 800ms 才吸掉 23%），0.08 是平衡点。
//
// 试过换成"按毫秒吸收"（上升 150ms 常数），想把连弹时的余响更快吸掉 —— 结果是
// 别的场景反而变差（bughunt 挂 2 项、live 挂 1 项），而延音场景的失配一点没降。
// 原因想明白了：重叠在一起的谐波本来就不可能靠"减本底"分开 ——
// G3 和 E4 的某些谐波就是落在同一个频点上，减掉就把新音也减掉了。
// 所以这条路不是参数问题，是方法问题（见"策略问题清单"第 3 条）。
export function updateBackground(mags) {
  if (!bgSpec || bgSpec.length !== mags.length) {
    bgSpec = Float32Array.from(mags);
    return;
  }
  for (let i = 0; i < mags.length; i++) {
    const v = mags[i];
    bgSpec[i] += (v - bgSpec[i]) * (v > bgSpec[i] ? 0.08 : 0.25);
  }
}

export function novelSpectrum(mags) {
  const out = new Float32Array(mags.length);
  for (let i = 0; i < mags.length; i++) {
    out[i] = Math.max(0, mags[i] - (bgSpec && bgSpec.length === mags.length ? bgSpec[i] : 0));
  }
  return out;
}

export const getLastMagsShort = () => lastMagsShort;
export const getLastMagsFull = () => lastMagsFull;
export const getBackground = () => bgSpec;

// ── 基础工具 ─────────────────────────────────────────────────────────────────
export function spectralMagAt(mags, sr, fftSize, hz) {
  const binHz = sr / fftSize;
  const k = hz / binHz;
  const k0 = Math.floor(k);
  if (k0 < 1 || k0 + 1 >= mags.length) return 0;
  const f = k - k0;
  return mags[k0] * (1 - f) + mags[k0 + 1] * f;
}

// 某个音的各次谐波位置上有多少能量（高次谐波按 1/h² 递减）
export function noteSalience(mags, sr, fftSize, midi) {
  const f0 = midiToHz(midi);
  let s = 0;
  for (let h = 1; h <= 5; h++) {
    const f = f0 * h;
    if (f > sr / 2 - 200) break;
    s += spectralMagAt(mags, sr, fftSize, f) / (h * h);
  }
  return s;
}

// 用频谱把 YIN 的估计修准。
//
// 为什么需要这一步：琴弦有刚性，第 k 次谐波实际是 k·f0·√(1+B·k²)，
// 比整数倍略高一点点。音色亮（高次谐波强）的时候，YIN 的差分函数会被这些
// 偏高的谐波带着走，读数偏高 —— 实测真实钢弦量级（B≈0.0008）能偏高 45 音分，
// 一取整就变成隔壁那个半音，判定成"高了 1 个半音"，永远过不去。
// （最典型的就是一弦空弦 E4，它在琴上最亮。）
//
// 但频谱上"基频那个峰"的位置是准的 —— 刚性把它抬高得很少（k=1 时几乎为零）。
// 所以在 YIN 的估计附近 ±1 个半音里找出那个峰，用它的位置当结果。
// 范围限制在 ±1 个半音是关键：找太远会跳到某个谐波上去。
export function refineBySpectrum(mags, sr, fftSize, hzHint) {
  const binHz = sr / fftSize;
  const lo = Math.max(1, Math.floor((hzHint * Math.pow(2, -1 / 12)) / binHz));
  const hi = Math.min(mags.length - 2, Math.ceil((hzHint * Math.pow(2, 1 / 12)) / binHz));
  let kMax = -1, vMax = 0;
  for (let k = lo; k <= hi; k++) if (mags[k] > vMax) { vMax = mags[k]; kMax = k; }
  if (kMax < 1 || vMax <= 0) return hzHint;

  // 抛物线插值，把 bin 精度提高一个量级
  const a = mags[kMax - 1], b = mags[kMax], c = mags[kMax + 1];
  const denom = a + c - 2 * b;
  const delta = Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0;
  const f = (kMax + Math.max(-0.5, Math.min(0.5, delta))) * binHz;

  // 峰要够突出才采信，否则（比如基频太弱）宁可用原来的估计
  const floor = Math.min(a, c);
  if (floor > 0 && b / floor < 1.4) return hzHint;
  return f;
}

// 把 pitch 就地修准。注意 fftSize 必须传"实际做 FFT 的点数"，
// 不是缓冲区长度——dec 的长度可能不是 2 的幂（spectrumOf 会往下取到 2 的幂）。
function fixPitchBySpectrum(pitch, mags, sr, fftSize) {
  if (!(pitch.hz > 0)) return;
  const realFft = 1 << Math.floor(Math.log2(fftSize));
  const fixedHz = refineBySpectrum(mags, sr, realFft, pitch.hz);
  const cents = 1200 * Math.log2(fixedHz / pitch.hz);
  if (Math.abs(cents) < 120) {           // 修正幅度限制在一个半音内
    pitch.hz = fixedHz;
    pitch.midi = hzToMidi(fixedHz);
  }
}

// 频谱差分：把"起音之前就已经在响的东西"减掉，剩下的就是这个新弹的音。
// 快速演奏时前一个音还没停，混在一起波形根本不周期，YIN 测不出来；
// 但减法可以把它去掉。
export function diffMags(cur, ref) {
  const n = Math.min(cur.length, ref.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, cur[i] - ref[i]);
  return out;
}

// 把观测到的音级整体转调（变调夹用）
export function rotateChroma(chroma, semis) {
  const out = new Array(12).fill(0);
  for (let i = 0; i < 12; i++) out[(((i + semis) % 12) + 12) % 12] = chroma[i];
  return out;
}

// 兜底判定：通用音高检测不可靠时，改成问"新出来的这一坨能量更像哪个音"。
// 这正是"知道标准答案"的好处——不用回答"这是什么音"，
// 只需要回答"它是不是谱上要的那个音，还是旁边那几个"。
// 比较对象必须包含上下八度，不然 E3 的二次谐波会让 E4 蒙混过关。
export function matchTargetBySalience(dmags, sr, fftSize, targetMidi) {
  const mine = noteSalience(dmags, sr, fftSize, targetMidi);
  if (mine <= 0) return { ok: false, mine: 0, best: 0 };
  let best = 0;
  for (const d of [-12, -2, -1, 1, 2, 12]) {
    best = Math.max(best, noteSalience(dmags, sr, fftSize, targetMidi + d));
  }
  return { ok: mine > best * 1.08, mine, best };
}

// ── 候选音比较：不预设音色，也不用任何绝对阈值 ────────────────────────────────
//
// 思路：既然知道谱面上该弹什么，就不必问"这是什么音"，只问
// **"新出现的这坨能量，最像哪一个候选音的谐波结构"**。
//
// 为什么这样就不吃音色：打分函数对目标音和它的常见错法用的是同一套算法，
// 换把琴、换个手机、换个房间，这些系统性因素对所有候选是同等影响，一比较就抵消。
// 我们不需要知道这把琴的泛音分布，只需要知道"谐波出现在整数倍位置上"这件事——
// 那是物理决定的，任何吉他、任何拨弦方式都成立。
//
// 顺带把两个以前要专门打补丁的事解决了：
//   · 八度：A2 的谐波是 110/220/330…，A3 是 220/440/660…。
//     弹 A2 时，A3 的候选只能命中它的一半谐波（110、330… 那些奇数谐波它没有），
//     分数天然低一截。不需要"查低八度基频存不存在"那种特判。
//   · 琴弦刚性（高次谐波偏高）：不知道这把琴的刚性系数，就**几个都试一遍**，
//     取最好的那个。这比猜一个系数可靠。

// 琴弦刚性系数：不同琴、不同弦都不一样，所以不猜，全部试一遍
const STRETCHES = [0, 0.0002, 0.0005, 0.0010];

// 某个候选音的谐波位置上，新出现了多少能量
function harmonicScore(novel, sr, fftSize, midi, stretch) {
  const binHz = sr / fftSize;
  const f0 = midiToHz(midi);
  let s = 0;
  for (let k = 1; k <= 10; k++) {
    const f = f0 * k * Math.sqrt(1 + stretch * k * k);
    if (f > sr / 2 - 300) break;
    // 在预期位置 ±40 音分里取最大值：容忍频率估计的误差
    const lo = Math.max(1, Math.floor((f * Math.pow(2, -40 / 1200)) / binHz));
    const hi = Math.min(novel.length - 2, Math.ceil((f * Math.pow(2, 40 / 1200)) / binHz));
    let m = 0;
    for (let i = lo; i <= hi; i++) if (novel[i] > m) m = novel[i];
    s += m / Math.sqrt(k);
  }
  return s;
}

function bestScore(novel, sr, fftSize, midi) {
  let best = 0;
  for (const st of STRETCHES) best = Math.max(best, harmonicScore(novel, sr, fftSize, midi, st));
  return best;
}

// ── 双向失配（Two-Way Mismatch，Maher & Beauchamp 1994 的简化版）──────────────
//
// 上面那个"谐波求和"有个致命弱点（实测撞到的）：它只会看
// **"该有能量的地方有没有能量"，从不问"该有的地方缺了没有"**。
// 于是谐波系列互相包含的音会互相蹭分：
//   · 低八度候选（E1）把 E2 的每个谐波都当成自己的第 2、4、6… 次谐波，
//     该有的 41.2Hz / 123.6Hz 一个都没有，却照样拿高分；
//   · 高八度候选（E3）把 E2 的偶数次谐波当成自己的第 1、2 次谐波，
//     蹭到的还全是权重最高的低次项（先扫 C 和弦再弹六弦 E2 判成 E3 就是这么来的）。
//
// 双向失配把这两个方向都堵上：
//   P2O（预测→观测）：我预测该有的每个谐波，观测里有没有？缺了记一笔。
//   O2P（观测→预测）：观测里冒出来的每个峰，我能不能解释？解释不了记一笔。
//
// 单位是**音分** —— 音分是音乐上的固定尺度（半音=100 音分），不是为了凑这套算法
// 才定的阈值，所以它不违背"不预设音色、不用绝对阈值"这条原则：
// 失配是拿"观测"和"预测"两边互相比出来的，换把琴、换个手机只影响绝对幅度，
// 不影响"峰在哪里、离预测位置多少个音分"。
//
// 另一件顺带解决的事：只有把两边的账都算上，才谈得上"这坨能量到底更像谁"。
// 以前打分只看分子（能量），现在分母（缺了哪些、多了哪些）也进来了。
// 失配的封顶值。为什么不能小：把"偏 48 音分"和"偏 246 音分"都截成 40，
// 两者就分不出来了 —— 实测偏低近半个音时，会被判成"听到 F#2"（差两个半音），
// 全因为超过了 40 音分的部分被一视同仁地截掉。取 150 音分（一个半音多一点），
// 既能让"差一点"和"差得远"分得开，又不至于让远处的候选靠巧合占便宜。
const CENTS_TOL = 150;
const PARTIAL_COUNT = 10;     // 最多看到第 10 次谐波

function centsBetween(hzA, hzB) {
  return Math.abs(1200 * Math.log2(hzA / hzB));
}

// 观测到的峰：novel 频谱里**最强的 N 个**局部极大值。
//
// 为什么是"最强的 N 个"而不是"超过某个幅度的所有峰"：实测发现后者根本不能用。
// novel 是"当前频谱减去本底"，音一衰减，novel 里剩下的基本就是噪声起伏；
// 用"最大值的 8%"当门限时，一帧能挑出 400 多个噪声小峰（见 probe-octave 的输出），
// 失配的账全被噪声占满，判定随机。
//
// 取最强的 N 个是纯相对的选择：不管信号多响、多轻，永远只有 N 个峰参与比较，
// 而且噪声峰天然排在真正的谐波峰后面。N 取 12，和"最多看 10 次谐波"配得上。
const MAX_PEAKS = 12;

function observedPeaks(novel, count = MAX_PEAKS) {
  const cands = [];
  for (let i = 1; i < novel.length - 1; i++) {
    const v = novel[i];
    if (v > novel[i - 1] && v >= novel[i + 1]) cands.push({ bin: i, mag: v });
  }
  cands.sort((a, b) => b.mag - a.mag);
  return cands.slice(0, count);
}

// 试过在挑峰时按"新度"（novel/(novel+本底)）过滤，想直接排除还在响的那根弦。
// 真机录音上确实有效果：原来"目标 E4 判成还在响的 B3""目标 G3 判成低八度 G2"
// 这种**自信的错判**，变成了"听不清…分不开"。但合成回归被它打挂（live 3 项、
// bughunt 2 项），所以没有采用 —— 需要的是下面这条更大的改动，不是在这儿加筛子。
//
// 结论（真机数据得出的）：目标 G3 在 B3/E4 还在响时仍然认不出来，
// 说明"减本底 + 挑新峰"救不回来。要救必须换问题：
// 跟弹模式下已知该弹哪个音 —— 不问"这是什么音"（开集），只问
// "谱上这个音，在它自己的时间片里出现了没有"（闭集验证），
// 并且候选只用时间轴上真正可能的那几个（不再放 ±5、±12 进来抢票）。

function mismatchOf(peaks, binHz, sr, midi, stretch) {
  const f0 = midiToHz(midi);
  const partials = [];
  for (let k = 1; k <= PARTIAL_COUNT; k++) {
    const f = f0 * k * Math.sqrt(1 + stretch * k * k);
    if (f > sr / 2 - 300) break;
    partials.push({ k, hz: f });
  }
  if (!partials.length) return { p2o: CENTS_TOL, o2p: CENTS_TOL, total: 2 * CENTS_TOL };

  // P2O：预测的谐波，去观测里找。缺得越远、缺得越多（低次谐波权重高），扣得越多。
  let wSum = 0, p2o = 0;
  for (const p of partials) {
    const w = 1 / Math.sqrt(p.k);
    wSum += w;
    let best = CENTS_TOL;
    for (const pk of peaks) {
      const c = centsBetween(pk.bin * binHz, p.hz);
      if (c < best) best = c;
    }
    p2o += w * best;
  }
  p2o = wSum > 0 ? p2o / wSum : CENTS_TOL;

  // O2P：观测到的峰，去预测里找。越响的峰解释不了，扣得越多。
  let mSum = 0, o2p = 0;
  for (const pk of peaks) {
    let best = CENTS_TOL;
    for (const p of partials) {
      const c = centsBetween(pk.bin * binHz, p.hz);
      if (c < best) best = c;
    }
    o2p += pk.mag * best;
    mSum += pk.mag;
  }
  o2p = mSum > 0 ? o2p / mSum : CENTS_TOL;

  return { p2o, o2p, total: p2o + o2p };
}

// 分数 = 1 / 失配。越大越好，且两个候选的比值就是"失配差几倍"，跟幅度无关。
function mismatchScore(peaks, binHz, sr, midi) {
  let best = Infinity, bestDetail = null;
  for (const st of STRETCHES) {
    const m = mismatchOf(peaks, binHz, sr, midi, st);
    if (m.total < best) { best = m.total; bestDetail = m; }
  }
  return { score: 1 / (best + 1e-6), mismatch: best, detail: bestDetail };
}

// 给一个（可以是小数个半音的）音高，返回它在这帧观测下的失配（单位：音分）。
// 用途是判断"琴准不准"：把目标音整体挪 ±半个音，看是不是解释得更好。
export function candidateMismatch(novel, sr, fftSize, midiFloat) {
  return mismatchScore(observedPeaks(novel), sr / fftSize, sr, midiFloat).mismatch;
}

// ── 知道答案的判定：在期望音附近搜最佳基频 ─────────────────────────────────
//
// 这是"调音器"的思路，也是唯一在真机录音上站得住的判据：
// 不去问"这是什么音"（开集），而是在**期望音 ±1 个半音**的范围内，
// 以 5 音分为步长扫一遍 f0，看哪个 f0 的谐波能量最能解释这帧的谱。
// 用户弹对了，最佳 f0 必然落在他弹的那个音上（偏差几十音分以内）；
// 弹成别的半音，最佳 f0 会跑到隔壁去 —— 于是"对/错"变成一次比较，而不是识别。
//
// 为什么比之前那套稳：只搜很窄的范围（±1 半音），不需要跟 ±5/±12 那些候选抢票；
// 而且用**所有谐波加权求和**，不依赖基频本身有多强（手机麦克风压掉基频也不怕）。
export function estimateF0Near(novel, sr, fftSize, expectedMidi, opts = {}) {
  const rangeCents = opts.rangeCents ?? 100;
  const stepCents = opts.stepCents ?? 5;
  const maxHarm = opts.maxHarm ?? 10;
  // 每个谐波位置允许的偏差。原来给 ±40 音分太宽：基频越低、越多谐波能"蹭"到强谱峰，
  // 最优解被系统性往下拉（实测偏差集中在 -60~-100 音分）。
  const tolCents = opts.tolCents ?? 15;
  const binHz = sr / fftSize;
  // tuneCents：本次演奏的整体/按弦音准偏移。所有候选频率一起平移，
  // 这样"哪个半音更像"的比较就不受"琴没调准"影响。
  const tune = opts.tuneCents ?? 0;
  const f0e = midiToHz(expectedMidi) * Math.pow(2, tune / 1200);

  const sumAt = (f0) => {
    let s = 0, wSum = 0;
    for (let k = 1; k <= maxHarm; k++) {
      const f = f0 * k;
      if (f > sr / 2 - 200) break;
      // 取该位置 ±tolCents 内的最大谱值
      const lo = Math.max(1, Math.floor((f * Math.pow(2, -tolCents / 1200)) / binHz));
      const hi = Math.min(novel.length - 2, Math.ceil((f * Math.pow(2, tolCents / 1200)) / binHz));
      let m = 0;
      for (let i = lo; i <= hi; i++) if (novel[i] > m) m = novel[i];
      const w = 1 / Math.sqrt(k);
      s += m * w;
      wSum += w;
    }
    // 必须按"实际用到的谐波个数"归一化：否则基频越低、带内谐波越多、总分越高，
    // 扫描结果会被系统性地推向搜索范围的边缘（实测：偏差总是 ±95~100 音分）。
    return wSum > 0 ? s / wSum : 0;
  };

  let bestF0 = f0e, bestScore = -1;
  for (let c = -rangeCents; c <= rangeCents; c += stepCents) {
    const f0 = f0e * Math.pow(2, c / 1200);
    const s = sumAt(f0);
    if (s > bestScore) { bestScore = s; bestF0 = f0; }
  }
  // 邻音（±1、±2 个半音）的强度：用来判断"是不是弹成了别的音"
  let rivalScore = 0, rivalMidi = null;
  for (const d of [-2, -1, 1, 2]) {
    const s = sumAt(midiToHz(expectedMidi + d) * Math.pow(2, tune / 1200));
    if (s > rivalScore) { rivalScore = s; rivalMidi = expectedMidi + d; }
  }
  const cents = 1200 * Math.log2(bestF0 / f0e);
  // 最优解贴在搜索边界上 → 属于"测不准"，不该当"你弹错了"
  const atEdge = Math.abs(cents) >= rangeCents - stepCents * 1.5;
  return { f0: bestF0, cents, score: bestScore, rivalScore, rivalMidi, energy: sumAt(f0e), atEdge };
}

// ── 音高测量（判定用的那一把尺子）：谐波峰 + 抛物线插值 + 最小二乘 ──────────────
//
// 为什么需要它：estimateF0Near 是在"期望音附近扫 f0、每个谐波取 ±15 音分内**最高那根谱线**"。
// 一根谱线有多宽？8192 点 @48k 是 5.86Hz —— 在 261Hz（C4）处就是 **39 音分**、
// 在 349Hz（F4）处 29 音分。也就是说那个读数天生是"一根谱线一根谱线"跳的，
// 实测散布 ±80 音分。而一个半音才 100 音分 —— 所以"按低一品/按高一品"根本分不开。
//
// 调音器怎么做到很准：对加窗后的谱在峰附近**做抛物线插值**，取到一根谱线的百分之几。
// 这里用同一招，再加一步"多个谐波一起最小二乘"：只用一个谐波容易被别的弦撞上，
// 五六个谐波一起投票就稳得多。模型带**弦刚性**（真实琴弦的谐波比整数倍略高，
// 不建这个模型就会把"谐波偏高"读成"基频偏高"）：f_k = k·f0·sqrt(1 + B·k²)。
//
// 实测（用户那段 30 秒 Hey Jude 录音，40 个音，按弦音准校正之后）：
//   中位误差 45 → 16 音分，90 分位 90 → 36，落在 ±50 音分内 53% → 98%。
// 量法见 test/probe-estimator.mjs。
const STRETCH_BETAS = [0, 0.00002, 0.00005, 0.0001, 0.0002, 0.0004, 0.0008, 0.0016];

// 在 f 附近 ±tolCents 内找最高谱线，再用 log 幅度做抛物线插值取次谱线精度。
function peakNear(mags, binHz, f, tolCents) {
  const lo = Math.max(1, Math.floor((f * Math.pow(2, -tolCents / 1200)) / binHz));
  const hi = Math.min(mags.length - 2, Math.ceil((f * Math.pow(2, tolCents / 1200)) / binHz));
  let bi = -1, bv = -1;
  for (let i = lo; i <= hi; i++) if (mags[i] > bv) { bv = mags[i]; bi = i; }
  if (bi <= 0 || bi >= mags.length - 1 || bv <= 0) return null;
  const a = Math.log(mags[bi - 1] + 1e-15);
  const b = Math.log(mags[bi] + 1e-15);
  const c = Math.log(mags[bi + 1] + 1e-15);
  const den = a - 2 * b + c;
  // 抛物线顶点；夹在 ±0.5 根谱线内（超出说明这三根谱线不是一个峰）
  const d = den !== 0 ? 0.5 * (a - c) / den : 0;
  return { hz: (bi + Math.max(-0.5, Math.min(0.5, d))) * binHz, mag: bv };
}

// 返回 f0（Hz）、相对期望音的音分、拟合用的谐波数、残差（音分，越小说明越像"一根弦"）
// 抬头权重：这一带在起音那一刻抬了多少（rise=1 表示没变，<1 表示在衰减）。
function freshOf(p, rise, riseBinHz, B, f0) {
  if (!rise || !(riseBinHz > 0)) return 1;
  const f = p.k * f0 * Math.sqrt(1 + B * p.k * p.k);
  const idx = Math.round(f / riseBinHz);
  if (idx < 0 || idx >= rise.length) return 1;
  return Math.max(0, Math.min(3, rise[idx] - 0.5));
}

export function estimateF0ByPeaks(mags, sr, fftSize, expectedMidi, opts = {}) {
  const binHz = sr / fftSize;
  const maxHarm = opts.maxHarm ?? 12;
  const tolCents = opts.tolCents ?? 60;      // 找峰范围放宽：我们在找"峰"，不是在做判定
  // 可选：按"起音时这一带抬没抬头"给每个谐波峰加权。
  // 判定"是不是这个音"时必须有这一层：上一个音还在响，它的谐波不抬头（rise<1），
  // 不加权的话"上一音那个音名"会一直赢（真机录音实测：21 处假判错全是上一音）。
  const rise = opts.rise || null;
  const riseBinHz = opts.riseBinHz || 0;
  const f0c = midiToHz(expectedMidi);
  const nyq = sr / 2 - 200;
  const peaks = [];
  for (let k = 1; k <= maxHarm; k++) {
    const f = f0c * k;
    if (f > nyq) break;
    const p = peakNear(mags, binHz, f, tolCents);
    if (p) peaks.push({ k, hz: p.hz, mag: p.mag });
  }
  if (!peaks.length) return { f0: f0c, cents: 0, score: 0, nHarm: 0, beta: 0, resid: Infinity };
  let best = null;
  for (const B of STRETCH_BETAS) {
    let use = peaks, f0 = f0c;
    for (let pass = 0; pass < 3; pass++) {          // 迭代：把不像这一族的峰踢出去
      let num = 0, den = 0;
      const kept = [];
      // 权重：按"这根峰有多强"给（归一化到最强的那个峰）。
      // 原来是 min(1, mag) —— 所有够响的峰都封顶成 1，等于**弱的杂峰跟真的谐波等价**，
      // 搜索范围边缘上随便一个弱峰就能把最小二乘拽走（实测同一个音，窗尾差 6ms，
      // 读数从 -25 音分跳到 -101 音分）。改成按强度成比例，弱峰自然说话没分量。
      // 默认封顶（'cap'）：谱线幅度 ≤1 时它等于按强度成比例；幅度大（信号响）时不封顶
      // 会让"已经很响的那个峰"继续放大权重 —— 合成回归里那个"按高了一品"的例子
      // 就是被这个翻掉的（cap 能判错，prop 判不过）。
      const wMode = opts.magWeight ?? 'cap';
      let wRef = 0;
      if (wMode === 'prop') for (const p of use) if (p.mag > wRef) wRef = p.mag;
      if (!(wRef > 0)) wRef = 1;
      for (const p of use) {
        const s = Math.sqrt(1 + B * p.k * p.k);
        const dev = p.hz - p.k * f0 * s;
        if (pass > 0 && Math.abs(dev) > 2.5 * binHz * p.k) continue;
        const w = wMode === 'prop' ? p.mag / wRef : Math.min(1, p.mag);
        num += w * p.k * s * p.hz;
        den += w * (p.k * s) * (p.k * s);
        kept.push(p);
      }
      if (!den) break;
      f0 = num / den;
      if (kept.length) use = kept;
    }
    let r = 0;
    let w = 0;
    for (const p of use) {
      r += Math.pow(1200 * Math.log2(p.hz / (p.k * f0 * Math.sqrt(1 + B * p.k * p.k))), 2);
      w += p.mag * freshOf(p, rise, riseBinHz, B, f0);
    }
    const resid = Math.sqrt(r / Math.max(1, use.length));
    const score = rise ? w : use.reduce((s, p) => s + p.mag, 0);
    // 选模型：残差 **加上"丢掉的谐波数"的罚分**。
    // 只比残差会奖励"把不好拟合的谐波扔掉"的模型：弦刚性 B 越大、能扔的越多，
    // 残差就越小 —— 实测就是它把 G3 读成了 F#3（-109 音分）：
    //   B=0.0004 → 12 个谐波全在，残差 49.7 → f0=194.2Hz（G3，-16 音分）✓
    //   B=0.0016 → 扔掉 2 个谐波，残差 45.2 → f0=184.1Hz（F#3，-109 音分）✗ 但它"残差更小"
    // 罚分按"每个被丢掉的谐波 20 音分"算：宁可承认拟合差一点，也不能靠丢数据取胜。
    const missing = Math.max(0, peaks.length - use.length);
    const quality = resid + 20 * missing;
    // 自检：拟合出来的 f0 要跟**基频那个峰**对得上。
    // 上一个音还在响、而这个音比它高一个全音时，谐波梳子会锁到两者中间
    // （实测：谱面 G3、谱里最强谱线就是 199Hz 的 G3，拟合却给出 184Hz 的 F#3）。
    // 基频峰够强的时候，用它当"这把尺子量歪了没有"的检查；歪太多就记不可信。
    const p1 = use.find((p) => p.k === 1) || null;
    const maxMag = use.reduce((s, p) => Math.max(s, p.mag), 0);
    const fundCents = p1 ? Math.abs(1200 * Math.log2(p1.hz / f0)) : null;
    const fundTrusted = !!(p1 && maxMag > 0 && p1.mag >= 0.25 * maxMag);
    if (!best || quality < best.quality - 0.5) {
      best = { f0, beta: B, resid, nHarm: use.length, score, fundCents, fundTrusted, quality };
    }
  }
  return {
    f0: best.f0, cents: 1200 * Math.log2(best.f0 / f0c),
    score: best.score, nHarm: best.nHarm, beta: best.beta, resid: best.resid,
    fundCents: best.fundCents, fundTrusted: best.fundTrusted,
  };
}

// 候选集：目标音本身 + 常见错法。都是"相对目标"的位置，跟音色无关。
// ── 验证式判定：已知该弹哪个音时，别再问"这是什么音" ──────────────────────────
//
// 真机录音逼出来的结论：手机录的 Em-T3231323，起音 8 次全检到，但 7 个判定错 4 个，
// 错法固定 —— 目标 E4 判成还在响的 B3、目标 G3 判成 G2。因为 341ms 的采集窗里
// 装着上一根弦的音，而"开集识别"（问这是谁）永远会被那个还在响的音抢走。
//
// 换个问法就没这个问题：**谱上这个音，在它该出现的时候出现了没有？**
// 强度按"新度"（novel/(novel+本底)）加权：还在响的弦新度低，贡献被压下去；
// 刚拨的那一下新度高，说话就算数。对手只留"手上真会错成的邻居"（±1、±2 个半音，
// 以及八度），不再把 ±5 放进来抢票。
function noteStrength(novel, bg, sr, fftSize, midi, stretch, rise, riseBinHz) {
  const binHz = sr / fftSize;
  const f0 = midiToHz(midi);
  let s = 0;
  for (let k = 1; k <= 10; k++) {
    const f = f0 * k * Math.sqrt(1 + stretch * k * k);
    if (f > sr / 2 - 300) break;
    // 起音瞬间这个谐波位置"抬头"了吗？没抬头的频点要打折 ——
    // 上一根弦的余响就待在这些频点上，它只会往下走。
    let fresh = 1;
    if (rise && riseBinHz > 0) {
      const idx = Math.round(f / riseBinHz);
      if (idx >= 0 && idx < rise.length) fresh = Math.min(4, Math.max(0.15, rise[idx]));
    }
    const lo = Math.max(1, Math.floor((f * Math.pow(2, -40 / 1200)) / binHz));
    const hi = Math.min(novel.length - 2, Math.ceil((f * Math.pow(2, 40 / 1200)) / binHz));
    let best = 0;
    for (let i = lo; i <= hi; i++) {
      const v = novel[i] * fresh;
      if (v > best) best = v;
    }
    s += best / Math.sqrt(k);
  }
  return s;
}

export function verifyExpectedNote(novel, bg, sr, fftSize, targetMidi, rise = null, riseBinHz = 0) {
  const best = (midi) => {
    let m = 0;
    for (const st of STRETCHES) {
      m = Math.max(m, noteStrength(novel, bg, sr, fftSize, midi, st, rise, riseBinHz));
    }
    return m;
  };
  const mine = best(targetMidi);
  let rival = 0;
  let rivalMidi = null;
  // 对手只留"手上真会错成的邻居"：按偏一品（±1、±2 个半音）。
  // 刻意**不放**低八度（-12）：谱面已经告诉我们该弹哪个音，而低八度假设
  // 天生占便宜（f/2 能把 f 的全部谐波解释成自己的偶数次谐波），
  // 真机录音里那点低频噪声又刚好喂给它 —— 放进来就必然在同一个地方反复输。
  // ±5 也不放：那是"上一根弦"（E4 往下 5 个半音正好是 B3），
  // 让还在响的弦当候选，等于自己把票投给它。
  for (const d of [-1, 1, -2, 2]) {
    const s = best(targetMidi + d);
    if (s > rival) { rival = s; rivalMidi = targetMidi + d; }
  }
  return { mine, rival, ratio: rival > 0 ? mine / rival : 99, rivalMidi };
}

const CANDIDATE_OFFSETS = [0, -1, 1, -2, 2, -12, 12, -5, 5];

// 音准扫描：在目标附近按四分之一音步进，看"往哪个方向挪一点最像"。
// 得到的不是"这个音有多高"（那是开集测量），而是**比谱上那个音偏了多少**——
// 纯相对量，跟音色、麦克风、房间都无关。
// 用途是分辨三件事：琴略不准（≤40 音分，照样判过）、卡在两个半音中间（该调弦）、
// 弹的是别的音（±1 个半音以上，判错）。
const DETUNE_STEPS = [0, -0.25, 0.25, -0.5, 0.5, -0.75, 0.75, -1, 1];
const OFF_SEMITONE_CENTS = 40;   // 四分之一音。和 CENTS_TOL 同源，都是音乐上的固定量

// 这台乐器**弹得出来**的音域：最低的那根空弦 → 最高那根弦的 24 品。
// 这不是猜的阈值，是吉他的物理约束（标准调弦就是六弦空弦 E2 = MIDI 40 封底）。
//
// 为什么必须用它：实测"先扫 C 和弦、再弹六弦空弦 E2"这个场景里，
// 真正的竞争者是**低一个八度的 E1**（41Hz）—— 它把 E2 每个谐波都当成自己的
// 偶数次谐波，余响一多就跟 E2 打平。可 E1 在这把琴上根本不存在，
// 留着它只会制造平局。排除掉之后，判定就回到"E2 还是 E3"这个真问题上。
const OPEN_MIDI_LIST = Object.values(OPEN_STRING_MIDI);
const LOWEST_MIDI = Math.min(...OPEN_MIDI_LIST);
const HIGHEST_MIDI = Math.max(...OPEN_MIDI_LIST) + 24;

// 判过所需的领先倍数（相对比值，跟音色无关）。
// 这个数是拿校准用例量出来的，不是拍的 —— 见 test/test-live.mjs 第 1、2、12 组
// 和 test/test-detect.mjs 的 A、B 组。改打分函数就要重新标这一条。
const MARGIN_OK = 1.08;

// 曾经想再加一条"像不像"的绝对下限（失配 ≤ 75 音分才算过），用音分当尺子。
// 单独看很有道理（真音 30~56 音分，C 和弦冒充 E2 是 91 音分），但放到
// "不消音连弹 + 手机频响"的场景里就误伤了：真音的失配能涨到 140~185 音分
// （重叠的谐波本来就分不开），绝对门槛会把真音也毙掉。
// 结论：这条路取决于"能不能把重叠的谐波分开"，是方法问题，不是阈值问题。
// 判过仍然只靠相对倍数 —— 假通过的风险改由"补测"（多等 40ms 让它衰减清楚）来兜。

export function matchNoteByCandidates(novel, sr, fftSize, targetMidi, capo = 0) {
  // 峰表只算一次，9 个候选共用
  const peaks = observedPeaks(novel);
  const binHz = sr / fftSize;
  const lo = LOWEST_MIDI + capo;
  const hi = HIGHEST_MIDI + capo;
  const ranked = CANDIDATE_OFFSETS.map((d) => {
    const midi = targetMidi + d;
    const m = mismatchScore(peaks, binHz, sr, midi);
    // signal 仍然用"谐波上有没有能量"来量，它回答的是另一个问题：
    // "到底有没有声音"，用来区分"弹错了"和"根本没弹/太轻听不见"。
    const signal = bestScore(novel, sr, fftSize, midi);
    return { midi, offset: d, score: m.score, mismatch: m.mismatch, detail: m.detail, signal };
  }).filter((x) => x.midi >= lo && x.midi <= hi)      // 弹不出来的音不当候选
    .sort((a, b) => b.score - a.score);

  // 注意这里必须容得下"候选为空"：目标音本身也可能不在音域里（比如调用方传了
  // 一个和弦事件，targetMidi 是 undefined）。以前这种情况下会算出全 0 分不报错，
  // 现在候选会被音域过滤掉，所以要显式兜底，不能想当然地认为 find 一定有结果。
  const self = ranked.find((x) => x.offset === 0) || null;
  const other = ranked.find((x) => x.offset !== 0) || null;
  const mine = self ? self.score : 0;
  const runnerUp = other ? other.score : 0;
  const margin = mine <= 0 ? 0 : (runnerUp > 0 ? mine / runnerUp : 99);

  // 音准扫描：在目标附近按四分之一音步进，找"挪多少最像"。
  // 这一步只在目标音本身还算说得通的时候才有意义（否则是在给错音找借口）。
  let detuneSemis = 0;
  let detuneMismatch = self ? self.mismatch : 0;
  if (self && self.mismatch < CENTS_TOL) {
    for (const d of DETUNE_STEPS) {
      if (d === 0) continue;
      const m = mismatchScore(peaks, binHz, sr, targetMidi + d).mismatch;
      if (m < detuneMismatch) { detuneMismatch = m; detuneSemis = d; }
    }
  }
  const detuneCents = detuneSemis * 100;

  return {
    // 判过的线（相对比值，跟音色无关）。双向失配这把尺子比原来的谐波求和更利，
    // 所以这个倍数重新标过 —— 校准用例见 test/test-live.mjs 的第 1、2、12 组。
    ok: mine > 0 && margin > MARGIN_OK,
    mine,
    runnerUp,
    runnerUpMidi: other ? other.midi : null,
    margin,
    signal: self ? self.signal : 0,
    fit: self ? self.mismatch : Infinity,
    detuneSemis,
    detuneCents,
    // 音准没落在半音上（卡在两个半音之间）→ 该提示调弦，而不是判对或判错
    offSemitone: Math.abs(detuneCents) >= OFF_SEMITONE_CENTS && Math.abs(detuneSemis) < 1,
    peaks,
    ranked,
  };
}

// ── 每帧都要跑的轻量分析 ─────────────────────────────────────────────────────
// 更新本底噪声谱，并返回最近一次短窗频谱（起音时要拿它当差分基准）。
export function track(buf, decim, sr2) {
  const dec = decimate(buf, decim);
  const n = Math.max(560, YIN_SAMPLES);
  const pitch = yinPitch(dec.subarray(Math.max(0, dec.length - n)), sr2,
    { window: Math.min(1024, n - 80), minHz: 65, maxHz: 1400 });
  const mags = spectrumOf(dec);
  lastMagsFull = mags;
  fixPitchBySpectrum(pitch, mags, sr2, dec.length);
  updateBackground(mags);       // 本底跟着余响走，新拨的一下才突得出来
  lastMagsShort = spectrumOf(dec.subarray(Math.max(0, dec.length - Math.min(2048, dec.length))));

  // 本底噪声谱：每个频点取"缓慢上升、立即下降"的最小值。
  // 安静的时候它会贴到环境噪声上，琴声进来时不会被带着走。
  if (!noiseSpec || noiseSpec.length !== mags.length) {
    noiseSpec = Float32Array.from(mags);
  } else {
    for (let i = 0; i < mags.length; i++) {
      const v = mags[i];
      noiseSpec[i] = v < noiseSpec[i] ? v : noiseSpec[i] * 1.004 + 1e-7;
    }
  }
  return { pitch, mags, magsShort: lastMagsShort, fftN: 1 << Math.floor(Math.log2(dec.length)) };
}

// 频谱通量：这一帧相对上一帧"新增"了多少频谱成分（只算正的变化，归一化）。
//
// 这是解决"延音拖累灵敏度"的关键判据。
// 只看总电平抬升有个致命问题：你让音一直延续，几根弦的余响叠起来的总电平
// 可能比新拨的那一下还响，抬升比例就上不去，于是触发不了 —— 这就是
// "消音再弹很丝滑、延续着弹很迟钝"的原因。
// 而余响只会衰减、不会凭空产生新的频谱成分；新拨一下则会在它自己的谐波位置上
// 冒出一整套新峰。所以看"新增成分占比"，延续不延续都一样灵敏。
export function fluxRelOf(buf) {
  const seg = buf.subarray(Math.max(0, buf.length - FLUX_N));
  const mags = spectrumOf(seg);
  let flux = 0, total = 0;
  for (let i = 0; i < mags.length; i++) {
    const d = mags[i] - (prevFluxSpec && prevFluxSpec.length === mags.length ? prevFluxSpec[i] : 0);
    if (d > 0) flux += d;
    total += mags[i];
  }
  beforeFluxSpec = prevFluxSpec;
  prevFluxSpec = mags;

  // 逐频点"抬头率"：这个频点相对上一帧涨了几倍。**必须用短窗。**
  //
  // 这是把"新拨的音"和"还在衰减的余响"分开的唯一可靠维度 —— 它们在频域上会重合：
  // Em 的 T3231323 里，二弦 B3 的基频 246.94Hz 和六弦 E2 的 3 次谐波 247.23Hz
  // 只差 0.3Hz（同一个频点）；E4(329.63) 与 E2 的 4 次谐波(329.64) 完全重合。
  // 余响只会往下走（比值 < 1），刚拨的一下会往上跳（比值 > 1）。
  //
  // 窗长必须是 512 点（10.7ms）：原来图省事用了 43ms（FLUX_N）那份频谱，
  // 它跟上一帧重叠 27ms，起音被稀释 —— 真机录音实测，长窗下很多音的抬头率
  // 只有 0.9~1.0（看着像"根本没拨"），换 512 点后变成 1.3~69 倍，信号立刻干净。
  const riseMags = spectrumOf(buf.subarray(buf.length - RISE_N));
  if (!lastFluxRise || lastFluxRise.length !== riseMags.length) {
    lastFluxRise = new Float32Array(riseMags.length);
  }
  const prevRise = prevRiseSpec && prevRiseSpec.length === riseMags.length ? prevRiseSpec : null;
  for (let i = 0; i < riseMags.length; i++) {
    lastFluxRise[i] = riseMags[i] / ((prevRise ? prevRise[i] : 0) + 1e-9);
  }
  prevRiseSpec = riseMags;
  return total > 1e-9 ? flux / total : 0;
}

export const getFluxRise = () => lastFluxRise;

// 高频段通量：只看 2kHz 以上的新增成分（拨片/指甲那一瞬的宽带瞬态）。
// 连续相同音（同一根弦同一个音再弹一次）在音高上几乎没有变化，
// 但**高频瞬态一定会有两次爆发** —— 这是 AMT 里把"起音"独立成一条支路的原因
// （Onsets and Frames / Basic Pitch 都是 onset 与 pitch 分开）。
let prevHfSpec = null;
export function hfFluxRelOf(buf) {
  const seg = buf.subarray(Math.max(0, buf.length - FLUX_N));
  const mags = spectrumOf(seg);
  const binHz = (buf.length && 48000) / FLUX_N;         // 48k / 2048 ≈ 23.4Hz
  const from = Math.max(1, Math.floor(2000 / binHz));   // 2kHz 以上
  let flux = 0, total = 0;
  for (let i = from; i < mags.length; i++) {
    const prev = prevHfSpec && prevHfSpec.length === mags.length ? prevHfSpec[i] : 0;
    const d = mags[i] - prev;
    if (d > 0) flux += d;
    total += mags[i];
  }
  prevHfSpec = mags;
  return total > 1e-9 ? flux / total : 0;
}

// ── 频谱"形状"变化（不是音量变化）────────────────────────────────────────────
// 用来分辨"新拨了一下"和"同一个音变响了"：
//   · 拨弦：带进新的泛音/宽带瞬态 → 归一化之后的频谱**形状变了**；
//   · 音量起伏（打拍子、麦克风自动增益、房间反射）：所有频点等比例缩放
//     → 归一化之后的形状**几乎不变**。
// 现有的 flux / hfFlux 都是"绝对幅度"的变化，两种情况都会亮，所以分不开。
// 返回 0~2：0 = 形状完全没变，1 = 正交，2 = 完全反相。
// ── 谐噪比（"这一下像不像一根弦在振"）──────────────────────────────────────
// 各谐波位置"峰的幅度"比"它两侧（挖掉峰本身）的中位幅度"，取中位数。
// 关键在于**挖多宽**：挖 ±25 音分会落在峰自己的裙边里（比值只有 ~2，什么都分不出），
// 挖到 ±120 音分才是真正的"谐波之间的谷"。
// 实测（test/probe-harmonicity.mjs）：干净拨弦 2 万倍以上，白噪声/风/拍桌子 ≈1.6 倍。
//
// 用途：YIN 在"上一个音还在响"的混合信号里会直接放弃（返回 0 音高，见 dsp.js 的注释），
// 于是连续两个快音里的第二个会被当成"不像琴声"丢掉。用这个尺子替代那一道关卡：
// 只要谐波墙立着，就继续判；墙不立（风、拍桌子）才丢。
// ── 谱的"稀疏程度"：拨弦是**线状谱**，风/拍桌子/说话是**连续谱** ──────────────
// 取 200Hz~4kHz 这一段：把最强的若干根谱线的幅度加起来，除以这一段的总幅度。
// 线状谱（琴弦）→ 大部分能量集中在少数谱线上，比值高；连续谱（噪声）→ 摊平，比值低。
// 这条和"谐噪比"不一样：谐噪比看的是"某个音自己的谐波墙"，
// 上一个音还在响时它的谐波会正好落在谷里，墙就立不起来 —— 但**两个都是线状谱**，
// 稀疏程度照样高。所以这条能分开"混合的两个音"和"真正的噪声"。
// ── 谱平坦度：教科书上判断"这是音还是噪声"的标准量 ──────────────────────────
// 几何平均 / 算术平均（都在 200Hz~4kHz 这一段）。
//   · 纯音/谐波（哪怕两个音叠在一起）→ 能量集中在少数谱线上 → 几何平均远小于算术平均 → 接近 0
//   · 噪声（风、拍桌子、说话）→ 谱是平的 → 两者接近 → 接近 1
// 比"谐噪比"和"稀疏度"都稳：前者在"上一个音还在响"时墙立不起来，
// 后者会被频谱倾斜（风偏低频）带偏。平坦度对"整体变亮变暗"不敏感。
// ── 局部峰锐度：能量里有多大比例落在"比旁边明显高"的谱线上 ────────────────────
// 这是最后一把、也是最贴题的一把尺子：它问的不是"形状像不像"，而是
// **"这一段谱到底是一根根立着的线，还是一片平的"**。
//   · 琴弦（哪怕两个音叠在一起）→ 谱线一根根立着，每根都比邻居高一截 → 比例高
//   · 风 / 拍桌子 / 说话 → 谱是毛的，相邻频点差不多 → 几乎没有"比邻居高 30%"的点 → 比例低
// 不受频谱倾斜影响（只比邻居，不比远处），也不受"上一个音还在响"影响（两根线都算）。
export function spectralPeakiness(mags, sr, fftSize, fromHz = 200, toHz = 4000, ratio = 1.3) {
  const binHz = sr / fftSize;
  const lo = Math.max(2, Math.floor(fromHz / binHz));
  const hi = Math.min(mags.length - 3, Math.ceil(toHz / binHz));
  let total = 0, tonal = 0;
  for (let i = lo; i <= hi; i++) total += mags[i];
  if (total <= 0) return 0;
  for (let i = lo; i <= hi; i++) {
    if (mags[i] > mags[i - 1] && mags[i] >= mags[i + 1]) {
      const nb = Math.max(mags[i - 1], mags[i + 1]);
      if (mags[i] > nb * ratio) { tonal += mags[i] + mags[i - 1] + mags[i + 1]; }
    }
  }
  return tonal / (2 * total);
}

export function spectralFlatness(mags, sr, fftSize, fromHz = 200, toHz = 4000) {
  const binHz = sr / fftSize;
  const lo = Math.max(1, Math.floor(fromHz / binHz));
  const hi = Math.min(mags.length - 1, Math.ceil(toHz / binHz));
  if (hi - lo < 8) return 1;
  let logSum = 0, sum = 0, n = 0;
  for (let i = lo; i <= hi; i++) {
    const v = mags[i] + 1e-12;
    logSum += Math.log(v);
    sum += v;
    n++;
  }
  if (!n || sum <= 0) return 1;
  return Math.exp(logSum / n) / (sum / n);
}

export function spectralSparsity(mags, sr, fftSize, fromHz = 200, toHz = 4000, topN = 24) {
  const binHz = sr / fftSize;
  const lo = Math.max(1, Math.floor(fromHz / binHz));
  const hi = Math.min(mags.length - 1, Math.ceil(toHz / binHz));
  if (hi - lo < topN * 2) return 0;
  const vals = [];
  let total = 0;
  for (let i = lo; i <= hi; i++) { vals.push(mags[i]); total += mags[i]; }
  if (total <= 0) return 0;
  vals.sort((a, b) => b - a);
  let top = 0;
  for (let i = 0; i < topN && i < vals.length; i++) top += vals[i];
  return top / total;
}

export function harmonicity(mags, sr, fftSize, f0, excludeCents = 120, maxHarm = 8) {
  const binHz = sr / fftSize;
  const out = [];
  for (let k = 1; k <= maxHarm; k++) {
    const f = k * f0;
    if (f > sr / 2 - 500 || f < 60) break;
    const c = f / binHz;
    const lo = Math.max(1, Math.floor(c * Math.pow(2, -25 / 1200)));
    const hi = Math.min(mags.length - 2, Math.ceil(c * Math.pow(2, 25 / 1200)));
    let pk = 0;
    for (let i = lo; i <= hi; i++) if (mags[i] > pk) pk = mags[i];
    const blo = Math.max(1, Math.floor(c * Math.pow(2, -250 / 1200)));
    const bhi = Math.min(mags.length - 2, Math.ceil(c * Math.pow(2, 250 / 1200)));
    const exLo = Math.floor(c * Math.pow(2, -excludeCents / 1200));
    const exHi = Math.ceil(c * Math.pow(2, excludeCents / 1200));
    const side = [];
    for (let i = blo; i <= bhi; i++) { if (i >= exLo && i <= exHi) continue; side.push(mags[i]); }
    if (side.length < 3) continue;
    side.sort((a, b) => a - b);
    out.push(pk / (side[Math.floor(side.length / 2)] + 1e-12));
  }
  if (!out.length) return 0;
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
}

let prevShapeSpec = null;
export function shapeFluxOf(buf) {
  const seg = buf.subarray(Math.max(0, buf.length - FLUX_N));
  const mags = spectrumOf(seg);
  let dot = 0, na = 0, nb = 0;
  const prev = prevShapeSpec && prevShapeSpec.length === mags.length ? prevShapeSpec : null;
  let d = 0;
  if (prev) {
    // 只看**高频段**（3k~10kHz）：拨弦那一下的"嗒"是新加进来的东西，
    // 而连续两个**相同音**的谐波形状是一样的 —— 全谱比较会把重复音也挡掉
    // （用户实测：连着两个快音会被并成一个音、还判错）。
    // 高频段里：拨弦 → 多出一段新的宽带瞬态（形状变）；音量起伏 → 整体变亮（形状不变）。
    const binHz = 48000 / FLUX_N;
    const from = Math.max(1, Math.floor(3000 / binHz));
    const to = Math.min(mags.length - 1, Math.ceil(10000 / binHz));
    for (let i = from; i <= to; i++) {
      dot += mags[i] * prev[i];
      na += mags[i] * mags[i];
      nb += prev[i] * prev[i];
    }
    if (na > 1e-12 && nb > 1e-12) d = 1 - dot / Math.sqrt(na * nb);
  }
  prevShapeSpec = mags;
  return Math.max(0, Math.min(2, d));
}
export const RISE_WINDOW = RISE_N;
// 起音当场快照用：这一帧和上一帧的 43ms 频谱（同窗长，错开 16ms）。
export const getFluxSpec = () => prevFluxSpec;
export const getBeforeFluxSpec = () => beforeFluxSpec;

// ── 和弦谱的判定：不逐音判，只判"有没有出现和弦外音" ────────────────────────
//
// 为什么和弦谱不能逐音判：和弦音本身就在同一条谐波序列上 —— Em 里
// B3(246.94) ≈ 六弦 E2 的 3 次谐波(247.23)、E4(329.63) = E2 的 4 次谐波(329.64)。
// 上一根弦还在响时，它"物理上就包含了"后面要弹的音，逐音判定必然互相串。
//
// 换个问法就没有这个问题，而且比"识别这是什么音"容易得多：
//   **这次起音冒出来的谱峰，能不能被当前和弦的谐波序列全部解释？**
// 能解释 → 是音内的音；解释不了的那一坨 → 和弦外音（顺手也就知道它是什么音）。
// 这是闭集测试（子集判断），不需要开集识别。
export function chordOutsiders(novel, sr, fftSize, chordMidis, opts = {}) {
  const tol = opts.tolCents ?? 50;
  const maxHarm = opts.maxHarm ?? 8;
  const binHz = sr / fftSize;
  // 和弦所有音的前 maxHarm 次谐波，作为"可以解释"的频率栅格
  const grid = [];
  for (const m of chordMidis) {
    for (let k = 1; k <= maxHarm; k++) {
      const f = midiToHz(m) * k;
      if (f < sr / 2 - 300) grid.push(f);
    }
  }
  // 外音检测要放宽取峰数量：和弦自己的低次谐波又强又多，
  // 只取最强 12 个的话，混进来的外音根本进不了榜（实测只报出个 226Hz 的杂物）。
  const peaks = observedPeaks(novel, opts.maxPeaks ?? 40);
  // 太弱的峰不算"外音"：那是噪声/拍频杂物（实测最大外音报成 229Hz 这种零星杂峰，
  // 真正弹出来的外音反而排在后面）。门限取"本帧最强峰的 8%"，相对量。
  let maxPeak = 0;
  for (const p of peaks) if (p.mag > maxPeak) maxPeak = p.mag;
  const minMag = maxPeak * (opts.minRelative ?? 0.08);
  let total = 0, explained = 0;
  const outsiders = [];
  for (const p of peaks) {
    const hz = p.bin * binHz;
    if (hz < 60) continue;                       // 低频噪声不算
    if (p.mag < minMag) continue;                // 太弱的不算
    let best = Infinity;
    for (const g of grid) {
      const c = Math.abs(1200 * Math.log2(hz / g));
      if (c < best) best = c;
    }
    total += p.mag;
    if (best <= tol) explained += p.mag;
    else outsiders.push({ hz: Math.round(hz), mag: p.mag, centsOff: Math.round(best) });
  }
  outsiders.sort((a, b) => b.mag - a.mag);
  return {
    ratio: total > 0 ? explained / total : 1,     // 被和弦解释掉的能量占比
    total,
    explained,
    outsiders,                                    // 外音（按能量排序）
  };
}

// ── 判定时用的重分析 ─────────────────────────────────────────────────────────
// shorten：听不清补测时缩短音高分析窗。快速演奏时窗里混着好几个还在响的音，
//          窗越短，最新弹的那个就越占主导。Chroma 那一份不缩短——它本来就要长窗。
// needChroma：只在判和弦时才开。算一次 Chroma 要做 61 个音高 × 5 次谐波查表，
//             判单音时根本用不上，开着纯属白算白等。
// 注意：这里**不要**试图把窗缩到"只有这一个音"。
// 试过两种缩窗法，都不行：
//   ① 起音锚定窗（只取起音之后那几十毫秒）：窗口太短，低音的谐波峰估不准，
//      第一条六弦空弦就被判成"卡在两个半音中间，去调弦"；
//   ② 用起音前的整窗做差分（diffMags）：两个 341ms 的窗内容大部分重叠，
//      相减互相抵消，差分出来基本是零 —— 这是 HANDOFF 里记过的坑，我又踩了一次。
// 连弹（<250ms 一个音）的正确解法在架构上：跟弹模式下已经知道该弹哪个音，
// 应该改成"在它自己的时间片里验证这个音"，而不是拿 341ms 的窗去做开集识别。
// 见"策略问题清单"里的第 3、5 条。
export function analyze(buf, decim, sr2, shorten = 0, needChroma = false) {
  const dec = decimate(buf, decim);
  const n = Math.max(560, YIN_SAMPLES - shorten);
  const pitch = yinPitch(dec.subarray(Math.max(0, dec.length - n)), sr2,
    { window: Math.min(1024, n - 80), minHz: 65, maxHz: 1400 });
  const mags = spectrumOf(dec);
  fixPitchBySpectrum(pitch, mags, sr2, dec.length);   // 治琴弦刚性带来的偏高

  let chroma = null;
  if (needChroma) {
    // 频谱降噪：减掉本底噪声谱。
    // 环境噪声（风扇、空调、说话）是宽带的，会在每个音级上都垫一层底，
    // 把和弦指纹糊掉。噪声谱是从安静时刻估出来的，减掉之后留下的才是琴声。
    const den = new Float32Array(mags.length);
    for (let i = 0; i < mags.length; i++) {
      den[i] = Math.max(0, mags[i] - (noiseSpec && noiseSpec.length === mags.length ? noiseSpec[i] : 0));
    }
    chroma = chromaFromSpectrum(den, sr2, dec.length);
  }

  // 另外算一份短窗频谱，专门用来做"起音前 vs 起音后"的差分。
  // 差分必须用短窗：两个长窗（341ms）之间只差一百多毫秒，内容大部分重叠，
  // 相减会互相抵消掉，差分出来是零。短窗才真正错得开。
  const shortN = Math.min(2048, dec.length);
  const magsShort = spectrumOf(dec.subarray(dec.length - shortN));
  return { pitch, mags, fftN: dec.length, chroma, magsShort, shortN };
}

// ── "这一下弹的是什么音"：低频带里最强的那根谱线（不锚定在期望音上）────────────
//
// 为什么用这个当判据（用户的原话）：
//   "如果下一个起音的音和下一个预期音不符，应该就是判错了" ——
// 所以要先**独立量出起音的那个音**，再和谱面对。以前的写法是"在期望音附近找峰"，
// 那是自证：弹偏两个半音也会在范围里捡个峰报回期望音，所以什么都判对。
//
// 这一条在用户那 6 段真机录音上验证过：同一段落里最强低频线在 258Hz(C4) 和
// 328Hz(E4) 之间干脆地来回跳，跳变点就是一次次新起音。所以它既能当起音判据，
// 也能当"这一下是什么音"的读数。
// 八度纠正：手机麦克风常常把基频压得很低、二次谐波反而最强；如果"当前最强峰的
// 一半处"也有一个像样的峰，就取那个低的（吉他的基频就在 80~400Hz 这一带）。
export function dominantF0InBand(mags, sr, fftSize, loHz = 90, hiHz = 900) {
  const binHz = sr / fftSize;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(mags.length - 2, Math.ceil(hiHz / binHz));
  if (hi <= lo + 2) return { hz: 0, mag: 0, sharp: 0 };
  const peakAt = (center, tol) => {
    const a = Math.max(lo, Math.floor(center * Math.pow(2, -tol / 1200) / binHz));
    const b = Math.min(hi, Math.ceil(center * Math.pow(2, tol / 1200) / binHz));
    let bi = -1, bv = -1;
    for (let i = a; i <= b; i++) if (mags[i] > bv) { bv = mags[i]; bi = i; }
    if (bi < lo + 1 || bi > hi - 1 || bv < 0) return { hz: 0, mag: 0, sharp: 0 };
    const x0 = Math.log(mags[bi - 1] + 1e-15), x1 = Math.log(mags[bi] + 1e-15), x2 = Math.log(mags[bi + 1] + 1e-15);
    const den = x0 - 2 * x1 + x2;
    const d = den !== 0 ? 0.5 * (x0 - x2) / den : 0;
    const nb = Math.max(mags[bi - 1], mags[bi + 1]) + 1e-12;
    return { hz: (bi + Math.max(-0.5, Math.min(0.5, d))) * binHz, mag: bv, sharp: bv / nb };
  };
  // 取**最低的那根强线**当基频。
  // 不能"先取最强、再往下折一半"：实测那样会把 2 次谐波（524Hz）当成基频，
  // 量出来正好高一个八度，判定全部报废。吉他在这个音区里，最低的强线就是基频。
  let bandMax = 0;
  for (let i = lo; i <= hi; i++) if (mags[i] > bandMax) bandMax = mags[i];
  if (!(bandMax > 0)) return { hz: 0, mag: 0, sharp: 0 };
  for (let i = lo; i <= hi; i++) {
    if (mags[i] < bandMax * 0.3) continue;                       // 太弱的不算"强线"
    if (!(mags[i] > mags[i - 1] && mags[i] >= mags[i + 1])) continue;   // 要是个峰
    const cand = peakAt(i * binHz, 40);
    if (cand.hz > 0) return cand;
  }
  return peakAt(loHz, 40);
}

// ── 在给定频带里找**最强**的那根谱线（不是最低的那根）────────────────────────
// 为什么不用"最低"：用户实测他弹 C4/A3/D4，别的弦同时在响、线更低，
// "取最低"会一路锁到别的弦上（导出记录里量出来老是 180~220Hz）→ 全判错。
// 频带由调用方收窄到"期望音 ±2 个半音"，所以带里只有目标音和它的邻居，
// 取最强的那根就是"他实际弹在哪儿"。
export function strongestF0InBand(mags, sr, fftSize, loHz, hiHz) {
  const binHz = sr / fftSize;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(mags.length - 2, Math.ceil(hiHz / binHz));
  if (hi <= lo) return { hz: 0, mag: 0, sharp: 0 };
  let bi = -1, bv = 0;
  for (let i = lo; i <= hi; i++) if (mags[i] > bv) { bv = mags[i]; bi = i; }
  if (bi < 1 || bv <= 0) return { hz: 0, mag: 0, sharp: 0 };
  const x0 = Math.log(mags[bi - 1] + 1e-15), x1 = Math.log(bv + 1e-15), x2 = Math.log(mags[bi + 1] + 1e-15);
  const den = x0 - 2 * x1 + x2;
  const d = den !== 0 ? 0.5 * (x0 - x2) / den : 0;
  const nb = Math.max(mags[bi - 1], mags[bi + 1]) + 1e-12;
  return { hz: (bi + Math.max(-0.5, Math.min(0.5, d))) * binHz, mag: bv, sharp: bv / nb };
}
