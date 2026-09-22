// ─────────────────────────────────────────────────────────────────────────────
// 判定层：把一次测量变成"过了 / 没过"，并推进练习进度。
//
// 这里集中了所有判定策略：
//   · 单音：音名比对 + 八度归属 + 频谱差分兜底
//   · 和弦：Chroma 指纹比对
//   · 听不清：先补测 3 次，再考虑差分兜底，最后才说"没听清"
// ─────────────────────────────────────────────────────────────────────────────

import { matchChordIn, observedPitchClasses, midiToName, midiToHz, spectrumOf } from './dsp.js';
import { LIVE_CHORDS } from './exercises.js';
import { CFG, CHORD_SETTLE_MS, FLUX_N } from './config.js';
import { S, step } from './state.js';
import { getBuffer, getDecim, getRate, getCtx } from './audio.js';
import {
  analyze, novelSpectrum, matchNoteByCandidates, rotateChroma,
  verifyExpectedNote, getBackground, RISE_WINDOW,
} from './analysis.js';
import {
  $, setVerdict, restoreVerdictAfter, bump, logResult, paintHeard,
  renderStep, renderDots, flashTarget,
} from './ui.js';
import { beatDeviation, reportTiming } from './metronome.js';

export function settleFor(ev) {
  if (!ev) return CFG.settleMs;
  if (ev.kind === 'chord') return CHORD_SETTLE_MS;
  return Math.max(CFG.settleMs, ev.settleMs || 0);
}

function tolFor(ev) {
  if (ev && ev.tech) return Math.max(CFG.toleranceCents + CFG.techExtraCents, ev.toleranceCents || 0);
  return CFG.toleranceCents;
}

