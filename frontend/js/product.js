// 产品页入口 product.js（2026-09-28 由 follow-score.js 改名 —— 老页面那个 main.js 别再用了）。
//
// 这里只做**装配**：建状态（session/slog）、建各层（scoreView / chordPractice / arpCells /
// judge）、挂按钮事件、挂离线钩子、启动。跟弹判定循环整块在 ./app/judge-loop.js；
// 谱面视图在 ./app/score-view.js；音格子/倒计时/节拍器在 ./app/arp-cells.js。
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
const BUILD = '0928-1845';
const err = (m) => { $('err').textContent = m ? String(m) : ''; };
const isPhone = () => window.innerWidth < 700;

// 信号与判定（engine/*）不在这里 import —— 它们由 ./app/judge-loop.js 直接用。
import * as audio from './audio.js';
// 光标层：谱面格子 ↔ 判定清单 的对号（纯函数，单独一个文件）
import { collectScoreSlots, mapSequenceToSlots } from './app/cursor.js';
// 实时诊断面板（页面层的一块）：只负责把一行行文字显示到 #diag
import { initDiag } from './app/diag.js';
// 和弦练习（卡片 / 试听 / 四拍轮转）—— 2026-09-28 整块搬出去，行为不变
import { createChordPractice } from './app/chord-practice.js';
import { createSessionLog } from './app/session-log.js';
import { createSessionState } from './app/session-state.js';
import { createScoreView } from './app/score-view.js';
import { createArpCells } from './app/arp-cells.js';
// 判定循环（起音 + 判定 + 记账）—— 2026-09-28 整块搬进 ./app/judge-loop.js
import { createJudgeLoop } from './app/judge-loop.js';

// api / score（alphaTab 实例和解析出来的谱面）已搬进 ./app/score-view.js —— 见下面的 scoreView。
// songKind / userBpm / capo / tuneDown / pitchShift / rising / PASS_RATIO 已搬进
// ./app/judge-loop.js（它们是判定循环要读写的那份"演奏会话"状态）—— 见下面的 judge。
// ⚠ 页面里要用就走 judge.songKind / judge.bpm / judge.capo / judge.pitchShift() …
//   千万不要在页面里再存一份（存两份就会出现"页面显示的和判定用的不是同一个值"）。
// 和弦练习自己那 5 个状态（数据 / 当前和弦 / 起点 / 定时器 / 试听上下文）
// 已经搬进 ./app/chord-practice.js。`beat` 留在本文件 —— 它是和弦卡上的点
// 和 alphaTab 光标**共用**的第几拍，存两份就会出现"卡片第 2 拍、光标第 3 拍"。
let beat = 0;

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

// 会话记录：每个音的"期望 / 实测"，包含判定比值、周期性(clarity)、电平、时刻。
// 这是**唯一能用来调参的数据**：录一遍干净的（只弹对的）就等于拿到标准答案，
// 不用再靠"你猜我有没有弹对"。
const slog = createSessionLog();
const session = createSessionState();   // 会话状态：见 app/session-state.js
// ⚠ 上面这两行必须在 scoreView 之前：谱面视图要拿 session 记"用户点了哪一格当起点"。

