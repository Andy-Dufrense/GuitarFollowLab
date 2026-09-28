// ── 音格子 + 倒计时 + 节拍器（无谱面测试页：arp / tech）─────────────────────
//
// 2026-09-28 从 follow-score.js 搬出来（原来 renderCells / highlightCell / countIn /
// metro + startMetronome / stopMetronome 那一段）。搬的规则只有一条：**行为一字不改**。
//
// 为什么这一块单独拎出来：它是在**麦克风循环里**被调到的东西（倒计时、节拍器），
// 前两次搬它都碰坏了 test-follow-page 的几条断言，所以这次先搬、先量。
//
// 模块自己独占：节拍器实例（metro）。其余全部注入：
//     $             DOM 查询
//     audio         Web Audio（倒计时的四声"哒"）
//     setVerdict    顶部那行提示
//     session       会话状态（记"从第几格开始"、清倒数四拍的计数）
//     midiToNameOf / pitchShift   格子上写什么音名
//     getNotes      判定清单
//     getBpm        用户设的速度（倒计时间隔、节拍器速度）
//     isMicRunning  跟弹进行中不许换起点
//     highlightCurrent  画光标（在谱面模块里）
//     onCellPicked  点了某一格之后，页面要做的那些事（清账、改提示…）

import { createMetro } from '../metro-core.js';

export function createArpCells({
  $, audio, setVerdict, session, midiToNameOf, pitchShift,
  getNotes, getBpm, isMicRunning, highlightCurrent, onCellPicked,
}) {
  // 节拍器：用共用的核心（metro-core.js，和调试图是同一份实现）。
  // 检查模式（跟节拍）没有拍子参照没法用。
  const metro = createMetro({ getCtx: () => audio.getCtx() });

  // 一排"音格子"：当前该弹的那个高亮
  function render() {
    const box = $('cells');
    const notes = getNotes();
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
          if (isMicRunning()) {
            setVerdict('跟弹进行中：先点「停止」，再点你想从哪一格开始');
            return;
          }
          session.noteIdx = i;
          session.pickedStart = true;
          session.holdUntilMs = 0;
          // 从新的地方开始练：**旧的标记要清掉**（跟谱面那条路的做法一致）——
          // 不然新一段和上一段的绿/红混在一起，看不出这次练到哪、对错是哪一遍的。
          if ($('marks')) $('marks').innerHTML = '';
          const cellBox = $('cells');
          if (cellBox && cellBox.querySelectorAll) {
            cellBox.querySelectorAll('.cell.ok, .cell.bad').forEach((c) => {
              if (c.classList) { c.classList.remove('ok'); c.classList.remove('bad'); }
            });
          }
          onCellPicked(i);
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
    session.resetCountinPeaks();
    const ms = (60 / getBpm()) * 1000;
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

  function start() { return metro.start({ bpm: getBpm() }); }
  function stop() { metro.stop(); }

  return { render, highlightCell, countIn, start, stop };
}
