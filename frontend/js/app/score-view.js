// ── 谱面视图（alphaTab 渲染 + 光标 + 对号）──────────────────────────────────
//
// 2026-09-28 从 follow-score.js 整块搬出来（原来 87~403 行，约 300 行）。搬的规则
// 和 chord-practice.js 一样：**只搬家，行为一字不改** —— 自己独占的状态（alphaTab 实例、
// 谱面对象、光标拍点表、对齐结论）留在闭包里，外面的东西全部用参数注入。
//
// 搬走的状态：
//     api        → api        alphaTab 实例（只建一次）
//     score      → score      解析出来的谱面
//     noteTicks  → noteTicks  每个音对应的 alphaTab tick（程序化移动光标用）
//     noteBeats  → noteBeats  每个音对应的 alphaTab Beat 对象（自己画光标用）
//     alignInfo  → alignInfo  谱面拍点 × 判定清单 的对齐结论
//
// 搬走的函数：initAlphaTab / buildTickMap / showAlignLine / markNote / highlightCurrent /
//            fillTracks / applyTrack（外加那个空的 costNothing）
//
// 依赖（由调用方注入）：
//     $            DOM 查询
//     err          页面上那行"自检/报错"文字
//     setVerdict   顶部那行提示
//     BUILD        版本号（谱面标题上要显示）
//     isPhone      窄屏判断（决定谱面缩放）
//     midiToNameOf 音名（点谱面定位时提示用）
//     session      会话状态（记住"用户点了哪一格当起点"）
//     getSongKind / getScoreUrl / getNotes / isMicRunning / setUserBpm
//     onBeatPicked 点了谱面上某个音之后，页面要做的那些事（清标记、改提示…）
//     highlightCell 没有谱面时（音格子测试页）的退路光标
//
// 同层的纯函数（cursor.js）直接 import —— 结构.md §1 允许这一条例外。

import { collectScoreSlots, mapSequenceToSlots } from './cursor.js';