// ── 谱面视图（alphaTab 渲染 + 光标）──────────────────────────────────────
// 2026-09-28：整块搬进 ./app/score-view.js（约 300 行，行为不变）。
// 这里只把页面侧的东西注入进去；api / score / 光标拍点表 / 对齐结论都归模块自己管。
const scoreView = createScoreView({
  $, err, setVerdict, BUILD, isPhone, session,
  midiToNameOf: (m) => midiToNameOf(m),      // 它在文件后面才声明，所以包一层、用到时再取
  getSongKind: () => judge.songKind,
  getScoreUrl: () => (scoreOf(judge.songKind) && scoreOf(judge.songKind).gp) || './data/hey_jude.gp3',
  getNotes: () => judge.notes,
  isMicRunning: () => judge.isRunning(),
  setUserBpm: (v) => { judge.bpm = v; },
  highlightCell: (idx) => arpCells.highlightCell(idx),
  // 点谱面定位之后，页面要做的那些事（模块只管"点了第几个音"）
  onBeatPicked: (idx) => {
    // 从新的地方开始练：**旧的谱面标记要清掉**。
    // （不然新一段和上一段的绿/红混在一起，看不出这次练到哪。）
    if ($('marks')) $('marks').innerHTML = '';
    session.resetWrongList();
    session.resetMissCounts();
    $('wrongs').textContent = '';
    $('good').textContent = '0'; $('bad').textContent = '0';
    if ($('unclear')) $('unclear').textContent = '0';
    if ($('missed')) $('missed').textContent = '0';
    setVerdict(`从第 ${idx + 1} 个音开始（${midiToNameOf((judge.notes && judge.notes[idx] && judge.notes[idx].midi) || 0)}）`);
    scoreView.highlightCurrent();
  },
});

// ── 和弦练习部分 ─────────────────────────────────────────────────────────────
// 2026-09-28：卡片 / 试听 / 四拍轮转整块搬进 ./app/chord-practice.js（行为不变）。
// 这里只把页面侧的东西注入进去；`beat` 用 get/set 传 —— 它和 alphaTab 光标共用。
const chordPractice = createChordPractice({
  $, audio, setVerdict,
  getBpm: () => judge.bpm,
  getBeat: () => beat,
  setBeat: (v) => { beat = v; },
});

// ── 顶部按钮 ─────────────────────────────────────────────────────────────────
$('song').onchange = async () => {
  // 切曲目时**先停掉跟弹**：不然麦克风循环还在跑，而判定清单已经换成新的那份
  // （notes 被清空、session.noteIdx 归零），两边对不上 —— 手机上表现为"切一下就卡住"。
  if (judge.isRunning()) judge.stop();
  judge.standby();
  judge.songKind = $('song').value;
  chordPractice.stop();
  if (scoreView.api && scoreView.api.playerState === 1) scoreView.api.playPause();
  // 换曲目 = 换一份判定清单：清掉上一份（含光标对照表）
  judge.clearNotes(); session.noteIdx = 0; scoreView.clearMap();
  if (judge.songKind === 'chords') {
    await chordPractice.load();
    $('scoreWrap').style.display = 'none';
    $('chords').style.display = 'block';
    $('track').style.display = 'none';
    $('title').textContent = '和弦练习 — C–Am–F–G';
    $('loop').style.display = 'none';
    judge.bpm = Number($('speed').value) || 76;
    chordPractice.render();
    setVerdict('和弦练习：点「试听」走一遍和弦（每和弦 4 拍），点「跟弹」开始判定。');
  } else if (judge.songKind === 'arp') {
    // 无谱面测试：不画五线谱，用音格子（T3231323 / C–Am–F–G）
    $('scoreWrap').style.display = 'none';
    $('chords').style.display = 'none';
    $('cells').style.display = 'block';
    $('track').style.display = 'none';
    $('loop').style.display = 'none';
    await judge.loadNotes();
    arpCells.render();
    $('title').textContent = `C–Am–F–G · T3231323（逐音测试）— v${BUILD}`;
    setVerdict('逐音测试：点「跟弹」，按格子里写的弦/品一个一个弹（蓝色格子 = 当前该弹的）。');
  } else if (judge.songKind === 'tech') {
    // 技巧练习：击弦 / 勾弦 / 滑音 —— 拨一下，第二个音靠左手（不用再拨）
    $('scoreWrap').style.display = 'none';
    $('chords').style.display = 'none';
    $('cells').style.display = 'block';
    $('track').style.display = 'none';
    $('loop').style.display = 'none';
    await judge.loadNotes();
    arpCells.render();
    $('title').textContent = `技巧练习 · 击弦/勾弦/滑音（逐音测试）— v${BUILD}`;
    setVerdict('技巧练习：每一对「拨一下 + 左手技巧」算两个音 —— 拨完不要停，让第二个音响出来。');
  } else {
    $('chords').style.display = 'none';
    $('cells').style.display = 'none';
    $('scoreWrap').style.display = 'block';
    $('track').style.display = '';
    $('loop').style.display = '';
    // ⚠ 切曲目必须**重建** alphaTab（2026-09-23 用户报"切到茉莉花还显示 Hey Jude"）：
    //   scoreView.init() 开头是 `if (api) return api;` —— api 建过一次就返回旧实例，
    //   谱面永远停在上一首。所以换谱之前先把旧的销毁、api/score 清空
    //   （销毁实例 + 清空谱面容器都在 scoreView.destroy() 里）。
    scoreView.destroy();
    const sc = scoreOf(judge.songKind);
    if (sc && $('title')) $('title').textContent = sc.title;
    scoreView.init();
  }
};