export function judge(ev) {
  if (!ev) return;
  const buf = getBuffer();
  const sr2 = getRate();
  const needChroma = ev.kind === 'chord';

  // 这次测量离起音多久了。连弹时它是"能不能按时判完"的关键量（补测要用）。
  const sinceOnsetMs = Math.max(0, performance.now() - S.onsetAt);
  const { pitch, mags, fftN, chroma, magsShort, shortN } =
    analyze(buf, getDecim(), sr2, S.measureTries * 220, needChroma);
  const capo = CFG.capo || 0;
  const targetMidi = ev.targetMidi + capo;      // 加了变调夹之后实际该响的音高

  // 听不清的时候不要立刻判错，往后挪 40ms 再测一次，最多补测 3 次。
  // 快速演奏时上一个音还在响，混在一起会把清晰度压下去；
  // 等 40ms 那些音又衰减了一截，新弹的这个就占主导了。
  // 补测只在真的听不清时发生，不拖慢正常情况。
  // 听不清就往后挪 40ms 再测一次，最多补测 3 次。
  // 试过把补测限制在 160ms 预算内（想给连弹留时间），结果**反而判错**：
  // 第一个音（C 和弦）在 60ms 就被判过，等于放了一个假通过。
  // 补测是"多等一会儿让它衰减清楚"，这个等待是有意义的，暂时不动它。
  if (ev.kind === 'note' && (!pitch.hz || pitch.clarity < 0.55) && S.measureTries < 3) {
    S.measureTries++;
    return;                       // phase 保持 settling，主循环里会算上补测的延时
  }

  // ── 单音的候选音比较 ─────────────────────────────────────────────────────
  //
  // 主力判据，也是这套东西"不吃音色"的关键（见 analysis.js 的 matchNoteByCandidates）。
  //
  // 为什么不用"先测音高再比对"：那是开集思路，要的是"这是什么音"这个绝对值，
  // 而这个绝对值会被音色、麦克风频响、琴弦刚性、房间一起带偏 ——
  // 我们一路打的补丁（八度特判、刚性修正、差分兜底）都是在救它。
  //
  // 现在反过来：既然知道该弹什么，就直接问"新出现的这坨能量最像哪个候选音"。
  // 打分函数对所有候选一视同仁，系统性偏差自己抵消，不需要预设任何音色。
  // 八度不用特判（错八度的候选只能命中一半谐波，分数天然低），
  // 琴弦刚性也不用猜（几个系数都试一遍取最好）。
  //
  // 注意这一段必须放在 `S.phase = 'cooldown'` 之前：
  // 补测要保持 settling 状态，主循环才会再调进来。放后面的话补测就永远等不到下一次。
  let noteMatch = null;
  if (ev.kind === 'note') {
    noteMatch = matchNoteByCandidates(novelSpectrum(mags), sr2, fftN, targetMidi, capo);
    // 只在"差一点就分得开"的时候补测：余响又衰减一截，也许就分开了。
    // 差距很大（比如你弹的就是别的音）就别拖，立刻给结果，不然提示会慢半拍。
    if (!noteMatch.ok && noteMatch.margin > 0.9 && S.measureTries < 2) {
      S.measureTries++;
      return;
    }
  }

  S.phase = 'cooldown';
  // 判定用的就是这一次测量，把它显示出来——用户看到的必须是"被判的那一次"
  if (pitch.hz > 0) paintHeard(pitch, ev);

  // 跟节拍器对时间：这个音比你打的拍子早了多少 / 晚了多少
  let tSuffix = '';
  if (S.metro.on && S.onsetAudioMs) {
    const dev = beatDeviation(S.onsetAudioMs);
    if (dev != null) {
      reportTiming(dev);
      tSuffix = ` · ${dev > 0 ? '偏晚' : '偏早'} ${Math.abs(Math.round(dev))}ms`;
    }
  }

  // ── 和弦 ────────────────────────────────────────────────────────────────
  if (ev.kind === 'chord') {
    // 变调夹把整个和弦升高了 capo 个半音，把观测到的音级转回来再和模板比
    const ranked = matchChordIn(rotateChroma(chroma, -capo), LIVE_CHORDS);
    const top = ranked[0];
    const pcs = observedPitchClasses(chroma).join(' ');
    if (!top || top.score < CFG.chordThreshold) {
      setVerdict('warn', `没听清（相似度 ${top ? top.score.toFixed(2) : '—'}）· 从六弦扫到一弦，扫完停住`);
      logResult(`<b>${ev.name}</b> 没听清 · 音级 ${pcs || '—'}`);
      return retry();
    }
    if (top.key === ev.chord) {
      bump('ok');
      logResult(`<b>${ev.name}</b> ✓ ${top.label} ${top.score.toFixed(2)}`);
      const msg = `✓ 听到 ${top.label} · ${top.score.toFixed(2)}${tSuffix}`;
      advance();
      // 和弦的余响又长又响，几根弦之间的拍频还会让音量忽高忽低，
      // 很容易被当成"又扫了一下"。判完往后压一小段静默期专门治这个。
      S.lastOnsetAt = Math.max(S.lastOnsetAt, performance.now() + 100);
      restoreVerdictAfter(setVerdict('ok', msg), 700, '弹吧');
      return;
    }
    bump('bad');
    setVerdict('bad', `听到 ${top.label}（${top.score.toFixed(2)}），目标是 ${ev.name}`);
    logResult(`<b>${ev.name}</b> ✗ 听到 ${top.label} ${top.score.toFixed(2)}`);
    return retry();
  }

  // ── 单音 ────────────────────────────────────────────────────────────────
  // 结论在函数开头就算好了（noteMatch），这里只负责根据它给反馈
  const m = noteMatch;
  const traj = S.trajectory.length > 2
    ? '（轨迹 ' + S.trajectory.map((x) => midiToName(x)).join(' → ') + '）' : '';
  const top = m.ranked[0];

  const heardName = top ? midiToName(top.midi) : '—';
  const semi = top ? top.midi - targetMidi : 0;

  // 复核：开集判定说"你弹的是别的音"时，再用"验证式判定"问一遍 ——
  // "谱上这个音，在它该出现的时候出现了没有（而且是新出现的）"。
  // 真机上"上一根弦还在响"导致的错判（目标 E4 判成 B3、目标 G3 判成 G2）会在这里被救回来：
  // 那个还在响的弦新度低，压不住刚拨的这个音。1.5 是相对倍数（跟音色无关）。
  if (!m.ok && top && top.offset !== 0) {
    // 抬头率用**起音那一刻**快照的一对频谱（main.js 的 S.onsetRise，同窗长、错开 16ms）。
    // 之前拿"判定时刻"的频谱去比，等于隔了 60~140ms，爆发峰早过去了 ——
    // 量出来 0.11~0.72，目标音全面低于对手，怎么调都救不回来。
    const rise = S.onsetRise;
    const riseBinHz = ((getCtx() && getCtx().sampleRate) || 48000) / FLUX_N;
    const vb = verifyExpectedNote(novelSpectrum(mags), getBackground(), sr2, fftN, targetMidi,
      rise, riseBinHz);
    // 再用"抬头加权后的频谱"跑一遍双向失配重排。
    //
    // 为什么要重排：只看"谁抬了头"分不开八度 —— G2 的谐波序列**包含** G3 的
    // （G3 是 G2 的 2 次谐波），两个候选都能蹭到同一批抬头的频点。
    // 但双向失配会问"你预测该有的低次谐波在不在"：G2 预测 98Hz 该有，而那里没抬头；
    // G3 预测 196 该有，那里抬了头。这一问就把两者分开了。
    const binHz = sr2 / fftN;
    const freshSpec = new Float32Array(mags.length);
    const nov = novelSpectrum(mags);
    for (let i = 0; i < nov.length; i++) {
      const hz = i * binHz;
      const ri = Math.round(hz / riseBinHz);
      // 只认"真的往上跳了"的部分：rise - 1（没抬头 = 0）。
      // 之前给没抬头的频点留了 0.15 的地板，那些正是"还在响的旧音"待的地方，
      // 留着就会继续给对手供分（实测 0.84/0.66/0.89 差一点过不去）。
      const f = rise && ri < rise.length ? Math.min(4, Math.max(0, rise[ri] - 1)) : 1;
      freshSpec[i] = nov[i] * f;
    }
    const re = matchNoteByCandidates(freshSpec, sr2, fftN, targetMidi, capo);
    if (process.env.VC_DEBUG) {
      console.log(`      重排：目标 ${midiToName(targetMidi)} 领先 ${re.margin.toFixed(2)} 倍`
        + `｜开集那一版 ${vb.ratio.toFixed(2)}`);
    }
    // 暂时不接进判定：接上会把 test-live 里"该判错/该提示调弦"的两条误放行。
    // 数字先留着（见 VC_DEBUG 的输出），等"按实际弹的音对齐"的测试做好再回来标定。
    if (process.env.VC_ACCEPT && re.ok) m.ok = true;
    if (process.env.VC_DEBUG) {
      console.log(`[复核] 目标 ${midiToName(targetMidi)} vs 开集判的 ${midiToName(top.midi)}`
        + ` → 目标强度 ${vb.mine.toExponential(2)} / 对手 ${vb.rival.toExponential(2)}`
        + ` = ${vb.ratio.toFixed(2)}（门槛 1.5）｜rise 数组 ${S.onsetRise ? S.onsetRise.length : 'null'}`
        + ` riseBinHz ${riseBinHz.toFixed(1)}`);
    }
    if (process.env.VC_ACCEPT && vb.ratio >= 1.5) m.ok = true;
  }
  // 判定顺序是有讲究的：
  //   1. 压根没听到能量              → 没听清
  //   2. 音准卡在两个半音之间        → 弦没调准，先调弦（不是弹错，也不是弹对）
  //   3. 目标音领先够多              → 判过
  //   4. 别的音解释得更好            → 判错，报出听到的是哪个
  //   5. 剩下：目标最高但优势不够    → 几个音叠在一起分不开，提醒弹清楚
  //
  // 第 2 条是这次换掉判据的地方：以前用"目标音和隔壁半音打平"来判断"弦没调准"，
  // 那依赖打分函数的尺度；换成双向失配之后不再等价，所以改成直接问
  // "往 ±半个音挪一点是不是明显更像" —— 同样只比相对量。
  if (m.signal <= 0) {
    setVerdict('warn', `没听清 · 弹响一点，然后停住别消音${tSuffix}`);
    logResult(`<b>${ev.name}</b> 没听清（没有能量）`);
    retry();
    return;
  }

  if (m.offSemitone) {
    // 音准卡在两个半音中间：既不该放过去（那不是目标音），
    // 也不该说"你弹错了"（品格按对了，是琴的问题）。
    setVerdict('warn', `听到的音比 ${midiToName(targetMidi)} ${m.detuneCents < 0 ? '低' : '高'}了 `
      + `约 ${Math.abs(Math.round(m.detuneCents))} 音分，卡在 ${midiToName(targetMidi)} 和 `
      + `${midiToName(m.detuneCents < 0 ? targetMidi - 1 : targetMidi + 1)} 中间 —— 弦没调准，先调一下再练${tSuffix}`);
    logResult(`<b>${ev.name}</b> 音准偏 ${Math.round(m.detuneCents)} 音分（卡在两个半音之间）`);
    retry();
    return;
  }

  if (m.ok) {
    bump('ok');
    const cents = pitch.hz > 0 ? (pitch.midi - targetMidi) * 100 : 0;
    const off = Math.abs(cents) > tolFor(ev) ? `，音准偏了 ${Math.round(cents)} 音分` : '';
    // 技巧：滑音要判**过程**。轨迹是 main.js 在 settling 期间逐帧攒的通用音高读数。
    // 只弹落点 → 轨迹里没有从起点滑过来的痕迹 → 不给过（这就是原来漏掉的那个 bug）。
    if (ev.slideFrom != null) {
      const tr = S.trajectory;
      const low = tr.length ? Math.min(...tr) : 0;
      const high = tr.length ? Math.max(...tr) : 0;
      const glided = tr.length >= 3
        && low <= ev.slideFrom + 1.0
        && high >= targetMidi - 1.0
        && (high - low) >= (targetMidi - ev.slideFrom) * 0.6;
      if (!glided) {
        bump('bad');
        setVerdict('warn', `听到 ${midiToName(targetMidi)}，但没听到滑的过程 —— `
          + `从 ${midiToName(ev.slideFrom)} 一路滑上来，中途别停${tSuffix}`);
        logResult(`<b>${ev.name}</b> ✗ 只有落点，没有滑音轨迹`);
        retry();
        return;
      }
    }
    logResult(`<b>${ev.name}</b> ✓ 谐波匹配（比次优高 ${m.margin.toFixed(2)} 倍）`);
    const msg = `✓ ${midiToName(targetMidi)}${off}${tSuffix}`;
    // 显示跟着判定走：判定说对了就显示目标音，免得"听到"和结果打架
    $('heardval').textContent = midiToName(targetMidi);
    advance();
    restoreVerdictAfter(setVerdict('ok', msg), 700, '弹吧');
    return;
  }

  bump('bad');
  if (top && top.offset !== 0 && Math.abs(top.offset) % 12 === 0) {
    setVerdict('bad', `听到 ${heardName}，和 ${midiToName(targetMidi)} 差 ${Math.abs(top.offset) / 12} 个八度${traj}${tSuffix}`);
  } else if (top && top.offset !== 0) {
    setVerdict('bad', `听到 ${heardName}，比 ${midiToName(targetMidi)} ${semi > 0 ? '高' : '低'}了 ${Math.abs(semi)} 个半音${traj}${tSuffix}`);
  } else {
    // 目标音得分最高但优势不够 —— 多半是好几个音叠在一起分不开
    setVerdict('warn', `听不清是不是 ${midiToName(targetMidi)}（和 ${midiToName(m.runnerUpMidi)} 分不开）· 逐个音弹清楚一点${tSuffix}`);
  }
  logResult(`<b>${ev.name}</b> ✗ 听到 ${heardName}`);
  retry();
}

