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
  minGapMs: 90,
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
  const sharpEnough = p.lv > p.prevLv * ONSET.sharp
    || p.prevLv < Math.max(ONSET.gateFloor, p.floor * ONSET.prevFloorScale)
    || (repeat && p.hfFlux > ONSET.repeatHfFlux && p.lv > p.prevLv * ONSET.sharpRepeat);
  const shapeChanged = p.shapeFlux > ONSET.shapeFluxMin;
  const riseOk = p.lv > p.lagged * riseNeed;
  const fluxOk = p.flux > fluxNeed && p.lv > p.lagged * ONSET.laggedRatio;
  const repeatOk = repeat && p.hfFlux > ONSET.repeatHfFlux && p.lv > p.lagged * ONSET.laggedRatio;
  const gapOk = p.now - p.lastOnsetMs > Math.max(ONSET.minGapMs, p.minGapCfg || 0);
  const onset = p.phase === 'waiting' && p.now >= p.refractoryUntilMs
    && p.lv > strongGate && sharpEnough && shapeChanged
    && (riseOk || fluxOk || repeatOk) && gapOk;
  return {
    onset, strongGate, sharpEnough, shapeChanged, riseOk, fluxOk, repeatOk, gapOk,
    repeat, riseNeed, fluxNeed,
    // 一句话原因（写进逐帧台帐，排查"这一段为什么没被当起音"）
    why: [
      p.phase !== 'waiting' ? `相位=${p.phase}` : '',
      p.now < p.refractoryUntilMs ? '冷却中' : '',
      p.lv <= strongGate ? `电平不够(${p.lv.toFixed(3)}<${strongGate.toFixed(3)})` : '',
      !sharpEnough ? '不够陡' : '',
      !shapeChanged ? '形状没变' : '',
      !(riseOk || fluxOk || repeatOk) ? '没有新拨的迹象' : '',
      !gapOk ? '离上一拨太近' : '',
    ].filter(Boolean).join(' / '),
  };
}
