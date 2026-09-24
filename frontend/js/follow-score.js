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
const BUILD = '0924-2015';
const err = (m) => { $('err').textContent = m ? String(m) : ''; };
const isPhone = () => window.innerWidth < 700;

import { rms, spectrumOf } from './engine/dsp.js?v=0924-2015';
import * as audio from './audio.js';
import {
  track, fluxRelOf, resetAnalysis, novelSpectrum, verifyExpectedNote, chordOutsiders,
  getFluxSpec, getBeforeFluxSpec, estimateF0Near, estimateF0ByPeaks, hfFluxRelOf,
  hfBandRiseOf,
  lowBandRiseOf,
  shapeFluxOf, harmonicity, spectralSparsity, spectralFlatness, spectralPeakiness, f0SeriesFromDiff,
  dominantF0InBand, strongestF0InBand, diffMags, matchNoteByCandidates, readPluckF0,
} from './engine/analysis.js?v=0924-2015';
import { CFG, FLUX_N } from './engine/config.js?v=0924-2015';
import { createMetro } from './metro-core.js';
// 分层：检测能力（起音层 / 判定层）各自一个文件，阈值也都收在那两个文件里。
import { decideOnset, ONSET } from './engine/onset.js?v=0924-2015';
import { judgeNote, decideByCandidates, JUDGE } from './engine/judger.js?v=0924-2015';
// 光标层：谱面格子 ↔ 判定清单 的对号（纯函数，单独一个文件）
import { collectScoreSlots, mapSequenceToSlots } from './app/cursor.js';
// 跟节拍层（状态机 + 拍点 + 提示音）—— 这一层只通过回调跟页面打交道
import { createTempoLayer } from './app/tempo.js';
// 实时诊断面板（页面层的一块）：只负责把一行行文字显示到 #diag
import { diag, resetDiag, initDiag } from './app/diag.js';

let api = null;            // alphaTab 实例（只建一次）
let score = null;
let songKind = 'heyjude';
let chords = null;         // 和弦练习的数据
let chordIdx = -1;
let chordPick = -1;        // 用户点过的起始和弦（-1 = 没点过 → 从头开始）
let beatTimer = 0;
let beat = 0;
let userBpm = 76;
// 变调夹 + 调弦：这两个都只是"期望音整体平移"——
//   · 变调夹 N 品：同一个品位实际音高**高** N 个半音（+N）
//   · 降半音调弦（Eb）：整把琴低一个半音（-1）
// 判定用的"期望音"= 谱面音 + pitchShift；页面上显示的音名仍是谱面写的那个（弹的人照谱子弹）。
let capo = 0;
let tuneDown = false;
const pitchShift = () => capo + (tuneDown ? -1 : 0);
let rising = false;
// 判过所需的领先倍数。默认 1.15 是拍的量级，还没用真机录音标定 ——
// 允许用 window.__passRatio 覆盖，方便拿真实录音扫一遍找合适的值。
const PASS_RATIO = Number((globalThis.__passRatio) || 1.15);

function setVerdict(text, kind) {
  $('verdict').textContent = text;
  $('verdict').className = kind || '';
}

// ── 真实谱面（.gp*）的统一登记表（2026-09-23）──────────────────────────────
// 以后接新谱只做三件事，不用改代码：
//   ① 把 .gp* 放进 frontend/data/；
//   ② 跑一条命令生成时间轴：backend\tools\gp_timeline.py <file> --json frontend\data\<name>.json
//   ③ 在下面这张表里加一行（gp / json / title），再在 index.html 的曲目下拉里加一个同名 option。
// ⚠ 谱面/时间轴地址都带 `?v=${BUILD}`：跟 JS 模块一个道理 —— 谱子改了以后，
//   手机不会拿缓存里的旧谱面（2026-09-24 改谱子时踩到过：谱面改了但页面还是旧的那张）。
const SCORES = {
  heyjude: { gp: `./data/hey_jude.gp3?v=${BUILD}`, json: `./data/hey_jude.json?v=${BUILD}`, title: 'Hey Jude' },
  jasmine: { gp: `./data/chinese-jasmine.gp4?v=${BUILD}`, json: `./data/chinese-jasmine.json?v=${BUILD}`, title: '茉莉花（Moo Li Wha）' },
  // 2026-09-24：C-Am-F-G × T3231323 的**真实谱面**。这个 .gp 是本项目自己生成的
  // （alphaTab 1.8.4 的 Gp7Exporter，不需要 Guitar Pro），和判定清单 chord_arp.json
  // **同一份数据** → 谱面拍点 32 = 判定 32，天然对齐（就是原来"117 vs 118"那个坑的反面）。
  chordarp: { gp: `./data/chord_arp.gp?v=${BUILD}`, json: `./data/chord_arp.json?v=${BUILD}`, title: 'C-Am-F-G · T3231323（真实谱面）' },
};
const scoreOf = (kind) => SCORES[kind] || null;