// 判过之后立刻进下一步，不等。
// 之前这里硬等 700ms，加上起音的等待，一个音最少要 800ms 以上——
// 八分音符超过 70BPM 就跟不上了。那个等待是当初为了"防止余响重复触发"加的，
// 现在的起音检测用"电平抬升 + 频谱通量"，余响本来就不会误触发，等待是多余的。
export function advance() {
  S.pos++;
  if (S.pos >= S.run.flat.length) {
    S.phase = 'done';
    setVerdict('done', '🎉 这一套练完了，全部通过');
    $('target').textContent = '🎉';
    $('where').textContent = '';
    $('frets').innerHTML = '';
    $('phrasewrap').style.display = 'none';
    $('techbadge').style.display = 'none';
    renderDots();
    return;
  }
  renderStep(); renderDots();
  S.phase = 'waiting';      // 马上就能听下一个音
}

export function retry() {
  // 判错了**立刻**恢复监听。
  //
  // 这里原来是一句 setTimeout(300ms) 才把相位放回 waiting —— 实机上的表现就是
  // "弹错了之后，接下来 300ms 里弹的音全都听不见"。实测把这条抓了出来：
  // 先扫一个 C 和弦（被判错），1.2 秒后弹六弦空弦 E2，判定条从头到尾没动过 ——
  // 那次拨弦压根没有被判（见 test/test-detect.mjs 的 B 组时间线）。
  // 密集连弹时（120BPM 八分音符 = 250ms 一个音）更是必然踩中。
  //
  // 错误提示不需要靠"挡住输入"来让人看清：提示文字本来就留在条上（FLASH_MS），
  // 而"会不会被同一个音的余响重复触发"是起音检测的职责（看电平抬升和频谱通量，
  // 余响永远不会自己往上跳），不该由一个固定 300ms 的闸门来兼职。
  S.phase = 'waiting';
}

// 跳过当前这一组的剩余步骤
export function skipGroup() {
  if (!S.running || S.phase === 'done' || !S.run) return;
  const ev = step();
  if (!ev) return;
  for (let i = S.pos; i < S.run.flat.length && S.run.flat[i].groupIndex === ev.groupIndex; i++) {
    if (S.results[i] == null) S.results[i] = '';
  }
  let next = S.pos;
  while (next < S.run.flat.length && S.run.flat[next].groupIndex === ev.groupIndex) next++;
  S.pos = next;
  if (S.pos >= S.run.flat.length) {
    S.phase = 'done';
    setVerdict('done', '🎉 这一套练完了（中间跳过了一些）');
    renderDots();
    return;
  }
  renderStep(); renderDots();
  S.phase = 'waiting';
  setVerdict('listening', '跳到下一组');
}

export { flashTarget };
