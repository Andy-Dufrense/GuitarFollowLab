// 产品页：谱面（alphaTab 渲染真实 .gp） + 试听 + 跟弹判定。
//
// 三条设计约束（都是手机优先）：
//   1. 窄屏用横向布局（一行一行铺开，跟着光标滚），宽屏用整页布局；
//   2. 声部可选、默认只放一个声部 —— Hey Jude 那首 .gp 里除了旋律还有钢琴伴奏，
//      全放出来"跟弹"时会听到一堆和弦音，那不是你要弹的东西；
//   3. 按钮状态由 alphaTab 的事件驱动，不靠"点完立刻读状态"（那会需要点两次）。

const $ = (id) => document.getElementById(id);

// 版本号：页面上会显示出来。**每次改代码都要改这里** ——
// 浏览器（尤其手机）会缓存 JS，光刷新有时还是旧的；
// 有了这个号，我们不用再猜"你跑的是哪一版"，看一眼就知道。
const BUILD = '0923-0300';
const err = (m) => { $('err').textContent = m ? String(m) : ''; };
const isPhone = () => window.innerWidth < 700;

import { rms, spectrumOf } from './dsp.js';
import * as audio from './audio.js';
import {
  track, fluxRelOf, resetAnalysis, novelSpectrum, verifyExpectedNote, chordOutsiders,
  getFluxSpec, getBeforeFluxSpec, estimateF0Near, estimateF0ByPeaks, hfFluxRelOf,
  shapeFluxOf, harmonicity, spectralSparsity, spectralFlatness, spectralPeakiness,
  dominantF0InBand, strongestF0InBand, diffMags, matchNoteByCandidates,
} from './analysis.js';
import { CFG, FLUX_N } from './config.js';
import { createMetro } from './metro-core.js';

let api = null;            // alphaTab 实例（只建一次）
let score = null;
let songKind = 'heyjude';
let chords = null;         // 和弦练习的数据
let chordIdx = -1;
let beatTimer = 0;
let beat = 0;
let userBpm = 76;
let rising = false;
// 判过所需的领先倍数。默认 1.15 是拍的量级，还没用真机录音标定 ——
// 允许用 window.__passRatio 覆盖，方便拿真实录音扫一遍找合适的值。
const PASS_RATIO = Number((globalThis.__passRatio) || 1.15);

function setVerdict(text, kind) {
  $('verdict').textContent = text;
  $('verdict').className = kind || '';
}

// ── alphaTab 部分 ────────────────────────────────────────────────────────────
function initAlphaTab() {
  if (api || !window.alphaTab) return api;
  api = new alphaTab.AlphaTabApi($('score'), {
    file: './data/hey_jude.gp3',
    core: { fontDirectory: './vendor/font/' },   // 字体在本地（jsdelivr 被挡）
    display: {
      // 谱面一律用整页折行（page）：一行摆若干小节，摆不下换下一行，纵向滚动 ——
      // 跟纸上谱子、跟 Songsterr / Soundslice 那种产品一样的排法。
      // 之前窄屏用 horizontal（无限一条长线）是错的：那是横向走带，不是谱面。
      layoutMode: 'page',
      // 手机上谱子按屏宽缩小（不是拉成一行），保证"一行里能放下几个小节"
      scale: isPhone() ? 0.7 : 1,
    },
    player: {
      enablePlayer: true,
      enableCursor: true,
      enableAnimatedBeatCursor: true,
      enableElementHighlighting: true,
      scrollElement: $('scoreWrap'),
      soundFont: './vendor/sonivox.sf2',
    },
  });
  api.error.on((e) => err('alphaTab: ' + ((e && (e.message || e)) || e)));
  // 自检：把渲染/加载的状态打到页面上（不靠猜，F12 都不用开）。
  // 谱面空白时这几行就能直接指出是哪一环断的。
  const diag = [];
  const showDiag = () => { err(diag.join(' ｜ ')); };
  diag.push(`alphaTab ${window.alphaTab && (window.alphaTab.version || '?')}`);
  if (api.soundFontLoaded) api.soundFontLoaded.on(() => { diag.push('音色库 ok'); showDiag(); });
  if (api.renderFinished) api.renderFinished.on(() => { diag.push('渲染 ok'); showDiag(); });
  api.scoreLoaded.on((s) => {
    score = s;
    diag.push(`谱面 ok（${s.title}，${s.tracks.length} 个声部）`);
    showDiag();
    $('title').textContent = `${s.title} — ${s.artist}（v${BUILD}）`;
    userBpm = Math.round(s.tempo) || 76;
    $('speed').value = userBpm;
    fillTracks(s);
    buildTickMap(s);
  });
  // 按钮文字跟着播放器的真实状态走（这是"要点两次"的根因：点完立刻读状态还没更新）
  api.playerStateChanged.on((e) => {
    const playing = e && e.state === 1;
    $('play').textContent = playing ? '■ 停止' : '▶ 试听';
    $('play').classList.toggle('on', playing);
  });
  api.playerPositionChanged.on(() => { if (songKind === 'heyjude') costNothing(); });
  // 点谱面定位：点哪个音就从哪个音开始练（练琴时最常见的需求：只想练那两句）
  if (api.beatMouseDown) {
    api.beatMouseDown.on((ev) => {
      const beat = ev && (ev.beat || ev);
      const idx = noteBeats.indexOf(beat);
      if (idx >= 0) {
        // ⚠ 跟弹进行中不要改起点：手指划到谱面碰一下就把序号挪走，
        // 这一遍剩下的音会跟着错位（"点跟弹还是从第二个音开始"有一半是这么来的）。
        // 要换位置就先停止。
        if (micTimer) {
          setVerdict('正在跟弹 —— 先点「停止」，再点谱面换练习位置', '');
          return;
        }
        noteIdx = idx;
        holdUntilMs = 0;
        userPickedStart = true;      // 明确点过谱面 → 这一遍从这儿开始
        // 从新的地方开始练：**旧的谱面标记要清掉**。
        // （不然新一段和上一段的绿/红混在一起，看不出这次练到哪。）
        if ($('marks')) $('marks').innerHTML = '';
        wrongList = [];
        unclearCount = 0; missed = 0;
        $('wrongs').textContent = '';
        $('good').textContent = '0'; $('bad').textContent = '0';
        if ($('unclear')) $('unclear').textContent = '0';
        if ($('missed')) $('missed').textContent = '0';
        setVerdict(`从第 ${idx + 1} 个音开始（${midiToNameOf((notes && notes[idx] && notes[idx].midi) || 0)}）`);
        highlightCurrent();
      }
    });
  }
  // 播放器就绪后再压一次静音 —— 这是"只听旋律"真正生效的时机。
  // 之前只在 scoreLoaded 里设 playbackInfo.isMute，播放器准备时会被覆盖，
  // 所以选了旋律轨仍然听得见钢琴伴奏。
  if (api.playerReady) api.playerReady.on(() => { if (score) applyTrack(Number($('track').value) || 0); });
  // 3 秒后还没渲染出东西，直接把结论说出来
  setTimeout(() => {
    const el = $('score');
    if (!el.children.length) err('谱面没有渲染出来：' + (diag.join(' ｜ ') || '（没有任何状态回调触发，说明 .gp 没加载成功）')
      + ' ｜ 检查 /data/hey_jude.gp3 和 /vendor/font/Bravura.woff2 能不能打开');
  }, 3000);
  // 布局稳定后补渲染一次：首帧容器可能还是 0 宽/0 高，alphaTab 按那个尺寸排完就什么都看不见。
  setTimeout(() => { try { api.render(); } catch (e) { err('补渲染失败：' + (e.message || e)); } }, 600);
  return api;
}

function costNothing() {}

// 谱面音符 → tick 对照表：alphaTab 里"程序化移动光标"的正规入口是 tickPosition
// （timePosition 需要播放器在跑）。设到"下一个该弹的音"，光标就动；
// 我们只在判完一个音之后才改它 —— 你不弹，它就一直停着。
let noteTicks = [];
let noteBeats = [];       // 每个音符对应的 alphaTab Beat 对象（用来高亮当"光标"）

// 把"判定用的时间轴"按谱面的拍点重排（两边索引一致，光标才查得到布局）。
//
// ⚠ 这段原来没有任何校验，是个大坑：它给**每个拍**找时间轴上最近的音，
// 一旦两边的时刻对不上（速度不一致 / absoluteStart 拿不到 / 时间轴是另一份谱），
// 所有拍就会**一起指到最近的那一个音** —— 于是"期望音"变成全曲同一个音。
// 手机实测就是这个：38 个音的期望全是 C4(2弦1品)，用户只弹了两个音却"全对"。
// 所以现在先算对齐质量，**对不上就不重排**（保持时间轴原样），并把结论写到自检栏。
let alignInfo = null;

