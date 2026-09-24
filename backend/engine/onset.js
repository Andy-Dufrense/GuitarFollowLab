// ── 起音层（检测能力之一）：这一帧算不算"一次新的拨弦" ───────────────────────
//
// 这一层只回答一个问题：**有没有新的拨弦动作**。它不借用音高（试过：长音的主峰会
// 随衰减在基频/谐波之间晃，一借音高就"弹一个延音过去两行"）。
//
// 三条判据（都是用户那 6 段真机录音逼出来的）：
//   ① 够响：电平要过"环境噪声 × 6、下限 0.05、上限 0.10"这条线；
//   ② 够陡：这一帧电平要涨到上一帧的 1.4 倍（拨弦几毫秒内从无到有；余响起伏是慢慢涨的）；
//   ③ 形状变了：频谱形状距离 > 0.02（余响起伏是整体变亮，形状不变）。
// 再加"到下一个音的间隔"这条时间闸。
//
// ⚠ 阈值全部收在这里。改起音层只动这个文件，不要回页面里改。
export const ONSET = {
  shapeFluxMin: 0.02,
  sharp: 1.4,
  // 连续同一个音再拨一下：新的一下叠在自己的余响上，电平只抬 1.1~1.3 倍（实测 1.10），
  // 用 1.4 倍卡就会把第二下整片丢掉（"两个连续音有时候只有一个"就是这个）。
  // 所以这种情况允许更低的上抬幅度（1.10），但**必须**有高频瞬态当证据 ——
  // 拨片/指甲那一下在 2kHz 以上一定有新的爆发，而衰减中的余响只会往下走、造不出新爆发。
  sharpRepeat: 1.10,
  riseNeedNormal: 1.5,
  riseNeedRepeat: 1.2,
  fluxNeedNormal: 0.18,
  fluxNeedRepeat: 0.12,
  laggedRatio: 1.15,
  repeatHfFlux: 0.10,
  // ── 频带抬头（1.5~4kHz 比自己 2 帧前涨几倍）────────────────────────────────
  // 和弦/分解和弦里认起音的主力判据。真机标定（6 段录音、204 次拨弦）：
  //   ≥2.0× → 覆盖真拨弦 92%（≥1.8× 覆盖 99%），其它帧 p99 只有 1.68×。
  // 为什么需要它：分解和弦里前一根弦还在响，**整段混音的电平几乎不跳**
  //   （实测漏掉的每一次拨弦总电平只有 0.90~1.11 倍，而"陡"要求 1.4 倍），
  //   但那一下新冒出来的高频能量是实打实的 2~10 倍。
  // 2026-09-22 晚（用户报"跳音"之后重新标定的值）：
  //   2.0 → 分解和弦里会把同一拨算两次（6415慢速 6 对、快速 4 对 250ms 内的重复），
  //         "等我弹"里每多一次起音就吃一个音 = 跳音；
  //   2.5 + "基频区也抬头（lowBandRiseMin）" → 重复 0 对，真拨弦覆盖只少 1 次。
  hfBandRiseMin: 2.5,
  // ⚠ 2026-09-24：**快段落专用**的 2kHz 抬头门槛（用户报"快弹漏音"）。
  //   依据：他自己那两段快弹录音里，被漏掉的那 2~3 下，抬头落在 1.5~2.5 之间；
  //   而"只用电平跳"在快弹里天生只有 11/12 次（第一个音还在响，第二个音电平跳不起来）。
  //   慢/中速不放松（2.5 不动）—— 9-22 那次"跳音/重复计数"就是把它放宽到 2.0 引起的。
  //   适用条件由页面给：谱面这一段音间距 ≤350ms 时才算快段落。
  hfBandRiseMinFast: 1.8,
  // 基频区（150~600Hz）抬头：真拨的一下一定重新激励基频，高频带的余响抖动不会。
  lowBandRiseMin: 1.2,
  hfBandLevelMul: 0.85,   // 过这条的同时，总电平不能塌（不塌到 2 帧前的 85% 以下）
  minGapMs: 90,
  // ── 同音再来一下（2026-09-23）──────────────────────────────────────────────
  // 用户那份 heyjude 导出：同音起音 20 次，18 次间隔 400ms 以上（肯定是又拨了一下），
  // 只有 2 次在 300ms 左右（296 / 301ms）—— 那两次正好落在"上一拨的余响还没死"的窗口里。
  // 余响能蹭过原来那条放宽判据（只要求 hfFlux 和电平比），于是"一个起音吃掉两个同音"。
  // 所以：**离上一拨 sameRepeatTightMs 以内的同音**，必须拿出"又拨了一下"的物理证据
  // （2kHz+ 频带抬头 = 新拨那一下的爆发），阈值取 2.0 ——
  // 严格版原是 2.5（会把真快音一起挡掉）、放宽版是不要门槛（余响能蹭过），
  // 2.0 是两者中间；实测那两次真·快同音的频带抬头是 2.34 和 5.94，都过得去。
  // ⚠ 2026-09-23 小步调：400 → **300ms**。用户报"逐音稍快就会有一个音跟不上、
  //   停下来又能慢慢过去"—— 那是这条守卫把 300~400ms 的真快音挡在外面了。
  //   一次只动这一档；若还漏，下一档 200ms（每档都要看"真快音进来多少 / 余响蹭过多少"）。
  sameRepeatTightMs: 0,   // 2026-09-23 回退检测层：这条守卫今天加的，置 0 = 不生效
  sameRepeatHfBandMin: 2.0,
  // 绝对电平下限（2026-09-23 试过 0.05 → 0.052 这一小步，**实测更差，已撤回**）：
  //   击弦 对3 → 对2（掉真音）；邻座小声弹琴 对2 → 对4（进来更多）。
  //   原因：邻座那几下的电平是 **0.060~0.079**，而用户自己最轻的 1 弦音是 **0.053~0.079** ——
  //   两边**区间重叠**，音量这条线根本分不开，抬线只会先伤自己的音。
  // 起音绝对下限（2026-09-23 试过 0.05 → **0.055** 这一小步：**实测掉了击弦那一个真音**
  //   （3/0 → 2/0），好处还没量到，所以撤回 0.05）。
  absNeedMin: 0.05,
  absNeedMax: 0.10,
  ambientScale: 6,
  gateScale: 1.2,
  gateFloor: 0.0012,
  prevFloorScale: 1.5,
};

