// ─────────────────────────────────────────────────────────────────────────────
// 入口：装配各层 + 主循环 + 所有按钮/滑块的接线。
//
// 这里只做"调度"：读一帧 → 交给分析层 → 需要判定就交给判定层 → 让界面层画出来。
// 具体的算法在 analysis.js，判定策略在 judge.js，DOM 在 ui.js。
// ─────────────────────────────────────────────────────────────────────────────

import { rms, spectrumOf } from './engine/dsp.js?v=0924-1725';
import { CFG } from './engine/config.js?v=0924-1725';
import { S, step, newRun } from './state.js';
import * as audio from './audio.js';
import {
  track, fluxRelOf, resetAnalysis, getLastMagsFull, getFluxSpec, getBeforeFluxSpec,
  novelSpectrum, matchNoteByCandidates,
} from './engine/analysis.js?v=0924-1725';
import { midiToName } from './engine/dsp.js?v=0924-1725';
import { judge, settleFor, skipGroup, advance } from './judge.js';
import { startMetro, stopMetro, autoFit, paintCurrentBeat } from './metronome.js';
import {
  $, buildModes, buildLevels, renderStep, renderDots, paintMeter,
  setVerdict, flashTarget, micFail, diagnose, showBootError,
} from './ui.js';

// 脚本活过来了。index.html 里的看门狗靠这个标记判断页面有没有启动成功。
window.__appReady = true;

let rafId = 0;