// ── alphaTab 部分 ────────────────────────────────────────────────────────────
function initAlphaTab() {
  if (api || !window.alphaTab) return api;
  api = new alphaTab.AlphaTabApi($('score'), {
    file: (scoreOf(songKind) && scoreOf(songKind).gp) || './data/hey_jude.gp3',
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
  // ⚠ 光标必须等**渲染完成**之后再摆一次（2026-09-23，用户报"切到茉莉花再切回来，两边都没光标"）：
  //   buildTickMap 在 scoreLoaded 里跑，那时 alphaTab 往往还没排完版，
  //   highlightCurrent() 去 renderer.boundsLookup 取坐标会取不到 → 光标画不出来；
  //   而切过一次曲子之后这个时机更差（旧实例销毁、新实例刚建），于是两边都没光标。
  //   这里在每帧渲染结束时补摆一次：映射重算 + 光标重画，位置取不到就下次渲染再试。
  if (api.renderFinished) {
    api.renderFinished.on(() => {
      if (!score) return;
      try { buildTickMap(score, Number($('track') && $('track').value) || 0); } catch (e) {}
      try { highlightCurrent(); } catch (e) {}
    });
  }
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

// 光标层的两个映射函数已挪到 ./app/cursor.js（collectScoreSlots / mapSequenceToSlots），
// 这里通过 import 使用 —— 见文件顶部。

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
  // 无谱面测试（arp）：直接在音格子上标对/错
  const cell = document.getElementById('cell' + idx);
  if (cell && cell.classList) cell.classList.add(kind === 'ok' ? 'ok' : 'bad');
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
    // 同理：#marks 也挂到 #scoreWrap 上了，要把 #score 的偏移补上（见 highlightCurrent）
    let mkOffX = 0, mkOffY = 0;
    try {
      const sEl = document.getElementById('score'), wEl = document.getElementById('scoreWrap');
      if (sEl && wEl && sEl.getBoundingClientRect && wEl.getBoundingClientRect) {
        const sr = sEl.getBoundingClientRect(), wr = wEl.getBoundingClientRect();
        mkOffX = sr.left - wr.left + wEl.scrollLeft;
        mkOffY = sr.top - wr.top + wEl.scrollTop;
      }
    } catch (e) { mkOffX = 0; mkOffY = 0; }
    el.style.left = `${Math.round(b.x + mkOffX)}px`;
    el.style.top = `${Math.round(b.y + b.h - 2 + mkOffY)}px`;
    el.style.width = `${Math.max(6, Math.round(b.w))}px`;
    box.appendChild(el);
  } catch (e) { /* 定位失败就不标，不影响判定 */ }
}

// index 省略 = 当前该弹的那个音（noteIdx）；给"起音预览"用时会显式传下一个音
function highlightCurrent(index = noteIdx) {
  if (!api) { highlightCell(Math.max(0, Math.min(index, (notes || []).length - 1))); return; }
  const box = document.getElementById('cursor');
  const idx = Math.max(0, Math.min(index, (noteBeats || []).length - 1));
  const beat = noteBeats[idx];
  // 光标/标记现在挂在 #scoreWrap 上（不放在 #score 里，免得被 alphaTab 渲染时删掉），
  // 而 alphaTab 给的坐标是**相对它自己的容器**的，所以要把两者的偏移补上。
  const scoreEl = document.getElementById('score');
  const wrapEl = document.getElementById('scoreWrap');
  let offX = 0, offY = 0;
  try {
    if (scoreEl && wrapEl && scoreEl.getBoundingClientRect && wrapEl.getBoundingClientRect) {
      const sr = scoreEl.getBoundingClientRect(), wr = wrapEl.getBoundingClientRect();
      offX = sr.left - wr.left + wrapEl.scrollLeft;
      offY = sr.top - wr.top + wrapEl.scrollTop;
    }
  } catch (e) { offX = 0; offY = 0; }
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
      // （下面正常画光标）
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
      box.style.left = `${Math.round(b.x + offX)}px`;
      box.style.top = `${Math.round(y + offY)}px`;
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
    // ⚠ 光标画不出来时把原因写到页面上（2026-09-23 用户报"一个光标都显示不出来"）：
    //   光标只有在**能取到这一拍的布局坐标**时才显示；取不到就什么都不显示，用户完全看不到线索。
    //   这里把三个数写出来：有没有 #cursor 元素、映射表有几条、这一拍取到坐标没有。
    {
      const box2 = document.getElementById('cursor');
      const msg = `光标：元素${box2 ? '有' : '无'}／映射 ${(noteBeats || []).length} 条／`
        + `这一拍${b ? '有坐标' : (beat ? '取不到坐标' : '没对应上拍点')}`
        + `（第 ${idx + 1} 个音）`;
      if ($('align')) $('align').textContent = msg;
      else err(msg);
    }
  } catch (e) {
    err('光标定位失败：' + (e.message || e) + '（不影响判定）');
  }
  try { if (noteTicks[idx] != null) api.tickPosition = noteTicks[idx]; } catch (e) { /* ignore */ }
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
    // 点和弦卡 = 从这一个和弦开始（试听/跟弹都按这个起点走）。
    el.onclick = () => {
      if (beatTimer) {
        setVerdict('试听进行中：先点「试听」停下，再点你想从哪个和弦开始');
        return;
      }
      chordIdx = i;
      chordPick = i;               // 记住起点：点「试听」/「跟弹」都从这一个开始
      paintChords();
      $('pos').textContent = `${i + 1}/${chords.chords.length}`;
      setVerdict(`这一遍从 <b>${c.name}</b> 开始（第 ${i + 1} 个和弦）`
        + ` —— 点「试听」听一遍，或点「跟弹」开始判定`, '');
    };
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
  // 起点：点过和弦卡就从那一个开始，没点过就从头
  chordIdx = (chordPick >= 0 ? chordPick : 0);
  chordPick = -1;                  // 只认这一次点击，下一遍仍旧从头
  beat = 0;
  paintChords();
  $('pos').textContent = `${chordIdx + 1}/${chords.chords.length}`;
  setVerdict('和弦练习：每个和弦 4 拍，跟着高亮换和弦。弹错不停，标红继续。');
  const ms = (60 / userBpm) * 1000;
  if (withSound) {
    if (!chordCtx) chordCtx = (audio.getCtx && audio.getCtx()) || new (window.AudioContext || window.webkitAudioContext)();
    chordCtx.resume && chordCtx.resume();
    strumChord(chords.chords[chordIdx].midis, chordCtx.currentTime + 0.05);
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
  // 切曲目时**先停掉跟弹**：不然麦克风循环还在跑，而判定清单已经换成新的那份
  // （notes 被清空、noteIdx 归零），两边对不上 —— 手机上表现为"切一下就卡住"。
  if (micTimer) stopMic();
  phase = 'idle';
  techDueMs = 0;
  songKind = $('song').value;
  stopChords();
  if (api && api.playerState === 1) api.playPause();
  // 换曲目 = 换一份判定清单：清掉上一份（含光标对照表）
  notes = null; notesMeta = null; noteIdx = 0; noteBeats = []; noteTicks = [];
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
  } else if (songKind === 'arp') {
    // 无谱面测试：不画五线谱，用音格子（T3231323 / C–Am–F–G）
    $('scoreWrap').style.display = 'none';
    $('chords').style.display = 'none';
    $('cells').style.display = 'block';
    $('track').style.display = 'none';
    $('loop').style.display = 'none';
    await loadNotes();
    renderCells();
    $('title').textContent = `C–Am–F–G · T3231323（逐音测试）— v${BUILD}`;
    setVerdict('逐音测试：点「跟弹」，按格子里写的弦/品一个一个弹（蓝色格子 = 当前该弹的）。');
  } else if (songKind === 'tech') {
    // 技巧练习：击弦 / 勾弦 / 滑音 —— 拨一下，第二个音靠左手（不用再拨）
    $('scoreWrap').style.display = 'none';
    $('chords').style.display = 'none';
    $('cells').style.display = 'block';
    $('track').style.display = 'none';
    $('loop').style.display = 'none';
    await loadNotes();
    renderCells();
    $('title').textContent = `技巧练习 · 击弦/勾弦/滑音（逐音测试）— v${BUILD}`;
    setVerdict('技巧练习：每一对「拨一下 + 左手技巧」算两个音 —— 拨完不要停，让第二个音响出来。');
  } else {
    $('chords').style.display = 'none';
    $('cells').style.display = 'none';
    $('scoreWrap').style.display = 'block';
    $('track').style.display = '';
    $('loop').style.display = '';
    // ⚠ 切曲目必须**重建** alphaTab（2026-09-23 用户报"切到茉莉花还显示 Hey Jude"）：
    //   initAlphaTab() 开头是 `if (api) return api;` —— api 建过一次就返回旧实例，
    //   谱面永远停在上一首。所以换谱之前先把旧的销毁、api/score 清空。
    if (api && api.destroy) { try { api.destroy(); } catch (e) {} }
    api = null; score = null;
    // 谱面容器也清空 —— 万一 destroy() 不顶用（不同 alphaTab 版本行为不一样），
    // 至少不会把两首谱画在同一个容器里。
    if ($('score')) $('score').innerHTML = '';
    const sc = scoreOf(songKind);
    if (sc && $('title')) $('title').textContent = sc.title;
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
// 变调夹：改了就立刻生效（下一次判定就用新值）。夹多少品，期望音就升多少半音。
$('capo').onchange = () => {
  capo = Math.max(0, Math.min(6, Number($('capo').value) || 0));
  setVerdict(`变调夹 ${capo} 品${tuneDown ? ' + 降半音' : ''} —— 期望音整体平移 ${pitchShift() > 0 ? '+' : ''}${pitchShift()} 个半音（谱面记号不变）`);
};
$('tuneDown').onchange = () => {
  tuneDown = !!$('tuneDown').checked;
  setVerdict(`调弦：${tuneDown ? '降半音（Eb）' : '标准'}${capo ? ` + 变调夹 ${capo} 品` : ''}`
    + ` —— 期望音整体平移 ${pitchShift() > 0 ? '+' : ''}${pitchShift()} 个半音（谱面记号不变）`);
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
// ⚠ 2026-09-24：判定时刻。默认 0 = 老行为（起音后 90ms 定案）；
//   只有"模糊音"会被推迟到 onsetAtMs + 250（这时判定窗自动变成稳定段）。
let judgeAtMs = 0;
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
// 已经记过错的音（同一个音只记第一次错 —— 停了重弹的那几次不再累加）
let wrongNoted = new Set();
let missNoted = -1;            // 这个音已经记过"漏拍/换和弦不流畅"了吗（只记一次）
let firstJudgeMs = null;       // 跟节拍：第一个被认到的音（总时间的起点）
let lastJudgeMs = null;        // 跟节拍：最后一个判完的音（总时间的终点）
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
// ── 技巧（击弦 / 勾弦 / 滑音）：**一次起音、两个音** ─────────────────────────
// 用户口径（2026-09-22）："滑音击弦还有勾弦，这里就是要判断两个不同的音但是只有一次起音"。
// 做法：谱面上第二个音带着 tech 标记时，不要求新的起音 —— 到了那个音该响的时刻，
// 直接走一次同样的判定（下面 techDueMs 到点就当成"一次起音"）。
// 时刻按谱面间距算（真机实测：击弦落地约 170ms、滑音落地约 270ms，
// 都比一个八分音符短，所以按谱面间距采样时它已经落稳了）。
let techDueMs = 0;         // 技巧第二个音该判定的时刻（0 = 没有待判的技巧音）
// 技巧音的"音准基准"：技巧的两个音在同一根弦上，整体调音偏高/偏低会一起平移。
// 做法：**用上一个音实测的频率当基准，按音程算这个音应该在多少 Hz** ——
//   真机实测（用户琴整体高 ~50 音分）：滑音 E4(335Hz) → 落点 298Hz；
//   按绝对音高比会判成 D#4（错），按音程预期（335 × 2^(-2/12) = 297.7Hz）只差 2 音分（对）。
// 用 Hz 而不是"音分偏差读数"：同一次演奏里两个一样的音，频率读数只差 1Hz，
// 但拟合出来的音分数能差 85（余响干扰），所以基准必须用频率。
let techRefHz = 0;         // 上一个音实测频率（技巧音算期望频率用）
let lastJudgeHz = null;
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
// ── §6「起音即读数」（2026-09-24 收工状态第 6 节）────────────────────────────
// 思路（用户口径）：起音那一刻只判"这一下新加进来的那条线是什么音"，
// 所以要在**以起音采样点为中心**的短窗上做 post − pre（负的归零），
// 在这份"只属于这一下"的谱上独立量出一条成串的基频，再和谱面那个音比：
//   · 同名 → 过；· 差 ≥2 个半音 → 判错（差 1 个半音不动，读数本身有 ±1 的抖动）；
//   · 量不出、或两次量不一致（不可信）→ **退回原链路**（候选重排），不许硬判。
// 频带必须**按弦分带**（谱面给了弦品就用那根弦的音域）：不限带时拨弦的低频闷响
// 也能凑出 2f/3f，读数会锁到 82~170Hz 的垃圾线上 —— 离线在 vc_gf/read-sweep.mjs
// 上量过（1弦1品的 16 下一调全错）。
// ⚠ 2026-09-24 夜实测结论：**这条路的读数在真机上不可用，默认关闭**（用户口径：误杀 >1 就撤）。
//   把 window.__judgeRead = 1 打开就能复现（离线探针 vc_gf/read-sweep.mjs 是同一套窗和尺子）：
//     · §6 第 1 条那个窗（pre[−40,−10] / post[+10,+40]）**必须带按弦分带**才有读数：
//       不带频带时限：1弦1品那 16 下**一条都读不对**（读数锁在 82~170Hz 的低频闷响上）；
//       带上"该弦空弦~25品"的频带后：1弦1品 16/16、6段标定录音 17/39；
//     · 但它在**和弦在响/旋律**的材料上依然不可用：hey_jude 标定集 24 个音里，
//       两个窗"意见一致"的 7 个里有 5 个是错的（G5/B5/C5 这类高频垃圾）——放它判错就是误杀 5 个；
//       琶音（6415慢速）52 下里采信的那些也基本都不对。
//   → 结论：读数要能接进判定，得换成"稳定段（起音后 +50~+220ms）+ 按弦分带"那把尺子
//     （离线：1弦1品 16/16、6段 39/39），而它在判定时刻(+90ms)还取不到，必须**延后取**
//     —— 这正是 §1 里写的下一步。今天不做（§6 明确要求"一步不改"）。
// 开关（离线对照用）：window.__judgeRead = 1 打开；window.__readGate = 'b2'|'b5'|'off'
// 选"第二个窗"（只认两个窗意见一致的读数）；window.__readVeto = 2 改"差几个半音才判错"。
const JUDGE_READ = globalThis.__judgeRead == null ? false : !!globalThis.__judgeRead;
const READ_GATE = globalThis.__readGate || 'b2';
const READ_VETO_SEMIS = globalThis.__readVeto == null ? 2 : Number(globalThis.__readVeto);
// 弦号 → 空弦音高（标准调弦）
const OPEN_STRING_MIDI = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };
// 会话记录：每个音的"期望 / 实测"，包含判定比值、周期性(clarity)、电平、时刻。
// 这是**唯一能用来调参的数据**：录一遍干净的（只弹对的）就等于拿到标准答案，
// 不用再靠"你猜我有没有弹对"。
let sessionLog = [];
// 起音台帐：**每一次**被判定为起音的事件都记一条（包括后来被判"不像琴声"丢掉的）。
// 为什么要它：手机上出现"任何音都算对、一阵风过两三个音"，而这个现象在合成信号上
// 复现不出来 —— 只能靠手机自己的台帐看"到底是什么被当成了起音"。
// 导出记录里带上它，出问题一串就能定位是哪一关放过去的。
let onsetLog = [];
// 近似帧日志（2026-09-23）：电平过了门限、却没被认成起音的帧 + 被否决的原因。
// 只留最近 120 条，导出里带出去（治"快弹有些音没收上"）。
let nearMissLog = [];
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

// 跟节拍那一层（状态机 + 拍点 + 提示音）已经拆到 ./app/tempo.js —— 见文件顶部 import。
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

// 诊断面板的实体在 ./app/diag.js（见文件顶部 import）。
// ⚠ 用户口径：这些"第几个音/听到什么/差多少音分/对错"的行**太占页面**，谱子都看不全了 ——
// 所以页面上不再显示它们（index.html 里的 #diag 也一起删了）。
// 判定证据仍然完整写进「导出记录」（cand / candFit / candMargin / devMs 那些字段），
// 需要时用 `window.__vcDiag = 1` 打开（前提是页面上有 #diag 元素）。
initDiag(() => (globalThis.__vcDiag ? $('diag') : null));
// ── 跟节拍层实例（宿主接口）：实体在 ./app/tempo.js，这里只把页面的状态/回调接进去 ──
let tempoLayer = null;
function tempo() {
  if (!tempoLayer) {
    tempoLayer = createTempoLayer({
      notes: () => notes,
      meta: () => notesMeta,
      phase: () => phase,
      startedAt: () => micStartedAt,
      userBpm: () => userBpm,
      expectedAtMs: (i) => expectedAtMs(i),
      toleranceMs: (i) => timingToleranceMs(i),
      setNoteIdx: (i) => { noteIdx = i; },
      midiName: (m) => midiToNameOf(m),
      metroOn: () => !!($('metro') && $('metro').checked),
      getCtx: () => audio.getCtx(),
      onBeat: (accent) => flashBeat(accent),
      // 漏一个音：计数 + 错音清单 + 谱面标记 + 导出记录 + 提示
      onMiss: ({ index, note, atMs, winFrom, winTo }) => {
        missed++;
        bad++;
        wrongList.push(`第${(note.measure || 0) + 1}小节 漏了${midiToNameOf(note.midi)}（时间窗内没弹）`);
        $('wrongs').textContent = '弹错：' + wrongList.join('、');
        $('missed').textContent = missed;
        $('bad').textContent = bad;
        markNote(index, 'bad');
        diag(`#${index + 1} ${midiToNameOf(note.midi)}(${note.string}弦${note.fret}品)`
          + ` 窗口 ${(winFrom / 1000).toFixed(2)}~${(winTo / 1000).toFixed(2)}s 没听到 → 错（漏）`);
        sessionLog.push({
          no: index + 1, t: Number((atMs / 1000).toFixed(3)),
          exp: note.midi, expName: midiToNameOf(note.midi), result: 'miss',
        });
        setVerdict(`漏了 ${midiToNameOf(note.midi)}（时间窗过了），继续`, 'bad');
      },
      // 光标跟着时钟走
      onCursor: (index, note) => {
        highlightCurrent();
        if (note) $('next').innerHTML = `当前：<b>${midiToNameOf(note.midi)}</b>（${note.string}弦 ${note.fret}品）`;
      },
      onReanchor: (devMs) => diag(`↻ 重新对齐 ${devMs > 0 ? '+' : ''}${Math.round(devMs)}ms（后面按你的节奏走）`),
      finish: () => finishSession(),
    });
  }
  return tempoLayer;
}

async function loadNotes() {
  // 全部音符（原来只取前 60 个，所以光标走到一半多就"结束"了）
  // arp = 无谱面的逐音测试：用预先算好的时间轴 frontend/data/chord_arp.json
  if (!notes) {
    const file = songKind === 'arp' ? './data/chord_arp.json'
      : songKind === 'tech' ? './data/tech_practice.json'
        : (scoreOf(songKind) && scoreOf(songKind).json) || './data/hey_jude.json';
    const data = await (await fetch(file)).json();
    notes = data.notes;
    notesMeta = data;            // 小节/拍号/速度都在这儿（节拍器要用）
    // ⚠ 光标映射要在**两份都到齐**之后再做一次（2026-09-23，用户报"茉莉花没有光标"）：
    //   buildTickMap() 是把"谱面拍点表"和"判定清单 notes"对起来的，
    //   而新谱接入时谱面先渲染完、notes 后到（或反过来），只跑一次就会出现
    //   "谱面出来了但没有光标"。这里 notes 一到位就补跑一次，两边就都齐了。
    if (score) { try { buildTickMap(score, Number($('track') && $('track').value) || 0); } catch (e) {} }
  }
  return notes;
}

// ── 无谱面测试（arp）：一排"音格子"，当前该弹的那个高亮 ──────────────────────
function renderCells() {
  const box = $('cells');
  if (!box || !notes) return;
  box.innerHTML = '';
  const byMeasure = new Map();
  notes.forEach((n, i) => {
    const m = n.measure || 0;
    if (!byMeasure.has(m)) byMeasure.set(m, []);
    byMeasure.get(m).push({ n, i });
  });
  for (const [m, list] of byMeasure) {
    const row = document.createElement('div');
    row.className = 'row';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = list[0].n.chord || ('第' + (m + 1) + '小节');
    row.appendChild(tag);
    for (const { n, i } of list) {
      const el = document.createElement('div');
      el.className = 'cell';
      el.id = 'cell' + i;
      el.innerHTML = `<b>${midiToNameOf(n.midi + pitchShift())}</b>${n.string}弦${n.fret}品`;
      // 点格子 = 从这一格开始练（和谱面那条路同一个口径：
      //   只认这一次点击，这一遍从这儿起，下一遍仍旧从头）。
      // 跟弹进行中不改起点 —— 中途换起点会让"已经判到哪"和"光标在哪"错开。
      el.onclick = () => {
        if (!notes || !notes[i]) return;
        if (micTimer) {
          setVerdict('跟弹进行中：先点「停止」，再点你想从哪一格开始');
          return;
        }
        noteIdx = i;
        userPickedStart = true;
        holdUntilMs = 0;
        // 从新的地方开始练：**旧的标记要清掉**（跟谱面那条路的做法一致）——
        // 不然新一段和上一段的绿/红混在一起，看不出这次练到哪、对错是哪一遍的。
        if ($('marks')) $('marks').innerHTML = '';
        const cellBox = $('cells');
        if (cellBox && cellBox.querySelectorAll) {
          cellBox.querySelectorAll('.cell.ok, .cell.bad').forEach((c) => {
            if (c.classList) { c.classList.remove('ok'); c.classList.remove('bad'); }
          });
        }
        wrongList = []; wrongNoted = new Set();
        unclearCount = 0; missed = 0;
        $('wrongs').textContent = '';
        $('good').textContent = '0'; $('bad').textContent = '0';
        if ($('unclear')) $('unclear').textContent = '0';
        if ($('missed')) $('missed').textContent = '0';
        highlightCurrent();
        setVerdict(`这一遍从第 ${i + 1} 个音开始：`
          + `<b>${midiToNameOf(notes[i].midi + pitchShift())}</b>`
          + `（${notes[i].string}弦 ${notes[i].fret}品）—— 点「跟弹」开始`, '');
      };
      row.appendChild(el);
    }
    box.appendChild(row);
  }
  highlightCurrent();
}
function highlightCell(idx) {
  const box = $('cells');
  if (!box) return;
  const prev = box.querySelector && box.querySelector('.cell.now');
  if (prev && prev.classList) prev.classList.remove('now');
  const el = document.getElementById('cell' + idx);
  if (!el || !el.classList) return;
  el.classList.add('now');
  if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
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

// 判定主循环外面包一层"防摔"：循环里任何一处抛异常，都会把整条 requestAnimationFrame
// 链掐断 —— 用户看到的就是"卡死，再怎么弹都没反应"（2026-09-22 实测过一次：
// 起音台账里最后一条有电平/flux、却没有判定结果，也没有被丢弃的记录）。
// 现在出错只报一行、把相位放回 waiting，然后**继续跑**。
function micTick() {
  try {
    micTickBody();
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (globalThis.__vcDebug) console.log('[mic-error] ' + msg);
    err('判定循环出错（已自动继续）：' + msg);
    if (phase === 'settling') phase = 'waiting';
    micTimer = requestAnimationFrame(micTick);
  }
}

function micTickBody() {
  const buf = audio.readFrame();
  if (!buf) { micTimer = requestAnimationFrame(micTick); return; }
  const lv = rms(buf, buf.length - 1024, 1024);
  frames++;
  // 开局的地板只吃"像环境"的帧（2026-09-23）：原来是前 30 帧无脑平均，
  // 那一刻屏幕上要是有声音（提前弹了 / 房间有人说话），它会被当成环境音吸进去，
  // 门槛跟着抬高 → 头几个音和轻音收不到（表现就像"第一次弹把界限顶死了"）。
  // 现在比当前地板明显高的帧直接不参与，只让安静的帧把它拉下来。
  // ⚠ 2026-09-23 曾把它改成"只吃安静帧"，结果房间一直有底噪时地板反而升不上去、
  // 门限停在最低线，安静的杂音就能进来了（用户当天报"周围小声弹吉他都被收进去"）。
  // 已撤回原来的写法：前 30 帧照常平均。
  if (frames <= 30) floor += (Math.min(lv, 0.05) * 0.9 - floor) * 0.3;
  else if (lv < floor) floor = floor * 0.9 + lv * 0.1;
  else floor = Math.min(floor * 1.0003 + 1e-7, 0.06);
  floor = Math.max(floor, 0.0005);
  gate = Math.max(CFG.absFloor, floor * CFG.onsetSensitivity);

  const flux = fluxRelOf(buf);
  const hfFlux = hfFluxRelOf(buf);      // 高频段通量：拨弦瞬态（连续相同音靠它）
  // 2kHz+ 频带比自己 32ms 前涨几倍（起音层的"频带抬头"判据）：
  // 和弦/分解和弦里前一根弦还在响，总电平几乎不跳，但那一下的高频能量会跳。
  const hfBandRise = hfBandRiseOf(buf);
  // 基频区（150~600Hz）抬头：和上面那条一起用，防止"同一拨被算两次"（跳音）
  const lowBandRise = lowBandRiseOf(buf);
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
  // ── 跟节拍 = 音驱动（2026-09-23 改口径）────────────────────────────────────
  // 用户的口径：光标**弹一个过一个**、弹错停下重弹；时间不再由时钟一格一格推着走，
  // 而是最后用**总时间**去对账（第一个音到最后一个音，容忍 ±10s），
  // 中途拖了/停顿了按"漏拍 / 换和弦不流畅"记一次错。
  // 所以这里不再调 tempo().tick()（那条路会把窗口过期算成错、一漏一路漏）。
  // 节拍器改成独立开关（勾选框），跟节拍模式下它只出声当参考、不参与判定。
  const lagged = levelHist.length >= 3 ? levelHist[levelHist.length - 3] : 0;
  // ── 漏拍 / 换和弦不流畅（2026-09-23）──────────────────────────────────────
  // 该弹的时候长时间没动 → 记一次错误 + 漏拍标记；**不前进**，继续等这一个音。
  // 容忍度按谱面走：max(1.5 × 这一处的谱面间隔, 2 × 拍长)，下限 0.7s。
  // 这一格如果是**新小节 / 新和弦的第一格**，记成"换和弦不流畅"（数字谱上的"没跟上"），
  // 否则记"漏拍" —— 两种分开，才知道是手慢还是手没动。
  // ⚠ 口径（2026-09-23 用户定）：
  //   · **只有跟节拍模式**才记漏拍/换和弦不流畅；
  //   · "换和弦不流畅"**只有和弦谱**用，别的谱记"漏拍"；
  //   · **等我弹模式只判对错**，不记漏拍、不记时机 —— 你停下来想多久都不算错。
  if (modeKind === 'tempo' && phase === 'waiting' && lastOnsetMs > 0
      && notes && notes[noteIdx] && missNoted !== noteIdx) {
    const prevNote = notes[noteIdx - 1];
    const ioiMs = prevNote ? Math.max(0.15, notes[noteIdx].t - prevNote.t) * 1000 : 400;
    const beatMs = (60 / (userBpm || 76)) * 1000;
    const limitMs = Math.max(700, Math.max(1.5 * ioiMs, 2 * beatMs));
    if (now - lastOnsetMs > limitMs) {
      missNoted = noteIdx;
      const isChordScore = songKind === 'chords'
        || !!(notes[noteIdx].chord || (prevNote && prevNote.chord));
      const isChange = isChordScore && (!prevNote
        || (notes[noteIdx].measure || 0) !== (prevNote.measure || 0)
        || !!(notes[noteIdx].chord && prevNote.chord && notes[noteIdx].chord !== prevNote.chord));
      missed++;
      if (!wrongNoted.has(noteIdx)) { bad++; wrongNoted.add(noteIdx); }
      markNote(noteIdx, 'bad');
      if ($('missed')) $('missed').textContent = String(missed);
      if ($('bad')) $('bad').textContent = String(bad);
      if ($('heard')) $('heard').textContent = isChange ? '换和弦没跟上' : '漏拍';
      const idleSec = ((now - lastOnsetMs) / 1000).toFixed(1);
      setVerdict(isChange
        ? `⚠ 换和弦不流畅：第 ${(notes[noteIdx].measure || 0) + 1} 小节这里停了 ${idleSec}s —— 重弹这一个`
        : `⚠ 漏拍：这一格空了 ${idleSec}s —— 重弹这一个（谱面要 ${midiToNameOf(notes[noteIdx].midi + pitchShift())}）`, 'bad');
    }
  }
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
  // 相对"最近最强"的门槛：试过 12%~22%，**把快音也挡掉了**
  // （快音第二下的起音电平只有首个峰值的一成左右），所以不启用，只留着这个参照给读数看。
  peakLvRef = Math.max(lv, peakLvRef * 0.998);
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
  // ── "够不够陡"是这一层最要紧的判据 ─────────────────────────────────────
  // 用户实测：**只弹一个音让它一直响**，隔一会儿光标自己往前跳好几个音，还一直判对。
  // 原因：音量起伏（琴弦打拍子、手机麦克风的自动增益、房间反射）会被当成"新拨了一下"。
  // 但拨弦和起伏有一个物理差别：**拨弦是几毫秒内从无到有**，起伏是几十毫秒慢慢涨。
  // 所以要求"这一帧（16ms）的电平至少是上一帧的 1.7 倍"——慢慢涨的过不了这一关。
  // （测过 flux/hfFlux 都分不开这两种情况：同一个音整体变响时，全谱是一起变亮的。）
  const prevLv = levelHist.length ? levelHist[levelHist.length - 1] : 0;
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
  // ── 起音层的判据在 engine/onset.js（阈值也都在那儿）────────────────────
  // 这里只负责把这一帧的量喂进去，然后用它给的结论。
// 1 弦自己的电平基准（滑动）：1 弦最细最轻，实测电平 0.053~0.199，
// 而绝对门限线在 0.05 —— 它天生就贴着那条线，所以"有时过有时不过"。
// 用同一根弦自己刚才弹出来的电平当参照，把它的门限按比例压下来（不低于 gateFloor）。
// 这不是给某首谱开特例：**任何谱子**只要那一格在 1 弦就按这个来。

  const gateOut = decideOnset({
    phase, now, refractoryUntilMs, lastOnsetMs, minGapCfg: CFG.minGapMs,
    lv, prevLv, lagged, gate, floor, flux, hfFlux, hfBandRise, lowBandRise, shapeFlux, repeatSame,
    // ⚠ 2026-09-24：快段落标志（谱面这一段音间距 ≤350ms）——起音层用它放宽"2kHz 抬头"这条线
    //   （1.8 而不是 2.5）。只影响快段落；慢/中速一位不改。
    fastPassage: !!(notes && notes[noteIdx] && notes[noteIdx + 1]
      && (notes[noteIdx + 1].t - notes[noteIdx].t) <= 0.35),
  });
  const { onset, sharpEnough, shapeChanged, strongGate } = gateOut;
  // 近似帧（2026-09-23）：电平到了门限的八成、却没被认成起音 → 记下被否决的原因。
  // 用户报"快弹有些音没收上、确定是检测没起来"，靠这份日志就能指出卡在哪一条。
  if (!gateOut.onset && phase === 'waiting' && lv > gateOut.strongGate * 0.8) {
    nearMissLog.push({
      t: Number((now / 1000).toFixed(3)), why: gateOut.why,
      lv: Number(lv.toFixed(4)), gate: Number(gateOut.strongGate.toFixed(4)),
      prevLv: Number(prevLv.toFixed(4)), lagged: Number(lagged.toFixed(4)),
      rise: Number((lv / (lagged + 1e-9)).toFixed(2)),
      flux: Number(flux.toFixed(3)), hfFlux: Number(hfFlux.toFixed(3)),
      shape: Number(shapeFlux.toFixed(3)), hfBand: Number((hfBandRise || 0).toFixed(2)),
      loBand: Number((lowBandRise || 0).toFixed(2)),
    });
    if (nearMissLog.length > 120) nearMissLog.shift();
  }
  // 起音层逐帧台帐（只在 test-follow-real.mjs 的 VC_ONSET_DEBUG=1 时打）：
  // 查"这一段为什么没被当起音 / 为什么一下被算成两下"用。对页面没有任何影响。
  if (globalThis.__vcOnsetDebug && lv > 0.02) {
    console.log(`[onset] t=${(now / 1000).toFixed(3)} 电平=${lv.toFixed(4)} 上帧=${prevLv.toFixed(4)}`
      + ` 滞后=${lagged.toFixed(4)} 门限=${strongGate.toFixed(4)} 陡=${sharpEnough ? 'y' : 'n'}`
      + ` 形状=${shapeFlux.toFixed(3)} 通量=${flux.toFixed(3)} 高频=${hfFlux.toFixed(3)}`
      + ` 频带抬头=${hfBandRise.toFixed(2)}`
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

  // 技巧第二个音：到点就当成"一次起音"走同一条路（不需要真的拨响）
  const techDue = modeKind !== 'tempo' && phase === 'waiting' && techDueMs && now >= techDueMs;
  if (techDue) techDueMs = 0;

  if (onset || jumpOnset || techDue) {
    onsetPeakLv = lv;                    // 记下峰值电平，判定时用它验"尾巴"（判据②）
    const tech = !!techDue;
    // 真起音先到（比如滑音滑到位那一下也会有点动静）→ 取消排队中的技巧时刻，
    // 否则同一个音会被判两次。谁先到算谁的。
    techDueMs = 0;
    if (globalThis.__onsetLog) globalThis.__onsetLog.push(Number((now / 1000).toFixed(3)));
    onsetLog.push({
      t: Number((now / 1000).toFixed(3)), level: Number(lv.toFixed(5)),
      floor: Number(floor.toFixed(5)), gate: Number(strongGate.toFixed(5)),
      flux: Number(flux.toFixed(3)), hfFlux: Number(hfFlux.toFixed(3)),
      hfBand: Number(hfBandRise.toFixed(2)),
      tech,
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
    // ── 听到了，光标**立刻**往前走一格 ────────────────────────────────────
    // 用户口径："有没有可能听到了光标就动，判错判对的延迟用户是感觉不到的" —— 可以：
    // 判定本身还要 90ms 才出结论，但"该弹下一格了"这件事现在就告诉他；
    // 对/错的结果回来之后只是把那格标绿/标红（markNote），不再挪光标。
    // ⚠ 不再把光标往前预览（2026-09-23）：弹错要"停在原地重弹"，
    // 预览一格会让用户以为已经过了、也让"没反应过来"更乱。
    // 光标只在**判过之后**由 advanceNote() 往前挪。
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

  // 起音之后等多久才判定：**90ms**。
  // ⚠ 2026-09-22 晚试过压到 60ms（想减延迟），用户实测"弹对但判错、还会漏音，
  // 比改之前差"——判定窗整体往前挪之后，窗里上一根的音多了一截。已改回 90ms。
  // ⚠ 2026-09-24 试过"**按需延后**"：把判定推到起音后 250ms，让那扇 170ms 窗自动变成
  //   稳定段（起音+80~+250，闷响已衰减）。在两条真机标定集上（错音测试 / 24 音旋律）
  //   结论是 —— **数字一个都没变**（错音测试 对 5、24 音 对 14，延后前也一样）。
  //   所以"高把位侥幸过"不是被闷响填出来的泛音假象，我对根因的判断不完整 →
  //   **没上线**。下一步先查"那 5 次到底走了哪条放行通道"（passCand / quietOk / 兜底），
  //   有了证据再动，不再猜。
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
    // ⚠ 这道闸门**只对真实谱面（Hey Jude 这条单旋律）生效** —— 2026-09-23 我一度把它
    //    "通用"到所有单音路径（逐音测试 / 技巧练习），结果**打崩了分解和弦**：
    //   判据是 YIN 的周期性，而分解和弦里前一根弦还在响，YIN 必然放弃（clarity=0），
    //   于是真弹的音被当"不像琴声"逐个丢掉。证据（用户的两份 arp 导出）：
    //     9:58 那份（改之前）：32 个起音、**0 个被丢**、31 个判对；
    //     10:46 那份（改之后）：开始出现 result=undefined（被丢）的起音，用户报"3弦都收不进去"。
    //   所以判据能通用、**适用条件不能通用**：YIN 的 clarity 在叠音里必失效。
    //   **改法（2026-09-23）**：判据换成"clarity 过 **或** 谐波墙 ≥ pluckHnrMin"——
    //   谐波墙在叠音里也立得住（C 和弦那段实测 3.3~8.5，噪声/敲桌子 ≈1.6），
    //   所以这条**对所有单音路径一样**（真实谱面 / 逐音测试 / 技巧练习 / 分解和弦逐音）。
    //   和弦路径（chords，一次多根弦同时响）不走这里。
    // 单音路径全都走这条闸门（真实谱面 / 逐音测试 / 技巧 / 分解和弦逐音）——
    // 因为判据已经换成"有没有弦被拨响"（谐波墙），它在叠音里也立得住。
    // 和弦路径（chords，一次多根弦同时拨）不走这里。
    const singleNotePath = !!(notes && notes.length);
    let notAString = false;
    if (singleNotePath) {
      // ⚠ 2026-09-23 我在这里给 1 弦开过一个口子（"只要有 2kHz 抬头 ≥2.5 就不丢"），
      //    意图是救 1 弦里 clarity=0 的那几种音。**结果是敲桌子被不停判对**：
      //    敲桌子正是宽频瞬态，2kHz 抬头极大 —— 这条口子把"最不像琴声"的东西放进来了。
      //    已撤：回到原来那把尺子（YIN 的周期性说了算），1 弦不再例外。
      // ① YIN 说得算：周期性强
      // 1 弦那一格单独放宽（用户口径：**只在谱面这一格是 1 弦时**放宽，别处不放）：
      // 只把"周期性"这条线降一档（0.42 → 0.25）；电平、形状、间隔一律不动。
      // 敲桌子/风那类 clarity 通常 <0.2，照样过不来；1 弦真音在叠音里常掉到 0.3 上下，这一档正好救它。
      const expStr1 = !!(notes && notes[noteIdx] && notes[noteIdx].string === 1);
      const clarMin = expStr1 ? (CFG.pluckClarityMinLow || 0.25) : CFG.pluckClarityMin;
      const byClarity = (a.pitch.clarity > clarMin) && (a.pitch.hz > CFG.pluckMinHz);
      // ② 谐波墙说得算：数不出周期，但"谐波成串"（叠音里 YIN 会放弃，墙却立着）
      let hnrDom = 0;
      try {
        const n = 1 << Math.floor(Math.log2(Math.min(8192, buf.length)));
        const srNow = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
        const sp = spectrumOf(buf.subarray(buf.length - n));
        const domF0 = dominantF0InBand(sp, srNow, n, 90, 900).hz || 0;
        if (domF0 > 0) hnrDom = harmonicity(sp, srNow, n, domF0);
      } catch (e) { hnrDom = 0; }
      const stringOk = byClarity || hnrDom >= (CFG.pluckHnrMin || 3);
      const clarityFail = !stringOk;
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
        // ── 过滤要留，但判据要换（2026-09-23 用户两句话定下来的）─────────────
        // 用户说得很清楚：
        //   ① "起音全进通道，那敲桌子/说话/周围杂音的起音都可以轻松判错了？体验不能这么差"
        //      → **过滤必须留**：环境音不进判定、不报错、不前进。
        //   ② "被丢掉不就代表真正需要他的时候也过不去了？"
        //      → **过滤不能把真音吞掉**。
        // 两条同时满足只有一个办法：把判据从"YIN 的周期性"换成"**有没有弦被拨响**"——
        //   谐波墙（harmonicity）：真拨弦 2 万倍以上、分解和弦里 3.3~8.5，
        //   而敲桌子/风 ≈1.6。所以：
        //     stringOk = clarity 过 **或** 谐波墙 ≥ pluckHnrMin(2.5)
        //   不用 YIN 单独定生死（它在叠音里必失效，真音就是这么被吞的）。
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
    if (notAString) {
      {
        const last = onsetLog[onsetLog.length - 1];
        if (last) (last.retry = last.retry || []).push(`${(a.pitch.clarity || 0).toFixed(2)}/${Math.round(a.pitch.hz || 0)}Hz`);
      }
      if (windowTries < CFG.pluckRetries) {
        windowTries++;
        onsetAtMs = now + 30;            // 再过 60ms 重测（settling 在 +90ms 触发）
        phase = 'settling';
      } else {
        phase = 'waiting';
        // 这一下没通过"像不像一根弦"的关卡 —— 记进台帐，别让它悄无声息地消失
        const last = onsetLog[onsetLog.length - 1];
        if (last) { last.dropped = 'not-a-string'; last.clarity = Number((a.pitch.clarity || 0).toFixed(3)); last.hz = Math.round(a.pitch.hz || 0); }
        // 这一下不算数（不像琴声）→ 把刚才预览挪过去的光标收回来
        if (modeKind !== 'tempo') highlightCurrent();
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
 // ⚠ 2026-09-24（用户报"全弹快没有提示"）：跟节拍模式下**逐音时间账**要真的算。
 //   口径（音驱动，不改"哪个音"的匹配）：拿**这一下与上一拨的间隔**去比**谱面这两格的间隔** ——
 //     devMs < 0 → 这一下走得比谱面快（抢拍）；> 0 → 比谱面慢（拖拍）。
 //   为什么用"间隔"而不是"绝对时刻"：绝对时刻里含着"他起手晚了多少 / 麦克风延迟"，
 //   那部分不是演奏快慢；间隔差值只反映**这一段他自己的节奏相对谱面快了多少**，
 //   所以"全弹快"会从第二三个音开始就一路记抢拍。
 //   （老的那段"时钟对号"仍然留着 but 停用：if (false) —— 那是按网格等，弹在前面会被吞。）
 if (modeKind === 'tempo' && best > 0 && lastOnsetMs > 0 && onsetAtMs > 0) {
   const scoreGap = (expectedAtMs(best) - expectedAtMs(best - 1));
   const myGap = onsetAtMs - lastOnsetMs;
   if (Number.isFinite(scoreGap) && scoreGap > 0 && myGap > 0) devMs = myGap - scoreGap;
 }
      if (false) {   // 2026-09-23：跟节拍改音驱动，老"时钟对号"这条路停用（保留对照）
        // ⚠ 这条路已经不通了（2026-09-23：跟节拍改成音驱动，见下面 micTickBody 的说明）。
        // 保留代码是为了对照老口径，条件永远是 false。
        // ── 老口径：这一下只看它落没落在某个音的时间窗里 ──────────────────
        // 不往前跳、也不把中间的音一起吃掉：窗口过期是"时钟"那边的事（tempoTick）。
        // 落在窗口外（弹早了/弹晚了）→ 这个起音不算数，等窗口关掉记错。
        const elapsed = onsetAtMs - micStartedAt;
        // 第一下 = 时间轴原点：把整条谱面时间轴对齐到用户这一下（第一个音以他为准）
        if (!tempo().isAnchored()) {
          tempo().anchor(elapsed);
          noteIdx = 0;
          highlightCurrent();
          const pickup = tempo().pickupCount();
          setVerdict(`起手对齐：以这一下为第 1 个音（${midiToNameOf(notes[0].midi)}）`
            + (pickup ? `　※ 这 ${pickup} 个音是起拍音（拾音），正拍从第 2 小节开始` : ''), '');
          if (pickup) diag(`※ 起拍音 ${pickup} 个（不掐拍子）；正拍 / 提示音从第 2 小节开始`);
        }
        // ── 对号：**时间 + 音高**（窗内、弹早了、弹晚了、快音，全都走这一条）──────
        // 只按时间最近的音对号，到 16 分音符那种地方差一位就整段判错；
        // 用户"弹在网格前面"时更糟：app 还在按上一格等（导出里 devMs -100~-250、
        // '听到的音'正好是谱面下一个音，就是这么来的）。
        // 所以候选取"附近还没判、时间上说得通"的几个音，逐个量一次"自己贴不贴"，
        // 挑最像的那个；同一音高重复出现时时间近的优先（损失里带了 |时间差|/2）。
        const N = 8192;
        const srNow = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
        let specE = null;
        try { specE = spectrumOf(buf.subarray(Math.max(0, buf.length - N))); } catch (e) { specE = null; }
        // 先按时间取"窗内最近的那个音"（这是老行为，快音段落最稳）；
        // 只有它不存在（弹早了/弹晚了，落在窗外）时，才让音高来挑附近哪个音。
        const kIn = tempo().noteAt(elapsed);
        const curIdx = tempo().cursorIndex();
        const cands = [];
        for (let j = Math.max(0, curIdx - 3); j <= Math.min(notes.length - 1, curIdx + 3); j++) {
          if (tempo().state()[j]) continue;
          const d = elapsed - tempo().at(j);
          const ioiJ = notes[j + 1] ? Math.max(60, (notes[j + 1].t - notes[j].t) * 1000) : 400;
          if (Math.abs(d) > Math.max(tempo().tol(j), ioiJ * 1.2)) continue;
          cands.push({ j, d, inWin: Math.abs(d) <= tempo().tol(j) });
        }
        let pick = -1, pickLoss = Infinity, pickInWin = false;
        if (specE) {
          for (const c of cands) {
            // 窗内的情况只做"微调"：kIn 存在时，只有候选比它更贴（差 > 40）才换
            if (kIn >= 0 && c.j !== kIn && !c.inWin) continue;
            const r = judgeNote({ spec: specE, sampleRate: srNow, fftSize: N, expectedMidi: notes[c.j].midi + pitchShift() });
            if (!r.self || !(r.self.mismatch < 250)) continue;
            const loss = r.self.mismatch + Math.abs(c.d) / 2 + (c.j === kIn ? -40 : 0);
            if (loss < pickLoss) { pickLoss = loss; pick = c.j; pickInWin = c.inWin; }
          }
        }
        if (pick < 0 && kIn >= 0) { pick = kIn; pickInWin = true; }
        if (pick < 0) {
          // 哪儿都对不上：只提示"早了/晚了多少"，那个音会在窗口关掉时按错记
          const near = tempo().nearestPending(elapsed);
          if (near.idx >= 0 && Math.abs(near.dev) <= tempo().tol(near.idx) * 4) {
            timingDevs.push(near.dev);
            timingTolMs = tempo().tol(near.idx);
            if (near.dev < 0) earlyCount++; else lateCount++;
            const dir = near.dev < 0 ? '早' : '晚';
            diag(`起音 ${(elapsed / 1000).toFixed(2)}s 比第${near.idx + 1}个音${dir} `
              + `${Math.abs(Math.round(near.dev))}ms（容许 ±${Math.round(tempo().tol(near.idx))}ms）→ 这一下不算`);
          }
          micTimer = requestAnimationFrame(micTick);
          return;
        }
        best = pick;
        noteIdx = pick;            // 只是把"当前音"对齐到这一下；光标仍由时钟驱动
        devMs = elapsed - tempo().at(pick);
        if (!pickInWin) {
          // 窗外但音对（弹早/弹晚）→ 先认下，判定之后把整条时间轴对齐到你这一下
          tempo().setLateAccept(true);
          if (Math.abs(devMs) > tempo().tol(pick)) {
            diag(`（${devMs < 0 ? '早' : '晚'}了 ${Math.abs(Math.round(devMs))}ms：先按第${pick + 1}个音认下，判定后重新对齐）`);
          }
        }
      }
      if (!notes[best]) { stopMic(); return; }
      let exp = notes[best];
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
      // ⚠ 2026-09-23 试过"判定只用抬头加权的那份谱"（onsetPeakSpec，用户的设计意图：
      //   上一根的余波在起音时是下降的，只算抬头的那条线）——**实测把真音也抹掉了**：
      //   真机 击弦 3/0、勾弦 2/0、滑音 4/0 → **0/1、2/0、2/1**。
      //   原因：加权是"比 43ms 前涨了几倍−1"，新拨那一下若涨得不够猛（1.1~1.3 倍），
      //   它的谐波也被压到接近 0，谱就废了。**设计意图对，这个实现太损**。
      //   正确的实现要用"起音瞬间前后各几毫秒"的差分（需要环形缓存 + 记住起音采样点），见调研文档。
      // 所以现在仍然用长窗（judgeSpec）当主判据，抬头快照只作备选。
      // ── 判定只用"抬头的那部分"（用户口径，2026-09-23）──────────────────────────
      // 用户的原话：**每一个音符的起音只单独判这个音符的音准；在这个窗口里，比它低（折线低）
      //  或者正在减弱的音，都不做处理。**
      // 逐频点看就是：只留"起音后比起音前高"的那些频点，跌下去的一律归零 ——
      // 也就是 **起音后 40ms − 起音前 40ms（负的削成 0）**，再零填充到 8192 保证低音的分辨率。
      // ⚠ 为什么必须 40ms + 零填充：20ms 窗 bin 宽 50Hz，低音（E2/C3）根本分不开，
      //   100Hz 那种伪基频总能凑出 200/300/400（用户导出里 detHz=100 就是这么来的）。
      let onDiffSpec = null;   // 起音前后相减后的谱（只留抬头的那部分）
      let srDOut = 48000;
      try {
        const srD = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
        srDOut = srD;
        const backD = Math.round(((now - onsetAtMs) / 1000) * srD);
        const WD = Math.round(0.040 * srD);
        if (backD > WD * 2 && backD + WD < buf.length) {
          const padTo = (src) => { const o = new Float32Array(8192); o.set(src.subarray(0, Math.min(src.length, 8192))); return o; };
          const post = spectrumOf(padTo(buf.subarray(buf.length - backD, buf.length - backD + WD)));
          const pre = spectrumOf(padTo(buf.subarray(buf.length - backD - WD, buf.length - backD)));
          onDiffSpec = new Float32Array(post.length);
          for (let i = 0; i < post.length; i++) { const v = post[i] - pre[i]; onDiffSpec[i] = v > 0 ? v : 0; }
        }
      } catch (e) { onDiffSpec = null; }
      // ⚠ 2026-09-23 实测记录：把"起音前后 40ms 相减（只留抬头）"接成**判定用的谱**后，
      //   两边都变差 —— 击弦 3/0→2/1、逐弦 4/1→2/1、一直弹1弦1品 对0→对1。
      //   原因：相减得到的是"增量"，它会低估"本来就已经在响的音"的谐波、又放大噪声，
      //   而候选重排需要一份**正常形态的谐波列**才能比失配。所以这一步撤回，
      //   **相减只用于读数（detHz/detCents）**，判定仍然用长窗。
      // ⚠ 2026-09-24：判定输入可以换成"**只属于这一下**的差分谱"（起音前后各 40ms 相减、只留抬头、
      //   零填充 8192）。开关 `__judgeOnDiff`（测试用），默认关闭 = 现在的行为。
      //   依据：现在这扇 170ms 长窗里同时装着"新拨的能量 + 上一根弦的余响 + 拨弦闷响"，
      //   两种证据混在一起分不开 —— 加严对手会误杀弹对的，删掉反证又放过弹错的（三次实验结论）。
      // ⚠ 2026-09-24：**以起音采样点为中心的前后短窗差分**（文档 9-21 记的那条正解）。
      //   和上面那份 `onDiffSpec` 的区别：那份的窗落在"判定时刻"（起音后 90ms）附近，
      //   慢音还行，快音/琶音时它已经混进下一个音；这份**用 onsetAtMs 反推出起音采样点**，
      //   取 pre = [起音-40ms, 起音-10ms]、post = [起音+10ms, 起音+40ms]（各留 10ms 空档避开
      //   起音瞬态那一下的宽带噪声），相减只留"这一下新加进来的"。
      //   buf 本身有 341ms，够反推 —— 不需要额外的环形缓存。
      let attackDiffSpec = null;
      try {
        const srA = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
        const backA = Math.round(((now - onsetAtMs) / 1000) * srA);   // 起音点距"现在"多少采样
        const WA = Math.round(0.030 * srA);                            // 30ms 窗
        const gapA = Math.round(0.010 * srA);                          // 两侧空档
        if (backA > WA + gapA && backA + WA + gapA < buf.length) {
          const padA = (src) => {
            const o = new Float32Array(8192);
            o.set(src.subarray(0, Math.min(8192, src.length)));
            return o;
          };
          const preA = spectrumOf(padA(buf.subarray(buf.length - backA - gapA - WA, buf.length - backA - gapA)));
          const postA = spectrumOf(padA(buf.subarray(buf.length - backA + gapA, buf.length - backA + gapA + WA)));
          attackDiffSpec = new Float32Array(preA.length);
          for (let i = 0; i < preA.length; i++) { const v = postA[i] - preA[i]; attackDiffSpec[i] = v > 0 ? v : 0; }
        }
      } catch (e) { attackDiffSpec = null; }
      const spec = (globalThis.__judgeAttackDiff && attackDiffSpec) ? attackDiffSpec
        : (globalThis.__judgeOnDiff && onDiffSpec) ? onDiffSpec
          : (judgeSpec || onsetPeakSpec || novel);
      const specRate = judgeSpec || onsetPeakSpec ? peakRate : sr2;
      const specN = judgeSpec || onsetPeakSpec ? PEAK_N : a.fftN;
      // ── §6「起音即读数」（第 1~4 条）────────────────────────────────────────
      // ① 窗以**起音采样点**为中心：pre = [起音−40, 起音−10]ms、post = [起音+10, 起音+40]ms；
      // ② post − pre（负的归零）= "这一下新加进来的谱"；
      // ③ 在这份谱上、**按该弦的频带**量一条"最响的、自带 2f/3f、且不是更低那根谐波"的基频；
      // ④ 可信度门：两个互不相同的锚定窗都量出来、而且**意见一致**（差 ≤1 个半音）才采信；
      //    量不出或两次打架 → 一律不硬判（读到多少只写进导出记录，判定退回原链路）。
      // 为什么要第二个窗：拨弦那一下的闷响/别的弦的余响偶尔也凑得出一次假读数，
      // 两个不同位置的窗同时被同一条假线骗到的概率低得多；而真音在两个窗里都立着。
      let readHz = null, readHz2 = null, readMidi = null, readSemis = null;
      let readConf = false, readVeto = false;
      if (JUDGE_READ) {
        try {
          const srR = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
          const backR = Math.round(((now - onsetAtMs) / 1000) * srR);   // 起音点在"现在"之前多少采样
          // 相对起音的时刻（秒）→ buf 里的下标（buf 末尾就是"现在"）
          const at = (sec) => buf.length - backR + Math.round(sec * srR);
          const padR = (src) => {
            const o = new Float32Array(8192);
            o.set(src.subarray(0, Math.min(8192, src.length)));
            return o;
          };
          const anchorDiff = (preFrom, preLen, postFrom, postLen) => {
            const p0 = at(preFrom), q0 = at(postFrom);
            const n1 = Math.round(preLen * srR), n2 = Math.round(postLen * srR);
            if (p0 < 0 || q0 < 0 || p0 + n1 > buf.length || q0 + n2 > buf.length) return null;
            const post = spectrumOf(padR(buf.subarray(q0, q0 + n2)));
            const pre = spectrumOf(padR(buf.subarray(p0, p0 + n1)));
            const d = new Float32Array(post.length);
            for (let i = 0; i < post.length; i++) { const v = post[i] - pre[i]; d[i] = v > 0 ? v : 0; }
            return d;
          };
          // 按弦分带：谱面给了弦品 → 只在那根弦的音域里读（空弦下 1 个半音 ~ 25 品）
          const openM = OPEN_STRING_MIDI[exp.string];
          const band = openM
            ? (() => {
              const o = 440 * Math.pow(2, (openM + pitchShift() - 69) / 12);
              return { loHz: o * Math.pow(2, -2 / 12), hiHz: o * Math.pow(2, 25 / 12) };
            })()
            : {};       // 没有弦品的格子（和弦/扫弦不走这里）→ 用吉他音域
          const w1 = anchorDiff(-0.040, 0.030, 0.010, 0.030);       // §6 第 1 条那个窗
          const w2 = READ_GATE === 'b2' ? anchorDiff(-0.053, 0.043, 0.010, 0.043)
            : READ_GATE === 'b5' ? anchorDiff(0.010, 0.040, 0.050, 0.040)
              : null;
          const r1 = w1 ? readPluckF0(w1, srR, 8192, band) : null;
          const r2 = w2 ? readPluckF0(w2, srR, 8192, band) : null;
          if (r1) readHz = r1.hz;
          if (r2) readHz2 = r2.hz;
          if (r1) {
            const m1 = 69 + 12 * Math.log2(r1.hz / 440);
            const m2 = r2 ? 69 + 12 * Math.log2(r2.hz / 440) : null;
            const agree = (m2 == null) ? (READ_GATE === 'off') : (Math.abs(m1 - m2) <= 1);
            if (agree) {
              readConf = true;
              readMidi = Math.round(m2 == null ? m1 : (m1 + m2) / 2);
              readSemis = readMidi - (exp.midi + pitchShift());
              readVeto = Math.abs(readSemis) >= READ_VETO_SEMIS;
            }
          }
        } catch (e) { readVeto = false; }
      }
      // ── 判定：候选重排（本音 vs ±1 品 vs ±2 品）────────────────────────────
      // spec 就是"判定这一刻往回 170ms"那扇窗，也就是 test/gt-notes.mjs 里验过的那扇。
      // 判定层在 engine/judger.js（候选重排 + 判过规则 + 阈值）
      let candMatch = JUDGE_CAND
        // ⚠ 2026-09-24：这里试过给候选重排传 rise（O2P 抬头加权）+ prevMidi（剔掉上一音的余响），
        //   在**带真值的旋律真机集**（vc_gf/tl-heyjude-label.json，24 个音）上 A/B：
        //     开着 = 对 7 / 错 6；关掉 = 对 7 / 错 5  → **变差，没上线**。
        //   能力本身留在 engine 里（analysis.js 的 opts.rise / opts.prevMidi，不传=不变），
        //   等找到在同一个标定集上"对更多、错更少"的用法再接回来。
        ? judgeNote({
          spec, sampleRate: specRate, fftSize: specN, expectedMidi: exp.midi + pitchShift(),
          // ⚠ 2026-09-24（用户口径）：**谱面给了弦品这一格，就把候选表收到 ±1/±2 品** ——
          //   1弦1品 弹不出低八度（那是 4弦3品），别再拿"约 F3/F2"去说他。
          //   没有弦品的格子（和弦/扫弦）保持原样，低八度守卫在那条路上继续生效。
          opts: (() => {
            if (exp.string == null) return { maxOffset: null, bandLo: 0, bandHi: 0 };
            // 弦 → 空弦音高（标准差：1弦E4=64 / 2弦B3=59 / 3弦G3=55 / 4弦D3=50 / 5弦A2=45 / 6弦E2=40）
            const OPEN = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };
            const open = OPEN[exp.string];
            if (!open) return { maxOffset: 2, bandLo: 0, bandHi: 0 };
            const o = 440 * Math.pow(2, (open + pitchShift() - 69) / 12);
            // ⚠ 诊断开关（默认关，产品行为不变）：把"抬头加权"和"上一音余响剔除"
            //   这两条 engine 里已有的能力接上看数字 —— 2026-09-24 在旋律真机集上试过是变差的，
            //   但那次琶音靶子配错了进行（见 vc_gf/tl-6415.json 那一段的说明），要在**修好的靶子**上重测。
            const extra = {};
            if (globalThis.__judgeRise && rise) {
              extra.rise = rise;
              extra.riseBinHz = ((audio.getCtx() && audio.getCtx().sampleRate) || 48000) / FLUX_N;
            }
            if (globalThis.__judgePrev && best > 0 && notes[best - 1]) {
              extra.prevMidi = notes[best - 1].midi + pitchShift();
            }
            return {
              ...extra,
              maxOffset: 2,                       // 谱面给了弦品 → 候选只留 ±1/±2 品
              // ⚠ 2026-09-24（用户实测"高把位乱弹有概率过"）：**响的音才要求本音明显领先**。
              //   实测那 5 次侥幸过全在电平 0.15~0.22：本音失配 226~249（落在"弹错"档），
              //   领先倍数只有 0.94~1.03（跟最强邻居基本打平）—— 收到 1.05 就全挡住。
              //   一律收紧会误杀 3 个弹对的音（多为轻音、证据本来就弱），所以按电平分档：
              //   **电平 ≥0.10 要领先 1.05；<0.10 仍用 0.90**（轻音那侧不动）。
              rivalMargin: (lv >= 0.10 ? 1.05 : 0.90),
              bandLo: o * Math.pow(2, -1 / 12),   // 本弦空弦下 1 个半音（留点容错）
              bandHi: o * Math.pow(2, 25 / 12),   // 到 25 品
            };
          })(),
        })
        : null;
      let candSelf = candMatch ? candMatch.self : null;
      let candRival = candMatch ? candMatch.rival : null;
      let candBest = candMatch ? candMatch.best : null;
      // ── "等我弹"也要做一次音高复核：这一下更像**下一个还没判的音** → 当前音记漏，
      // 把这一下改判给下一个。解决两件事（用户 15:12 那份导出的 3 处错就在这儿）：
      //   ① 快速交替处（E4/F4 那种邻音）对号错一位；
      //   ② 漏弹一格之后"全体错位一位"的老毛病。
      // 只在这三个条件同时成立时才跳：量到的音 == 下一个音、当前音明显不像（失配 >200）、
      // 且下一个音自己明显更贴（失配好 60 以上）。这样不会把正常演奏判成"跳音"。
      // ⚠ 只在**快音段落**才允许"跳过去一个音"：
      // 用户口径（2026-09-22）：慢的地方我把 2 品弹成 3 品，那就是我弹错了，不许系统替我解释成
      // "你跳过了一个音"。快音段落才可能出现"漏弹一格 → 后面全体错位"，那里才用得着它。
      const ioiHere = (notes[best] && notes[best + 1]) ? (notes[best + 1].t - notes[best].t) * 1000 : 999;
      const fastPair = ioiHere <= 260;
      if (modeKind !== 'tempo' && fastPair && candMatch && candBest && candSelf && notes[best + 1]
        && candBest.midi === notes[best + 1].midi && candSelf.mismatch > 200) {
        const r2 = judgeNote({ spec, sampleRate: specRate, fftSize: specN, expectedMidi: notes[best + 1].midi + pitchShift() });
        // ⚠ 2026-09-24：**跳音必须双证据**（用户 10:27 导出里 21.167s 那处真拨弦被记成
        //   "漏了 A#3（跳过去了）"，他不认这个判定）。原来只要"下一个音比当前音好 60"就跳，
        //   而余响把当前音罚到 250~300 时，"好 60"太容易满足。
        //   现在多一条**绝对质量**要求：下一个音自己必须落在"弹对"那一档（失配 < 190，
        //   实测分布：弹对 118~195）。不满足 → 不跳，老老实实判"这一格"，用户重弹即可，
        //   绝不会被系统悄悄当成"你没弹"。
        if (r2.self && r2.self.mismatch < 190 && r2.self.mismatch + 60 < candSelf.mismatch) {
          // 当前这个音：你没弹它 → 记"漏"（不是判你弹错）
          missed++;
          wrongList.push(`第${(exp.measure || 0) + 1}小节 漏了${midiToNameOf(exp.midi)}（跳过去了）`);
          $('wrongs').textContent = '弹错/漏：' + wrongList.join('、');
          $('missed').textContent = missed;
          markNote(best, 'bad');
          sessionLog.push({
            no: best + 1, t: Number((now / 1000).toFixed(3)),
            exp: exp.midi, expName: midiToNameOf(exp.midi), result: 'miss',
          });
          best += 1;
          exp = notes[best];
          if (!exp) { stopMic(); return; }      // 跳过去的是最后一个音 → 收尾，别让后面读空
          candMatch = r2;
          candSelf = r2.self; candRival = r2.rival; candBest = r2.best;
          noteIdx = best;
        }
      }
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
      const est = estimateF0Near(onsetPeakSpec || novel, peakRate, 8192, exp.midi + pitchShift(), fit);
      // 差分谱上的同一把尺子（范围放宽到 ±250）：这就是"不看上一个音、也不看答案"
      // 的那一次量 —— 判定优先用它。
      const estDiff = onsetDiffSpec
        ? estimateF0Near(onsetDiffSpec, peakRate, 8192, exp.midi + pitchShift(), { rangeCents: 250, tolCents: 15 })
        : null;
      const useDiff = !!(JUDGE_DIFF && estDiff && estDiff.score > 0);
      const estJ = useDiff ? estDiff : est;
      // 复核：主判据读的是"起音那一刻的快照"，实测它会抓早（把弹对的读偏 60~80 音分）。
      // 所以判定这一刻（起音后约 90ms）再用同一把尺子量一次平窗，落在 45 音分内就判过。
      // 这一条在你那段 30 秒录音上把结果从"对 28／错 3"抬到"对 40／错 0"。
      let confirmCents = null;
      try {
        const cs = judgeSpec || spectrumOf(buf.subarray(Math.max(0, buf.length - PEAK_N)));
        const ce = estimateF0Near(cs, peakRate, PEAK_N, exp.midi + pitchShift(), fit);
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
      const estP = estimateF0ByPeaks(spec, specRate, specN, exp.midi + pitchShift(), {});
      // 记下"这一次量出来的频率"：下一个音如果是技巧音，用它当音程基准（见 techRefHz）。
      // ⚠ 必须写在 estP 声明之后 —— 写前面就是暂时性死区，主循环会整条断掉（今天栽第二次）。
      lastJudgeHz = (estP && estP.f0) ? estP.f0 : null;
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
      const passCand = candMatch ? candMatch.pass : false;
      // 轻音兜底（2026-09-22 晚，用用户新录的 F4/E4 交替量的）：
      // 那段录音里"响的几下（电平 0.1~0.2）"量得很干净（残差 1~20 vs 23~70），
      // 出问题的全是**轻的下（电平 0.02~0.04）**，残差变成 43v49、44v43 这种分不开的；
      // 而手机上判错的那两行也正是轻的（0.021 / 0.031）。
      // 所以：**电平低于 0.06 的音**，如果精确读数说它就在谱面这个音上（±45 音分内），
      // 就不让"候选重排"把它判成错 —— 低信噪比下候选重排本来就没有分辨力。
      // 响的音（≥0.06）不受影响：±1/±2 弹错的两向验收都在那个区间，检出不能松。
      // ⚠ 这里必须用 estP.cents（上面已经算好），**不能**用下面的别名 centsP ——
      // 那个 const 声明在几行之后，在声明前访问会抛 ReferenceError（暂时性死区）。
      // 2026-09-22 就是这么把主循环弄死的：音够响时 && 短路不发作，1 弦衰减到 0.06 以下才炸。
      const quiet = lv < 0.06;
      // ⚠ 要用 nearMidi（不看答案的独立读数）就必须在这儿算 —— 它在上面的行里已经定义好了；
      //    往后挪到 `const midiP = nearMidi;` 之后会踩暂时性死区，判定循环整条抛错（2026-09-23 栽过一次）。
      // ⚠ 2026-09-23 试过把这里的容差从 ±1 收到 0（想堵住"差半音也判过"），
      //   **实测把技术练习打崩了**：击弦 3/0→2/1、勾弦 2/0→0/1、滑音 4/0→2/1。
      //   原因：这个"独立读数"（低频带最强线 dominantF0InBand）本身就不够准
      //   （它就是页面上那个"听到"，经常差半音），**不能拿它当等号用**。
      //   所以容差回 ±1；"听到≠期待却判过"要从**显示**和**判定结论**统一上解决（见下一步）。
      const heardIsExpected = Number.isFinite(nearMidi)
        && Math.abs(nearMidi - (exp.midi + pitchShift())) <= 1;
      // ⚠ 轻音兜底不能只看"锚在期望音上"的读数（2026-09-23，用户实测）：
      //   1 弦最轻，电平常在 0.06 以下 → 一直走这条 → **弹什么音都算过**（他连续弹 1弦1品，全过；
      //   别的弦响一些、不走这条，反而会被判错——这正是他看到的"1弦1品最畅通"）。
      //   所以再加一条：**候选重排必须认为这一下像谱面那个音**（本音失配 < fitMax 250）。
      //   真·轻音（弹的就是谱面那个音）本音失配很小，照样过；弹的是别的音则失配很大，判错。
      // ⚠ 按"我们知道谱子"来分场景（用户口径，2026-09-23）：
      //   · **谱面这一格是 1 弦** → 放宽：不要求候选也同意（1 弦基频弱、读数本来就不稳，先让它进来）；
      //   · 别的格子 → 收紧：轻音兜底也要候选认为它像谱面那个音（挡住"拿一个错音到处蒙"）。
      //   技巧格（exp.tech）本来就走它自己那条路（一次起音 + 按 BPM 等第二个音），这里不掺和。
      const expIsStr1 = !!(exp && exp.string === 1);          // 谱面这一格是不是 1 弦
      // ── 起音台阶（2026-09-23，用户设计）──────────────────────────────────────
      // 「只知道谱面、也知道起音时刻」→ 只问一件事：**谱面这个音的基频位置上，
      //   起音前后各 5ms 有没有一个台阶**（后 5ms ÷ 前 5ms）。
      //   · 上一根的余响：在这个尺度上是连续下降 → 比值 ≈1（甚至 <1）；
      //   · 新拨的一下：几毫秒内从无到有 → 比值远大于 1；
      //   · 4Hz 打拍子 / 手机自动增益：周期 250ms，5ms 内涨不了多少 → 比值接近 1；
      //   · 敲桌子/说话：不在"谱面这个音的基频"上 → 也是接近 1。
      // 1 弦（细、轻、基频弱）单独放宽；技巧格不走这条（它按 BPM 等第二个音）。
      let stepRatio = null;
      try {
        const srNow = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
        const back = Math.round(((now - onsetAtMs) / 1000) * srNow);   // 起音点在这之前多久
        const N5 = Math.max(96, Math.round(0.005 * srNow));            // 5ms
        if (back > N5 * 2 && back + 8 < buf.length) {
          const expHzS = 440 * Math.pow(2, (exp.midi + pitchShift() - 69) / 12);
          const bandE = (from) => {
            const seg = buf.slice(Math.max(0, from), Math.max(0, from) + N5);
            if (seg.length < 8) return 0;
            const m = spectrumOf(seg);
            const binHz = srNow / seg.length;
            const lo = Math.max(1, Math.floor((expHzS * 0.966) / binHz));
            const hi = Math.min(m.length - 1, Math.ceil((expHzS * 1.035) / binHz));
            let e = 0; for (let i = lo; i <= hi; i++) e += m[i] * m[i];
            return e;
          };
          const ePre = bandE(buf.length - back - N5);
          const ePost = bandE(buf.length - back);
          stepRatio = ePost / (ePre + 1e-12);
        }
      } catch (e) { stepRatio = null; }
      // 技巧格**整对**都豁免：tech 标记只打在第二个音上，但**拨的那一下（第一个音）也属于技巧格**，
      // 不能拿"起音台阶"去卡它（技巧是"一次起音 + 按 BPM 等第二个音"的特例路径）。
      const ntNext = notes[best + 1] || null, ntPrev = notes[best - 1] || null;
      const inTechPair = !!(exp.tech || (ntNext && ntNext.tech) || (ntPrev && ntPrev.tech));
      // ── "检测到什么就是什么"的读数（2026-09-23）：不看答案 ──────────────────
      // 起音前后各 20ms 相减（旧弦的余响被抵掉），在这份"只属于这一下"的谱上取
      // **最低的那条成串线**（f、2f、3f 都立着）当读数。然后按用户口径：
      //   和谱面那个音的音分差 **不在 ±80 内就是错**（1 弦格放宽到 ±100；技巧整对豁免）。
      // ⚠ 这里**不能**用 centsFixed ——它锚在期望音上、窗口只有 ±80，永远报"擦边"，
      //   那条规则等于没生效（用户实测：弹 1弦3品 仍把 C 和弦全过）。
      let detCents = null;
      let detHz = null;
      try {
        const srNow4 = (audio.getCtx() && audio.getCtx().sampleRate) || 48000;
        const back4 = Math.round(((now - onsetAtMs) / 1000) * srNow4);
        // ⚠ 窗长**不能**用期望音的频率去定（那就等于把"期望音那把尺子"带回来了，
        //   用户当场指出）。这里用**固定 40ms**：最粗的 6 弦空弦 E2(82Hz) 也有 3.3 个周期，
        //   而 40ms 相对一个音的时值仍然很短（不会拖进下一个音）。
        const W4 = Math.round(0.040 * srNow4);
        // 零填充到 8192：bin 宽从 50Hz（20ms 窗）降到 5.9Hz —— 成串判断才立得住，
        // 否则 100Hz 那种"伪基频"总能凑出 200/300/400 的谐波（用户导出的 detHz=100 就是这么来的）。
        const padTo = (src) => {
          const out = new Float32Array(8192);
          out.set(src.subarray(0, Math.min(src.length, 8192)));
          return out;
        };
        if (back4 > W4 * 2 && back4 + W4 < buf.length) {
          const post4 = spectrumOf(padTo(buf.subarray(buf.length - back4, buf.length - back4 + W4)));
          const pre4 = spectrumOf(padTo(buf.subarray(buf.length - back4 - W4, buf.length - back4)));
          // 先用"相减谱"（只留抬头的那部分）找成串线；找不到时**退回用起音后那份谱**再找一次
          // （相减把新音的能量也削掉时，至少还能给一个读数）。
          let ser = f0SeriesFromDiff(post4, pre4, srNow4, 8192).hz || 0;
          if (!(ser > 0)) ser = f0SeriesFromDiff(post4, new Float32Array(post4.length), srNow4, 8192).hz || 0;
          if (!(ser > 0)) {
            // 最后再退一步：相减谱里若只剩"最低那条还算成串"的线也算（阈值放宽）
            ser = f0SeriesFromDiff(post4, pre4, srNow4, 8192, 70, 1200, 0.06).hz || 0;
          }
          if (ser > 0) {
            detHz = ser;
            const expHz4 = 440 * Math.pow(2, (exp.midi + pitchShift() - 69) / 12);
            detCents = 1200 * Math.log2(ser / expHz4);
          }
        }
      } catch (e) { detCents = null; }
      // 用户口径（2026-09-23 定版）：**80 太宽，收到 50**。
      //   读数 = 起音前后各 40ms 相减 + 零填充（不看答案）→ 和谱面那个音比音分；
      //   不在 ±50 内就是错，不管差 1 品、2 品还是 12 品。
      //   读数为空（这一下没取到成串线）时退回原来的判定链，不硬判。
      // 用户口径（2026-09-23 晚，定版）：**容忍度 80**（50 太紧，卡在边界的被误杀）。
      const detTol = expIsStr1 ? (CFG.detCentsStr1 || 80) : (CFG.detCents || 80);
      // ⚠ 2026-09-23 修"报错却还能过"：**取不到读数就不算过**。
      //   用户导出里那些 `detHz = -`（没取到成串线）的行，原来退回老链路 → 全判 ok，
      //   于是"1弦3品报了错，但照样一路过下去"。按用户口径（不是容忍度内就是错），
      //   没读数 = 没有"这就是谱面那个音"的证据 → 不算过（技巧整对仍豁免）。
      // ⚠ 2026-09-23 实测：**取不到读数就不算过**这条会把逐弦的正确演奏一起误杀
      //   （对 4/1 → 对 0/1）。所以改成：**有读数就按 ±80 判；没有读数退回原来的链路**。
      //   空读数用"起音后那份谱再找一次"的兜底来减少（见上面的读取块）。
      // ── 用户定版口径（2026-09-23 晚）：**音名一样就过，不一样就不过** ──────────────
      //   C4 vs C4 → 过；C4 vs C3（差八度）、C4 vs C#4（差半音）→ 都不过。
      //   判据 = 检测到的音（不看答案的读数 detHz 归到最近半音）与谱面那个音**同名同八度**。
      //   （不再用音分容忍度：80 太宽、50 太紧，直接按音名，一步到位。）
      const detMidi = (detHz && detHz > 0)
        ? Math.round(69 + 12 * Math.log2(detHz / 440)) : null;
      const detNameOk = (detMidi == null) ? null : (detMidi === (exp.midi + pitchShift()));
      // ⚠ 2026-09-24：**读数不再当硬闸门**（用户点头）。
      //   依据（都是真机数据）：
      //     · 用户 9-24 导出：43 个起音里 20 个有读数，其中 **19 个是 82~141Hz 的垃圾**；
      //       唯一那个对的（C4=264Hz）才是例外。1弦1品那 4 次判错，候选重排明明说 F4 对
      //       （本音失配 84~222、领先 1.10~2.08 倍），全是被 `detOk=false` 一票否决的。
      //     · 离线 79 个真机样本：现状读数（±40ms 相减 → 成串线）**只对 3 个**。
      //     · 根因：拨弦那一下最强的是**闷响**，不是音（1弦1品那次：低频 199Hz 幅度 158.6
      //       vs 真音 349Hz 只有 46.0，3.4 倍），100ms 内才衰减 —— 在起音瞬间读数必然锁到它。
      //   新口径（= 调研文档 §4 第 3 条）：**判对判错交回候选重排**（本音 vs ±1/±2 品，
      //   gt-notes 两向 39/39）；读数只用于**显示**，而且不可信时不许显示音名（见 heard 那行）。
      //   读数要再接回判定，得先换成"稳定段(+50~+220ms) + 按弦分带"那把尺子（离线在单弦集上
      //   39/39、16/16，但在旋律上只有 7/24，还不够），且它需要起音后 250ms 的音频 ——
      //   判定发生在 +90ms，取不到，得单独延后取（下一步）。
      const detOk = true;
      // 2026-09-23 小步降一档：1.5 → **1.2**。依据：用户导出里一批"音分 ±1~12、几乎完美"
      // 的音被判错（电平 0.056~0.156），它们全落在"轻音要台阶"这一档里，说明 1.5 太严
      // （上一根还在响时，前 5ms 窗里已有能量、台阶被压平）。错音那一侧（弹别的音时，
      // 期望音基频位置的前后比 ≈1.0）在 1.2 这一档仍然过不去。
      const stepNeed = expIsStr1 ? (CFG.onsetStepMinStr1 || 1.1) : (CFG.onsetStepMin || 1.2);
      // ⚠ 台阶判据**只在轻音上用**（2026-09-23，用户导出抓到的误杀）：
      //   导出里 #5/#7/#8 是"期望=听到、电平 0.31~0.34、clarity 0.98"却被判错 ——
      //   原因就是上一根还在响时，前 5ms 窗里已有能量、台阶被压平 → 又响又准的音过不了。
      //   而"拿一个错音到处蒙"那种 false accept 全都发生在轻音档（电平 0.05~0.1）。
      //   所以：**只在轻音时才要求台阶**，响的音不用（它本来就不可能是环境杂音）。
      const stepNeeded = lv < (CFG.onsetStepQuietMax || 0.12);
      const stepOk = !stepNeeded || (stepRatio == null) || inTechPair || (stepRatio >= stepNeed);
      const quietOk = quiet && Math.abs(estP.cents) <= 45
        && (expIsStr1 || !!(candMatch && candMatch.self && candMatch.self.mismatch < JUDGE.fitMax));
      // ── 一弦放宽（2026-09-23，按用户 arp 那份导出定的）──────────────────────
      // 那份导出里唯一的错音是 1弦3品 G4：电平 0.185、clarity 0.925、
      // **锚定读数 -1.7 音分** —— 量得完全正确，却被候选重排判成错。
      // ⚠ 2026-09-23：这里给 1 弦加过"锚定读数在 ±45 音分内就放行"（只要求 nHarm ≥ 3），
      //    已撤 —— 敲桌子是宽频，锚定尺子照样在期望音附近凑出"谐波"，敲一下判对一次。
      // ── 技巧音（击弦 / 勾弦 / 滑音）单独一把尺子：**扣掉上一个音的偏差再比** ────
      // 两个音在同一根弦上，琴整体偏高/偏低、左手滑音差一点点，会一起平移。
      // 真机实测（用户琴整体高 ~50 音分、滑音落点又差 12 音分）：
      //   · 按绝对音高比 → 读成隔壁半音 D#4 → 判错（用户看到的"滑音不算过"）；
      //   · 扣掉上一个音的 +54 音分后只差 12 音分 → 判对。
      // 期望频率 = 上一个音（同一根弦、就在前一个音）实测频率 × 音程。
      // 容忍度 = 45 + CFG.techExtraCents（技巧额外 40 → 85 音分）：
      // 真机实测滑音落点常常差半个半音以内；而"弹成隔壁半音"是 100 音分，仍然判错。
      const techTol = 45 + (CFG.techExtraCents || 0);
      const prevTech = best > 0 ? notes[best - 1] : null;
      const techExpectedHz = (exp.tech && techRefHz > 0 && prevTech)
        ? techRefHz * Math.pow(2, (exp.midi - prevTech.midi) / 12) : 0;
      const techCentsOff = techExpectedHz > 0 && estP && estP.f0
        ? 1200 * Math.log2(estP.f0 / techExpectedHz) : null;
      const techOk = !!(techCentsOff != null && Math.abs(techCentsOff) <= techTol);
      // ⚠ 2026-09-23 在这里试过两条更严的写法（"候选认出来的音 != 谱面 → 判错"，
      //    以及只让它约束轻音/1弦两条放宽通道），**都被实测否掉**：
      //    击弦那一段把弹对的音判错（对 3/错 0 → 对 2/错 1）。
      //    原因：候选重排在轻音和 1 弦上本来就摇摆（heard 会在期望音和邻居之间跳）。
      //    "故意弹错却算对"要在**测量层**解决（不看答案的差分测量），不是在这儿加闸门。
      // ⚠ 2026-09-23 把"按音分判（80/100）"接到这条路上的那次**失败记录**，别再走：
      //   差分谱万一没有可靠峰（score/nHarm 判不住、或拿到的是退化谱），
      //   estimateF0Near 照样会吐一个接近 0 的音分数 → `|cents| <= 80` 恒成立 →
      //   **任何音都判对**（用户实测：1弦1品连弹到底全过；换任何错弦也一路过）。
      //   所以音分那条口径要落地，**前提是先把"不看答案的测量"做成可靠的**
      //   （要有可信度判据，拿不到可靠峰时必须报"测不准"，而不是报 0 音分）。
      // ⚠ 2026-09-23 这里试过"用抬头加权快照量期望音谐波高度"当闸门 —— **实测两种情形都是 0.00**
      //   （弹错 F4 是 0.00，弹对 A3 也是 0.00：因为余响比新拨那一下还响，快照把台阶一起抹平了），
      //   会把**弹对的音也判错**。已删。验证脚本：vc_gf/spectrum-ab.mjs（结果见调研文档）。
      // ⚠ 2026-09-23：按用户要求，把"起音台阶"从**判定**里拿掉（它对真音的误杀太明显：
      //   同一批"音分只有 ±1~12"的音被判错，电平 0.056~0.156，全落在它管的范围内）。
      //   ⚠ 测量照旧算、照旧写进导出（step / stepUsed / stepOk），**只是不再参与对错**。
      // ⚠ 2026-09-24 试过**基频抬头守卫**（"这一下谱面音的基频位置有没有抬头"），
      //   在带真值的 24 音旋律集上：对 14 → **对 10**（误杀 4 个弹对的），错音测试只从 5 降到 4。
      //   → **没上线**。原因：rise 是 43ms / 23.4Hz 的逐频点比，对 1 弦那种细而轻的基频不稳，
      //   拿它当硬闸门就会一刀切。方向没错，但证据得换（见下面"带内新能量占比"那条）。
      const pass = ((JUDGE_CAND && candMatch
        // ⚠ **听到的音必须就是谱面那个音（2026-09-23 用户定，第二次强调）**：
        //   界面上"听到 X"和"期待 Y"不一致（X≠Y）却判过，是最不能接受的 ——
        //   两个读数自己都摆出来了，还说对，用户只会觉得"根本没在听"。
        //   所以放行通道（候选重排 / 轻音兜底）统统加上这道前置：
        //   **不看答案的独立读数（低频带最强线 midiP）必须指向谱面这个音**（容差 1 个半音）。
        //   技巧音（击弦/勾弦/滑音）不套：它按音程比上一个音，绝对音高校验会误杀（实测）。
        // ⚠ 2026-09-23 撤掉这里的"听到必须=谱面音"闸门：它用的那个读数
        //   （低频带最强线 dominantF0InBand）**自带"八度纠正：取低的那一个"**，
        //   实测经常把 C4 读成 C3、F4 读成 F3 —— 拿它当闸门，真音会被判错、漏音变多
        //   （用户报"漏得很多"）。判定仍然由候选重排那条路负责（它自己有领先 3% 的要求）。
        ? (passCand || quietOk)
        // ⚠ 兜底那条（不用候选重排时）原来只看"锚在期望音上"的音分 —— 那条会自证！
        //   37 分那两份导出里 12 行"听到 ≠ 期待却判 ok"（期待 A3 听到 A2 也判过）就是它。
        //   现在同样要求**不看答案的独立读数指向谱面这个音**（技巧音豁免）。
        : (reliable && Math.abs(centsFixed) <= 75))
        // ±80 音分（用户口径：不在 80 内就是错）——技巧整对豁免（它按音程比上一个音，
        // 绝对音分本来就会偏，实测勾弦会被这条误杀：对2 → 对0）。
        // ⚠ 2026-09-23：这条"不看答案的 ±80"先**不参与判定**（用户口径：回到刚才那版判定，
        //   新测量只当字段记进导出）。原因：20ms 窗对低音太短，直接上会让合成/低音被误杀。
        //   读数照算、照写进导出（detCents / serHz），等窗长按频率改好再决定是否启用。
        || techOk) && detOk
        // ── §6 第 5 条：**读数与谱面不同名（差 ≥2 个半音）→ 判错** ──────────────
        // 差 1 个半音不动：读数自己有 ±1 个半音的抖动（两个窗一致也只保证到这一档），
        // 所以"差一品"仍然交给候选重排（它在 gt-notes 的两向验收里是 39/39）。
        // 技巧格（击弦/勾弦/滑音）整对豁免：它按"和上一个音的**音程**"比，
        // 绝对音高那条本来就对不准（实测会把弹对的勾弦判错）。
        && !(readVeto && !inTechPair);
      // ── 同一格的多音（双音/三音）：各自判一次（2026-09-23，用户口径）────────────
      // 这一格同时发声的 2~3 个音**共用同一次起音的频谱窗**，对每个期望音各跑一次判定
      // （和单音同一把尺子）；**全过才算这一格过**，哪个没过就报出来；
      // 判错 → 停在原地标红等重弹；判过 → 一次前进过这一整格。
      const slotLast = slotEndIdx(best);
      const slotSize = slotLast - best;
      let slotBad = null;
      if (slotSize > 1) {
        // ⚠ 多音格**不能**用单音那把尺子逐个判（2026-09-23，用户报"三音过不去、期待只有一个音"）：
        //   单音判定会把"别人的谐波"当成"解释不了的峰"扣分 → 三音同时响时每个音单独判都失分。
        //   改成**成组判**，两件事同时成立才算过：
        //     ① 解释率：这一格的音能解释掉多少能量（chordOutsiders，和"和弦练习"同一把尺子）；
        //     ② 逐个存在性：这一格里每个期望音，各自那串谐波要立得住（harmonicity ≥ 2.0）。
        //   缺哪个就报哪个；有解释不了的多余强峰（①不达标）就报"这一格多了音/有杂音"。
        const groupMidis = notes.slice(best, slotLast).map((n) => n.midi + pitchShift());
        let ratio = 0;
        try { ratio = chordOutsiders(novel, sr2, a.fftN, groupMidis).ratio; } catch (e) { ratio = 0; }
        let weakest = null, weakestHnr = Infinity;
        for (let k = best; k < slotLast; k++) {
          const hz = 440 * Math.pow(2, (notes[k].midi + pitchShift() - 69) / 12);
          let h = 0;
          try { h = harmonicity(spec, peakRate, PEAK_N, hz); } catch (e) { h = 0; }
          if (h < weakestHnr) { weakestHnr = h; weakest = notes[k]; }
        }
        const ratioOk = ratio >= 0.7;              // 和"和弦练习"同一个门限
        const presentOk = weakestHnr >= 2.0;       // 每个音自己那串谐波要立着
        if (!presentOk) slotBad = weakest;
        else if (!ratioOk) {
          slotBad = { midi: exp.midi, string: exp.string, fret: exp.fret, extra: true };
        }
      }
      const passSlot = pass && !slotBad;
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
        const wide = estimateF0ByPeaks(spec, specRate, specN, exp.midi + pitchShift(), { tolCents: 140 });
        if (wide.score > 0 && wide.nHarm >= 2) {
          const wC = wide.cents - tuning;
          if (Math.abs(wC) <= 250) { seenMidi = Math.round(69 + 12 * Math.log2(wide.f0 / 440) - tuning / 100); seenCents = wC; }
        }
      }
      // §6 的读数说"这一下不是谱面那个音"时，报错就按**它**说 —— 显示必须和判定同一个结论
      // （它量的是"起音这一下新加进来的那条线"，不是锚在谱面音上找出来的读数）。
      if (readConf && readVeto && readHz > 0) {
        seenMidi = readMidi;
        seenCents = 1200 * Math.log2(readHz / (440 * Math.pow(2, (exp.midi + pitchShift() - 69) / 12)));
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
      // ── 轻音兜底（2026-09-23 修正）──────────────────────────────────────────
      // 原来：电平 < 0.06 且"锚在期望音上"的读数在 ±45 音分内 → 直接放行。
      // ⚠ 那把锚定读数天然自证（它在期望音附近找峰，弹错也能找到东西），
      //   所以**1 弦一弹就过**（1 弦最细最轻，电平天生落在 0.05~0.09，正踩这条通道），
      //   用户实测"只要弹 1 弦就能一直往下走"，就是这条造成的。
      // 现在加一条**不看答案的校验**：独立读数（低频带最强线 midiP，不锚期望音）
      // 必须也指向谱面这个音，否则这条通道不成立。
      // 容差先给 1 个半音（独立读数本身也会抖）；要更严就改成 0 —— 见铁律的"一次只动一档"。
      // （heardIsExpected / quietOk 已经在上面定义好了，这里不再重复声明 ——
      //   同一作用域里重复 const 会直接语法错。）
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
        // §6「起音即读数」：两个锚定窗各读到什么、采信了没有、和谱面差几个半音
        readHz: readHz ? Math.round(readHz) : null,
        readHz2: readHz2 ? Math.round(readHz2) : null,
        readMidi: readConf ? readMidi : null,
        readSemis: readConf ? readSemis : null,
        readVeto: !!readVeto,
        // 候选重排这一路的证据：挑出来的音、本音失配、本音相对最强对手的领先倍数
        cand: candBest ? midiToNameOf(candBest.midi) : null,
        // 低八度守卫的证据：期望音判过时，若"低一个八度"明显更像，会被判错并记在这里
        candTopFit: candBest && candBest.mismatch != null ? Number(candBest.mismatch.toFixed(0)) : null,
        octaveBelow: candMatch && candMatch.octaveBelow ? midiToNameOf(candMatch.octaveBelow.midi) : null,
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
          // ── 判定证据（2026-09-23 加）──────────────────────────────────────────
          // 用户报"听到的和期待的一致却判错"，但导出里看不到是**哪条判据**否决的。
          // 这几个字段就是全部线索：候选重排的失配/领先倍数、轻音兜底、起音台阶、是否 1 弦格。
          // 下一次导出直接看这些，不用再猜。
          candFit: candSelf ? Number(candSelf.mismatch.toFixed(0)) : null,
          candMargin: (candSelf && candRival && candRival.score > 0)
            ? Number((candSelf.score / candRival.score).toFixed(3)) : null,
          passCand: !!passCand, quietOk: !!quietOk, str1: !!expIsStr1,
          step: stepRatio == null ? null : Number(stepRatio.toFixed(2)),
          stepUsed: !!stepNeeded, stepOk: !!stepOk,
          // 不看答案的读数（2026-09-23 新增字段）：起音前后各 20ms 相减 → 最低成串线
          // 当读数，再算它离谱面那个音多少音分。**只记录、不参与判定**，
          // 用来回答"到底检测成了什么音、差多少音分"。
          detCents: detCents == null ? null : Number(detCents.toFixed(1)),
          detHz: detHz == null ? null : Math.round(detHz),
          // §6 的读数（两个锚定窗 + 采信结论）——排查"为什么这一下判错"靠这几列
          readHz: readHz ? Math.round(readHz) : null,
          readHz2: readHz2 ? Math.round(readHz2) : null,
          readMidi: readConf ? readMidi : null,
          readSemis: readConf ? readSemis : null,
          readVeto: !!readVeto,
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
      // ⚠ 显示必须**和判定用同一个结论**（2026-09-23，用户报"每个音都显示正确、
      //   下面那行文字却一直显示没匹配上"）：原来"候选说就是谱面这个音"时，
      //   这里显示的是**另一把读数**（低频带最强线 midiP）—— 那把读数经常差半音，
      //   于是文字说"听到 X"、判定说"对"，看起来自相矛盾。
      //   现在：候选认定是谱面这个音时，就直接显示谱面这个音（加音分偏差）；
      //   候选认定是别的音（offset≠0）时，显示候选认出来的那个音 —— 判定怎么判的，屏幕就怎么说。
      // 显示也用**检测到的那个音名**（用户口径：音名一样就过）——这样"显示什么就按什么判"，
      // 不会再出现"显示同一个音名却不给过"的自相矛盾。
      // ⚠ 2026-09-24：**读数不可信就不显示它**。原来"读数非空就显示"，于是出现
      //   "听到 F2（谱面要 F4）"这种 —— 那个 F2 是拨弦的低频闷响，不是音；
      //   用户看到的就是"音准听错了"，而且紧接着就被判错。
      //   现在只有"读数 == 谱面这个音"时才拿它当显示依据（那时它至少不会骗人）；
      //   不一致就按**候选重排的结论**说 —— 显示和判定保持同一个结论。
      const detTrusted = (detMidi != null) && (detMidi === (exp.midi + pitchShift()));
      $('heard').textContent = detTrusted
        ? `${midiToNameOf(detMidi)}（和谱面一致）`
        : ((candBest && candBest.offset !== 0)
          ? `${midiToNameOf(candBest.midi)}（谱面要 ${midiToNameOf(exp.midi)}）`
          : `${midiToNameOf(exp.midi + pitchShift())} ${centsP > 0 ? '+' : ''}${Math.round(centsP)}音分`);
      // 同一个音只记第一次错（用户口径）：停了重弹的那几次不再累加错误数，
      // 否则一声咳嗽 / 一次听不准就能把错误数刷到十几。
      const firstWrong = !passSlot && !unclear && !wrongNoted.has(best);
      // 跟节拍的总时间账：第一个被认到的音 → 最后一个判完的音
      if (firstJudgeMs == null) firstJudgeMs = onsetAtMs;
      lastJudgeMs = onsetAtMs;
      if (passSlot) good++;
      else if (firstWrong) { bad++; wrongNoted.add(best); }
      markNote(best, passSlot ? 'ok' : (unclear ? 'unclear' : 'bad'));   // 谱面上标对错
      setVerdict(passSlot
        ? (slotSize > 1
          ? `✓ ${notes.slice(best, slotLast).map((n) => midiToNameOf(n.midi)).join(' + ')}（${slotSize} 个音都对）`
          : `✓ ${midiToNameOf(exp.midi)}${timKind ? `（${timKind === 'early' ? '抢拍' : '拖拍'} ${timStr}）` : (timStr ? `（${timStr}）` : '')}`)
        : (unclear
          ? `? 这一处没听清（量到 ${midiToNameOf(midiP)}${timStr ? `，${timStr}` : ''}），继续`
          // "约"不是客气：认音名用的是宽搜索的尺子，判"不是谱面这个音"很稳，
          // 但具体是哪个邻居、偏高还是偏低会被上一个音和重叠谐波带偏（合成用例里
          // 真弹 D#4 会被认成 C#4 附近）—— 所以说"约"，不把话说死。
          : (seenSame
            ? `✗ 谱面要 ${midiToNameOf(exp.midi)}，这一处偏得比较多（${Math.round(seenCents)} 音分${timStr ? `，${timStr}` : ''}）—— 停在这里，重弹这一个`
            : (slotBad
              ? (slotBad.extra
                // 解释率不够：这一格里有它解释不了的能量（多弹了别的音 / 有杂音）
                ? `✗ 这一格要 ${notes.slice(best, slotLast).map((n) => midiToNameOf(n.midi)).join(' + ')}，但里面混进了多余的声音 —— 停在这里，重弹这一格`
              // 双音/三音：说清是哪一个音没听到（这一格要 X+Y+Z）
                : `✗ 这一格要 ${notes.slice(best, slotLast).map((n) => midiToNameOf(n.midi)).join(' + ')}，**${midiToNameOf(slotBad.midi)}（${slotBad.string}弦${slotBad.fret}品）没听到** —— 停在这里，重弹这一格`)
              : `✗ 谱面要 ${midiToNameOf(exp.midi)}，你弹的是 约${midiToNameOf(seenMidi)}${timStr ? `（${timStr}）` : ''} —— 停在这里，重弹这一个`))),
        passSlot ? 'ok' : (unclear ? '' : 'bad'));
      // 错音标记：先记账再往下走 —— advanceNote() 会在最后一个音上收尾并出总结，
      // 记账排在它后面的话，最后一个音的错误就进不了总结里的"要改的地方"。
      if (!passSlot && !unclear) {
        if (firstWrong) wrongList.push(slotBad
          ? `第${(exp.measure || 0) + 1}小节 这一格少/错了 ${midiToNameOf(slotBad.midi)}`
          : seenSame
          ? `第${(exp.measure || 0) + 1}小节 ${midiToNameOf(exp.midi)} 偏得比较多`
          : `第${(exp.measure || 0) + 1}小节 弹成约${midiToNameOf(seenMidi)}（要${midiToNameOf(exp.midi)}）`);
        $('wrongs').textContent = '弹错：' + wrongList.join('、');
      }
      const judgedNo = best + 1;
      // 实时诊断：这一个音是怎么判的（wait 只看音，tempo 连时间窗和偏差一起给）
      {
        const heardName = candBest ? midiToNameOf(candBest.midi) : midiToNameOf(midiP);
        if (modeKind === 'tempo') {
          const w = tempo().tol(best);
          diag(`#${judgedNo} ${midiToNameOf(exp.midi)}(${exp.string}弦${exp.fret}品)`
            + ` 窗口 ${((tempo().at(best) - w) / 1000).toFixed(2)}~${((tempo().at(best) + w) / 1000).toFixed(2)}s`
            + ` 起音 ${((onsetAtMs - micStartedAt) / 1000).toFixed(2)}s`
            + (devMs == null ? '' : `(${devMs >= 0 ? '+' : ''}${Math.round(devMs)}ms)`)
            + ` 听到 ${heardName} → ${pass ? '对' : '错'}`);
        } else {
          diag(`#${judgedNo} ${midiToNameOf(exp.midi)}(${exp.string}弦${exp.fret}品)`
            + ` 听到 ${heardName} ${centsP > 0 ? '+' : ''}${Math.round(centsP)}音分 → ${pass ? '对' : '错'}`);
        }
      }
      // ── 弹错停下重弹（2026-09-23，用户口径："弹错停下重弹是对的"）──────────
      // 判过才往下走；判错**停在原地**，等他重弹这一个 —— 光标不再往前预览。
      // 这样环境里的杂音（旁边的说话、咳嗽）最多让你重弹一次，
      // 不会把后面整条对号顶错位（"弹快一点就跟不上"的根也在这儿）。
      // 判过 → 一次前进过**整格**（双音/三音一次拨弦就过这一格）；判错停在原地
      if (passSlot) { for (let k = 0; k < slotSize; k++) advanceNote(); }
      else highlightCurrent();
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
  // 跟节拍的总时间账（2026-09-23，用户口径）：**第一个音到最后一个音**的用时，
  // 和谱面应有的时长比，容忍 ±10s。停了/拖了会累加在这上面。
  let totalLine = '';
  if (modeKind === 'tempo' && firstJudgeMs != null && lastJudgeMs != null && notes && notes.length > 1) {
    const userSec = (lastJudgeMs - firstJudgeMs) / 1000;
    const scoreSec = notes[notes.length - 1].t - notes[0].t;
    const diff = userSec - scoreSec;
    // ⚠ 2026-09-24（用户报"全弹快没有提示"）：总时间账从"±10 秒"改成**比例**。
    //   为什么：原来 ±10s 是绝对值 —— 30 秒的段落你整体快 20%（−6s）照样"过关"，
    //   于是"全弹快"什么都不会报。改成按**比例**判：|差| ≤ 谱面时长的 15% 才算过。
    const tolSec = Math.max(CFG.tempoTotalTolSec || 0, scoreSec * (CFG.tempoTotalTolPct || 0.15));
    const pct = scoreSec > 0 ? (diff / scoreSec) * 100 : 0;
    totalLine = `　总时间：你用了 ${userSec.toFixed(1)}s ／ 谱面 ${scoreSec.toFixed(1)}s`
      + `（整体${diff >= 0 ? '慢' : '快'} ${Math.abs(pct).toFixed(0)}%）`
      + `，差 ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}s（容忍 ±${tolSec.toFixed(1)}s = 谱面的 15%）`
      + `${Math.abs(diff) <= tolSec ? ' → 时间这关过了' : ' → 时间这关没过（整体太快或太慢）'}`;
  }
  setVerdict(head + todo + timLine + totalLine, ok ? 'ok' : 'bad');
  $('next').innerHTML = '想再练一遍？直接再点一次「跟弹」（或点谱面上任意一个音从那开始）。';
}

// 这一格到哪（不含）：**同一时刻发声的音算一格**（双音/三音），容差 2ms。
// 时间轴里同一槽位的音 t 是同一个数（gp_timeline.py 算出来的），所以直接按 t 比。
function slotEndIdx(i) {
  if (!notes || !notes[i]) return i + 1;
  const t0 = notes[i].t;
  let k = i + 1;
  while (k < notes.length && Math.abs(notes[k].t - t0) <= 0.002) k++;
  return k;
}

function advanceNote() {
  // 按谱面间距设"下一次至少隔多久才算新的拨弦"：
  // 快音段（间距 150ms）约 80ms 后可再触发，慢音段最多等到 160ms。
  const prevNote = notes && notes[noteIdx];
  const nextN = notes && notes[noteIdx + 1];
  const gapMs = (nextN && prevNote) ? Math.max(0, (nextN.t - prevNote.t) * 1000) : 200;
  // 连续相同音时把间隔再压缩（否则第二下会被当成余响忽略掉）
  const same = !!(nextN && prevNote && nextN.midi === prevNote.midi);
  // ⚠ 这一条也回退了：2026-09-22 晚试过"从拨弦那一刻算"（想缩聋期，帮快音），
  // 用户实测"有些音弹对判错、偶尔还漏"——从判定那一刻算（下面这行）保守但准。
  // ⚠ 2026-09-23 治"快弹漏音"：用户导出里 nearMiss 的主因是**"冷却中"**（67/120 条）——
  //   判定完一个音之后的静默期太长，把后面的真起音挡在门外。
  //   按**谱面间距**分档：快段落（间隔 ≤250ms）冷却上限收到 85ms（原来 160ms），
  //   慢段落维持原样（间隔大本来就不会被挡）。
  const fastRun = gapMs <= 250;
  refractoryUntilMs = performance.now()
    + (fastRun
      ? Math.min(85, Math.max(same ? 45 : 60, gapMs * 0.30))
      : Math.min(160, Math.max(same ? 55 : 70, gapMs * (same ? 0.35 : 0.55))));
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
  // ── 技巧：下一个音如果带 tech 标记，就在谱面该响的时刻自动判定它 ────────────
  // 只有一个起音（拨/击/滑的那一下），第二个音靠音高确认 —— 不再要求第二次起音。
  techDueMs = 0;
  if (nx && nx.tech) {
    // 采样时刻：按谱面间距，但每个技巧有"至少等这么久"的下限 ——
    // 真机实测落地时间：击弦/勾弦约 170ms、滑音约 270~350ms（滑音是连续爬音，
    // 采样太早会量到"滑到一半"的音，判成错音）。
    const techMin = nx.tech === 'slide' ? 520 : 250;
    const dtMs = Math.max(0, (nx.t - (notes[noteIdx - 1] || nx).t) * 1000);
    const at = onsetAtMs + Math.max(techMin, Math.min(700, dtMs));
    techDueMs = Math.max(performance.now() + 40, at);
    techRefHz = (typeof lastJudgeHz === 'number' && lastJudgeHz > 40) ? lastJudgeHz : 0;
    $('next').innerHTML = `下一个：<b>${midiToNameOf(nx.midi)}</b>（${nx.string}弦 ${nx.fret}品）`
      + `　<span style="color:#7fd">技巧音：${({ hammer: '击弦', pull: '勾弦', slide: '滑音' })[nx.tech] || nx.tech}，不用再拨</span>`;
  } else if (nx) {
    $('next').innerHTML = `下一个：<b>${midiToNameOf(nx.midi)}</b>（${nx.string}弦 ${nx.fret}品）`;
  }
}

async function startMic() {
  try { await audio.acquire(); } catch (e) {
    setVerdict('开不了麦克风：' + (e.message || e.name) + '（手机必须 https）'); return;
  }
  resetAnalysis();
  frames = 0; floor = 0.001; levelHist = []; lastOnsetMs = -1e9;
  techDueMs = 0;                  // 上一轮残留的技巧时刻不能带进这一遍
  good = 0; bad = 0; rise = null;
  // 变调夹 / BPM 在开弹这一刻读一次（设置面板里改了立刻生效）
  capo = Math.max(0, Math.min(6, Number($('capo') && $('capo').value) || 0));
  tuneDown = !!($('tuneDown') && $('tuneDown').checked);
  userBpm = Number($('speed') && $('speed').value) || userBpm || 76;
  // 从哪里开始：
  //   · 默认**永远从第一个音开始** —— 不然中途停过一遍，noteIdx 残留，
  //     下一遍就从中间接着来（用户实测"点跟弹还是从第二小节开始、第一个音根本没在待测里"）；
  //   · 只有**这一遍之前点过谱面上某个音**，才从那儿开始练那一段。
  //     这条以前是坏的：点哪个音都对不上，因为"光标那份谱面格子"和"判定那份清单"
  //     错开了一位（117 vs 118）。现在两边是同一份清单（buildTickMap → mapSequenceToSlots，
  //     点第几格就是第几个音），而且跟弹进行中点谱面**不会再偷偷改起点**（见 beatMouseDown）。
  wrongList = []; wrongNoted = new Set();
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
  // 真实谱面（登记表里的：Hey Jude / 茉莉花 …）+ 两个测试页都要装时间轴
  if (scoreOf(songKind) || songKind === 'arp' || songKind === 'tech') await loadNotes();
  // 跟节拍：每次开始都清空状态（每个音先记成"待判"）
  tempo().reset();
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
  // 节拍器 = 独立开关（2026-09-23）：跟节拍模式下也由它自己出声，
  // 只当参考、不参与判定（判定已经改成音驱动 + 总时间对账）。
  if ($('metro') && $('metro').checked) startMetronome();
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
  // ── 近似帧日志（2026-09-23 加，治"快弹漏音"）─────────────────────────────────
  // 用户说"确定是检测没起来"。这一份把**没被认成起音、但电平已经过了门限**的那些帧记下来，
  // 带上它被哪条判据否决（why）和当时的量（电平/涨速/形状/频带抬头）。
  // 快弹一段导出后，看这份就能直接指出"这一下卡在不够陡 / 没有新拨的迹象 / 形状没变"。
  nearMiss: nearMissLog,
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

// ── 启动完成标记（写在文件最后 = 所有按钮/处理器都挂好了）───────────────────
// index.html 里的自检条靠它判断："页面脚本起没起来"。
// 只改 import 一行、模块图断掉时，这里根本到不了 → 手机上会直接把原因显示出来。
globalThis.__gfBooted = true;