// ── 谱面 → 判定格子 ────────────────────────────────────────────────────────
// 把谱面里"**要用户弹的音**"按顺序列出来（含时间）。单独抽出来是为了**能测**：
// 以前这段藏在渲染回调里，只有真机 + alphaTab 才能跑，所以"延音要不要弹第二下"
// 这种问题只能靠用户在手机上试 —— 现在可以拿一个假的谱面对象直接测。
//
// 两条规则：
//   ① 用**当前选中的那一轨**（以前写死 tracks[0]，切到钢琴轨就串了）；
//   ② 延音（tie）：谱面里延音是**独立的一拍**（"上一个音还在响"，不是"再弹一次"），
//      必须跳过 —— 时间轴（gp_timeline.py）那边也是这么合的，两边必须一致，
//      否则重排之后又给延音撑出一个格子，判定就要求用户弹两下。
function collectScoreSlots(s, trackIndex = 0, opts = {}) {
  const tr = s.tracks[trackIndex] || s.tracks[0];
  const stave = tr && tr.staves && tr.staves[0];
  if (!stave) return [];
  const tempo = s.tempo || 76;
  // ⚠ 只认 `isTieDestination`，**别的都不要碰**。三种写法都在手机上出过事：
  //   ① `isTiedNote`：语义是"这个音带延音"，**起点和接续都是 true** → 两个都丢；
  //   ② `tieDestination`：这个字段挂在**起点**身上（见下面 vendored 构建里的原文），
  //      拿它当"接续判据"等于把起点也丢掉；
  //   ③ 两个一起"或"（上一版就是）→ 起点 + 接续**都**被丢 → 谱面少两格。
  //
  // 依据是浏览器里真正跑的那份 alphaTab（frontend/vendor/alphaTab.min.js 原文）：
  //     tieOrigin=null; tieDestination=null; isTieDestination=false;
  //     get isTieOrigin(){ return null !== this.tieDestination }
  // 即：`tieDestination` 指向"接续到哪个音"，所以它挂在起点上；只有
  // `isTieDestination` 是"我接在上一个音后面"，也就是谱面里那一拍**不用弹**。
  //
  // 数出来对不上就是这么来的（用 PyGuitarPro 直接数过，见 test/probe-gp3-beats.py）：
  //   Hey Jude 轨 0「Voice」：**119 个有音符的拍**，其中 **1 个是延音接续**
  //   → 该有 **118** 个要弹的音（时间轴、试听、三处数都是 118）。
  //   上一版把起点和接续都丢了 → 谱面只剩 **117** 格，而判定清单是 118 个音
  //   → 从那一格起**全体错开一位** → "弹对的判错、弹错的判对"。
  const isTieDest = (n) => !!(n && n.isTieDestination);
  const out = [];
  for (const bar of stave.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        const tieDest = beat.notes.length ? beat.notes.every(isTieDest) : false;
        if (tieDest && !opts.includeTieDests) continue;                     // 整拍都是延音接续
        // ⚠ 拍点时刻的取值顺序：用户手机上实测 `absoluteStart` / `start` **都是 undefined**
        // （导出里 align.sample 全是 "NaN"），导致"谱面×时间轴对号"永远失败、光标定位不到。
        // alphaTab 不同版本/不同渲染阶段暴露的是这几组名字，全都试一遍。
        const start = beat.absoluteStart ?? beat.start
          ?? beat.absoluteDisplayStart ?? beat.displayStart
          ?? beat.absolutePlayStart ?? beat.playStart ?? NaN;
        for (const note of beat.notes) {
          if (isTieDest(note) && !opts.includeTieDests) continue;          // 被延音的接续音符不算一格
          out.push({
            beat, start, t: (start / 960) * (60 / tempo),
            // midi 用 realValue（alphaTab 里就是"算上调弦的真正音高"），
            // 用它 + 品来跟时间轴逐条对号 —— 这两个字段跟"弦号怎么编号"无关。
            midi: note.realValue, string: note.string, fret: note.value,
          });
        }
      }
    }
  }
  return out;
}
// ── 判定清单 → 光标位置：**一一对应**（第 i 个音 ↔ 第 i 个谱面位置）────────────
//
// 光标指哪儿，系统就在等哪个音 —— 两边必须是**同一份清单**，不然就是
// "照着光标弹都判错、瞎弹反而对"。所以这里不再用"按时间就近挑一个"的那种配法
// （试过：时刻不可靠时会退化，而且映射本身不单调 → 光标来回乱跳）。
//
// 默认就该是一一对应：谱面 118 个要弹的音（PyGuitarPro 数出来的，
// test/probe-gp3-beats.py）和时间轴 118 个音本来就是同一批东西、同一个顺序
// （test/probe-timelines.mjs 逐条比过音高+品，0 处不同）。
// 而且这里**每次加载都再验一遍**：逐条对音高+品，对得上才写「对齐 ✓」。
//
// 对不上（谱面解析跟时间轴真的不是一份）时退到"按品+音高单调往后配"，
// 并且把结论标成 ⚠ 写在页面上 —— 宁可让人看见"这两份东西不一样"，
// 也不许再出现"悄悄错开一位、还装作没事"。
function mapSequenceToSlots(list, beats) {
  const m = beats.length;
  const all = () => beats.map((b) => b.beat);
  if (!list || !list.length) {
    return { beats: all(), info: { source: 'score-only', beatsFromScore: m, notesFromTimeline: 0 } };
  }
  // ① 数量一样 → 逐条验（音高 + 品，跟弦号怎么编号无关）
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
  // ② 数量不一样 → 按品+音高**只往后**找（单调 → 光标绝不会往回跳）
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

function buildTickMap(s, trackIndex = 0) {
  noteTicks = [];
  noteBeats = [];
  alignInfo = null;
  // 光标用的拍点表：**过滤掉延音接续**。
  // （试过把延音那一拍也放进来，想让数量和时间轴一致 —— 结果更糟：延音那一拍在谱面上
  //   往往没有独立的音符头，boundsLookup 查不到它 → 光标指不到地方、或者干脆不动。
  //   用户当场反馈"根本不指向正确的，有时候压根不动"。退回来。）
  const beats = collectScoreSlots(s, trackIndex);
  if (!beats.length) return;
  noteTicks = beats.map((b) => b.start);
  // 判定清单 = 时间轴那一份（`notes`，118 个音）；光标 = 谱面的拍点表（`beats`）。
  // 两边合成一份"第 i 个音用哪一个拍点当光标"的对照表 —— 见 mapSequenceToSlots。
  // ⚠ 这一层只做这一件事：**把光标指到判定清单里正在等的那个音上**。
  const mapped = mapSequenceToSlots(notes, beats);
  noteBeats = mapped.beats;
  alignInfo = mapped.info;
  showAlignLine();
}

// 对齐结论写在「导出记录」旁边（跟版本号挨着）：手机上出问题时，这两个数
// 一眼就能说明"是不是两份清单不一样"。用户不用开控制台。
function showAlignLine() {
  const box = $('align');
  if (!box) return;
  const a = alignInfo || {};
  if (!a.notesFromTimeline) { box.textContent = `谱面 ${a.beatsFromScore || 0} 格`; return; }
  const okLine = a.source === 'index';
  box.textContent = okLine
    ? `对齐 ✓ 谱面${a.beatsFromScore}=判定${a.notesFromTimeline}`
    : `对齐 ⚠ 谱面${a.beatsFromScore} vs 判定${a.notesFromTimeline}（${a.source}`
      + `${a.mismatched ? `，${a.mismatched} 处对不上` : ''}`
      + `${a.matchedFail ? `，${a.matchedFail} 处凑不上` : ''}）`;
  box.style.color = okLine ? '#6fbf73' : 'var(--bad)';
}

// 把"当前该弹的那一格"高亮出来当光标。
// alphaTab 自带的播放光标需要播放器在跑（跟弹时我们故意不跑），
// 所以改用它的高亮 API —— 不依赖播放，最稳。
// 在谱面上标出这个音判成什么：绿 = 对、红 = 错、灰 = 测不准。
// 用和光标同一套布局坐标，所以标记会一直贴在对应的音上（滚动也跟着走）。
function markNote(idx, kind) {
  if (!api || !api.renderer) return;
  const beat = noteBeats[idx];
  const box = $('marks');
  if (!beat || !box) return;
  try {
    const lookup = api.renderer.boundsLookup;
    const bb = lookup && lookup.findBeat ? lookup.findBeat(beat) : null;
    const b = bb && (bb.visualBounds || bb.realBounds || bb);
    if (!b || b.w == null) return;
    const el = document.createElement('div');
    el.className = 'mk ' + kind;
    el.style.left = `${Math.round(b.x)}px`;
    el.style.top = `${Math.round(b.y + b.h - 2)}px`;
    el.style.width = `${Math.max(6, Math.round(b.w))}px`;
    box.appendChild(el);
  } catch (e) { /* 定位失败就不标，不影响判定 */ }
}

function highlightCurrent() {
  if (!api) return;
  const box = document.getElementById('cursor');
  const beat = noteBeats[noteIdx];
  // 这个版本的 alphaTab 没有 highlight API（包里的 highlightBeats 出现 0 次），
  // 但提供了布局坐标（boundsLookup）。所以自己算位置、自己画。
  try {
    const lookup = api.renderer && api.renderer.boundsLookup;
    let b = null;
    if (lookup && beat) {
      const bb = (lookup.findBeat && lookup.findBeat(beat)) || (lookup.getBeatBounds && lookup.getBeatBounds(beat));
      b = bb && (bb.visualBounds || bb.realBounds || bb);
    }
    if (box && b && b.w != null) {
      // 光标要盖住**整行**（五线谱 + 六线谱），不能只盖五线谱那一行：
      // 找到这一行所属的 staff system，用它的上下边界当光标高度。
      let y = b.y, h = b.h;
      const systems = lookup && (lookup.staffSystems || lookup.staffSystemBounds);
      if (systems && systems.length) {
        for (const sys of systems) {
          const sb = sys.visualBounds || sys.realBounds || sys.bounds;
          if (!sb || !(b.y >= sb.y - 6 && b.y <= sb.y + sb.h + 6)) continue;
          // 只要**六线谱那一行**（你说得对：光标是给弹的人看的，应该落在六线谱上）。
          // 一行里 staves 的顺序通常是 [五线谱, 六线谱]，取最后一个；取不到就退回整行。
          const staves = sys.staffBounds || sys.staves;
          const tab = staves && staves.length ? staves[staves.length - 1] : null;
          const tb = tab && (tab.visualBounds || tab.realBounds || tab.bounds);
          if (tb && tb.h) { y = tb.y; h = tb.h; } else { y = sb.y; h = sb.h; }
          break;
        }
      }
      box.style.display = 'block';
      box.style.left = `${Math.round(b.x)}px`;
      box.style.top = `${Math.round(y)}px`;
      box.style.width = `${Math.round(b.w)}px`;
      box.style.height = `${Math.round(h)}px`;
      // 自动翻谱：光标跑出可视区就把谱面滚过去 —— 一路弹到最后，谱子自己往下走。
      const wrap = $('scoreWrap');
      if (wrap && wrap.clientHeight) {
        const viewTop = wrap.scrollTop;
        const viewBottom = viewTop + wrap.clientHeight;
        // 当前这一行要显示在**第一行**：直接滚到顶部，而不是"刚好露出来"。
        // 只在换"行"时滚：快曲子里每小节好几个音，每个音都滚一次会显得光标跟不上。
        if (Math.abs(y - (highlightCurrent.lastY || 0)) > 40) {
          wrap.scrollTop = Math.max(0, y - 8);
          highlightCurrent.lastY = y;
        }
      }
      return;
    }
    if (box) box.style.display = 'none';
  } catch (e) {
    err('光标定位失败：' + (e.message || e) + '（不影响判定）');
  }
  try { if (noteTicks[noteIdx] != null) api.tickPosition = noteTicks[noteIdx]; } catch (e) { /* ignore */ }
}

// 声部选择：默认只留第一个（旋律），其余静音 —— 不然会听到伴奏的和弦声
function fillTracks(s) {
  const sel = $('track');
  sel.innerHTML = '';
  s.tracks.forEach((t, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${t.name || '声部' + (i + 1)}${i === 0 ? '（旋律）' : '（伴奏）'}`;
    sel.appendChild(o);
  });
  sel.value = '0';
  applyTrack(0);
  sel.onchange = () => applyTrack(Number(sel.value));
}

function applyTrack(index) {
  if (!api || !score) return;
  const want = score.tracks[index] || score.tracks[0];
  // 切声部也要重建"光标→谱面"对照表，否则光标还指着上一轨的音
  buildTickMap(score, index);
  const others = score.tracks.filter((t, i) => i !== index);
  // 用官方 API（changeTrackMute）才靠得住；playbackInfo.isMute 也设一遍，双保险。
  try { api.changeTrackMute(others, true); } catch (e) { /* 老版本没有 */ }
  try { api.changeTrackMute([want], false); } catch (e) { /* 同上 */ }
  score.tracks.forEach((t, i) => { if (t.playbackInfo) t.playbackInfo.isMute = i !== index; });
  try { api.changeTrackVolume([want], 1); } catch (e) { /* 老版本没这个 API */ }
  // 注意：这里**不要**调 api.render()。静音不影响排版，而加载过程中手动 render
  // 会打断 alphaTab 自己的渲染流程 —— 表现就是谱面空白（我上一版就踩了这个）。
}

// ── 和弦练习部分 ─────────────────────────────────────────────────────────────
async function loadChords() {
  if (!chords) chords = await (await fetch('./data/chord_practice.json')).json();
  return chords;
}

function renderChords() {
  const box = $('chords');
  box.innerHTML = '';
  chords.chords.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'c';
    el.innerHTML = `<div class="nm">${c.name}</div><div class="vo">${c.voicing}</div>`
      + '<div class="beat">○○○○</div>';
    box.appendChild(el);
  });
  $('pos').textContent = `0/${chords.chords.length}`;
}

function paintChords() {
  [...$('chords').children].forEach((el, i) => {
    el.classList.toggle('now', i === chordIdx);
    const dots = el.querySelector('.beat');
    if (dots) dots.textContent = i === chordIdx ? '●'.repeat(beat) + '○'.repeat(4 - beat) : '○○○○';
  });
}

// 和弦谱的试听：把当前和弦的音按节奏拨出来（Web Audio 合成，不依赖音色库）。
// 跟弹时不发声 —— 否则会被麦克风收进去，反而干扰判定。
let chordCtx = null;
function strumChord(midis, at) {
  if (!chordCtx) chordCtx = (audio.getCtx && audio.getCtx()) || new (window.AudioContext || window.webkitAudioContext)();
  midis.forEach((m, i) => {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const t = at + i * 0.018;                    // 六根弦依次扫过（18ms）
    const osc = chordCtx.createOscillator(), g = chordCtx.createGain(), lp = chordCtx.createBiquadFilter();
    osc.type = 'sawtooth'; osc.frequency.value = f;
    lp.type = 'lowpass'; lp.frequency.value = Math.min(5000, f * 7);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 / Math.max(1, midis.length / 4), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    osc.connect(lp); lp.connect(g); g.connect(chordCtx.destination);
    osc.start(t); osc.stop(t + 1.2);
  });
}

function startChords(withSound = false) {
  // 护栏：数据没到（或 JSON 出错）时别让按钮"点了没反应/报错"，直接说清楚。
  if (!chords || !chords.chords || !chords.chords.length) {
    setVerdict('和弦谱数据没加载成功，刷新页面再试（data/chord_practice.json）');
    return;
  }
  chordIdx = 0; beat = 0;
  paintChords();
  $('pos').textContent = `1/${chords.chords.length}`;
  setVerdict('和弦练习：每个和弦 4 拍，跟着高亮换和弦。弹错不停，标红继续。');
  const ms = (60 / userBpm) * 1000;
  if (withSound) {
    if (!chordCtx) chordCtx = (audio.getCtx && audio.getCtx()) || new (window.AudioContext || window.webkitAudioContext)();
    chordCtx.resume && chordCtx.resume();
    strumChord(chords.chords[0].midis, chordCtx.currentTime + 0.05);
  }
  beatTimer = setInterval(() => {
    beat++;
    if (beat >= 4) {
      beat = 0;
      chordIdx++;
      if (chordIdx >= chords.chords.length) {
        stopChords();
        setVerdict('🎉 一轮走完', 'ok');
        return;
      }
      $('pos').textContent = `${chordIdx + 1}/${chords.chords.length}`;
    }
    if (withSound && chordCtx) strumChord(chords.chords[chordIdx].midis, chordCtx.currentTime + 0.02);
    paintChords();
  }, ms);
}

function stopChords() {
  clearInterval(beatTimer); beatTimer = 0;
  $('play').textContent = '▶ 试听'; $('play').classList.remove('on');
}

// ── 顶部按钮 ─────────────────────────────────────────────────────────────────
$('song').onchange = async () => {
  songKind = $('song').value;
  stopChords();
  if (api && api.playerState === 1) api.playPause();
  if (songKind === 'chords') {
    await loadChords();
    $('scoreWrap').style.display = 'none';
    $('chords').style.display = 'block';
    $('track').style.display = 'none';
    $('title').textContent = '和弦练习 — C–Am–F–G';
    $('loop').style.display = 'none';
    userBpm = Number($('speed').value) || 76;
    renderChords();
    setVerdict('和弦练习：点「试听」走一遍和弦（每和弦 4 拍），点「跟弹」开始判定。');
  } else {
    $('chords').style.display = 'none';
    $('scoreWrap').style.display = 'block';
    $('track').style.display = '';
    $('loop').style.display = '';
    initAlphaTab();
  }
};

$('play').onclick = async () => {
  // 试听和跟弹互斥：正在跟弹时点试听，先把跟弹停掉（两个播放状态不能并存）
  if (micTimer) { stopMic(); setVerdict('已停止跟弹 —— 试听和跟弹不能同时进行'); }
  if (songKind === 'chords') {
    if (beatTimer) { stopChords(); setVerdict('已停止'); }
    else { await loadChords(); startChords(true); }        // 和弦谱试听：4 拍一个和弦，带声音
    return;
  }
  initAlphaTab();
  if (!api) { err('alphaTab 没加载起来。'); return; }
  api.playPause();          // 按钮文字由 playerStateChanged 更新
};

$('loop').onclick = () => {
  if (!api) return;
  api.isLooping = !api.isLooping;
  $('loop').classList.toggle('on', api.isLooping);
};

// 模式切换：等我弹 / 跟节拍（两条路的推进规则不同，见 micTick 里的说明）
$('mode').onchange = () => {
  modeKind = $('mode').value;
  setVerdict(modeKind === 'wait'
    ? '等我弹：谱面不动，你没弹它就一直等（延音期间也不会推进）'
    : '跟节拍：谱面按拍走，漏掉的音会被标成漏');
};

const __unusedLoop = () => {
  if (!api) return;
  api.isLooping = !api.isLooping;
  $('loop').classList.toggle('on', api.isLooping);
};

$('speed').onchange = () => {
  userBpm = Number($('speed').value) || 76;
  if (songKind === 'heyjude' && api && score) {
    api.playbackSpeed = userBpm / (score.tempo || 76);
  } else if (beatTimer) {                 // 和弦练习：换速度要重排拍子
    stopChords(); startChords();
  }
};

// ── 跟弹：麦克风判定 ─────────────────────────────────────────────────────────
//
// 判定链路和调试图里那套完全一样（起音当场快照抬头率 → 问"谱上这个音出现了没有"），
// 只是把结果接到产品页上：
//   · Hey Jude：按谱面时间轴的音符顺序判，判完一格就把 alphaTab 的光标推到下一个位置；
//   · 和弦练习：每次起音判"当前这个和弦有没有外音"。
// 弹错不停 —— 标红/标橙，然后继续（跟弹的规矩）。

let micTimer = 0;
let notes = null;          // Hey Jude 谱面音符（时间轴）
let notesMeta = null;      // 谱面 meta（含 timeSignatures —— 节拍器按小节/拍号走要用）
let noteIdx = 0;
let phase = 'idle';        // idle | countin | waiting | settling
let onsetAtMs = 0;
let lastOnsetMs = -1e9;   // 忘了声明这个变量 → 模块加载时直接抛错 → 所有按钮都没挂上事件
let rise = null;
let levelHist = [];
let floor = 0.001, gate = 0.01, frames = 0;
let good = 0, bad = 0;
let missed = 0;
let unclearCount = 0;      // "测不准"（最优解贴在搜索边界）——不算弹错
let devHistory = [];       // 本次演奏的音准偏差（用来估"这把琴这会儿整体偏高/偏低多少"）
const devByString = {};    // 按弦分别估：吉他每根弦漂移不一样，整体中位数会互相抵消
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
let wrongList = [];
// 时间片模型的三个量：当前音自己的时钟起点、它的时间窗长度、以及"这个窗里听没听到"
let noteClockStart = null;
let heardInWindow = false;
let windowTries = 0;          // 同一个音的重试次数（第一下不能被丢弃）
let holdUntilMs = 0;          // 上一个音的延音期：这段时间内不判下一个音
let refractoryUntilMs = 0;    // 两次拨弦的最小间隔（按谱面这一段音间距自适应）
let onsetPeakSpec = null;     // 起音那一刻的快照频谱（老判据用的那份）
// 差分谱：**起音前 170ms 与起音后 170ms 相减**，只剩"这一下新拨进去的东西"。
// 为什么要有它（三件事是同一个病）：
//   · 快音的第二下 —— 上一个音还在响，快照里两个音叠在一起，量出来是上一个音；
//   · 1 弦 1 品那种"轻又高"的音 —— 被还在响的低音弦盖住；
//   · 弹错却判对 —— 快照里上一个（弹对的）音还在响，在"期望音附近找峰"永远找得到东西。
// 减法能把"本来就在响的东西"去掉，剩下的是新拨的那一下。见 analysis.js 的 diffMags。
let onsetDiffSpec = null;
// ⚠ 判定**仍然用老的起音快照**（下面那一份）。差分谱只**量、只记**，不用来判。
//
// 为什么不用（这一轮离线量过了，两个方向都量了）：
//   合成回归（test/test-follow-page.mjs）：弹错音矩阵 8/8 全部判错（缺口补上），
//      但"两个音都弹对"变成 对1/错1；
//   **真机录音**（用户的 30 秒 Hey Jude、全部弹对，test/test-follow-real.mjs）：
//      差分谱 对10/错25 —— 比老快照的 对29/错6 **明显退步**。
// 合成只有一根弦在响，所以看不出这个坑（这已经是第三次被合成信号骗了）。
// 结论：这条路（把上一个音减掉）方向没错，但"两个 170ms 半窗做幅度相减"这一步在真机上
// 站不住（衰减中相位/包络不一致，减完残余把谐波结构打散）。要上就得先离线把窗长、
// 相减方式、以及"同一根弦重复音"那种自相消的情况调好 —— 见记忆同步第 10 节。
// 现在只把差分谱的读数记进导出记录（`lit` / `dCents` / `dHz`），当调参数据。
// 想看它判起来什么样：window.__judgeDiff = 1（离线对照用）。
const JUDGE_DIFF = globalThis.__judgeDiff == null ? false : !!globalThis.__judgeDiff;
// ── 判定改用"候选重排"（老页面那套，产品页一直没接上）─────────────────────────
// 问法从"谱面这个音在不在"换成"**新出现的这坨能量最像哪个候选音**"：
// 候选只留用户真会弹错的方式 —— 本音、±1 品、±2 品。
// 刻意**不放**低八度（低八度假设天生占便宜：它把本音每个谐波都当成自己的偶数次谐波），
// 也不放 ±5（那正好是"上一根弦还在响"的位置，等于自己把票投给对手）。
//
// 为什么必须这么换：原来那把尺子是**在谱面那个音附近找峰**，弹成隔壁半音它照样
// 在范围里捡到东西、报回本音 —— 把整段录音升半音再跑，它报出的音高、谐波数、残差
// 和原录音一模一样（见 test/probe-notes.mjs），所以"弹错判对"不是阈值问题。
//
// 验收（test/gt-notes.mjs，6 段真机录音、39 个拨弦，音高独立量出来再交叉校验）：
//   弹对→判对 39/39；谱面要 ±1/±2 品 → 判错 39/39。这一步只用真机录音，不用合成信号。
const JUDGE_CAND = globalThis.__judgeCand == null ? true : !!globalThis.__judgeCand;
// 本音"失配"上限（analysis.js mismatchOf 那套双向失配，单位音分）。
// 250 是照实测分布定的：弹对 118~195（1弦最松）、弹错 186~300、没证据 300。
// 原来写 190 —— 正好卡在 1 弦那批安静音的失配上（190/193/195），于是同一段里
// 一半判对一半判错（用户报的"1弦1品不是每次都错"就是这个）。
const CAND_FIT_MAX = 250;
// 会话记录：每个音的"期望 / 实测"，包含判定比值、周期性(clarity)、电平、时刻。
// 这是**唯一能用来调参的数据**：录一遍干净的（只弹对的）就等于拿到标准答案，
// 不用再靠"你猜我有没有弹对"。
let sessionLog = [];
// 起音台帐：**每一次**被判定为起音的事件都记一条（包括后来被判"不像琴声"丢掉的）。
// 为什么要它：手机上出现"任何音都算对、一阵风过两三个音"，而这个现象在合成信号上
// 复现不出来 —— 只能靠手机自己的台帐看"到底是什么被当成了起音"。
// 导出记录里带上它，出问题一串就能定位是哪一关放过去的。
let onsetLog = [];
// 时间对齐：每个起音按"它出现在谱面的什么时刻"决定该判哪个音，而不是"弹一下就走一格"。
// 真机录音实测：30 秒里检出 47 次起音，按次数对齐会整体错位 —— 那时阈值怎么调都没用
// （从 1.0 到 1.2 都只过 13~14 个）。
let alignOffsetSec = null;      // 用户起弹时刻与谱面 0 时刻之差
let micStartedAt = 0;
let cursorEngine = false;      // 跟弹时用"静音播放"驱动 alphaTab 的光标
let countInEndMs = 0;          // 四拍倒计时结束的时刻（用主循环同一个时钟判断）
let sessionToken = 0;          // 每次开始/停止 +1：让过期的延时任务作废
let guideOn = false;           // 跟弹时是否播放旋律当向导
// 模式：wait = 等我弹（谱面不动，判过/判错才走一格）；tempo = 跟节拍（谱面按拍走，漏了算漏）
let modeKind = 'wait';
// ── 时间层（检查模式用的）────────────────────────────────────────────────
// 谱面给每个音一个时刻 t（秒，按谱面自己的速度）。用户换了速度就按比例缩放：
// 实际时刻 = 起点 + (t − 第一个音的 t) × (谱面速度 ÷ 用户速度)。
// 判定时看"你这一下比该弹的时刻早/晚了多少毫秒"，先报数字，不急着判对错。
let scoreTempo = 76;
let timingDevs = [];        // 每个音的偏差（ms，负=抢拍）
let earlyCount = 0, lateCount = 0;
let timingTolMs = 0;        // 当前这个音的容许偏差

// 自听检测（外放被自己收进去）：倒数四拍里麦克风"听见"了几声清楚的响动。
// 为什么必须检测：手机实测"只弹了两个音，过去了 30 多个音，还全是对的" ——
// 噪声不可能连出 30 个正确音高，能让每个音都对的只有一种声源：**伴奏/旋律本身**。
let countinPeaks = 0;
let couplingDetected = false;

// ── 起音分离：三条判据（都是用户那 6 段真机录音逼出来的）────────────────────
//   ① 峰高：弱峰不算（真拨弦的峰在 -2~-6dB，噪声晃动在 -20dB 上下）
//   ② 尾巴：峰后 90ms 不能掉到峰下 15dB（用户说的"延续性/热感"）
//   ③ 低频主峰跳变：**换了个音就是新的一下** —— 快音的第二下（尤其换弦换品）
//      电平还没掉就先跳了音高，只靠电平永远分不开（用户 6 组飞快换弦实测）。
let domHist = [];          // 最近几帧的低频主峰（Hz）
let onsetPeakLv = 0;       // 这一次起音那一刻的电平（用来验"尾巴"）
// 最近"听到过"的最大电平（慢慢往下掉）。用户的实测：真弹比环境响 10~30 倍，
// 所以"比最近的最大电平低太多"的响动根本不可能是拨弦 —— 这条比绝对音量稳得多：
// 它自动跟着手机麦克风的增益走，不需要我去猜一个绝对值。
let peakLvRef = 0;
// "用户明确点过谱面某个音" —— 只有点过，这一遍才从那儿开始；
// 否则**永远从第一个音开始**。（原来只写"上一遍弹完了才回到开头"，
// 于是中途停过一次之后，noteIdx 残留，下一遍就从中间开始 ——
// 用户实测"点跟弹还是从第二小节开始、第一个音根本没在待测里"。）
let userPickedStart = false;

// 容许偏差：按时值比例给，再夹上下限 —— 这不是行业标准公式（没有那种东西），
// 是按"等时序列的起音差异阈约 20~30ms"和"别拖到下一个音"两头定的起点值。
// 第一个音给 2 倍（刚起手最容易不稳）。要调就调这三个数。
// ⚠ 2026-09-22 晚实测：用户跟着弹时偏差在 ±200ms 之间游走（导出记录里 devMs -199~+69），
// 而 25%×395ms=99ms 的窗太紧 —— 一漏就一路漏（那份导出 41 个音里 24 个判漏）。
// 现在放宽到 45%×音距、下限 100ms、上限 350ms：跟得上比掐得准重要。
const TIMING_FRAC = 0.45, TIMING_MIN_MS = 100, TIMING_MAX_MS = 350;
function timingToleranceMs(i) {
  const cur = notes && notes[i], next = notes && notes[i + 1];
  // 时值优先用"到下一个音的间隔"；最后一个音没有下一个，就用它自己的时值
  const ioiMs = !cur ? 250
    : (next ? Math.max(60, (next.t - cur.t) * 1000) : Math.max(60, (cur.dur || 0.25) * 1000));
  const base = Math.min(TIMING_MAX_MS, Math.max(TIMING_MIN_MS, ioiMs * TIMING_FRAC));
  return i === 0 ? base * 2 : base;      // 第一个音宽容倍数
}
// 谱面第 i 个音"该响"的时刻（毫秒，相对 micStartedAt）
function expectedAtMs(i) {
  if (!notes || !notes[i]) return 0;
  const scale = scoreTempo / (userBpm || scoreTempo);
  return (notes[i].t - notes[0].t) * 1000 * scale;
}

// ── 跟节拍（tempo）层：一切都由**谱面时钟**驱动 ──────────────────────────────
// 和"等我弹"（wait）严格分开：wait 那条链路一个字节都不动。
//   · 光标：按时间走（和"试听"用的是同一份 expectedAtMs），**不跟着用户走**；
//   · 起音：只回答"这个音的**时间窗**里，有没有出现正确的音"；
//   · 窗口过了还没判到 → 这个音算错（窗口不会回来）。
// 这样就不会出现"一个起音把后面好几个音一起吃掉"（用户报的"疯狂过音符"）。
let tempoState = [];       // 每个音：'' 待判 | 'ok' | 'bad' | 'miss'
let tempoCursor = 0;       // 光标（= 当前时间窗所在的音）
let tempoClosed = -1;      // 已经关窗结算到第几个音
// 时间轴原点：null = 还没听到第一个音。听到第一下就把整条谱面时间轴**对齐到用户这一下**
// （用户口径：第一个音以他的起音为准 —— 否则他一上来差半拍，后面就全乱）。
// 超过这个宽限还没起手，就退回"按理数拍子"的正规时间轴，免得整段卡住。
const TEMPO_FIRST_GRACE_MS = 4000;
let tempoOriginMs = null;
let tempoClicks = [];      // 还没响的"音符提示音"时刻（相对 micStartedAt 的 ms）
let lateAccept = false;    // 这一下是"超出时间窗、但按下一个音认下来"的（用来决定要不要重新对齐）
// 起拍音（拾音）：第 1 小节如果不是完整小节（这首谱是 1/4），它里面的音就算"起拍音"。
// 交互上不掐它的拍子 —— 给一整拍宽限，而且节拍提示音从第 2 小节的正拍开始。
function tempoPickupCount() {
  if (!notes || notes.length < 2) return 0;
  const first = notes[0].measure;
  let n = 0;
  for (const nt of notes) { if (nt.measure === first) n++; else break; }
  return n < notes.length ? n : 0;
}
const tempoBeatMs = () => (60 / (userBpm || 76)) * 1000;
// 提示音：和光标同一个时钟（都由 tempoAt 驱动）—— 这样"听到的"和"看到的"必然是一回事，
// 不会出现"节拍器和光标对不上"（那是两个时钟域：Web Audio 的 currentTime vs performance.now）。
function tempoClickAt(delaySec, accent) {
  const ctx = audio.getCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1568 : 1046;
    const t = ctx.currentTime + Math.max(0, delaySec);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.14 : 0.09, t + 0.02);   // 软起振：别被麦克风当成拨弦
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.09);
  } catch (e) { /* 没有音频就不响，不影响判定 */ }
}
// 把"接下来 200ms 内该响的提示音"预约出去（跟节拍时用；每个音的起点响一下 = 光标走到哪响到哪）
function scheduleTempoClicks(tMs) {
  if (!($('metro') && $('metro').checked)) return;
  const off = tempoOriginMs || 0;
  while (tempoBeatIdx < tempoBeats.length && tempoBeats[tempoBeatIdx].ms + off < tMs - 80) tempoBeatIdx++;
  while (tempoBeatIdx < tempoBeats.length && tempoBeats[tempoBeatIdx].ms + off <= tMs + 200) {
    const b = tempoBeats[tempoBeatIdx++];
    const accent = b.beat === 0;
    const delay = (b.ms + off - tMs) / 1000;
    tempoClickAt(delay, accent);
    // 闪灯也按同一个时刻延后（用相对 delay，和提示音同源）
    setTimeout(() => flashBeat(accent), Math.max(0, delay * 1000));
  }
}
// ── 节拍器：按**小节/拍号**走（不是每个音响一下）────────────────────────────
// 拍点时刻 = 小节起点 + k × 一拍；小节起点由拍号累加算出来（和谱面时间轴同一个 scale）。
// 强拍（每小节第 1 拍）音高一点、并让光标闪一下 —— 这就是"节拍器跟着光标闪"。
function buildBeatGrid() {
  if (!notes || !notes.length) return [];
  const sigs = (notesMeta && notesMeta.timeSignatures) || [];
  const perOf = (m) => {
    const s = sigs.find((x) => x.measure === m + 1);
    const n = s ? Number(String(s.sig).split('/')[0]) : 4;
    return n > 0 ? n : 4;
  };
  const measures = Math.max(...notes.map((n) => n.measure || 0)) + 1;
  const beat = tempoBeatMs();
  const out = [];
  let ms = 0;
  for (let m = 0; m < measures; m++) {
    const per = perOf(m);
    for (let b = 0; b < per; b++) out.push({ ms: ms + b * beat, measure: m, beat: b });
    ms += per * beat;
  }
  return out;
}
let tempoBeats = [];       // 上面的拍点表（相对时间轴 0）
let tempoBeatIdx = 0;      // 已经排到第几个拍点
function rebuildTempoClicks() {
  tempoBeats = buildBeatGrid();
  tempoBeatIdx = 0;
}
// 视觉：拍点闪一下（跟光标同一时刻 —— 预约提示音和闪灯用的是同一个"该响时刻"）
function flashBeat(accent) {
  const el = $('beat');
  if (el) {
    el.textContent = accent ? '●' : '○';
    el.style.color = accent ? '#2f6bd8' : '#8b857c';
    setTimeout(() => { if (el.textContent === (accent ? '●' : '○')) el.textContent = '·'; }, 130);
  }
  const cur = $('cursor');
  if (cur) {
    cur.style.borderColor = accent ? 'rgba(47,107,216,1)' : 'rgba(47,107,216,.85)';
    cur.style.background = accent ? 'rgba(47,107,216,.45)' : 'rgba(47,107,216,.28)';
    setTimeout(() => {
      cur.style.borderColor = 'rgba(47,107,216,.85)';
      cur.style.background = 'rgba(47,107,216,.28)';
    }, 120);
  }
}

// ── 实时诊断：每判一个音/漏一个音就往页面上写一行 ────────────────────────────
// 为什么要有：出问题时"说不清是什么造成的"。把 期望音 / 时间窗 / 起音时刻与偏差 /
// 听到的音 / 最后判什么 直接摊在页面上，手机上不用导文件，看一眼（或截图）就知道
// 是"没听到"、"时间不对"还是"音不对"。最多留 8 行。
let diagLines = [];
function diag(line) {
  diagLines.push(line);
  if (diagLines.length > 8) diagLines.shift();
  const el = $('diag');
  if (el) el.textContent = diagLines.join('\n');
}
function resetDiag() { diagLines = []; const el = $('diag'); if (el) el.textContent = ''; }
const tempoTol = (i) => {
  const base = timingToleranceMs(i);
  // 起拍音给一整拍的宽限（它是"起手"，不是"正拍"）
  return i < tempoPickupCount() ? Math.max(base, tempoBeatMs()) : base;
};
// 谱面第 i 个音"该响"的时刻（tempo 专用：带上原点偏移）
const tempoAt = (i) => expectedAtMs(i) + (tempoOriginMs || 0);
// 这一刻的起音归到哪个音？不在任何窗口里 → -1（早了/晚了，不算这个音）
function tempoNoteAt(ms) {
  if (!notes || !notes.length) return -1;
  let best = -1, bestD = Infinity;
  for (let i = Math.max(0, tempoCursor - 2); i < notes.length; i++) {
    const c = tempoAt(i);
    if (c - tempoTol(i) > ms + 300) break;      // 后面的音还早，不用看
    if (tempoState[i]) continue;                // 这个音已经判过了
    const d = Math.abs(ms - c);
    if (d <= tempoTol(i) && d < bestD) { best = i; bestD = d; }
  }
  return best;
}
// 这一下离"还没判的那个音"差多少（用来提示"你早了/晚了多少ms"）
function tempoNearestPending(ms) {
  let idx = -1, dev = 0, bestD = Infinity;
  for (let i = Math.max(0, tempoCursor - 2); i < notes.length; i++) {
    if (tempoState[i]) continue;
    const d = ms - tempoAt(i);
    if (Math.abs(d) < bestD) { bestD = Math.abs(d); idx = i; dev = d; }
    if (expectedAtMs(i) > ms + 1000) break;
  }
  return { idx, dev };
}
// 时钟：关窗结算 + 挪光标 + 收尾。返回 true = 整曲跑完（调用方要 return）
function tempoTick(nowMs) {
  if (!notes || !notes.length || phase !== 'waiting') return false;
  const t = nowMs - micStartedAt;
  // 还没起手：第一个音**等用户**（光标停在第 1 个音上）；宽限过了就退回正规时间轴
  if (tempoOriginMs == null) {
    if (t < TEMPO_FIRST_GRACE_MS) return false;
    tempoOriginMs = 0;
  }
  scheduleTempoClicks(t);
  // ① 关窗：右边界过了还没判到 → 记错（用户口径：规定时间里没出现理想音就是错）
  while (tempoClosed + 1 < notes.length
    && t > tempoAt(tempoClosed + 1) + tempoTol(tempoClosed + 1)) {
    tempoClosed++;
    if (!tempoState[tempoClosed]) {
      tempoState[tempoClosed] = 'miss';
      const cur = notes[tempoClosed];
      missed++;
      bad++;
      wrongList.push(`第${(cur.measure || 0) + 1}小节 漏了${midiToNameOf(cur.midi)}（时间窗内没弹）`);
      $('wrongs').textContent = '弹错：' + wrongList.join('、');
      $('missed').textContent = missed;
      $('bad').textContent = bad;
      markNote(tempoClosed, 'bad');
      diag(`#${tempoClosed + 1} ${midiToNameOf(cur.midi)}(${cur.string}弦${cur.fret}品)`
        + ` 窗口 ${((tempoAt(tempoClosed) - tempoTol(tempoClosed)) / 1000).toFixed(2)}`
        + `~${((tempoAt(tempoClosed) + tempoTol(tempoClosed)) / 1000).toFixed(2)}s 没听到 → 错（漏）`);
      sessionLog.push({
        no: tempoClosed + 1, t: Number((nowMs / 1000).toFixed(3)),
        exp: cur.midi, expName: midiToNameOf(cur.midi), result: 'miss',
      });
      setVerdict(`漏了 ${midiToNameOf(cur.midi)}（时间窗过了），继续`, 'bad');
    }
  }
  // ② 光标按时间走：落在哪个音的窗口里就指哪个音
  let cur = tempoCursor;
  while (cur + 1 < notes.length && t >= tempoAt(cur + 1) - tempoTol(cur + 1)) cur++;
  if (cur !== tempoCursor) {
    tempoCursor = cur;
    noteIdx = cur;
    highlightCurrent();
    const nx = notes[cur];
    if (nx) $('next').innerHTML = `当前：<b>${midiToNameOf(nx.midi)}</b>（${nx.string}弦 ${nx.fret}品）`;
  }
  // ③ 最后一个音的时间窗也过了 → 整曲结束
  if (tempoClosed >= notes.length - 1) { finishSession(); return true; }
  return false;
}