// 这一帧"起音必须超过的电平"：跟环境噪声走，但有上下限
export function onsetGateLevel(lv, gate, floor) {
  const ambient = Math.max(floor, 0.002);
  const absNeed = Math.min(ONSET.absNeedMax, Math.max(ONSET.absNeedMin, ambient * ONSET.ambientScale));
  return Math.max(ONSET.gateFloor, gate * ONSET.gateScale, absNeed);
}

// p: { phase, now, refractoryUntilMs, lastOnsetMs, minGapCfg, lv, prevLv, lagged, gate, floor,
//      flux, hfFlux, shapeFlux, repeatSame }
export function decideOnset(p) {
  const strongGate = onsetGateLevel(p.lv, p.gate, p.floor);
  const repeat = !!p.repeatSame;
  const riseNeed = repeat ? ONSET.riseNeedRepeat : ONSET.riseNeedNormal;
  const fluxNeed = repeat ? ONSET.fluxNeedRepeat : ONSET.fluxNeedNormal;
  // 新拨那一下特有的证据：2kHz+ 频带比自己 32ms 前明显抬头（余响不会抬头）
  // ⚠ 2026-09-24 试过"快段落用 1.8（hfBandRiseMinFast）"：在用户那两段快弹录音上，
  //   **快/慢两档的检出次数完全一样（9/9）**，杂音三段也一样（说话0/咳嗽1/邻居3）——
  //   即这条改动**没有任何效果**，所以不上线，仍一律用 2.5。
  //   （快弹本身已经不漏：产品在那段录音上把倒计时之后的 9 下全部认了出来。）
  const hfBandOk = (p.hfBandRise || 0) > ONSET.hfBandRiseMin
    && (p.lowBandRise || 0) > ONSET.lowBandRiseMin
    && p.lv > p.lagged * ONSET.hfBandLevelMul;
  const sharpEnough = p.lv > p.prevLv * ONSET.sharp
    || p.prevLv < Math.max(ONSET.gateFloor, p.floor * ONSET.prevFloorScale)
    || (repeat && p.hfFlux > ONSET.repeatHfFlux && p.lv > p.prevLv * ONSET.sharpRepeat)
    || hfBandOk;
  const shapeChanged = p.shapeFlux > ONSET.shapeFluxMin;
  // 同音且离上一拨很近：余响还在，这一下必须有"又拨了一次"的证据（频带抬头），
  // 否则衰减中的同一根弦就能把第二格蹭过去 —— 用户报的"一次起音过两个同音"。
  const sinceLastMs = p.now - p.lastOnsetMs;
  const repeatTight = repeat && sinceLastMs < ONSET.sameRepeatTightMs;
  const repeatFreshOk = !repeatTight || (p.hfBandRise || 0) >= ONSET.sameRepeatHfBandMin;
  const riseOk = p.lv > p.lagged * riseNeed;
  const fluxOk = p.flux > fluxNeed && p.lv > p.lagged * ONSET.laggedRatio;
  const repeatOk = repeat && p.hfFlux > ONSET.repeatHfFlux && p.lv > p.lagged * ONSET.laggedRatio;
  const newEvidence = riseOk || fluxOk || repeatOk || hfBandOk;
  const gapOk = p.now - p.lastOnsetMs > Math.max(ONSET.minGapMs, p.minGapCfg || 0);
  // ⚠ 2026-09-24：**冷却期内有新拨证据就放行**。
  //   用户 10:41 导出里"没被认成起音"的 120 帧中有 56 帧（47%）卡在"冷却中" ——
  //   快段落里前一个音刚判完，下一个音落进冷却期就被一律挡掉（体感 = "那个速度会漏一个"）。
  //   冷却期的本意只是"别把同一个音的余响算两次"，所以加一条放行条件：冷却期内若
  //   **2kHz+ 频带抬头达标（hfBandOk —— 余响绝不会抬头）**，说明这是**新拨的一下**，放它进来。
  //   其余条件（电平/够陡/形状/最小间隔/同音守卫）一条都不放宽。
  const coolOk = p.now >= p.refractoryUntilMs || hfBandOk;
  const onset = p.phase === 'waiting' && coolOk
    && p.lv > strongGate && sharpEnough && shapeChanged
    && newEvidence && gapOk && repeatFreshOk;
  return {
    onset, strongGate, sharpEnough, shapeChanged, riseOk, fluxOk, repeatOk, hfBandOk, newEvidence, gapOk,
    repeatTight, repeatFreshOk, sinceLastMs,
    repeat, riseNeed, fluxNeed,
    // 一句话原因（写进逐帧台帐，排查"这一段为什么没被当起音"）
    why: [
      p.phase !== 'waiting' ? `相位=${p.phase}` : '',
      (p.now < p.refractoryUntilMs && !hfBandOk) ? '冷却中' : '',
      p.lv <= strongGate ? `电平不够(${p.lv.toFixed(3)}<${strongGate.toFixed(3)})` : '',
      !sharpEnough ? '不够陡' : '',
      !shapeChanged ? '形状没变' : '',
      !newEvidence ? '没有新拨的迹象' : '',
      !repeatFreshOk ? `同音太近(${Math.round(sinceLastMs)}ms)且没有重新拨的迹象` : '',
      !gapOk ? '离上一拨太近' : '',
    ].filter(Boolean).join(' / '),
  };
}