$('play').onclick = async () => {
  // 试听和跟弹互斥：正在跟弹时点试听，先把跟弹停掉（两个播放状态不能并存）
  if (judge.isRunning()) { judge.stop(); setVerdict('已停止跟弹 —— 试听和跟弹不能同时进行'); }
  if (judge.songKind === 'chords') {
    if (chordPractice.isRunning()) { chordPractice.stop(); setVerdict('已停止'); }
    else { await chordPractice.load(); chordPractice.start(true); }        // 和弦谱试听：4 拍一个和弦，带声音
    return;
  }
  scoreView.init();
  if (!scoreView.api) { err('alphaTab 没加载起来。'); return; }
  scoreView.api.playPause();          // 按钮文字由 playerStateChanged 更新
};

$('loop').onclick = () => {
  if (!scoreView.api) return;
  scoreView.api.isLooping = !scoreView.api.isLooping;
  $('loop').classList.toggle('on', scoreView.api.isLooping);
};

// 模式切换：等我弹 / 跟节拍（两条路的推进规则不同，见 micTick 里的说明）
$('mode').onchange = () => {
  judge.mode = $('mode').value;
  setVerdict(judge.mode === 'wait'
    ? '等我弹：谱面不动，你没弹它就一直等（延音期间也不会推进）'
    : '跟节拍：谱面按拍走，漏掉的音会被标成漏');
};