async function loadNotes() {
  // 全部音符（原来只取前 60 个，所以光标走到一半多就"结束"了）
  if (!notes) {
    const data = await (await fetch('./data/hey_jude.json')).json();
    notes = data.notes;
    notesMeta = data;            // 小节/拍号/速度都在这儿（节拍器要用）
  }
  return notes;
}

function countIn(beats = 4) {
  // 倒数这四拍同时也是**自听检测**的窗口（见 micTick 里的 coupling）：
  // 这四拍用户还在等，如果他没在弹而麦克风却"听见"了四声清楚的响动，
  // 那就是手机外放被自己收进去了 —— 那种情况下判定一定全错（听到的是伴奏本身）。
  countinPeaks = 0;
  const ms = (60 / userBpm) * 1000;
  // 屏幕上的倒计时：4 → 3 → 2 → 1（跟四拍提示同一套时间）
  const box = $('count');
  box.classList.add('on');
  for (let i = 0; i < beats; i++) setTimeout(() => { box.textContent = String(beats - i); }, i * ms);
  setTimeout(() => { box.classList.remove('on'); box.textContent = ''; }, beats * ms);
  const ctx = audio.getCtx();
  if (!ctx) return;
  for (let i = 0; i < beats; i++) {
    const t = ctx.currentTime + 0.1 + (i * ms) / 1000;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = i === 0 ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.12);
  }
}

