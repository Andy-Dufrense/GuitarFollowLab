// ── 光标层：谱面格子 ↔ 判定清单 的**对号** ───────────────────────────────────
//
// 这一层只回答"判定清单里第 i 个音，对应谱面上的哪一格"。
// 光标指哪儿，系统就在等哪个音 —— 两边必须是**同一份清单**，否则就是
// "照着光标弹都判错、瞎弹反而对"。
//
// 为什么不用"按时间就近挑一格"：手机上 beat 的时刻字段常常是 undefined，
// 一退化就全体塌到第一拍（用户看到的"光标停在第一个不动"）。这里改成**一一对应**，
// 并在每次加载时逐条验音高+品，对不上就明确报 ⚠，绝不悄悄错开一位。

// 谱面 → "要用户弹的音"（含时间）。抽出来是为了能拿假谱面单独测。
// 延音（tie）在谱面里是**独立的一拍**（"上一个音还在响"，不是"再弹一次"），必须跳过。
export function collectScoreSlots(s, trackIndex = 0, opts = {}) {
  const tr = s.tracks[trackIndex] || s.tracks[0];
  const stave = tr && tr.staves && tr.staves[0];
  if (!stave) return [];
  const tempo = s.tempo || 76;
  // ⚠ 只认 `isTieDestination`：`tieDestination` 挂在**延音起点**身上（它指向"接续到哪"），
  // 拿它当接续判据等于把起点也丢掉（上一版就这样，谱面少两格 → 全体错开一位）。
  const isTieDest = (n) => !!(n && n.isTieDestination);
  const startOf = (beat) => beat.absoluteStart ?? beat.start
    ?? beat.absoluteDisplayStart ?? beat.displayStart
    ?? beat.absolutePlayStart ?? beat.playStart ?? NaN;
  const out = [];
  for (const bar of stave.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.notes.length && beat.notes.every(isTieDest) && !opts.includeTieDests) continue;
        const start = startOf(beat);
        for (const note of beat.notes) {
          if (isTieDest(note) && !opts.includeTieDests) continue;
          out.push({
            beat, start, t: (start / 960) * (60 / tempo),
            // realValue = 算上调弦的真正音高；用它 + 品来对号，跟弦号怎么编号无关
            midi: note.realValue, string: note.string, fret: note.value,
          });
        }
      }
    }
  }
  return out;
}

// 判定清单 ↔ 谱面格子
export function mapSequenceToSlots(list, beats) {
  const m = beats.length;
  const all = () => beats.map((b) => b.beat);
  if (!list || !list.length) {
    return { beats: all(), info: { source: 'score-only', beatsFromScore: m, notesFromTimeline: 0 } };
  }
  // ① 数量一样 → 逐条验（音高 + 品）
  if (list.length === m) {
    let bad = 0, firstBad = -1;
    for (let i = 0; i < m; i++) {
      const n = list[i], b = beats[i];
      if (n.midi !== b.midi || n.fret !== b.fret) { bad++; if (firstBad < 0) firstBad = i; }
    }
    return {
      beats: all(),
      info: {
        source: bad ? 'index(有对不上的)' : 'index',
        beatsFromScore: m, notesFromTimeline: list.length,
        mismatched: bad, firstMismatch: firstBad,
      },
    };
  }
  // ② 数量不一样 → 按品+音高**只往后**找（单调 → 光标绝不往回跳）
  let j = 0, miss = 0;
  const out = [];
  for (const n of list) {
    let k = -1;
    for (let i = j; i < m; i++) {
      if (beats[i].midi === n.midi && beats[i].fret === n.fret) { k = i; break; }
      if (Number.isFinite(beats[i].t) && Number.isFinite(n.t) && beats[i].t > n.t + 0.6) break;
    }
    if (k < 0) { miss++; k = Math.min(j, m - 1); } else { j = k + 1; }
    out.push(beats[k].beat);
  }
  return {
    beats: out,
    info: {
      source: 'string+fret(单调)', beatsFromScore: m,
      notesFromTimeline: list.length, matchedFail: miss,
    },
  };
}