$('speed').onchange = () => {
  judge.bpm = Number($('speed').value) || 76;
  if (judge.songKind === 'heyjude' && scoreView.score) {
    scoreView.setSpeed(judge.bpm / (scoreView.score.tempo || 76));
  } else if (chordPractice.isRunning()) {                 // 和弦练习：换速度要重排拍子
    chordPractice.stop(); chordPractice.start();
  }
};
// 变调夹：改了就立刻生效（下一次判定就用新值）。夹多少品，期望音就升多少半音。
$('capo').onchange = () => {
  judge.setCapo(Math.max(0, Math.min(6, Number($('capo').value) || 0)));
  setVerdict(`变调夹 ${judge.capo} 品${judge.tuneDown ? ' + 降半音' : ''} —— 期望音整体平移 ${judge.pitchShift() > 0 ? '+' : ''}${judge.pitchShift()} 个半音（谱面记号不变）`);
};
$('tuneDown').onchange = () => {
  judge.setTuneDown(!!$('tuneDown').checked);
  setVerdict(`调弦：${judge.tuneDown ? '降半音（Eb）' : '标准'}${judge.capo ? ` + 变调夹 ${judge.capo} 品` : ''}`
    + ` —— 期望音整体平移 ${judge.pitchShift() > 0 ? '+' : ''}${judge.pitchShift()} 个半音（谱面记号不变）`);
};

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
// ── 音格子 + 倒计时 + 节拍器 ────────────────────────────────────────────────
// 2026-09-28：renderCells / highlightCell / countIn / metro 整块搬进 ./app/arp-cells.js
// （行为不变）。这里只做装配 —— 模块自己那件"节拍器实例"在它闭包里建。
const arpCells = createArpCells({
  $, audio, setVerdict, session,
  midiToNameOf: (m) => midiToNameOf(m),      // 它在文件后面才声明，用到时再取
  pitchShift: () => judge.pitchShift(),
  getNotes: () => judge.notes,
  getBpm: () => judge.bpm,
  isMicRunning: () => judge.isRunning(),
  highlightCurrent: () => scoreView.highlightCurrent(),
  // 点了某一格之后，页面要做的那些事（模块只管"点了第几格"）
  onCellPicked: (i) => {
    session.resetWrongList(); session.resetWrongNoted();
    session.resetMissCounts();
    $('wrongs').textContent = '';
    $('good').textContent = '0'; $('bad').textContent = '0';
    if ($('unclear')) $('unclear').textContent = '0';
    if ($('missed')) $('missed').textContent = '0';
    scoreView.highlightCurrent();
    setVerdict(`这一遍从第 ${i + 1} 个音开始：`
      + `<b>${midiToNameOf(judge.notes[i].midi + judge.pitchShift())}</b>`
      + `（${judge.notes[i].string}弦 ${judge.notes[i].fret}品）—— 点「跟弹」开始`, '');
  },
});

// ── 判定循环（起音 + 判定 + 记账）────────────────────────────────────────────
// 2026-09-28：整块搬进 ./app/judge-loop.js（状态 + micTick + 各判定段 + start/stop）。
// ⚠ 它必须在 scoreView / chordPractice / arpCells 之后建：那三个模块注进去的回调
//   （getNotes / isMicRunning / getBpm …）都要读 judge，而它们是懒执行，所以没问题。
// 页面只通过 judge.* 跟它打交道：start/stop/isRunning/phase/standby/advance/
//   songKind/bpm/mode/capo/tuneDown/pitchShift/notes/notesMeta/clearNotes/loadNotes。
const judge = createJudgeLoop({
  $, err, audio, session, slog, setVerdict, flashBeat,
  scoreView, chordPractice, arpCells,
  midiToNameOf: (m) => midiToNameOf(m),      // 它在文件后面才声明，所以包一层、用到时再取
  scoreOf,
});

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiToNameOf = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

$('mic').onclick = () => (judge.isRunning() ? (judge.stop(), setVerdict('已停止')) : judge.start());

// 「跳过这个音」：谱面记错的地方（用户那份 Hey Jude 第2小节那个 h 就是记错的：
// 谱面记成**一个**音，实际要弹**两个**）用一下。练习模式是**按顺序对号**，
// 你多弹的那一下会吃掉谱面的下一个音、从那儿起整条错位 —— 这一格跳过就正回来了。
// 只跳一格、不判、不计数（不是"你弹错了"，是"谱面这一格不算"）。
if ($('skip')) {
  $('skip').onclick = () => {
    if (judge.phase !== 'waiting' || !judge.notes || !judge.notes[session.noteIdx]) return;
    const skipped = midiToNameOf(judge.notes[session.noteIdx].midi);
    judge.advance();
    setVerdict(`已跳过谱面这一格（${skipped}）—— 继续弹下一个`, '');
  };
}

// 屏幕旋转/改窗口大小：重排谱面（窄屏横向铺开，宽屏整页）
let lastPhone = isPhone();
window.addEventListener('resize', () => {
  const now = isPhone();
  if (now === lastPhone) return;
  lastPhone = now;
  // 旋转/改窗口时只调缩放，布局仍然是整页折行（保证手机上也是一页一页的谱子）
  scoreView.resize(now);
});