export function createScoreView({
  $, err, setVerdict, BUILD, isPhone, midiToNameOf, session,
  getSongKind, getScoreUrl, getNotes, isMicRunning, setUserBpm,
  onBeatPicked, highlightCell,
}) {
  let api = null;            // alphaTab 实例（只建一次）
  let score = null;
  let noteTicks = [];        // 每个音符对应的 alphaTab tick
  let noteBeats = [];        // 每个音符对应的 alphaTab Beat 对象（用来高亮当"光标"）
  let alignInfo = null;      // 谱面拍点 × 判定清单 的对齐结论

  function costNothing() {}

  function init() {
    if (api || !window.alphaTab) return api;
    api = new alphaTab.AlphaTabApi($('score'), {
      file: getScoreUrl(),
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
    const lines = [];
    const showDiag = () => { err(lines.join(' ｜ ')); };
    lines.push(`alphaTab ${window.alphaTab && (window.alphaTab.version || '?')}`);
    if (api.soundFontLoaded) api.soundFontLoaded.on(() => { lines.push('音色库 ok'); showDiag(); });
    if (api.renderFinished) api.renderFinished.on(() => { lines.push('渲染 ok'); showDiag(); });
    api.scoreLoaded.on((s) => {
      score = s;
      lines.push(`谱面 ok（${s.title}，${s.tracks.length} 个声部）`);
      showDiag();
      $('title').textContent = `${s.title} — ${s.artist}（v${BUILD}）`;
      setUserBpm(Math.round(s.tempo) || 76);
      $('speed').value = Math.round(s.tempo) || 76;
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
    api.playerPositionChanged.on(() => { if (getSongKind() === 'heyjude') costNothing(); });
    // 点谱面定位：点哪个音就从哪个音开始练（练琴时最常见的需求：只想练那两句）
    if (api.beatMouseDown) {
      api.beatMouseDown.on((ev) => {
        const beat = ev && (ev.beat || ev);
        const idx = noteBeats.indexOf(beat);
        if (idx < 0) return;
        // ⚠ 跟弹进行中不要改起点：手指划到谱面碰一下就把序号挪走，
        // 这一遍剩下的音会跟着错位（"点跟弹还是从第二个音开始"有一半是这么来的）。
        // 要换位置就先停止。
        if (isMicRunning()) {
          setVerdict('正在跟弹 —— 先点「停止」，再点谱面换练习位置', '');
          return;
        }
        session.noteIdx = idx;
        session.holdUntilMs = 0;
        session.pickedStart = true;      // 明确点过谱面 → 这一遍从这儿开始
        onBeatPicked(idx);
      });
    }
    // 播放器就绪后再压一次静音 —— 这是"只听旋律"真正生效的时机。
    // 之前只在 scoreLoaded 里设 playbackInfo.isMute，播放器准备时会被覆盖，
    // 所以选了旋律轨仍然听得见钢琴伴奏。
    if (api.playerReady) api.playerReady.on(() => { if (score) applyTrack(Number($('track').value) || 0); });
    // 3 秒后还没渲染出东西，直接把结论说出来
    setTimeout(() => {
      const el = $('score');
      if (!el.children.length) err('谱面没有渲染出来：' + (lines.join(' ｜ ') || '（没有任何状态回调触发，说明 .gp 没加载成功）')
        + ' ｜ 检查 /data/hey_jude.gp3 和 /vendor/font/Bravura.woff2 能不能打开');
    }, 3000);
    // 布局稳定后补渲染一次：首帧容器可能还是 0 宽/0 高，alphaTab 按那个尺寸排完就什么都看不见。
    setTimeout(() => { try { api.render(); } catch (e) { err('补渲染失败：' + (e.message || e)); } }, 600);
    return api;
  }

  // 把"判定用的时间轴"按谱面的拍点重排（两边索引一致，光标才查得到布局）。
  //
  // ⚠ 这段原来没有任何校验，是个大坑：它给**每个拍**找时间轴上最近的音，
  // 一旦两边的时刻对不上（速度不一致 / absoluteStart 拿不到 / 时间轴是另一份谱），
  // 所有拍就会**一起指到最近的那一个音** —— 于是"期望音"变成全曲同一个音。
  // 手机实测就是这个：38 个音的期望全是 C4(2弦1品)，用户只弹了两个音却"全对"。
  // 所以现在先算对齐质量，**对不上就不重排**（保持时间轴原样），并把结论写到自检栏。
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
    // 判定清单 = 时间轴那一份（`notes`）；光标 = 谱面的拍点表（`beats`）。
    // 两边合成一份"第 i 个音用哪一个拍点当光标"的对照表 —— 见 mapSequenceToSlots。
    // ⚠ 这一层只做这一件事：**把光标指到判定清单里正在等的那个音上**。
    const mapped = mapSequenceToSlots(getNotes(), beats);
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
    const cell = $('cell' + idx);
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
        const sEl = $('score'), wEl = $('scoreWrap');
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

  // index 省略 = 当前该弹的那个音（session.noteIdx）；给"起音预览"用时会显式传下一个音
  function highlightCurrent(index = session.noteIdx) {
    if (!api) { highlightCell(Math.max(0, Math.min(index, (getNotes() || []).length - 1))); return; }
    const box = $('cursor');
    const idx = Math.max(0, Math.min(index, (noteBeats || []).length - 1));
    const beat = noteBeats[idx];
    // 光标/标记现在挂在 #scoreWrap 上（不放在 #score 里，免得被 alphaTab 渲染时删掉），
    // 而 alphaTab 给的坐标是**相对它自己的容器**的，所以要把两者的偏移补上。
    const scoreEl = $('score');
    const wrapEl = $('scoreWrap');
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
        const box2 = $('cursor');
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

  // 换曲目：销毁旧实例，两边都清干净（不然新谱永远不显示 / 两首谱画在一个容器里）
  function destroy() {
    if (api && api.destroy) { try { api.destroy(); } catch (e) {} }
    api = null; score = null;
    clearMap();
    if ($('score')) $('score').innerHTML = '';
  }

  // 只清"光标 → 谱面"的对照表（换曲目时先清；不用动 alphaTab 实例）
  function clearMap() {
    noteBeats = []; noteTicks = []; alignInfo = null;
  }

  // 音符加载完之后重建对照表（切声部、重新开始都要）
  function rebuildMap(trackIndex = 0) {
    if (score) { try { buildTickMap(score, trackIndex); } catch (e) {} }
  }

  // 谱面缩放变了（手机 ↔ 宽屏）：只改缩放，布局仍然是整页折行
  function resize(narrow) {
    if (!api || !score) return;
    api.settings.display.scale = narrow ? 0.7 : 1;
    api.render();
  }

  // 试听速度：谱面自己的速度是基准，用户设的速度是比例
  function setSpeed(ratio) {
    if (api) api.playbackSpeed = ratio;
  }

  return {
    init, buildTickMap, showAlignLine, markNote, highlightCurrent, applyTrack,
    destroy, clearMap, rebuildMap, resize, setSpeed,
    setScore(s, trackIndex = 0) { score = s; buildTickMap(s, trackIndex); },
    get api() { return api; },
    get score() { return score; },
    get noteBeats() { return noteBeats; },
    get alignInfo() { return alignInfo; },
  };
}
