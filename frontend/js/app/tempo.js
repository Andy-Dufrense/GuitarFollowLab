// ── 跟节拍层（tempo）：一切都由**谱面时钟**驱动 ──────────────────────────────
//
// 和"等我弹"（wait）严格分开：wait 那条链路一个字节都不动。
//   · 光标：按时间走（和"试听"用的是同一份 expectedAtMs），**不跟着用户走**；
//   · 起音：只回答"这个音的**时间窗**里，有没有出现正确的音"；
//   · 窗口过了还没判到 → 这个音算错（窗口不会回来）；
//   · 起手以用户第一下为准；跟丢了（超窗但音对）也能认下并把时间轴重新对齐。
// 这样就不会出现"一个起音把后面好几个音一起吃掉"（用户报的"疯狂过音符"）。
//
// 这一层不认识 DOM/计数/日志：那些通过 host 回调交回页面（见 createTempoLayer 的参数）。
export const TEMPO_FIRST_GRACE_MS = 4000;   // 起手宽限：这么久没弹才退回正规时间轴

export function createTempoLayer(host) {
  let state = [];          // 每个音：'' 待判 | 'ok' | 'bad' | 'miss'
  let cursor = 0;          // 光标（= 当前时间窗所在的音）
  let closed = -1;         // 已经关窗结算到第几个音
  let originMs = null;     // 时间轴原点（null = 还没起手）
  let lateAccept = false;  // 这一下是"超窗但按下一个音认下来"的
  let beats = [];          // 拍点表（相对时间轴 0）
  let beatIdx = 0;         // 已经排到第几个拍点

  const notes = () => host.notes() || [];
  const beatMs = () => (60 / (host.userBpm() || 76)) * 1000;

  // 起拍音（拾音）：第 1 小节不是完整小节时（这首谱是 1/4），它里面的音算"起拍音" ——
  // 不掐它的拍子（给一整拍宽限），提示音也从第 2 小节的正拍才开始响。
  function pickupCount() {
    const ns = notes();
    if (ns.length < 2) return 0;
    const first = ns[0].measure;
    let n = 0;
    for (const nt of ns) { if (nt.measure === first) n++; else break; }
    return n < ns.length ? n : 0;
  }
  const at = (i) => host.expectedAtMs(i) + (originMs || 0);
  const tol = (i) => {
    const base = host.toleranceMs(i);
    return i < pickupCount() ? Math.max(base, beatMs()) : base;
  };

  // ── 提示音 / 拍点闪灯：和光标同一个时钟（都由 at(i) 驱动）─────────────────
  // 这样"听到的"和"看到的"必然是一回事，不会出现"节拍器和光标对不上"
  // （那是两个时钟域：Web Audio 的 currentTime vs performance.now）。
  function clickAt(delaySec, accent) {
    const ctx = host.getCtx && host.getCtx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = accent ? 1568 : 1046;
      const t = ctx.currentTime + Math.max(0, delaySec);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(accent ? 0.14 : 0.09, t + 0.02);  // 软起振：别被麦克风当成拨弦
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.09);
    } catch (e) { /* 没有音频就不响，不影响判定 */ }
  }
  // 拍点表：小节起点由拍号累加算出来（和谱面时间轴同一个 scale），强拍 = 每小节第 1 拍
  function buildBeatGrid() {
    const ns = notes();
    if (!ns.length) return [];
    const sigs = (host.meta() && host.meta().timeSignatures) || [];
    const perOf = (m) => {
      const s = sigs.find((x) => x.measure === m + 1);
      const n = s ? Number(String(s.sig).split('/')[0]) : 4;
      return n > 0 ? n : 4;
    };
    const measures = Math.max(...ns.map((n) => n.measure || 0)) + 1;
    const beat = beatMs();
    const out = [];
    let ms = 0;
    for (let m = 0; m < measures; m++) {
      const per = perOf(m);
      for (let b = 0; b < per; b++) out.push({ ms: ms + b * beat, measure: m, beat: b });
      ms += per * beat;
    }
    return out;
  }
  function rebuildBeatGrid() { beats = buildBeatGrid(); beatIdx = 0; }
  function scheduleClicks(tMs) {
    if (!(host.metroOn && host.metroOn())) return;
    const off = originMs || 0;
    while (beatIdx < beats.length && beats[beatIdx].ms + off < tMs - 80) beatIdx++;
    while (beatIdx < beats.length && beats[beatIdx].ms + off <= tMs + 200) {
      const b = beats[beatIdx++];
      const accent = b.beat === 0;
      const delay = (b.ms + off - tMs) / 1000;
      clickAt(delay, accent);
      if (host.onBeat) setTimeout(() => host.onBeat(accent), Math.max(0, delay * 1000));
    }
  }

  // 这一刻的起音归到哪个音？不在任何窗口里 → -1
  function noteAt(ms) {
    const ns = notes();
    if (!ns.length) return -1;
    let best = -1, bestD = Infinity;
    for (let i = Math.max(0, cursor - 2); i < ns.length; i++) {
      const c = at(i);
      if (c - tol(i) > ms + 300) break;      // 后面的音还早，不用看
      if (state[i]) continue;                // 已经判过
      const d = Math.abs(ms - c);
      if (d <= tol(i) && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }
  // 这一下离"还没判的那个音"差多少（提示"你早了/晚了多少ms"用）
  function nearestPending(ms) {
    const ns = notes();
    let idx = -1, dev = 0, bestD = Infinity;
    for (let i = Math.max(0, cursor - 2); i < ns.length; i++) {
      if (state[i]) continue;
      const d = ms - at(i);
      if (Math.abs(d) < bestD) { bestD = Math.abs(d); idx = i; dev = d; }
      if (host.expectedAtMs(i) > ms + 1000) break;
    }
    return { idx, dev };
  }
  // 起手对齐：把整条谱面时间轴对齐到用户第一下（用户口径：第一个音以他的起音为准）
  function anchor(elapsedMs) {
    originMs = elapsedMs - host.expectedAtMs(0);
    cursor = 0;
    lateAccept = false;
    rebuildBeatGrid();
    return originMs;
  }
  // 时钟：关窗结算 + 挪光标 + 收尾。返回 true = 整曲跑完（调用方要 return）
  function tick(nowMs) {
    const ns = notes();
    if (!ns.length || host.phase() !== 'waiting') return false;
    const t = nowMs - host.startedAt();
    if (originMs == null) {
      if (t < TEMPO_FIRST_GRACE_MS) return false;
      originMs = 0;                      // 宽限过了：退回正规时间轴，免得整段卡住
    }
    scheduleClicks(t);
    // ① 关窗：右边界过了还没判到 → 记错（规定时间里没出现理想音就是错）
    while (closed + 1 < ns.length && t > at(closed + 1) + tol(closed + 1)) {
      closed++;
      if (!state[closed]) {
        state[closed] = 'miss';
        if (host.onMiss) host.onMiss({ index: closed, note: ns[closed], atMs: nowMs, winFrom: at(closed) - tol(closed), winTo: at(closed) + tol(closed) });
      }
    }
    // ② 光标按时间走：落在哪个音的窗口里就指哪个音
    let cur = cursor;
    while (cur + 1 < ns.length && t >= at(cur + 1) - tol(cur + 1)) cur++;
    if (cur !== cursor) {
      cursor = cur;
      host.setNoteIdx(cur);
      if (host.onCursor) host.onCursor(cur, ns[cur]);
    }
    // ③ 最后一个音的时间窗也过了 → 整曲结束
    if (closed >= ns.length - 1) { if (host.finish) host.finish(); return true; }
    return false;
  }
  // 判定回来之后：记状态；超窗但音对（lateAccept）时把时间轴重新对齐到这一下
  function onJudged(index, pass, devMs) {
    state[index] = pass ? 'ok' : 'bad';
    if (lateAccept && pass && devMs != null && Math.abs(devMs) > tol(index) * 0.5) {
      originMs += devMs;
      rebuildBeatGrid();
      if (host.onReanchor) host.onReanchor(devMs);
    }
    lateAccept = false;
  }
  return {
    reset() {
      state = notes().map(() => '');
      cursor = 0; closed = -1; originMs = null; lateAccept = false;
      beats = []; beatIdx = 0;
    },
    tick, noteAt, nearestPending, anchor, onJudged,
    pickupCount, at, tol,
    isAnchored: () => originMs != null,
    setLateAccept: (v) => { lateAccept = !!v; },
    isLateAccept: () => lateAccept,
    cursorIndex: () => cursor,
    state: () => state,
  };
}