// ── 麦克风开/关 ──────────────────────────────────────────────────────────────
async function startMic() {
  // 硬门槛：不是安全上下文就根本不调用 getUserMedia。
  // 安卓 Chrome 在 http 下的表现是"不弹授权框，promise 也一直挂着"，
  // 看起来就跟点了没反应一样，所以这里必须先拦下来。
  if (window.isSecureContext === false) {
    return micFail(location.protocol === 'https:'
      ? '这个 https 证书手机还没信任，浏览器不给麦克风。先按右边说明把证书装到手机里。'
      : '这个地址浏览器不给麦克风权限（既不是 https 也不是 localhost），所以连授权框都不会弹。'
        + '手机必须用 https 打开，步骤见右边。');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return micFail('这个浏览器没有提供麦克风接口。');
  }

  setVerdict('listening', '正在请求麦克风权限…手机上会弹一个授权框，点「允许」');
  $('btnStart').textContent = '连接中…';

  // 等待期间每秒报一次数，证明确实在等，不是卡死了
  let waiting = true;
  const t0 = Date.now();
  const tickTimer = setInterval(() => {
    if (waiting) setVerdict('listening', `正在等待麦克风授权…（已等 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
  }, 1000);

  try {
    await audio.acquire();
  } catch (e) {
    waiting = false;
    clearInterval(tickTimer);
    let why = e.name === 'NotAllowedError'
      ? '权限被拒绝了。点地址栏左边那个小图标，把麦克风改成「允许」，再刷新页面'
      : e.name === 'NotFoundError' ? '这台设备上找不到麦克风'
      : e.name === 'NotReadableError' ? '麦克风被别的程序占着'
      : e.name === 'TimeoutError' ? '等了 8 秒也没等到授权结果，多半是被浏览器或者系统拦住了'
      : e.name === 'NoWebAudio' ? '这个浏览器不支持 Web Audio'
      : e.name === 'OverconstrainedError' ? '麦克风不支持要求的参数' : (e.message || e.name);

    // 权限要是已经被设成"拒绝"，浏览器根本不会再弹框，这里把真实原因说出来
    if (e.name === 'NotAllowedError' || e.name === 'TimeoutError') {
      const ps = await audio.permissionState();
      if (ps === 'denied') {
        why = '麦克风权限是「拒绝」，所以不会再弹授权框。两种可能都要查：'
          + '① 浏览器里拒的（地址栏左边图标 → 权限 → 麦克风 → 允许）；'
          + '② 手机系统把浏览器的麦克风权限关了（设置 → 应用管理 → 找到这个浏览器 → 权限 → 麦克风）。'
          + '详细步骤见右边说明。';
      } else if (ps === 'prompt') {
        why = '授权请求被直接挡掉了，但权限状态还是「询问」。两种可能：'
          + '① 刚才的授权框被关掉了没点"允许"（再点一次"开始"，留意屏幕上的弹框）；'
          + '② 系统层面关了麦克风：安卓看 设置→应用→找到你的浏览器→权限→麦克风，'
          + 'iPhone 看 设置→Safari→麦克风';
      }
    }
    return micFail('开不了麦克风：' + why, e);
  }

  waiting = false;
  clearInterval(tickTimer);

  S.running = true;
  S.lastError = null;
  newRun();
  S.phase = 'waiting';
  S.floor = 0.001;
  S.frames = 0;
  S.hist = new Float32Array(16);   // 约 250ms，只要比基准滞后长就行
  S.histIdx = 0;
  resetAnalysis();
  $('btnStart').textContent = '停止';
  $('btnStart').classList.add('stop');
  renderStep(); renderDots();
  diagnose();
  rafId = requestAnimationFrame(loop);
}

function stopMic() {
  S.running = false;
  S.phase = 'idle';
  if (S.metro.on) stopMetro();
  cancelAnimationFrame(rafId);
  audio.release();
  $('btnStart').textContent = '开始';
  $('btnStart').classList.remove('stop');
  $('levelfill').style.width = '0%';
  setVerdict('idle', '已停止。点开始重新来。');
}

// 整体复位：回到"刚打开页面"的状态。
// 关掉麦克风、清掉进度、清掉分析层的跨帧状态（噪声谱、上一帧频谱）。
// 测试里每个场景之间调它，避免上一个场景的残留影响下一个。
export function resetApp() {
  if (S.running) stopMic();
  S.modeIndex = 0;
  S.levelIndex = 0;
  S.phase = 'idle';
  S.onsetAt = 0;
  S.lastOnsetAt = -1e9;
  S.measureTries = 0;
  S.trajectory = [];
  S.onsetAudioMs = 0;
  S.refMags = null;
  S.onsetRise = null;
  S.onsetPreSpec = null;
  S.hist = null;
  S.histIdx = 0;
  S.floor = 0.001;
  S.gate = 0.01;
  S.level = 0;
  S.frames = 0;
  S.fluxRel = 0;
  S.lastAnalysisAt = 0;
  S.lastError = null;
  S.metro.on = false;
  S.metro.marks = [];
  S.metro.devs = [];
  resetAnalysis();
  newRun();
  $('btnStart').textContent = '开始';
  $('btnStart').classList.remove('stop');
  $('levelfill').style.width = '0%';
  $('heardval').textContent = '—';
  $('heardcents').textContent = '';
  renderStep();
  renderDots();
}

// ── 主循环 ───────────────────────────────────────────────────────────────────
// tick 是真正的循环体。外面包一层 try，出异常时要报出来，
// 不能让 requestAnimationFrame 悄悄断掉、页面看着像卡死。
function tick() {
  const buf = audio.readFrame();
  if (!buf) return;
  const lv = rms(buf, buf.length - 1024, 1024);
  S.level = lv;

  // 本底电平。用指数平均，但**启动的头半秒要快速贴一次本底**：
  // 不然它从 0.001 慢慢往上爬，爬到位之前门限偏低，房间噪声就能骗出一次误判
  // （实测纯噪声会冒出莫名其妙的"没听清"）。
  //
  // 试过改用"最近 1.5 秒的最小值"来估本底，理论上更稳，但实测反而更差：
  // 密集琶音时 1.5 秒里没有安静的时刻，最小值被抬高，门限跟着涨，
  // 结果 80BPM 反而过不去了。所以还是回到指数平均，只补启动这一段。
  S.frames = (S.frames || 0) + 1;
  if (S.frames <= 30) {
    S.floor += (Math.min(lv, 0.05) * 0.9 - S.floor) * 0.3;
  } else if (lv < S.floor) {
    S.floor = S.floor * 0.9 + lv * 0.1;
  } else {
    S.floor = Math.min(S.floor * 1.0003 + 1e-7, 0.06);
  }
  S.floor = Math.max(S.floor, 0.0005);
  S.gate = Math.max(CFG.absFloor, S.floor * CFG.onsetSensitivity);
  paintMeter();

  const now = performance.now();
  const ev = step();

  // 起音判定。基准用"48ms 前的电平"，不是"最近几百毫秒的最高值"：
  //   · 用最高值，连弹同一个音会卡死——第二个音的峰值并不比第一个高，
  //     永远超不过那 1.6 倍。
  //   · 用平均值，会被几根弦之间的拍频骗到——余响忽高忽低，误触发。
  // 48ms 这个尺度上，拨弦是陡升（好几倍），拍频是缓变（几十个百分点），分得开。
  //
  // 更早的版本要求"必须先彻底安静下来才能再次触发"，那是个 bug——
  // 只要上一个音还在响、或者房间底噪偏高，后面弹的音就永远触发不了。
  const lagFrames = 3;                    // 3 × 16ms ≈ 48ms
  const lagged = S.hist
    ? S.hist[(S.histIdx + S.hist.length - lagFrames) % S.hist.length] : 0;
  const rising = lv > lagged * 1.6;

  // 第二条判据：出现了新的频谱成分。
  // 你让音一直延续时，几根弦的余响叠起来的总电平可能比新拨的那一下还响，
  // 光看电平抬升就触发不了——"消音再弹很丝滑、延续着弹很迟钝"就是这个原因。
  // 余响只会衰减、不会凭空产生新成分，所以这条对延音免疫。
  // 但它还得配合一点点电平抬升：真拨弦一定会抬高电平，衰减中的余响永远不会。
  const fluxRel = fluxRelOf(buf);
  S.fluxRel = fluxRel;
  const fluxOnset = fluxRel > 0.16 && lv > lagged * 1.15;

  if (S.phase === 'waiting' && lv > S.gate && (rising || fluxOnset) && now - S.lastOnsetAt > CFG.minGapMs) {
    S.onsetAt = now;
    S.lastOnsetAt = now;
    const ctx = audio.getCtx();
    S.onsetAudioMs = ctx ? ctx.currentTime * 1000 : 0;
    // 起音之前的短窗频谱，用来做差分基准
    // 起音前的整窗频谱：判定时拿它做差分，把"这个音之前就已经在响的东西"减掉。
    // 用整窗（和判定那份等长）而不是短窗 —— 两份频谱等长才能逐频点相减。
    S.refMags = getLastMagsFull();
    // 起音那一瞬间的"逐频点抬头率"，判定时用来分辨"刚拨的"和"还在响的"。
    // 必须此刻抓一份拷贝 —— 这个数组每帧都会被覆写。
    // 起音当场快照：这一帧 vs 上一帧的 43ms 频谱（错开 16ms，都贴着起音那一刻）。
    // "拨弦那一下哪个频点跳起来了"必须在这一刻取，不能等判定时刻（60~140ms 后）——
    // 那时候爆发峰早过去了，实测比值只有 0.11~0.72，目标音全面低于对手。
    const nowSpec = getFluxSpec();
    const prevSpec = getBeforeFluxSpec();
    if (nowSpec && prevSpec && nowSpec.length === prevSpec.length) {
      const r = new Float32Array(nowSpec.length);
      for (let i = 0; i < nowSpec.length; i++) r[i] = nowSpec[i] / (prevSpec[i] + 1e-9);
      S.onsetRise = r;
    } else {
      S.onsetRise = null;
    }
    S.phase = 'settling';
    S.measureTries = 0;
    S.trajectory = [];
    // 起音瞬间就给视觉反馈：目标音闪一下。
    // 判定本身要 60ms 才出来，但"它听见了"这件事可以立刻告诉用户。
    flashTarget('hit');
    setVerdict('listening', '听到了，正在听清…');
  }

  paintCurrentBeat();

  if (S.hist) {
    S.hist[S.histIdx] = lv;
    S.histIdx = (S.histIdx + 1) % S.hist.length;
  }

  // 连续追踪：给"听到"显示，也顺便记录滑音轨迹
  if (now - S.lastAnalysisAt > 60 && lv > S.gate * 0.5) {
    S.lastAnalysisAt = now;
    const a = track(buf, audio.getDecim(), audio.getRate());

    // "听到"这一栏显示的是【你刚弹的那个音】，不是【此刻最响的那个音】。
    //
    // 之前这里用的是通用音高检测（问"此刻最响的是什么音"）。你拨弦那一瞬间它是对的，
    // 但几十毫秒之后上一根弦的余响盖上来，"最响的"就变成上一根弦了 ——
    // 读数被顶掉，看着像"音名对了一下就被延音盖过去"。
    // 判定那一路早就改成看"新出现的能量"了，显示没跟上，两边打架。
    //
    // 现在显示和判定用同一套候选比较，并且**只在起音窗口内更新**：
    // 弹完就停在那儿，不会被下一根弦的余音顶掉。
    // 只有单音事件才走"候选音比较"这一路：和弦事件没有 targetMidi，
    // 以前这里会拿 undefined 去算（算出来全是 0，看着没事），现在会显式区分开。
    if (ev && ev.kind === 'note' && S.phase === 'settling') {
      const disp = matchNoteByCandidates(
        novelSpectrum(a.mags), audio.getRate(), a.fftN, ev.targetMidi + (CFG.capo || 0), CFG.capo || 0,
      );
      const top = disp.ranked[0];
      if (top && top.score > 0) {
        $('heardval').textContent = midiToName(top.midi);
        // 音分只在"通用检测和显示出来的是同一个音名"时才报，否则会自相矛盾
        const yinName = a.pitch.hz > 0 ? midiToName(a.pitch.midi) : null;
        $('heardcents').textContent = yinName === midiToName(top.midi)
          ? `${Math.round((a.pitch.midi - (ev.targetMidi + (CFG.capo || 0))) * 100)} 音分`
          : '';
      }
      // 滑音轨迹仍然用通用检测的逐帧音高（要看的是音高连续滑动）
      if (a.pitch.hz > 0 && a.pitch.clarity > 0.6) {
        const last = S.trajectory[S.trajectory.length - 1];
        if (last == null || Math.abs(last - a.pitch.midi) > 0.3) S.trajectory.push(a.pitch.midi);
        if (S.trajectory.length > 12) S.trajectory.shift();
      }
    }
  }

  // 听不清会往后补测，每次多等 40ms，所以这里要把补测次数算进去
  if (S.phase === 'settling' && now - S.onsetAt >= settleFor(ev) + S.measureTries * 40) judge(ev);
}

function loop() {
  if (!S.running) return;
  try {
    tick();
  } catch (e) {
    S.running = false;
    cancelAnimationFrame(rafId);
    setVerdict('bad', '页面内部出错了，已经停下：' + ((e && e.message) || e) + '  —— 刷新页面可以重来');
    showBootError('运行中出错', (e && e.stack) || e);
    return;
  }
  rafId = requestAnimationFrame(loop);
}

// ── 按钮与设置 ───────────────────────────────────────────────────────────────
$('btnStart').onclick = () => (S.running ? stopMic() : startMic());
$('btnSkip').onclick = skipGroup;
$('btnReset').onclick = () => {
  newRun();
  S.phase = S.running ? 'waiting' : 'idle';
  renderStep(); renderDots();
};

function bindSlider(id, outId, key, fmt, after) {
  const el = $(id), out = $(outId);
  const paint = () => { out.textContent = fmt(CFG[key]); };
  el.addEventListener('input', () => { CFG[key] = Number(el.value); paint(); if (after) after(); });
  paint();
}
bindSlider('s-tol', 'o-tol', 'toleranceCents', (v) => `±${v} 音分`);
bindSlider('s-sen', 'o-sen', 'onsetSensitivity', (v) => `${v.toFixed(1)}×`);
bindSlider('s-set', 'o-set', 'settleMs', (v) => `${v} ms`);
bindSlider('s-chd', 'o-chd', 'chordThreshold', (v) => v.toFixed(2));
bindSlider('s-capo', 'o-capo', 'capo', (v) => (v ? v + ' 品' : '不夹'), () => renderStep());

// 节拍器的控件
$('btnMetro').onclick = () => (S.metro.on ? stopMetro() : startMetro());
$('s-bpm').addEventListener('input', (e) => {
  S.metro.bpm = Number(e.target.value);
  $('bpmval').textContent = S.metro.bpm;
  autoFit();
});
$('c-sound').addEventListener('change', (e) => {
  S.metro.sound = e.target.checked;
  $('soundsay').textContent = e.target.checked
    ? '已经把声音打开了。响声会被麦克风收到，请戴耳机——否则它可能被当成你在弹。'
    : '开声音的话，节拍器的响声会被麦克风收进去，可能当成你在弹。要用声音请戴耳机。';
});
$('c-autofit').addEventListener('change', () => {
  if ($('c-autofit').checked) autoFit();
  else $('autofit-note').textContent = '已关闭，用「听音时长」手动调';
});
autoFit();

// 初始化包一层 try：万一这里出错，也要把错误显示出来，而不是留一个点不动的按钮
try {
  buildModes();
  buildLevels();
  newRun();
  $('tipbox').innerHTML = S.run.level.tip;
  renderStep();
  renderDots();
  paintMeter();
  diagnose();
} catch (e) {
  showBootError('页面初始化失败', (e && e.message) || e);
  throw e;
}

// 调试出口：浏览器控制台里敲 __live.S 就能看到内部状态
window.__live = { S, CFG, step };