// 节拍器：用共用的核心（metro-core.js，和调试图是同一份实现）。
// 检查模式（跟节拍）没有拍子参照没法用。
const metro = createMetro({ getCtx: () => audio.getCtx() });
function startMetronome() { return metro.start({ bpm: userBpm }); }
function stopMetronome() { metro.stop(); }

function micTick() {
  const buf = audio.readFrame();
  if (!buf) { micTimer = requestAnimationFrame(micTick); return; }
  const lv = rms(buf, buf.length - 1024, 1024);
  frames++;
  if (frames <= 30) floor += (Math.min(lv, 0.05) * 0.9 - floor) * 0.3;
  else if (lv < floor) floor = floor * 0.9 + lv * 0.1;
  else floor = Math.min(floor * 1.0003 + 1e-7, 0.06);
  floor = Math.max(floor, 0.0005);
  gate = Math.max(CFG.absFloor, floor * CFG.onsetSensitivity);

  const flux = fluxRelOf(buf);
  const hfFlux = hfFluxRelOf(buf);      // 高频段通量：拨弦瞬态（连续相同音靠它）
  const now = performance.now();
  // ③ 低频主峰：这一帧"听起来是什么音"。换音时它会跳 —— 快音的第二下靠这个抓。
  let domHz = 0;
  if (phase === 'waiting') {
    try {
      const n = 8192;
      const srNow = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
      domHz = dominantF0InBand(spectrumOf(buf.subarray(buf.length - n)), srNow, n, 90, 900).hz || 0;
    } catch (e) { domHz = 0; }
    domHist.push(domHz);
    if (domHist.length > 5) domHist.shift();
  }
  // 自听检测：倒数期间用户还在等，麦克风却响了好几下 → 我们在听自己放的伴奏
  if (phase === 'countin') {
    const back = levelHist.length >= 6 ? levelHist[levelHist.length - 6] : 0;
    if (lv > Math.max(0.004, floor * 3) && lv > back * 1.6) countinPeaks++;
  }
  if (phase === 'countin' && now >= countInEndMs) {
    phase = 'waiting';
    micStartedAt = now;
    couplingDetected = countinPeaks >= 3;   // 四拍里听见三下以上就算自听
    alignOffsetSec = null;
    noteClockStart = null;
    setVerdict(couplingDetected
      ? '⚠ 检测到外放：手机把播放的声音也收进来了 —— 判定会失真，请戴耳机或关掉旋律，重新开始'
      : '开始 —— 弹第一个音', couplingDetected ? 'bad' : '');
    highlightCurrent();                        // 开始就把光标摆到第一个音上
  }
  // ── 跟节拍：光标和时间窗**全部由谱面时钟驱动**（和"等我弹"完全分开）──────
  // 每次主循环只做一件事：关掉已经过期的窗口、把光标挪到当前时间窗。
  // 起音只负责回答"这个窗口里有没有正确的音"，所以不存在"一个起音吃好几个音"。
  if (modeKind === 'tempo' && phase === 'waiting' && tempoTick(now)) return;
  const lagged = levelHist.length >= 3 ? levelHist[levelHist.length - 3] : 0;
  // 起音判据调严一点：真拨弦是"明显"的一跳，环境声/说话不该触发。
  // 门限：比"脏环境"那版严一点，但别严到把正常拨弦挡掉
  // （上一版 1.8×/0.25 太狠，会把第一下吃掉 → 只能弹第二次）
  // 手机拿远一点音量就小：绝对下限 0.006 会把正常演奏整片挡掉
  // （现象：手机上"下一个预期音"一直停在第一个音 —— 一个音都没判到）。
  // 改成跟着环境噪声走的相对门限，只留很低的兜底。
  // 绝对音量下限：**跟着环境走，不按最吵的情况定**（用户的口径：
  // "太吵确实怪不了我们，但普通没那么吵的环境要能区分"）。
  //   · 安静/普通房间（环境 0.002~0.005）→ 线在 0.008~0.02，正常弹奏绝不会被挡；
  //   · 吵的房间（他那 6 段实测环境 0.008~0.022）→ 线升到 0.03~0.06，杂音进不来；
  //   · 上限封在 0.06 —— 真弹的峰值是 0.18~0.38，留了 3 倍以上余量，压不到真音。
  const ambient = Math.max(floor, 0.002);
  // 倍率 6、下限 0.02：真弹的峰值实测 0.18~0.38，所以这条线（0.02~0.09）压不到真音，
  // 但比环境噪声（0.008~0.022）高一截 —— 手机上"放着不动它自己走"就是原来倍率/下限太低。
  // 用户的要求：**按他录的音频把界限定到极限、容忍度收紧**。
  // 他那 6 段的实测：环境 0.008~0.022、真弹峰值 0.18~0.38（最轻的一段也有 0.18）。
  // 所以线下到 0.05（最轻那次峰值的 1/3.6），倍率提到 8、上限 0.12 ——
  // 宁可漏掉很轻的声音，也不让环境里的响动变成音符。
  // ⚠ 门槛定得太高会**切掉真音**：用户实测"1弦1品怎么弹都过不去，换 2 弦同音就轻松过" ——
  // 1弦细、轻、衰减快，电平就是低；而他导出记录里真弹的电平最低是 **0.076**，
  // 我把线下放到 0.10 就正好把它切了。
  // 重新按他的数据定：环境 0.008~0.022、真弹 0.076~0.213
  //   → 线下 **0.05**（环境的 2~6 倍，最轻那次真弹的 2/3）、上限 0.10。
  const absNeed = Math.min(0.10, Math.max(0.05, ambient * 6));
  // 相对"最近最强"的门槛：试过 12%~22%，**把快音也挡掉了**
  // （快音第二下的起音电平只有首个峰值的一成左右），所以不启用，只留着这个参照给读数看。
  peakLvRef = Math.max(lv, peakLvRef * 0.998);
  const strongGate = Math.max(0.0012, gate * 1.2, absNeed);
  // 不做节奏、也不设"延音期"：每一次拨弦都对应"下一个还没判过的音"。
  // （原来按时值设延音期，你弹得比时值快时，下一个音落在窗口里被忽略，
  //   光标不动 → 后面每个音都少一位、越走越乱。）
  // 谱面知道这一段是快音还是慢音：按"到下一个音的间距"决定最小间隔。
  // 快音段（间距 150ms）约 80ms 后就允许再次触发，慢音段最长等到 160ms。
  // 这样一次拨弦的余响抖动不会再被当成"下一个音"（4 下跳 8 个的问题）。
  // 谱面知道"这里是连续两个相同音"：同一根弦同一个音再拨一次，频谱上没有新音高可认，
  // 判据必须放宽，否则一定漏 —— 这是"连续两个一样的音"测不准的主因。
  const curN = notes && notes[noteIdx];
  const prevN = notes && notes[noteIdx - 1];
  const repeatSame = !!(curN && prevN && curN.midi === prevN.midi);
  const riseNeed = repeatSame ? 1.2 : 1.5;
  const fluxNeed = repeatSame ? 0.12 : 0.18;
  // ── "够不够陡"是这一层最要紧的判据 ─────────────────────────────────────
  // 用户实测：**只弹一个音让它一直响**，隔一会儿光标自己往前跳好几个音，还一直判对。
  // 原因：音量起伏（琴弦打拍子、手机麦克风的自动增益、房间反射）会被当成"新拨了一下"。
  // 但拨弦和起伏有一个物理差别：**拨弦是几毫秒内从无到有**，起伏是几十毫秒慢慢涨。
  // 所以要求"这一帧（16ms）的电平至少是上一帧的 1.7 倍"——慢慢涨的过不了这一关。
  // （测过 flux/hfFlux 都分不开这两种情况：同一个音整体变响时，全谱是一起变亮的。）
  const prevLv = levelHist.length ? levelHist[levelHist.length - 1] : 0;
  // 1.4 倍：拨弦那一帧通常涨 1.5~50 倍；连着两个快音时第二个音只在第一个音的
  // 余响上再抬一截（实测 1.67 倍），门限设 1.7 会把这种**真拨弦**挡掉。
  const sharpEnough = lv > prevLv * 1.4 || prevLv < Math.max(0.0012, floor * 1.5);
  // ③ 换音：最近两帧的主峰都落在"和 3 帧前不同的音"上（差半个半音以上）
  let pitchJump = false;
  if (domHist.length >= 5) {
    const oldHz = domHist[0], a = domHist[3], b = domHist[4];
    if (oldHz > 0 && a > 0 && b > 0) {
      const dA = Math.abs(1200 * Math.log2(a / oldHz)), dB = Math.abs(1200 * Math.log2(b / oldHz));
      // 差值要在"一个音到另一个音"的范围内：>60 音分（不是抖动），<700 音分
      // （**排除八度**——一个音衰减时主峰会从基频翻到二次谐波，那正好差 1200 音分，
      //   不是换了音，实测会让一个长音被判成两个）。
      const cB = 1200 * Math.log2(b / oldHz);
      if (dA > 60 && dB > 60 && Math.abs(cB) < 700 && Math.abs(1200 * Math.log2(b / a)) < 80) pitchJump = true;
    }
  }
  // 再加一条：**频谱形状**得变。音量起伏（打拍子/自动增益）是整体变亮，形状不变；
  // 拨弦会带进新的泛音，形状一定变。实测 4Hz 深打拍子能骗过"够不够陡"，
  // 但骗不过这一条（形状距离 ≈ 0）。
  const shapeFlux = shapeFluxOf(buf);
  const shapeChanged = shapeFlux > 0.02;
  const onset = phase === 'waiting' && now >= refractoryUntilMs && lv > strongGate
    && sharpEnough && shapeChanged
    && (lv > lagged * riseNeed || (flux > fluxNeed && lv > lagged * 1.15)
        // 重复音：**必须是"真再拨一下"**——高频瞬态和电平抬升要同时出现（用 && 不用 ||）。
        // 只有延音在响时，高频是衰减的、电平也在往下走，两条都不成立，就不会被当成新的一下。
        || (repeatSame && hfFlux > 0.10 && lv > lagged * 1.15))
    && now - lastOnsetMs > Math.max(90, CFG.minGapMs);
  // 起音层逐帧台帐（只在 test-follow-real.mjs 的 VC_ONSET_DEBUG=1 时打）：
  // 查"这一段为什么没被当起音 / 为什么一下被算成两下"用。对页面没有任何影响。
  if (globalThis.__vcOnsetDebug && lv > 0.02) {
    console.log(`[onset] t=${(now / 1000).toFixed(3)} 电平=${lv.toFixed(4)} 上帧=${prevLv.toFixed(4)}`
      + ` 滞后=${lagged.toFixed(4)} 门限=${strongGate.toFixed(4)} 陡=${sharpEnough ? 'y' : 'n'}`
      + ` 形状=${shapeFlux.toFixed(3)} 通量=${flux.toFixed(3)} 高频=${hfFlux.toFixed(3)}`
      + ` 上升=${(lv / (lagged + 1e-9)).toFixed(2)} 重复=${repeatSame ? 'y' : 'n'}`
      + ` 相位=${phase} 冷却=${now >= refractoryUntilMs ? 'y' : 'n'} → ${onset ? '起音' : ''}`);
  }
  // ③ **撤掉**"主峰跳变就算新起音"这条。
  // 它本来是想解决"快音的第二下"（换弦换品时电平还没掉、音高先跳），但代价是：
  // 一个长音在响的时候，主峰会随衰减在基频和某个谐波之间来回晃 —— 每晃一下就多算一个音，
  // 用户实测"弹一个延音过去两行"就是这么来的。
  // 起音层只该回答"有没有新的拨弦动作"（电平+瞬态），**不该借用音高**（两次实测都证明会误触发）。
  // 快音的第二下要分开，正确的做法是在**低频能量包络**上做"峰高+回落"（离线已验证），
  // 那是起音层自己的活，不是音高层的事。
  let jumpOnset = false;
  levelHist.push(lv);
  if (levelHist.length > 10) levelHist.shift();
  // 实时电平（每 10 帧更新一次）：排查"放着不动它自己走"时，让用户直接把数报给我。
  // 环境 = 噪声地板估计，门限 = 起音必须超过的电平，电平 = 当前这一帧。
  if (frames % 10 === 0 && $('lv')) {
    $('lv').textContent = `环境 ${floor.toFixed(4)} / 门限 ${strongGate.toFixed(4)} / 电平 ${lv.toFixed(4)} / 最近最强 ${peakLvRef.toFixed(4)}`;
  }

  if (onset || jumpOnset) {
    onsetPeakLv = lv;                    // 记下峰值电平，判定时用它验"尾巴"（判据②）
    if (globalThis.__onsetLog) globalThis.__onsetLog.push(Number((now / 1000).toFixed(3)));
    onsetLog.push({
      t: Number((now / 1000).toFixed(3)), level: Number(lv.toFixed(5)),
      floor: Number(floor.toFixed(5)), gate: Number(strongGate.toFixed(5)),
      flux: Number(flux.toFixed(3)), hfFlux: Number(hfFlux.toFixed(3)),
      repeat: repeatSame, expect: (notes && notes[noteIdx]) ? midiToNameOf(notes[noteIdx].midi) : null,
    });
    const nowSpec = getFluxSpec();
    const prevSpec = getBeforeFluxSpec();
    if (nowSpec && prevSpec && nowSpec.length === prevSpec.length) {
      rise = new Float32Array(nowSpec.length);
      for (let i = 0; i < nowSpec.length; i++) rise[i] = nowSpec[i] / (prevSpec[i] + 1e-9);
    } else rise = null;
    phase = 'settling';
    onsetAtMs = now;
    lastOnsetMs = now;
    heardInWindow = true;
    windowTries = 0;
    // 峰值快照：只在**起音这一刻**取一次 170ms 频谱（8192 点，bin 宽 5.9Hz）。
    // 判定只用它 —— 之后的余响、延音、衰减一概不参与（这就是"只处理峰值"）。
    try {
      const PEAK_N = 8192;
      const sim = spectrumOf(buf.subarray(Math.max(0, buf.length - PEAK_N)));
      // 抬头过滤：只有起音这一下**真的往上跳**的频点才算数（rise>1），
      // 还在衰减的旧谐波（rise<1）压到 0 —— 即"取过峰值后，后续延续谐波不处理"。
      const ctxRate = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
      const riseBinHz = ctxRate / FLUX_N;      // rise 阵列来自 2048 点窗
      const peakBinHz = ctxRate / PEAK_N;
      for (let i = 0; i < sim.length; i++) {
        const ri = Math.round((i * peakBinHz) / riseBinHz);
        const r = rise && ri < rise.length ? rise[ri] : 1;
        sim[i] *= Math.max(0, Math.min(3, r - 1));
      }
      onsetPeakSpec = sim;
    } catch (e) { onsetPeakSpec = null; }
    // 差分谱：`buf` 此刻装着最近 341ms（CAPTURE=16384 @48k），正好切两半 ——
    // 前半是"起音之前"（上一个音的余响 + 房间），后半是"起音之后"（新音 + 余响）。
    // 相减 = 这一下新加进来的东西。
    onsetDiffSpec = null;
    try {
      const PEAK_N = 8192;
      const end = buf.length;
      const postFrom = Math.max(0, end - PEAK_N);
      const preFrom = Math.max(0, end - 2 * PEAK_N);
      if (end - postFrom === PEAK_N && postFrom - preFrom === PEAK_N) {
        onsetDiffSpec = diffMags(spectrumOf(buf.subarray(postFrom, end)),
          spectrumOf(buf.subarray(preFrom, postFrom)));
      }
    } catch (e) { onsetDiffSpec = null; }
  }

  if (phase === 'settling' && now - onsetAtMs >= 90) {
    phase = 'waiting';
    const sr2 = audio.getRate();
    const riseBinHz = ((audio.getCtx() && audio.getCtx().sampleRate) || 48000) / FLUX_N;
    const a = track(buf, audio.getDecim(), sr2);
    const novel = novelSpectrum(a.mags);
    // 调音器那条思路：**只有"足够像一根弦在振动"的信号才算演奏**。
    // track() 给的 clarity 就是周期性强度（0~1）：真拨弦高、说话/敲门/摩擦低。
    // 不像琴声就当作环境音，直接忽略 —— 不判、不计数、不推进。
    // "像不像一根弦在振"这道关卡不能太狠：拨弦瞬间窗里主要是起振，
    // clarity 常常还没稳定 —— 阈值设高就会把你这一下丢弃（表现就是同一个音要弹两次）。
    // 现在放低阈值；确实不像琴声时也**不丢弃**，而是 60ms 后再量同一段，最多重试两次。
    // "这一下像不像一根弦在振"：原来只看 YIN 的 clarity，但 YIN 在**上一个音还在响**的
    // 混合信号里会直接放弃（返回 0 音高）—— 于是连续两个快音里的第二个被丢掉，
    // 用户看到的就是"第二个音跟不上"。现在补一把尺子：只要谐波墙立着（谐噪比够高）
    // 就继续判；真正的噪声/风/拍桌子谐波墙是立不起来的（实测 1.6 倍 vs 2 万倍）。
    let notAString = false;
    if (songKind === 'heyjude') {
      const clarityFail = !(a.pitch.clarity > 0.42) || !(a.pitch.hz > 55);
      if (clarityFail) {
        let hnr = 0;
        let sparse = 0;
        let flat = 1;
        let peaky = 0;
        let peakyNovel = 0;
        try {
          const n = 1 << Math.floor(Math.log2(Math.min(8192, buf.length)));
          const srNow = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
          const expMidi = notes && notes[noteIdx] ? notes[noteIdx].midi : 60;
          const expHz = 440 * Math.pow(2, (expMidi - 69) / 12);
          const sp = spectrumOf(buf.subarray(buf.length - n));
          hnr = harmonicity(sp, srNow, n, expHz);
          sparse = spectralSparsity(sp, srNow, n);
          flat = spectralFlatness(sp, srNow, n);
          peaky = spectralPeakiness(sp, srNow, n);
          // 再看**差分谱**（新加进来的那部分）像不像谐波串：
          // 拨弦新加的是一串新谐波，拍桌子/风新加的是宽带 —— 这跟"整体谱长什么样"是两件事。
          peakyNovel = spectralPeakiness(novel, sr2, a.fftN);
        } catch (e) { hnr = 0; sparse = 0; flat = 1; }
        // YIN 在"上一个音还在响"的混合信号里必然放弃（返回 0 音高），
        // 而那种情况正是**连续两个音的第二下**。试过"够响就放行"（门限 8 倍）：
        // 快音是进来了，但拍桌子/风的误判也一起进来了（实测 2 处假判对）。
        // 现在两把尺子（谐噪比 / 谱的稀疏程度）都分不开"两个音叠在一起"和"噪声"：
        //   · 谐噪比：上一个音的谐波正好落在这个音的谷里 → 墙立不起来（实测 1.8 vs 1.6）；
        //   · 稀疏度：混合的两个音是两条线状谱，反而比低频为主的风更"不集中"（0.09 vs 0.16）。
        // 所以先维持"宁可不判"：YIN 放弃就按不像琴声处理，不冤枉也不乱吃音符。
        // **这条待解**：需要一条能分开"新拨的一下"和"环境瞬态"的判据（见记忆同步）。
        // 0.35 这条线是量出来的：风/拍桌子（宽带）落在 0.19~0.32，
        // 拨弦（含"上一个音还在响时的新一下"）落在 0.45~0.50。
        // 用差分谱而不是整谱：整谱上两个音叠在一起和噪声长得一样（前四把尺子都栽在这），
        // 而"**新加进来的那部分**是不是一串谐波"这件事，拨弦和噪声差得很清楚。
        // ⚠ 这里只能用 YIN 的结论（clarity 不成立就算"不像琴声"）。
        // 曾经为了放连续快音的第二下进来，把它放宽成"谐噪比和稀疏度同时不成立才算噪声"——
        // 结果是环境里那些"YIN 说不行、频谱却有点结构"的声音全放了进来，手机上又变成
        // **任何音都判对**。所以回到 YIN 说了算：宁可丢掉连音的第二下（已知缺口），
        // 也不能让随便什么声音都当音符。
        notAString = true;
        const last0 = onsetLog[onsetLog.length - 1];
        if (last0) {
          last0.hnr = Number(hnr.toFixed(1));
          last0.sparse = Number(sparse.toFixed(2));
          last0.flat = Number(flat.toFixed(3));
          last0.peaky = Number(peaky.toFixed(2));
          last0.peakyNovel = Number(peakyNovel.toFixed(2));
        }
      }
    }
    if (songKind === 'heyjude' && notAString) {
      {
        const last = onsetLog[onsetLog.length - 1];
        if (last) (last.retry = last.retry || []).push(`${(a.pitch.clarity || 0).toFixed(2)}/${Math.round(a.pitch.hz || 0)}Hz`);
      }
      if (windowTries < 2) {
        windowTries++;
        onsetAtMs = now + 30;            // 再过 60ms 重测（settling 在 +90ms 触发）
        phase = 'settling';
      } else {
        phase = 'waiting';
        // 这一下没通过"像不像一根弦"的关卡 —— 记进台帐，别让它悄无声息地消失
        const last = onsetLog[onsetLog.length - 1];
        if (last) { last.dropped = 'not-a-string'; last.clarity = Number((a.pitch.clarity || 0).toFixed(3)); last.hz = Math.round(a.pitch.hz || 0); }
      }
      micTimer = requestAnimationFrame(micTick);
      return;
    }
    if (songKind === 'chords' && chords) {
      const c = chords.chords[chordIdx];
      if (c) {
        const r = chordOutsiders(novel, sr2, a.fftN, c.midis);
        const pass = r.ratio >= 0.7;
        $('heard').textContent = `解释 ${(r.ratio * 100).toFixed(0)}%`
          + (r.outsiders.length ? ` · 外音 ${r.outsiders[0].hz}Hz` : '');
        if (pass) good++; else bad++;
        setVerdict(pass ? `✓ ${c.name}` : `⚠ ${c.name} 里有和弦外音（约 ${r.outsiders[0] ? r.outsiders[0].hz : '?'}Hz），继续`,
          pass ? 'ok' : 'bad');
      }
    } else if (notes && noteIdx < notes.length) {
      const onsetSec = (now - micStartedAt) / 1000;
      // 对齐参考只记时刻 —— **不丢弃这个起音**。
      // （原来这里直接 return，于是"用户弹的第一个音"永远不判。用户实测确认：
      //   Hey Jude 开头就是 2弦1品的那个音，不是多出来的声音。）
      if (alignOffsetSec == null) alignOffsetSec = onsetSec;
      const scoreT = (onsetSec - alignOffsetSec) + notes[0].t;
      // 该判谱面哪一个音：**就是"下一个还没判过的音"**。
      // （试过改成"按时间+音高在附近挑一个"，结果更糟：光标的位置和"判过的音"不再一致
      //   —— advanceNote 是从原位置往后加一的，而挑出来的音可能在前面；而且量错一次就会
      //   去匹配旁边另一个音、把错音判成对。用户当场就说"修了个什么出来"。撤掉。）
      // 这条"按顺序"的老规矩有一个已知弱点（漏检一次后面全体错开一位），要改就得**连光标
      // 的推进方式一起改**（让光标也按同一个规则走），不能只改一半 —— 见思路整理第 3 节。
      let best = noteIdx;
      let devMs = null;
      if (modeKind === 'tempo') {
        // ── 跟节拍：这一下**只看它落没落在某个音的时间窗里** ────────────────
        // 不往前跳、也不把中间的音一起吃掉：窗口过期是"时钟"那边的事（tempoTick）。
        // 落在窗口外（弹早了/弹晚了）→ 这个起音不算数，等窗口关掉记错。
        const elapsed = onsetAtMs - micStartedAt;
        // 第一下 = 时间轴原点：把整条谱面时间轴对齐到用户这一下（第一个音以他为准）
        if (tempoOriginMs == null) {
          tempoOriginMs = elapsed - expectedAtMs(0);
          tempoCursor = 0;
          noteIdx = 0;
          lateAccept = false;
          rebuildTempoClicks();
          highlightCurrent();
          const pickup = tempoPickupCount();
          setVerdict(`起手对齐：以这一下为第 1 个音（${midiToNameOf(notes[0].midi)}）`
            + (pickup ? `　※ 这 ${pickup} 个音是起拍音（拾音），正拍从第 2 小节开始` : ''), '');
          if (pickup) diag(`※ 起拍音 ${pickup} 个（不掐拍子）；正拍 / 提示音从第 2 小节开始`);
        }
        let k = tempoNoteAt(elapsed);
        if (k < 0) {
          const near = tempoNearestPending(elapsed);
          // 落在时间窗之外：如果离"下一个还没判的音"不算太远（≤1.2 个音距），
          // **先按那个音判音准**（lateAccept）。音对 → 认下并**把时间轴重新对齐到你这一下**，
          // 免得"一漏就一路漏、越弹越乱"（用户实测的痛点）；音不对 → 才是真错。
          const ioi = near.idx >= 0 ? Math.max(60, (notes[near.idx + 1] ? notes[near.idx + 1].t - notes[near.idx].t : 0.4) * 1000) : 400;
          if (near.idx >= 0 && Math.abs(near.dev) <= ioi * 1.2) {
            k = near.idx;
            lateAccept = true;
          } else if (near.idx >= 0 && Math.abs(near.dev) <= tempoTol(near.idx) * 4) {
            // 差太多：只提示，不认（那个音会在窗口关掉时按错记）
            timingDevs.push(near.dev);
            timingTolMs = tempoTol(near.idx);
            if (near.dev < 0) earlyCount++; else lateCount++;
            const dir = near.dev < 0 ? '早' : '晚';
            diag(`起音 ${(elapsed / 1000).toFixed(2)}s 比第${near.idx + 1}个音${dir} `
              + `${Math.abs(Math.round(near.dev))}ms（容许 ±${Math.round(tempoTol(near.idx))}ms）→ 这一下不算`);
            micTimer = requestAnimationFrame(micTick);
            return;
          } else {
            micTimer = requestAnimationFrame(micTick);
            return;
          }
        }
        best = k;
        noteIdx = k;             // 只是把"当前音"对齐到这一下；光标仍由时钟驱动
        // 偏差要跟"带原点的时间轴"比（起手对齐之后，第一个音的偏差应该≈0）
        devMs = elapsed - tempoAt(k);
        // ── 快速段落：用"这一下最像哪个音"来定归属（时间 + 音高）──────────────
        // 只按时间最近对号，到 16 分音符那种地方**差一位就整段判错**
        // （用户实测"连续的快节奏音符会判定不过来、导致全错"）。
        // 这里在附近还没判的 ±3 个音里各量一次"自己贴不贴"，挑最像的那个；
        // 同一个音高反复出现时（F4 F4 F4）时间近的优先（损失里带了时间差）。
        try {
          const N = 8192;
          const srNow = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
          const specE = spectrumOf(buf.subarray(Math.max(0, buf.length - N)));
          const c0 = Math.max(0, k - 3), c1 = Math.min(notes.length - 1, k + 3);
          let pick = k, bestLoss = Infinity;
          for (let j = c0; j <= c1; j++) {
            if (tempoState[j]) continue;
            const d = Math.abs(elapsed - tempoAt(j));
            const ioiJ = notes[j + 1] ? Math.max(60, (notes[j + 1].t - notes[j].t) * 1000) : 400;
            if (d > Math.max(tempoTol(j), ioiJ * 1.2)) continue;
            const r = matchNoteByCandidates(specE, srNow, N, notes[j].midi);
            const self = r.ranked.find((x) => x.offset === 0);
            if (!self || !(self.mismatch < 250)) continue;
            const loss = self.mismatch + d / 2;
            if (loss < bestLoss) { bestLoss = loss; pick = j; }
          }
          if (pick !== k) {
            best = pick;
            noteIdx = pick;
            devMs = elapsed - tempoAt(pick);
            diag(`（快音对号：这一下最像第${pick + 1}个音 ${midiToNameOf(notes[pick].midi)}）`);
          }
        } catch (e) { /* 量不出来就按时间对号 */ }
      }
      if (!notes[best]) { stopMic(); return; }
      const exp = notes[best];
      // 判定：知道答案的打法 —— 量出实际音高，再归到最近的半音上比。
      // 不用 YIN 的绝对读数：真机录音上它会锁到次谐波（实测 82~100Hz，差一个半八度，
      // 而 clarity 还有 0.9），这也是项目当初放弃用 YIN 判定的原因。
      const peakRate = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
      // ── 量音高用哪个窗 ───────────────────────────────────────────────
      // 用**判定这一刻往回 170ms**（判定发生在起音后约 90ms，所以这个窗大部分是新音）。
      // 原来用的是"起音那一刻往回 170ms"的快照 —— 那个窗**结束在起音那一瞬**，
      // 里面几乎全是上一个音的余响，只有最后十几毫秒是新音，实测把干净的 D4
      // 读成 +70 音分。窗的位置这一条就把散布从 ±80 音分降到 ±40 上下
      // （量法见 test/probe-estimator.mjs）。
      const PEAK_N = 8192;
      let judgeSpec = null;
      try { judgeSpec = spectrumOf(buf.subarray(Math.max(0, buf.length - PEAK_N))); }
      catch (e) { judgeSpec = null; }
      // ── 量什么：**只看"起音这一下新加进来的那部分"（差分谱）────────────────
      // 用户一句话点破了：判定该回答的是"**谱面要的这个音，是不是起音的那个音**"。
      // 那就不该问"谱面这个音在不在"（那个问法必然被锚死 —— 在期望音附近找峰，
      // 弹偏两个半音也会在范围里捡个峰报回期望音，于是什么都判对）。
      // 改法：后一窗（起音后 170ms）减前一窗（起音前 170ms），剩下的就是**这一下新加的东西**。
      //   ① 弹错音 → 差分谱里是那个错音，量出来就是错音 → 判得出；
      //   ② 快音的第二下 → 差分谱把上一个音减掉了 → 第二个音能单独量出来（这就是"快音怎么办"）；
      //   ③ 噪声/拍桌子 → 差分谱是宽带，量不出稳定音高 → 测不准。
      // 找峰范围放到 ±250 音分（两个半音）：范围太窄会重新把读数锚回期望音。
      const spec = judgeSpec || onsetPeakSpec || novel;
      const specRate = judgeSpec || onsetPeakSpec ? peakRate : sr2;
      const specN = judgeSpec || onsetPeakSpec ? PEAK_N : a.fftN;
      // ── 判定：候选重排（本音 vs ±1 品 vs ±2 品）────────────────────────────
      // spec 就是"判定这一刻往回 170ms"那扇窗，也就是 test/gt-notes.mjs 里验过的那扇。
      const candMatch = JUDGE_CAND ? matchNoteByCandidates(spec, specRate, specN, exp.midi) : null;
      const candSelf = candMatch ? (candMatch.ranked.find((x) => x.offset === 0) || null) : null;
      const candRival = candMatch
        ? (candMatch.ranked.filter((x) => x.offset !== 0 && Math.abs(x.offset) <= 2)
          .sort((a, b) => b.score - a.score)[0] || null)
        : null;
      const candBest = candMatch ? (candMatch.ranked[0] || null) : null;
      let diffSpec = spec;
      // ── 判定：**先独立量出"这一次起音弹的是什么音"，再和谱面对**（用户的口径）──
      // 不用"在期望音附近找峰"那把尺子（那个必然自证：弹偏两个半音也会捡个峰报回期望音，
      // 于是什么都判对）。改用低频带最强谱线 —— 在 6 段真机录音上验证过：
      // 同段落里最强低频线在 258Hz(C4)/328Hz(E4) 之间干脆地跳，跳变点就是一次次起音。
      //
      // ⚠ 量音高必须用**短窗、只看起音之后那一段**：判定发生在起音后约 90ms，
      // 如果用 170ms 的长窗，里面有 80ms 是"上一个音还在响"，快音的第二下会被上一个音盖住
      // （实测：两个不同音隔 200ms 时，第二下量到的是第一下 → 判错）。
      // 用 85ms 窗（4096 点）= 只看起音之后的这一段，量的就是新弹的那个音。
      // ⚠ 试过把量音高的窗缩短到 85ms（4096 点）来躲开上一个音：结果**全部变成"测不准"**
      // （窗短了峰变宽、八度判断也会翻），整段判定报废。所以仍旧用 170ms 那扇窗量。
      // 代价：快音的第二下会被上一个音带偏 → 记"测不准"而不是"对"（已知缺口，见记忆同步）。
      // ── 量音高：退回"老页面"那套（多谐波打分 + 本底相减）─────────────────────
      // 这几天我自作聪明换成"在频带里找最强的那根线"，结果三条全错：
      //   ① 吉他上基频常常不是最强的（实测把 C4 量成 524Hz，整整高一个八度）；
      //   ② 一根线的高低抗不了干扰，"一整排谐波对不对"才是真证据；
      //   ③ 没有减掉"上一个音还在响"（本底），谁响就锁谁 —— 用户导出里
      //      弹 C4/A3/D4 却老是量到 180~220Hz，就是锁到别的弦上了。
      // 老做法（estimateF0Near：1~10 次谐波加权打分；输入是 novelSpectrum 本底相减后的谱）
      // 正好解决这三条 —— 它唯一的毛病是"偶尔收不到音"，那是起音层的事。
      // 范围就用老页面的 ±80 音分（试过放宽到 ±250：读数会锁在边界上、整段判废 ——
      // 那个打分函数对"更低的假设"天然给分更高，范围一宽就往低处贴）。
      // 配合"只有对错两档、判据 50 音分"：弹对 → 读数在几音分内 → 对；
      // 弹偏了 → 最优解顶到 ±80 边界 → 超过 50 → 错。正好是用户要的口径。
      // ⚠ 换成"老页面那套（estimateF0Near + novel 本底相减）"试过了：**合成回归立刻红**
      // （"两个音都弹对"变成 对1/错1）。也就是说我这样"照猫画虎地接"并不等价于老页面 ——
      // 老页面那条链路里还有它的上下文（track 的状态、settle 的时机、judge.js 的候选比较），
      // 我这么搬会搬坏。**正确做法是让产品页直接复用老页面的判定函数**（judge.js 那条），
      // 不是照抄它的算法 —— 这条留给下一轮，动之前先用它的代码路径跑通再说。
      // 这一版先保持"多谐波峰 + 最小二乘"（它在"弹错音矩阵"上是全对的），
      // 只把**起音层**那条"主峰跳变"撤掉（那是"一个音走好几格"的直接原因）。
      // ── 量音高：**用 YIN**（老页面那条，用户实测"音准识别很好"）───────────────
      // 这几天我换过两次都不行，原因现在很清楚：
      //   ① "在期望音 ±2 半音的带子里找最强线" → 带子里有什么就报什么 → **瞎弹也会对**（自证）；
      //   ② "取最低/最强的线" → 吉他上基频常不是最强，且别的弦在响 → 锁到别的弦上（全错）。
      // YIN 是**自己在时域上找基频**（不预设答案），而且它已经在 `track()` 里跑过、
      // 还带了 `fixPitchBySpectrum` 的修正 —— 老页面就是用它，`a.pitch.hz` 直接就是读数。
      // 它唯一的毛病是"混合信号里会放弃（返回 0）"，那是**起音层/时机**的事，不是测量的事。
      // ⚠ **不要用 YIN 的绝对读数做判定**。这一条这个项目早就写过答案（见 analysis.js 的注释）：
      //   真机录音上 YIN 会**锁到次谐波**（实测 82~100Hz，差一个半八度，而 clarity 还有 0.9），
      //   项目当初就是因为这个放弃用 YIN 判定的。
      //   我这两轮又把它接回来做判定 → 用户当场"真正意义上的全错"（普遍读低一个半八度）。
      // 回到项目原本的做法：**在"起音那一刻的快照"上，用多谐波加权打分**
      // （estimateF0Near：不用 YIN 的绝对音高，只看"期望音的谐波位置上有多少能量、
      //   以及最佳解偏离期望音多少音分"）。
      // ⚠ 宽搜索（±1200 音分）在**合成**上 8/8 全对，但**真机上量出来是垃圾**：
      // 用户 17:46 那份导出里，期望 C4 量到 136Hz、期望 F4 量到 175Hz（差一个多八度）——
      // 和 YIN 一个病：**锁到次谐波/别的弦上**。合成信号只有一根弦在响，所以看不出这个坑。
      // 退回 ±80 音分：它不会乱跑（代价是"弹错音"难判出来，那条要用**差分谱**解决，
      // 见下面的注释和记忆同步）。
      const fit = { rangeCents: 80, tolCents: 15 };
      // 差分谱那份：范围放宽到 ±250 音分（两个半音）。
      // 为什么要放宽：搜索范围一窄（±80），"弹成隔壁半音"的最优解就会**贴在边界上**
      // 报回 ±80 —— 和"音准差一点"几乎同一个数；范围放宽之后，真弹 D#4 就报 ~+100 音分，
      // 和"差一点"（十几音分）清清楚楚分开。快照那份之所以不敢放宽，是因为它里面
      // 混着上一个音，一放宽就锁到别的弦上（实测期望 C4 量到 136Hz）。
      // ⚠ 试过把输入换成 `novel`（本底相减后的谱），想让 1弦1品那种"轻又高的音"
      // 不被还在响的低音弦盖住 —— **合成回归立刻红**（弹对的变成判错）：
      // because 那个本底是**缓慢吸收**的，判定发生在起音后 90ms，这时连**新拨的这个音**
      // 也已经被本底吃掉一部分了。所以本底相减只能用**以起音采样点为中心的前后短窗**
      // （需要环形缓存 + 记住起音采样位置），不能在"判定这一刻的 340ms 长窗"上用。
      // 那条路（差分谱 = 攻击前短窗 − 攻击后短窗）是 1弦1品 和 快音 的共同正解，
      // 但今天不做 —— 见对话记录里的取舍：不在没有离线验证的情况下再改测量。
      const est = estimateF0Near(onsetPeakSpec || novel, peakRate, 8192, exp.midi, fit);
      // 差分谱上的同一把尺子（范围放宽到 ±250）：这就是"不看上一个音、也不看答案"
      // 的那一次量 —— 判定优先用它。
      const estDiff = onsetDiffSpec
        ? estimateF0Near(onsetDiffSpec, peakRate, 8192, exp.midi, { rangeCents: 250, tolCents: 15 })
        : null;
      const useDiff = !!(JUDGE_DIFF && estDiff && estDiff.score > 0);
      const estJ = useDiff ? estDiff : est;
      // 复核：主判据读的是"起音那一刻的快照"，实测它会抓早（把弹对的读偏 60~80 音分）。
      // 所以判定这一刻（起音后约 90ms）再用同一把尺子量一次平窗，落在 45 音分内就判过。
      // 这一条在你那段 30 秒录音上把结果从"对 28／错 3"抬到"对 40／错 0"。
      let confirmCents = null;
      try {
        const cs = judgeSpec || spectrumOf(buf.subarray(Math.max(0, buf.length - PEAK_N)));
        const ce = estimateF0Near(cs, peakRate, PEAK_N, exp.midi, fit);
        if (ce && ce.score > 0) confirmCents = ce.cents;
      } catch (e) { confirmCents = null; }
      const dom = { hz: estJ.f0, mag: estJ.score, sharp: 1, cents: estJ.cents };
      // ★ 判定改用**判定这一刻的窗**（estP.cents，代码里本来就在算，只是以前只拿去记日志）。
      // 依据是用户 18:24 那份导出（同一批 66 个音，两种测量同时记在记录里）：
      //   起音快照（原判定用）: 中位 60 音分、90 分位 80、±20 内 17/66
      //   判定窗（现在用这个）  : 中位 9.9 音分、90 分位 31、±20 内 50/66
      // 快照为什么会差：它**结束在起音那一瞬**，窗里几乎全是上一个音的余响
      // （这是项目最早就知道的事，我这两天才又把判定接回它上面）。
      // 判定窗是"起音后约 90ms 往回 170ms"，大部分是新拨的那个音。
      // estP = 判定窗上的多谐波测量（这就是上面那个"准 6 倍"的值）
      const estP = estimateF0ByPeaks(spec, specRate, specN, exp.midi, {});
      // ⚠ 试过改用"判定窗"（estP.cents）：它看着准（中位 9.9 音分），但**什么都判对** ——
      // 用户 18:24 那份"随便弹"的记录里，用它 64/66 仍然判对。原因和快照一样：
      // **都是锚在谱面那个音上找**，任何输入都能在期望音附近找到点东西。
      // 所以判定仍然用快照（它噪声大，但至少还有区分度）。
      // 真正的出路是**不看答案的测量**（攻击前后短窗的差分谱），见记忆同步。
      const centsJudged = estJ.cents;
      // 判定用的偏差 = 独立量到的音（低频带最强线）离谱面那个音有多远
      const expHz0 = 440 * Math.pow(2, (exp.midi - 69) / 12);
      const centsOff = centsJudged;
      // 本次演奏的整体音准基线：把已经测过的偏差取中位数。
      // 琴整体偏低 40 音分是常事；不校正的话，弹对的音会成片被判成"差一点点"。
      // 用"最近 20 个音"的中位数（滑动），而不是全部历史：演奏中手感和按弦会变，
      // 只用前几个音又会拖很久才校正。门槛从 5 降到 3，让校正早点生效。
      // 按弦校正：优先用**同一根弦**的偏差中位数（该弦漂多少就补多少），
      // 样本不够时退回全局中位数。用户随手弹、琴还可能不准，这一步是关键。
      const str = exp.string || 0;
      const arr = devByString[str] || [];
      const globalMed = devHistory.length >= 5 ? median(devHistory) : 0;
      // 样本足够（≥5）才信"这根弦"的值，并且向全局值收缩一半 ——
      // 每根弦的样本太少时，单纯用弦内中位数会把噪声当调音偏差（实测反而更差：14/6）。
      // ⚠ **校正不再参与判定**（用户的口径："只要不在这个音分范围内都是错"）。
      // 它原来是"把琴整体偏高/偏低扣掉"，但用户 18:24 那份导出里它涨到 60 音分，
      // 于是判定带变成"±75 + 60"——**一个半音以内的错音全被这 60 掩盖** →
      // "随便弹一些音都会判对"。现在它只用来**提示调弦**（界面上那行红字），
      // 判定只跟谱面那个音比。
      const tuningRaw = arr.length >= 5 ? 0.5 * median(arr) + 0.5 * globalMed : globalMed;
      const tuning = Math.max(-40, Math.min(40, tuningRaw));
      // ⚠ 只有"**看起来像音准偏差**"的读数才进基线（±150 音分以内）。
      // 用户 17:46 那份导出里，基线被 -1135、-950、-583 这种**垃圾读数**拖成了
      // -235 / -320 / -583，于是校正值乱摆、判定跟着一起乱（"判得很离谱"）。
      // 差一个半音以上的读数不是"琴偏了"，是"量飞了"——不能让它污染基线。
      if (Math.abs(centsOff) <= 150) {
        devHistory.push(centsOff);
        if (devHistory.length > 200) devHistory.shift();
        devByString[str] = (arr.length >= 40 ? arr.slice(-40) : arr).concat([centsOff]);
      }
      // 提示用户调音：某根弦整体偏差超过 25 音分就说出来（跟调音器一个作用）
      const worst = Object.entries(devByString)
        .filter(([, v]) => v.length >= 3)
        .map(([k, v]) => ({ str: Number(k), off: median(v) }))
        .sort((a, b) => Math.abs(b.off) - Math.abs(a.off))[0];
      if (worst && Math.abs(worst.off) > 25 && $('tune')) {
        $('tune').textContent = `⚠ 第${worst.str}弦${worst.off > 0 ? '偏高' : '偏低'} ${Math.abs(Math.round(worst.off))} 音分，建议先调弦`;
      }
      // 判定用的偏差：**就是"量到的音离谱面那个音多少音分"，不扣校正**
      const centsFixed = centsOff;
      // ── 判定：把校正后的实测音高归到**最近的半音** ─────────────────────
      //   · 归到谱面这个音（半个半音以内）→ 对
      //   · 归到 ±1/±2 个半音 → 错，并说出量到的是哪个音
      //   · 再远、或者谐波太少（不像一根弦在振）→ 测不准，不判错、不计数
      // 一格就是一个半音 = 100 音分；判据成立的前提是量音高准到 ±50 音分以内
      // （estimateF0ByPeaks 在那段真机录音上 100% 落在带内）。
      const midiMeas = dom.hz > 0 ? (69 + 12 * Math.log2(dom.hz / 440) - tuning / 100) : NaN;
      const nearMidi = Math.round(midiMeas);
      const offSemis = nearMidi - exp.midi;
      // 可信度：低频带里得真有一根"立得住"的线（够强、够尖），否则记"测不准"不判错
      // 门槛只要"确实有一根线"就行（实测真拨弦的峰锐度是 1.07~1.65，
      // 设 1.25 会把弹对的音也变成"测不准"）。宁可让噪声走进 ±50 音分那条判据里判错，
      // 也不能把弹对的音挡在门外——"任何音都判对"比"偶尔判错"严重得多。
      // ⚠ 这里只要"确实量到一根线"就算可信。曾经要求 `sharp > 1.02`，
      // 结果用户导出记录里出现"量到 G3、差 4 音分、却判错"（那条 domSharp 正好 1.01）——
      // 量对了的音被这道关卡卡成错音。可信度不该由"峰够不够尖"决定，
      // 该由"量的这个音是不是谱面要的那个"决定。
      const reliable = dom.hz > 0 && dom.mag > 0;
      // 用户的要求：**对就是对、错就是错**，不要第三档"测不准"。
      // 判过线：**75 音分**（用户定的：比原来 50 宽一点，但仍**不到半音 100** ——
      // 这样"琴/手法差一点"能过，"按低一品/高一品"仍会被判错）。
      const unclear = false;
      // 判过：主判据在 75 音分内 → 过；否则**复核说"音在这里"（45 音分内）也判过**。
      // 判定：**就一次比较** —— 在 75 音分内就是对，出去就是错。
      // （复核不再当"放行通道"：它是第二次机会，而且同样锚在期望音上，几乎什么都放得过 ——
      //   用户实测"大部分都对、很多音推荐我调弦但我就是弹错了"，它就是主因之一。
      //   复核值仍然记进导出记录，只作参考。）
      const confirmed = false;
      // 判过：**本音失配够小 + 本音在"差一品"的候选里最像**，两条都要。
      // 真正干活的是第二条（领先对手）：弹错半音时，那个邻居候选会明显压过本音。
      // 第一条只是个"别把噪声当音"的上限 —— 实测分布（真机 39 个拨弦 + 手机导出 82 条）：
      //   弹对（真机）        本音失配 121~182
      //   弹对（手机·1弦）     本音失配  118~195   ← 1弦又细又轻，失配天生偏高
      //   弹错（真机 ±1/±2）   本音失配  186~300
      //   没证据（静音/噪声）   本音失配  300（= 找不到任何峰）
      // 所以门槛放在 250：既容得下 1 弦的安静音（195），又不会把"没证据"放进来（300）。
      // ⚠ 别用"锚定测量说准"来兜底：试过，会把"弹高了半音"的检出打崩（39 个里只剩 7 个判错）——
      // 锚定测量本来就会在高半音的窗里找到东西。
      const passCand = !!(candSelf && candSelf.mismatch < CAND_FIT_MAX
        && (!candRival || candSelf.score > candRival.score));
      const pass = JUDGE_CAND && candMatch ? passCand : (reliable && Math.abs(centsFixed) <= 75);
      // 判"错"之后要说出**用户弹的是哪个音**。问题：上面那把尺子是在"谱面那个音"的
      // 谐波位置上找峰的（±60 音分），真弹成隔壁半音时真谐波落在范围外，读数会被拉回来
      // —— 实测真弹 D#4 读成 -59 音分（指向 C#4，方向还反了）。
      // 所以只在要报错时才换一把**宽搜索**的尺子（±140 音分）去认音名；认不出来就不硬说。
      let seenMidi = nearMidi;
      let seenCents = estP.cents;
      if (candBest && candBest.offset !== 0) {
        // 候选重排挑出来的那个音 = "你实际弹的是什么"（这条路不是锚在本音上找的，所以可信）
        seenMidi = candBest.midi;
      } else if (!pass && !unclear) {
        const wide = estimateF0ByPeaks(spec, specRate, specN, exp.midi, { tolCents: 140 });
        if (wide.score > 0 && wide.nHarm >= 2) {
          const wC = wide.cents - tuning;
          if (Math.abs(wC) <= 250) { seenMidi = Math.round(69 + 12 * Math.log2(wide.f0 / 440) - tuning / 100); seenCents = wC; }
        }
      }
      // 认出来的邻居和谱面这个音撞名了（取整可能撞上）：这时不能说"要 G3、你弹的是 G3"，
      // 改成说"偏得比较多"。
      const seenSame = seenMidi === exp.midi;
      // ── 时间：这一下比该弹的时刻早/晚了多少 ─────────────────────────────
      // 单独报，不和音准合成一个"对/错" —— 用户被标红时得知道错在音还是错在拍。
      let timKind = null, timStr = '';
      if (devMs != null) {
        timingTolMs = timingToleranceMs(best);
        timingDevs.push(devMs);
        if (devMs < -timingTolMs) { earlyCount++; timKind = 'early'; }
        else if (devMs > timingTolMs) { lateCount++; timKind = 'late'; }
        timStr = `${devMs > 0 ? '+' : ''}${Math.round(devMs)}ms`;
      }
      if (unclear && !pass) {
        unclearCount++;
        // 测不准 ≠ 弹错：单独计数，不算错、也不进错音清单
        if ($('unclear')) $('unclear').textContent = unclearCount;
      }
      const hz = estP.f0;
      const clar = a.pitch.clarity || 0;
      // 两把尺子的读数都记进导出记录：导出的 JSON 是唯一能拿来调参的数据。
      // cents = 判定尺子（estimateF0Near）的偏差；centsP = 精测尺子（estimateF0ByPeaks）的偏差。
      // 两者的差就是"这一段到底量得准不准"的直接证据。
      const centsP = estP.cents;
      const midiP = nearMidi;
      const prevIdx = best - 1;
      const prevLog = prevIdx >= 0 ? notes[prevIdx] : null;
      sessionLog.push({
        no: best + 1, t: Number((now / 1000).toFixed(3)),
        exp: exp.midi, expName: midiToNameOf(exp.midi),
        str: exp.string ?? null, fret: exp.fret ?? null,
        prev: prevLog ? prevLog.midi : null,
        prevStr: prevLog ? (prevLog.string ?? null) : null,
        prevFret: prevLog ? (prevLog.fret ?? null) : null,
        cents: Number(centsOff.toFixed(1)), f0: Math.round(hz), clarity: Number(clar.toFixed(3)),
        // 用了哪一把尺子（差分谱 / 快照），以及差分谱那一次量出来多少 ——
        // 导出记录里这两列就是"该不该继续用差分谱"的直接证据。
        lit: useDiff ? 'diff' : 'snap',
        dCents: estDiff && estDiff.score > 0 ? Number(estDiff.cents.toFixed(1)) : null,
        dHz: estDiff && estDiff.score > 0 ? Math.round(estDiff.f0) : null,
        // 候选重排这一路的证据：挑出来的音、本音失配、本音相对最强对手的领先倍数
        cand: candBest ? midiToNameOf(candBest.midi) : null,
        candOffset: candBest ? candBest.offset : null,
        candFit: candSelf ? Number(candSelf.mismatch.toFixed(0)) : null,
        candRival: candRival ? midiToNameOf(candRival.midi) : null,
        candMargin: candSelf && candRival && candRival.score > 0
          ? Number((candSelf.score / candRival.score).toFixed(3)) : null,
        // 判定证据：量到哪个半音、偏多少、用了几个谐波、拟合残差、弦刚性
        measured: midiToNameOf(midiP), centsP: Number(centsP.toFixed(1)),
        domHz: Math.round(dom.hz), domSharp: Number((dom.sharp || 0).toFixed(2)),
        domMag: Number((dom.mag || 0).toFixed(1)), domBand: '90-900',
        seen: pass ? null : midiToNameOf(seenMidi), seenCents: pass ? null : Number(seenCents.toFixed(1)),
        nHarm: estP.nHarm ?? 0, resid: Number.isFinite(estP.resid) ? Number(estP.resid.toFixed(1)) : null,
        beta: estP.beta ?? 0, tuning: Math.round(tuning), centsFixed: Number(centsFixed.toFixed(1)),
        devMs: devMs == null ? null : Math.round(devMs), timKind,
        score: Number((estP.score || 0).toFixed(5)),
        hz: Math.round(hz),
        level: Number(lv.toFixed(5)), result: pass ? 'ok' : (unclear ? 'unclear' : 'bad'),
      });
      // 起音台帐里也补上这一下的结果（前面只记了"检测到"这一半）
      {
        const last = onsetLog[onsetLog.length - 1];
        if (last) Object.assign(last, {
          judgedAs: midiToNameOf(exp.midi), result: pass ? 'ok' : (unclear ? 'unclear' : 'bad'),
          measured: midiToNameOf(midiP), cents: Number(centsP.toFixed(1)),
          clarity: Number(clar.toFixed(3)), nHarm: estP.nHarm ?? 0,
        });
      }
      if (globalThis.__vcSession) globalThis.__vcSession.push({ no: best + 1, exp: exp.midi, f0: hz });
      if (globalThis.__vcDebug) {
        console.log(`  [${judgedNoForLog(best)}] 期望 ${midiToNameOf(exp.midi)}`
          + ` 量到 ${Math.round(estP.f0)}Hz ${midiToNameOf(midiP)}（${centsP.toFixed(0)} 音分，`
          + `谐波 ${estP.nHarm}，残差 ${Number.isFinite(estP.resid) ? estP.resid.toFixed(0) : '—'}，`
          + `clarity ${clar.toFixed(2)}） → ${pass ? '✓' : (unclear ? '测不准' : '✗')}`);
      }
      // 听到的到底是哪个音（跟调音器一样的读数）
      // 候选重排说"你弹的是别的音"时，直接把那个音写出来（它比锚在本音上的读数可信）
      $('heard').textContent = candBest && candBest.offset !== 0
        ? `${midiToNameOf(candBest.midi)}（谱面要 ${midiToNameOf(exp.midi)}）`
        : `${midiToNameOf(midiP)} ${centsP > 0 ? '+' : ''}${Math.round(centsP)}音分`;
      if (pass) good++; else if (!unclear) bad++;
      markNote(best, pass ? 'ok' : (unclear ? 'unclear' : 'bad'));   // 谱面上标对错
      setVerdict(pass
        ? `✓ ${midiToNameOf(exp.midi)}${timKind ? `（${timKind === 'early' ? '抢拍' : '拖拍'} ${timStr}）` : (timStr ? `（${timStr}）` : '')}`
        : (unclear
          ? `? 这一处没听清（量到 ${midiToNameOf(midiP)}${timStr ? `，${timStr}` : ''}），继续`
          // "约"不是客气：认音名用的是宽搜索的尺子，判"不是谱面这个音"很稳，
          // 但具体是哪个邻居、偏高还是偏低会被上一个音和重叠谐波带偏（合成用例里
          // 真弹 D#4 会被认成 C#4 附近）—— 所以说"约"，不把话说死。
          : (seenSame
            ? `✗ 谱面要 ${midiToNameOf(exp.midi)}，这一处偏得比较多（${Math.round(seenCents)} 音分${timStr ? `，${timStr}` : ''}），继续`
            : `✗ 谱面要 ${midiToNameOf(exp.midi)}，你弹的是 约${midiToNameOf(seenMidi)}${timStr ? `（${timStr}）` : ''}，继续`)),
        pass ? 'ok' : (unclear ? '' : 'bad'));
      // 错音标记：先记账再往下走 —— advanceNote() 会在最后一个音上收尾并出总结，
      // 记账排在它后面的话，最后一个音的错误就进不了总结里的"要改的地方"。
      if (!pass && !unclear) {
        wrongList.push(seenSame
          ? `第${(exp.measure || 0) + 1}小节 ${midiToNameOf(exp.midi)} 偏得比较多`
          : `第${(exp.measure || 0) + 1}小节 弹成约${midiToNameOf(seenMidi)}（要${midiToNameOf(exp.midi)}）`);
        $('wrongs').textContent = '弹错：' + wrongList.join('、');
      }
      const judgedNo = best + 1;
      // 实时诊断：这一个音是怎么判的（wait 只看音，tempo 连时间窗和偏差一起给）
      {
        const heardName = candBest ? midiToNameOf(candBest.midi) : midiToNameOf(midiP);
        if (modeKind === 'tempo') {
          const w = tempoTol(best);
          diag(`#${judgedNo} ${midiToNameOf(exp.midi)}(${exp.string}弦${exp.fret}品)`
            + ` 窗口 ${((tempoAt(best) - w) / 1000).toFixed(2)}~${((tempoAt(best) + w) / 1000).toFixed(2)}s`
            + ` 起音 ${((onsetAtMs - micStartedAt) / 1000).toFixed(2)}s`
            + (devMs == null ? '' : `(${devMs >= 0 ? '+' : ''}${Math.round(devMs)}ms)`)
            + ` 听到 ${heardName} → ${pass ? '对' : '错'}`);
        } else {
          diag(`#${judgedNo} ${midiToNameOf(exp.midi)}(${exp.string}弦${exp.fret}品)`
            + ` 听到 ${heardName} ${centsP > 0 ? '+' : ''}${Math.round(centsP)}音分 → ${pass ? '对' : '错'}`);
        }
      }
      if (modeKind === 'tempo') {
        // 跟节拍：判完只标记这个音，光标/时间轴继续按时钟走（不推进 noteIdx）
        tempoState[best] = pass ? 'ok' : 'bad';
        // 超窗但音对（lateAccept）→ 把时间轴**重新对齐到这一下**：
        // 用户口径是"跟得上比掐得准重要"，一漏就一路漏、越弹越乱才是最大的问题。
        if (lateAccept && pass && devMs != null && Math.abs(devMs) > tempoTol(best) * 0.5) {
          tempoOriginMs += devMs;
          rebuildTempoClicks();
          diag(`↻ 重新对齐 ${devMs > 0 ? '+' : ''}${Math.round(devMs)}ms（后面按你的节奏走）`);
        }
        lateAccept = false;
      } else {
        advanceNote();
      }
      if (api && exp.t != null) api.timePosition = (exp.t + (exp.dur || 0)) * 1000;
    }
    $('good').textContent = good;
    $('bad').textContent = bad;
    $('pos').textContent = songKind === 'chords'
      ? `${Math.min(chordIdx + 1, (chords.chords.length))}/${chords.chords.length}`
      : `${Math.min(noteIdx, notes.length)}/${notes.length}`;
    // 光标跟着谱面时间走（不是跟着你弹了几声走）
    // 光标（用高亮当光标）：只在判完一个音之后才挪 —— 你不弹它就不动。
    highlightCurrent();
    // 光标提示：告诉用户"下一个该弹什么"，跟弹时不用猜
    if (songKind === 'heyjude' && notes && noteIdx < notes.length) {
      const nx = notes[noteIdx];
      $('next').innerHTML = `下一个：<b>${midiToNameOf(nx.midi)}</b>（${nx.string}弦 ${nx.fret}品）`;
    } else if (songKind === 'chords' && chords && chords.chords[chordIdx]) {
      $('next').innerHTML = `当前和弦：<b>${chords.chords[chordIdx].name}</b>`;
    }
  }
  micTimer = requestAnimationFrame(micTick);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiToNameOf = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
const judgedNoForLog = (idx) => idx + 1;

// 往下走一格：把"当前音"的时钟重置，光标挪到下一个音，并把新音的窗口重新开始计时。
// 时间片模型下，推进只有三个入口：判对、判错、窗口过了算漏。
// 整段结束时的收尾（两条链路共用：wait 判完最后一个音 / tempo 时间轴跑完）
function finishSession() {
  stopMic();
  // 练琴闭环的最后一环：整段结果（对/错/漏 + 最常出问题的地方）
  const judged = good + bad;
  const acc = judged ? Math.round((good / judged) * 100) : 0;
  const ok = acc >= 90;                        // 正确率 ≥90% 这份作业算完成
  const head = `整段弹完 —— 对 ${good} ／ 错 ${bad} ／ 测不准 ${unclearCount}`
    + `　正确率 ${acc}%（${ok ? '✅ 这份作业算完成' : '还没到 90%，建议重练'}）`;
  const todo = wrongList.length
    ? `　要改的地方：${wrongList.slice(0, 5).join('、')}${wrongList.length > 5 ? ' 等' : ''}`
    : '　（没有错音，漂亮）';
  // 跟节拍才有的时间账：偏差中位数 / 最大 / 抢拍几处 / 拖拍几处。
  // 不和音准合成一个"对/错"——用户被标红时要能看出错在音还是错在拍。
  let timLine = '';
  if (modeKind === 'tempo' && timingDevs.length) {
    const abs = timingDevs.map(Math.abs).slice().sort((a, b) => a - b);
    const med = Math.round(timingDevs.slice().sort((a, b) => a - b)[Math.floor(timingDevs.length / 2)]);
    timLine = `　节奏：偏差中位 ${med >= 0 ? '+' : ''}${med}ms／最大 ${Math.round(abs[abs.length - 1])}ms`
      + `，抢拍 ${earlyCount} 处、拖拍 ${lateCount} 处（容许 ±${Math.round(timingTolMs)}ms）`;
  }
  setVerdict(head + todo + timLine, ok ? 'ok' : 'bad');
  $('next').innerHTML = '想再练一遍？直接再点一次「跟弹」（或点谱面上任意一个音从那开始）。';
}

function advanceNote() {
  // 按谱面间距设"下一次至少隔多久才算新的拨弦"：
  // 快音段（间距 150ms）约 80ms 后可再触发，慢音段最多等到 160ms。
  const prevNote = notes && notes[noteIdx];
  const nextN = notes && notes[noteIdx + 1];
  const gapMs = (nextN && prevNote) ? Math.max(0, (nextN.t - prevNote.t) * 1000) : 200;
  // 连续相同音时把间隔再压缩（否则第二下会被当成余响忽略掉）
  const same = !!(nextN && prevNote && nextN.midi === prevNote.midi);
  refractoryUntilMs = performance.now()
    + Math.min(160, Math.max(same ? 55 : 70, gapMs * (same ? 0.35 : 0.55)));
  // 不设延音期：谱面的延音只是"这个音响得久"，不代表你要再弹一次，
  // 也不代表接下来不能判定。判定只跟"你拨了几下"有关。
  noteIdx++;
  noteClockStart = performance.now();
  heardInWindow = false;
  $('pos').textContent = `${Math.min(noteIdx, (notes || []).length)}/${(notes || []).length}`;
  if (noteIdx >= (notes || []).length) {
    finishSession();
    return;
  }
  highlightCurrent();
  const nx = notes[noteIdx];
  if (nx) $('next').innerHTML = `下一个：<b>${midiToNameOf(nx.midi)}</b>（${nx.string}弦 ${nx.fret}品）`;
}

async function startMic() {
  try { await audio.acquire(); } catch (e) {
    setVerdict('开不了麦克风：' + (e.message || e.name) + '（手机必须 https）'); return;
  }
  resetAnalysis();
  frames = 0; floor = 0.001; levelHist = []; lastOnsetMs = -1e9;
  good = 0; bad = 0; rise = null;
  // 从哪里开始：
  //   · 默认**永远从第一个音开始** —— 不然中途停过一遍，noteIdx 残留，
  //     下一遍就从中间接着来（用户实测"点跟弹还是从第二小节开始、第一个音根本没在待测里"）；
  //   · 只有**这一遍之前点过谱面上某个音**，才从那儿开始练那一段。
  //     这条以前是坏的：点哪个音都对不上，因为"光标那份谱面格子"和"判定那份清单"
  //     错开了一位（117 vs 118）。现在两边是同一份清单（buildTickMap → mapSequenceToSlots，
  //     点第几格就是第几个音），而且跟弹进行中点谱面**不会再偷偷改起点**（见 beatMouseDown）。
  if (!userPickedStart || !(noteIdx >= 0 && noteIdx < (notes || []).length)) noteIdx = 0;
  userPickedStart = false;         // 只认"这一次点击"，下一遍仍旧从头
  if (notes && notes[noteIdx] && $('next')) {
    $('next').innerHTML = `下一个：<b>${midiToNameOf(notes[noteIdx].midi)}</b>`
      + `（${notes[noteIdx].string}弦 ${notes[noteIdx].fret}品）`;
  }
  wrongList = [];
  sessionLog = [];
  onsetLog = [];
  timingDevs = []; earlyCount = 0; lateCount = 0;
  // ★ **音准基线必须清**：它是"这把琴这几分钟整体偏高/偏低多少"的估计，
  // 跨轮使用会把上一轮（可能被带坏的，比如 -335 音分）一直带进新的一遍 →
  // 整段系统性偏移 → **全错**。用户实测："重新开始之后从头检测，好像内部还在检测
  // 我上次停下的地方，导致全错" —— 就是这个。
  devHistory = [];
  Object.keys(devByString).forEach((k) => { delete devByString[k]; });
  // 谱面自己的速度：换速度练习时，时间轴按这个比例缩放
  scoreTempo = (score && score.tempo) || userBpm;
  $('wrongs').textContent = '';
  alignOffsetSec = null;
  micStartedAt = performance.now();
  $('good').textContent = '0'; $('bad').textContent = '0';
  if (songKind === 'heyjude') await loadNotes();
  // 跟节拍：每次开始都清空状态（每个音先记成"待判"）
  tempoState = (notes || []).map(() => '');
  tempoCursor = 0;
  tempoClosed = -1;
  tempoOriginMs = null;
  tempoClicks = [];
  lateAccept = false;
  resetDiag();
  // 音符加载后重建"光标→谱面"对应表（按**当前选中的声部**）
  if (score) buildTickMap(score, Number($('track') && $('track').value) || 0);
  else await loadChords();
  // 一开始就把光标画在"第一个该弹的音"上（以前要等判完第一个音才出现，
  // 用户看到的就是"光标没从第一个音开始"）。
  highlightCurrent();
  // 倒计时期间**不判**（原来这里直接 waiting，所以数拍子的时候就已经在判了）
  phase = 'countin';
  modeKind = $('mode') ? $('mode').value : 'wait';
  countIn(4);                                   // 四拍提示，按用户设的速度
  // 倒计时结束用主循环的时钟判断（不用 setTimeout）：判定和倒计时同一个时间源
  countInEndMs = performance.now() + (60 / userBpm) * 1000 * 4;
  // 跟弹时让 alphaTab 当"光标引擎"：所有声部静音后开始播放 ——
  // 不出声（不会灌进麦克风），但光标会跟着我们的谱面时间走。
  // 注意：**不启动播放器**。上一版这么干，结果光标跟着播放时间自己走，
  // 倒计时还没完它就在动、你还没弹它就过去了。现在光标只由"判到第几个音"驱动。
  cursorEngine = false;
  // 跟弹时播放旋律当向导（成熟产品都这么做）：你跟着伴奏弹，时间自然对上。
  // 用耳机 —— 外放会被麦克风收进去。光标仍然只由"判到第几个音"驱动。
  guideOn = $('guide') ? $('guide').checked : false;
  if (guideOn && songKind === 'heyjude' && api && api.score) {
    try {
      const token = ++sessionToken;
      applyTrack(Number($('track').value) || 0);
      api.playbackSpeed = userBpm / (api.score.tempo || 76);
      // 只有"这一轮跟弹还在进行"时才播放：中途停止/切歌/点试听都不会再触发
      setTimeout(() => {
        if (token !== sessionToken || !micTimer) return;
        try { api.play(); } catch (e) { /* ignore */ }
      }, (60 / userBpm) * 1000 * 4);
    } catch (e) { /* 播放器不可用就算了 */ }
  }
  // 节拍器：排在向导旋律之后启动 —— 它要抓当前的 sessionToken，
  // 上面那句 ++sessionToken 会让先启动的排程立刻作废。
  // 跟节拍模式用"音符提示音"（scheduleTempoClicks，和光标同一个时钟）；
  // 四分音符节拍器只在"等我弹"模式下用 —— 两个一起响会打架，而且跟节拍时
  // 用户要的是"光标走到哪响到哪"，不是抽象的拍子。
  if ($('metro') && $('metro').checked && modeKind !== 'tempo') startMetronome();
  $('mic').textContent = '⏹ 停止';
  $('mic').classList.add('on');
  setVerdict(`准备 —— 四拍后开始（${userBpm} BPM），弹错不停。`);
  micTimer = requestAnimationFrame(micTick);
}

function stopMic() {
  cancelAnimationFrame(micTimer); micTimer = 0; phase = 'idle';
  sessionToken++;                       // 让还在等待的延时任务作废
  stopMetronome();                      // 节拍器也要停
      if (cursorEngine && api) {
    try { api.pause(); } catch (e) { /* ignore */ }
    cursorEngine = false;
    if (score) applyTrack(Number($('track').value) || 0);   // 还原原来选的声部
  }
  audio.release();
  $('mic').textContent = '🎤 跟弹'; $('mic').classList.remove('on');
}

$('mic').onclick = () => (micTimer ? (stopMic(), setVerdict('已停止')) : startMic());

// 「跳过这个音」：谱面记错的地方（用户那份 Hey Jude 第2小节那个 h 就是记错的：
// 谱面记成**一个**音，实际要弹**两个**）用一下。练习模式是**按顺序对号**，
// 你多弹的那一下会吃掉谱面的下一个音、从那儿起整条错位 —— 这一格跳过就正回来了。
// 只跳一格、不判、不计数（不是"你弹错了"，是"谱面这一格不算"）。
if ($('skip')) {
  $('skip').onclick = () => {
    if (phase !== 'waiting' || !notes || !notes[noteIdx]) return;
    const skipped = midiToNameOf(notes[noteIdx].midi);
    advanceNote();
    setVerdict(`已跳过谱面这一格（${skipped}）—— 继续弹下一个`, '');
  };
}

// 屏幕旋转/改窗口大小：重排谱面（窄屏横向铺开，宽屏整页）
let lastPhone = isPhone();
window.addEventListener('resize', () => {
  const now = isPhone();
  if (now === lastPhone) return;
  lastPhone = now;
  if (api && score) {
    // 旋转/改窗口时只调缩放，布局仍然是整页折行（保证手机上也是一页一页的谱子）
    api.settings.display.scale = now ? 0.7 : 1;
    api.render();
  }
});

initAlphaTab();
// 版本号：**第一帧就写在标题上**（上一版藏在自检那行、还只在空的时候写，手机上根本没看到）
if ($('title') && !$('title').textContent) $('title').textContent = 'v' + BUILD + ' 正在加载谱面…';
// 版本号也写进「导出记录」旁边那一格（用户要看的就是这里）
if ($('ver')) $('ver').textContent = 'v' + BUILD;
window.__page = () => ({ songKind, userBpm, chordIdx, beat, hasApi: !!api });
// 给离线分析用的钩子：拿到这一遍的逐音记录（导出按钮存的就是它）
window.__vcSessionLog = () => sessionLog;
window.__vcOnsetLog = () => onsetLog;
window.__vcAlignInfo = () => alignInfo;
window.__vcSlots = (mockScore, trackIndex) => collectScoreSlots(mockScore, trackIndex);
// 判定清单 → 光标位置的映射：离线回归要能单独测它（不开浏览器）
window.__vcMap = (list, beats) => mapSequenceToSlots(list, beats);
// 光标表本身（测"第 i 个音是不是指到第 i 个谱面位置"）
window.__vcCursor = () => noteBeats.slice();
// 塞一份假谱面进去当"alphaTab 解析出来的结果"（离线回归整条链路时要走这一层）
window.__vcSetScore = (s, trackIndex = 0) => { score = s; buildTickMap(s, trackIndex); };

// ── 自检：页面上点一下，把"到底哪一环断了"直接打出来 ─────────────────────────
// 导出记录：把这一遍每个音的"期望 / 实测"存成 JSON 文件。
// 这是给我调参用的数据 —— 你录一遍"只弹对的"，就等于给我标准答案。
$('saveLog').onclick = () => {
  if (!sessionLog.length) { err('还没有记录，先点「跟弹」弹一遍再导出。'); return; }
// 导出两份：判定过的音（notes）+ **每一次起音**（onsets，含被判"不像琴声"丢掉的）。
// 排查手机上"任何音都算对/一阵风过两三个音"就靠 onsets 这份。
const blob = new Blob([JSON.stringify({
  song: songKind, mode: modeKind,
  // 这次运行的环境（排查时不用再问"当时勾了什么"）
  guide: !!($('guide') && $('guide').checked),
  metro: !!($('metro') && $('metro').checked),
  bpm: userBpm,
  align: alignInfo,          // 谱面 × 时间轴的对齐结论（对不上时这里能看出来）
  notes: sessionLog, onsets: onsetLog,
}, null, 1)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `follow-log-${songKind}-${Date.now()}.json`;
  a.click();
  err(`已导出 ${sessionLog.length} 条记录`);
};

$('selftest').onclick = async () => {
  const lines = [];
  lines.push(`alphaTab：${window.alphaTab ? ('有，版本 ' + (window.alphaTab.version || '?')) : '没有（vendor/alphaTab.min.js 没加载）'}`);
  for (const u of ['./data/hey_jude.gp3', './vendor/font/Bravura.woff2', './vendor/font/Bravura.otf', './vendor/sonivox.sf2']) {
    try {
      const r = await fetch(u);
      const b = await r.blob();
      lines.push(`${u.split('/').pop()}：${r.status} ${Math.round(b.size / 1024)}KB`);
    } catch (e) { lines.push(`${u.split('/').pop()}：取不到（${e.message}）`); }
  }
  const el = $('score');
  lines.push(`谱面容器：${el.clientWidth}×${el.clientHeight}px，里面 ${el.children.length} 个元素`);
  if (api && api.score) lines.push(`已解析：${api.score.title}，${api.score.tracks.length} 个声部，${api.score.masterBars.length} 小节`);
  err('自检 → ' + lines.join(' ｜ '));
};
