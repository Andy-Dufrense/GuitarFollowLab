// ── 和弦练习（C–Am–F–G）────────────────────────────────────────────────────
//
// 2026-09-28 从 follow-score.js 整块搬出来（原来在 394~492 行）。搬的规则只有一条：
// **行为一字不改** —— 只把"它自己独占的状态"和"它自己的函数"一起带走，
// 外面的依赖全部用参数注入，模块内部不碰任何全局。
//
// 搬走的状态（原来散在 follow-score.js 的模块作用域里）：
//     chords → data      和弦数据
//     chordIdx → idx     当前第几个和弦
//     chordPick → pick   用户点过的起点（-1 = 没点过，从头开始）
//     beatTimer → timer  四拍轮转的定时器（0 = 没在跑）
//     chordCtx → ctx     试听用的 Web Audio 上下文
//
// 没搬走的一样东西：`beat`（第几拍）。它是**和弦卡上的点**和**alphaTab 光标**共用的
// 同一份状态，所以这里只通过 getBeat()/setBeat() 读写，不自己存一份 ——
// 存两份就会出现"卡片显示第 2 拍、光标还在第 3 拍"这种两边不一致。
//
// 依赖（由调用方注入）：
//     $           DOM 查询
//     audio       Web Audio（试听要发声）
//     setVerdict  顶部那行提示
//     getBpm      用户设的速度
//     getBeat/setBeat  第几拍（0..3）

export function createChordPractice({ $, audio, setVerdict, getBpm, getBeat, setBeat }) {
  let data = null;
  let idx = -1;
  let pick = -1;
  let timer = 0;
  let ctx = null;
  let withSound = false;

  async function load() {
    if (!data) data = await (await fetch('./data/chord_practice.json')).json();
    return data;
  }

  function render() {
    const box = $('chords');
    box.innerHTML = '';
    data.chords.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'c';
      el.innerHTML = `<div class="nm">${c.name}</div><div class="vo">${c.voicing}</div>`
        + '<div class="beat">○○○○</div>';
      // 点和弦卡 = 从这一个和弦开始（试听/跟弹都按这个起点走）。
      el.onclick = () => {
        if (timer) {
          setVerdict('试听进行中：先点「试听」停下，再点你想从哪个和弦开始');
          return;
        }
        idx = i;
        pick = i;               // 记住起点：点「试听」/「跟弹」都从这一个开始
        paint();
        $('pos').textContent = `${i + 1}/${data.chords.length}`;
        setVerdict(`这一遍从 <b>${c.name}</b> 开始（第 ${i + 1} 个和弦）`
          + ` —— 点「试听」听一遍，或点「跟弹」开始判定`, '');
      };
      box.appendChild(el);
    });
    $('pos').textContent = `0/${data.chords.length}`;
  }

  function paint() {
    const b = getBeat();
    [...$('chords').children].forEach((el, i) => {
      el.classList.toggle('now', i === idx);
      const dots = el.querySelector('.beat');
      if (dots) dots.textContent = i === idx ? '●'.repeat(b) + '○'.repeat(4 - b) : '○○○○';
    });
  }

  // 和弦谱的试听：把当前和弦的音按节奏拨出来（Web Audio 合成，不依赖音色库）。
  // 跟弹时不发声 —— 否则会被麦克风收进去，反而干扰判定。
  function strum(midis, at) {
    if (!ctx) ctx = (audio.getCtx && audio.getCtx()) || new (window.AudioContext || window.webkitAudioContext)();
    midis.forEach((m, i) => {
      const f = 440 * Math.pow(2, (m - 69) / 12);
      const t = at + i * 0.018;                    // 六根弦依次扫过（18ms）
      const osc = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      osc.type = 'sawtooth'; osc.frequency.value = f;
      lp.type = 'lowpass'; lp.frequency.value = Math.min(5000, f * 7);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16 / Math.max(1, midis.length / 4), t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      osc.connect(lp); lp.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + 1.2);
    });
  }

  function start(sound = false) {
    // 护栏：数据没到（或 JSON 出错）时别让按钮"点了没反应/报错"，直接说清楚。
    if (!data || !data.chords || !data.chords.length) {
      setVerdict('和弦谱数据没加载成功，刷新页面再试（data/chord_practice.json）');
      return;
    }
    // 起点：点过和弦卡就从那一个开始，没点过就从头
    idx = (pick >= 0 ? pick : 0);
    pick = -1;                  // 只认这一次点击，下一遍仍旧从头
    setBeat(0);
    paint();
    $('pos').textContent = `${idx + 1}/${data.chords.length}`;
    setVerdict('和弦练习：每个和弦 4 拍，跟着高亮换和弦。弹错不停，标红继续。');
    const ms = (60 / getBpm()) * 1000;
    withSound = sound;
    if (withSound) {
      if (!ctx) ctx = (audio.getCtx && audio.getCtx()) || new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume && ctx.resume();
      strum(data.chords[idx].midis, ctx.currentTime + 0.05);
    }
    timer = setInterval(() => {
      let b = getBeat() + 1;
      if (b >= 4) {
        b = 0;
        idx++;
        if (idx >= data.chords.length) {
          stop();
          setVerdict('🎉 一轮走完', 'ok');
          return;
        }
        $('pos').textContent = `${idx + 1}/${data.chords.length}`;
      }
      setBeat(b);
      if (withSound && ctx) strum(data.chords[idx].midis, ctx.currentTime + 0.02);
      paint();
    }, ms);
  }

  function stop() {
    clearInterval(timer); timer = 0;
    $('play').textContent = '▶ 试听'; $('play').classList.remove('on');
  }

  return {
    load, render, paint, strum, start, stop,
    isRunning: () => !!timer,
    get data() { return data; },      // 外面还要读和弦名（判定行 / 提示行）
    get idx() { return idx; },
  };
}