scoreView.init();
// 版本号：**第一帧就写在标题上**（上一版藏在自检那行、还只在空的时候写，手机上根本没看到）
if ($('title') && !$('title').textContent) $('title').textContent = 'v' + BUILD + ' 正在加载谱面…';
// 版本号也写进「导出记录」旁边那一格（用户要看的就是这里）
if ($('ver')) $('ver').textContent = 'v' + BUILD;
window.__page = () => ({ songKind: judge.songKind, userBpm: judge.bpm, chordIdx: chordPractice.idx, beat, hasApi: !!scoreView.api });
// 给离线分析用的钩子：拿到这一遍的逐音记录（导出按钮存的就是它）
window.__vcSessionLog = () => slog.sessions;
window.__vcOnsetLog = () => slog.onsets;
window.__vcAlignInfo = () => scoreView.alignInfo;
window.__vcSlots = (mockScore, trackIndex) => collectScoreSlots(mockScore, trackIndex);
// 判定清单 → 光标位置的映射：离线回归要能单独测它（不开浏览器）
window.__vcMap = (list, beats) => mapSequenceToSlots(list, beats);
// 光标表本身（测"第 i 个音是不是指到第 i 个谱面位置"）
window.__vcCursor = () => scoreView.noteBeats.slice();
// 塞一份假谱面进去当"alphaTab 解析出来的结果"（离线回归整条链路时要走这一层）
window.__vcSetScore = (s, trackIndex = 0) => { scoreView.setScore(s, trackIndex); };

// ── 自检：页面上点一下，把"到底哪一环断了"直接打出来 ─────────────────────────
// 导出记录：把这一遍每个音的"期望 / 实测"存成 JSON 文件。
// 这是给我调参用的数据 —— 你录一遍"只弹对的"，就等于给我标准答案。
$('saveLog').onclick = () => {
  if (!slog.sessions.length) { err('还没有记录，先点「跟弹」弹一遍再导出。'); return; }
// 导出两份：判定过的音（notes）+ **每一次起音**（onsets，含被判"不像琴声"丢掉的）。
// 排查手机上"任何音都算对/一阵风过两三个音"就靠 onsets 这份。
const blob = new Blob([JSON.stringify({
  song: judge.songKind, mode: judge.mode,
  // 这次运行的环境（排查时不用再问"当时勾了什么"）
  guide: !!($('guide') && $('guide').checked),
  metro: !!($('metro') && $('metro').checked),
  bpm: judge.bpm,
  align: scoreView.alignInfo, // 谱面 × 时间轴的对齐结论（对不上时这里能看出来）
  notes: slog.sessions, onsets: slog.onsets,
  // ── 近似帧日志（2026-09-23 加，治"快弹漏音"）─────────────────────────────────
  // 用户说"确定是检测没起来"。这一份把**没被认成起音、但电平已经过了门限**的那些帧记下来，
  // 带上它被哪条判据否决（why）和当时的量（电平/涨速/形状/频带抬头）。
  // 快弹一段导出后，看这份就能直接指出"这一下卡在不够陡 / 没有新拨的迹象 / 形状没变"。
  nearMiss: slog.nearMisses,
}, null, 1)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `follow-log-${judge.songKind}-${Date.now()}.json`;
  a.click();
  err(`已导出 ${slog.sessions.length} 条记录`);
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
  if (scoreView.api && scoreView.api.score) {
    lines.push(`已解析：${scoreView.api.score.title}，${scoreView.api.score.tracks.length} 个声部，${scoreView.api.score.masterBars.length} 小节`);
  }
  err('自检 → ' + lines.join(' ｜ '));
};

// ── 启动完成标记（写在文件最后 = 所有按钮/处理器都挂好了）───────────────────
// index.html 里的自检条靠它判断："页面脚本起没起来"。
// 只改 import 一行、模块图断掉时，这里根本到不了 → 手机上会直接把原因显示出来。
globalThis.__gfBooted = true;
