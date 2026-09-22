// ─────────────────────────────────────────────────────────────────────────────
// 界面层：所有 DOM 读写都在这里。
// 只管"把状态画出来"，不掺判定逻辑，也不碰音频采集。
// ─────────────────────────────────────────────────────────────────────────────

import { midiToName, midiToHz } from './dsp.js';
import { MODES } from './exercises.js';
import { CFG, FLASH_MS } from './config.js';
import { S, mode, step, newRun } from './state.js';
import { permissionState } from './audio.js';

export const $ = (id) => document.getElementById(id);

// ── 判定条 ───────────────────────────────────────────────────────────────────
// verdictToken 用来让"过一会儿恢复成默认文字"这件事在被打断时自动失效
let verdictToken = 0;
export function setVerdict(kind, text) {
  const el = $('verdict');
  el.className = 'verdict ' + kind;
  el.textContent = text;
  verdictToken++;
  return verdictToken;
}

export function restoreVerdictAfter(token, ms, text) {
  setTimeout(() => { if (verdictToken === token) setVerdict('listening', text); }, ms);
}

// 目标音闪一下，给即时反馈（判定结果晚 60ms 才出来，但"听见了"可以立刻显示）
let flashTimer = 0;
export function flashTarget(kind) {
  const el = $('target');
  if (!el || !el.classList) return;
  el.classList.remove('hit', 'ok', 'bad');
  el.classList.add(kind);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('hit', 'ok', 'bad'), kind === 'hit' ? 220 : 500);
}

// ── 练习内容的选择 ───────────────────────────────────────────────────────────
export function buildModes() {
  const host = $('modes');
  host.innerHTML = '';
  MODES.forEach((m, i) => {
    const b = document.createElement('button');
    b.className = 'mode' + (i === S.modeIndex ? ' on' : '');
    b.innerHTML = `${m.name}<small>${m.sub}</small>`;
    b.onclick = () => {
      S.modeIndex = i;
      S.levelIndex = 0;
      newRun();
      S.phase = S.running ? 'waiting' : 'idle';
      document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x === b));
      buildLevels();
      $('tipbox').innerHTML = S.run.level.tip;
      renderStep(); renderDots();
    };
    host.appendChild(b);
  });
}

export function buildLevels() {
  const host = $('levels');
  const m = mode();
  host.innerHTML = '';
  host.style.display = m.levels.length > 1 ? 'flex' : 'none';
  if (m.levels.length < 2) return;
  m.levels.forEach((lv, i) => {
    const b = document.createElement('button');
    b.className = 'level' + (i === S.levelIndex ? ' on' : '');
    b.textContent = lv.name;
    b.onclick = () => {
      S.levelIndex = i;
      newRun();
      S.phase = S.running ? 'waiting' : 'idle';
      document.querySelectorAll('.level').forEach((x) => x.classList.toggle('on', x === b));
      $('tipbox').innerHTML = S.run.level.tip;
      renderStep(); renderDots();
    };
    host.appendChild(b);
  });
}

// ── 主区渲染 ─────────────────────────────────────────────────────────────────
export function renderStep() {
  const ev = step();
  if (!ev) return;
  const inGroup = ev.groupSize > 1 ? ` · 第 ${ev.indexInGroup + 1}/${ev.groupSize} 步` : '';
  $('stepno').textContent = `${ev.groupLabel}${inGroup}`;

  // 技巧类练习：把技巧名字摆到最显眼的位置
  const badge = $('techbadge');
  if (ev.tech) {
    badge.style.display = '';
    badge.textContent = '技巧 · ' + ev.tech;
  } else {
    badge.style.display = 'none';
    badge.textContent = '';
  }

  // 加了变调夹之后，实际该响的音高整体上移
  const capo = CFG.capo || 0;
  const soundMidi = ev.targetMidi + capo;
  $('target').textContent = ev.kind === 'chord' ? ev.name : midiToName(soundMidi);
  $('where').textContent = ev.kind === 'chord'
    ? (capo ? `扫一下这个和弦（变调夹 ${capo} 品，实际是 ${midiToName(48 + capo)} 那一档）` : '扫一下这个和弦')
    : `${ev.where} · ${midiToHz(soundMidi).toFixed(2)} Hz${capo ? `（变调夹 ${capo} 品）` : ''}`;
  $('hintline').textContent = ev.hint || '';

  const fh = $('frets');
  fh.innerHTML = ev.kind === 'chord'
    ? ev.frets.map((f, i) =>
        `<div class="slot${f === 'x' ? ' off' : ''}">${f}<span class="s">${['六', '五', '四', '三', '二', '一'][i]}</span></div>`).join('')
    : '';

  renderPhrase(ev);
  // 注意：这里不清空"听到"那一栏。
  // 弹完一个音之后它应该停在刚弹的那个音上，直到下一个音被听见 ——
  // 每换一步就清成"—"的话，用户会觉得"刚弹对了就没了"。
  setVerdict(S.running ? 'listening' : 'idle', S.running ? '弹吧' : '点下面的按钮开始，会请求麦克风权限');
}

// 当前这一组的全部步骤，走到哪高亮到哪
function renderPhrase(ev) {
  const wrap = $('phrasewrap');
  if (ev.groupSize < 2) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  $('phraselabel').textContent = `${ev.groupLabel} · 共 ${ev.groupSize} 步`;
  $('phrase').innerHTML = ev.groupEvents.map((g, i) => {
    const tag = g.tag || (g.kind === 'chord' ? String(i + 1) : '');
    const cls = i < ev.indexInGroup ? 'ok' : i === ev.indexInGroup ? 'now' : '';
    return `<div class="pchip ${cls}"><b>${g.name}</b>${tag ? `<span>${tag}</span>` : ''}</div>`;
  }).join('');
}

export function renderDots() {
  if (!S.run) return;
  const { flat, groupCount } = S.run;
  const state = [];
  for (let g = 0; g < groupCount; g++) {
    const idx = [];
    for (let i = 0; i < flat.length; i++) if (flat[i].groupIndex === g) idx.push(i);
    if (idx.some((i) => S.results[i] === 'bad')) state[g] = 'bad';
    else if (idx.every((i) => S.results[i] === 'ok')) state[g] = 'ok';
    else if (S.running && idx.includes(S.pos)) state[g] = 'now';
    else state[g] = '';
  }
  $('dots').innerHTML = state.map((s, i) => `<div class="dot ${s}">${i + 1}</div>`).join('');
  $('recent').innerHTML = S.log.slice(-4).map((x) => `<div>${x}</div>`).join('');
}

export function bump(mark) {
  S.results[S.pos] = mark;
  renderDots();
  if (mark === 'ok' || mark === 'bad') flashTarget(mark);
}

export function logResult(text) {
  S.log.push(text);
  if (S.log.length > 20) S.log.shift();
  renderDots();
}

export function paintMeter() {
  const scale = Math.max(0.05, S.gate * 4);
  $('levelfill').style.width = Math.min(100, (S.level / scale) * 100) + '%';
  $('gatemark').style.left = Math.min(98, (S.gate / scale) * 100) + '%';
  $('lvlnum').textContent = S.level.toFixed(4);
  $('gatenum').textContent = S.gate.toFixed(4);
  if ($('floornum')) $('floornum').textContent = S.floor.toFixed(4);
}

export function paintHeard(pitch, ev) {
  $('heardval').textContent = midiToName(pitch.midi);
  if (ev && ev.kind === 'note') {
    const c = Math.round((pitch.midi - ev.targetMidi) * 100);
    $('heardcents').textContent = `${c > 0 ? '+' : ''}${c} 音分`;
  } else {
    $('heardcents').textContent = `${pitch.hz.toFixed(1)} Hz`;
  }
}

// 节拍器的四拍指示灯
export function paintBeats(idx) {
  const kids = $('beats').children;
  for (let i = 0; i < kids.length; i++) {
    kids[i].className = i === idx ? (i === 0 ? 'on accent' : 'on') : '';
  }
}

export function showBootError(title, detail) {
  const el = document.getElementById('bootfail');
  if (!el) return;
  el.innerHTML = `<b>${title}</b><br>${detail}<div class="ua"></div>`;
  el.querySelector('.ua').textContent = navigator.userAgent || '';
  el.style.display = 'block';
}

// ── 麦克风诊断面板 ───────────────────────────────────────────────────────────
export async function diagnose(err) {
  if (err) S.lastError = err;
  const out = [];
  const secure = window.isSecureContext;

  // 顺便问服务器要一下局域网地址，下面好几处提示都要用
  let info = null, ip = null;
  try {
    info = await (await fetch('/cert-info')).json();
    ip = (info.lanIPs || [])[0] || null;
  } catch (e) { /* 拿不到就用通用文案 */ }

  if (window.__inAppBrowser) {
    out.push(`<div class="dg-bad">✗ 你现在在微信/QQ 这类内置浏览器里。
      它们普遍不给麦克风权限，页面脚本也常常跑不起来。
      请点右上角「⋯」→「在浏览器中打开」。</div>`);
  }
  out.push(`<div class="${secure ? 'dg-ok' : 'dg-bad'}">${secure ? '✓' : '✗'} 安全上下文：${secure ? '是' : '否'}
    <span class="dg-note">${location.origin}</span></div>`);
  if (!secure) {
    out.push(`<div class="dg-hint">浏览器只在 <b>https</b> 或 <b>localhost</b> 下才给麦克风权限，
      你现在这个地址不算，所以怎么点都没用。电脑上请用 http://localhost:1209。</div>`);
    if (info && ip && info.httpsReady) {
      out.push(`<div class="dg-hint"><b>安卓手机上最简单的办法（不用装证书）：</b><br>
        ① 地址栏输入 <b>chrome://flags/#unsafely-treat-insecure-origin-as-secure</b><br>
        ② 把那一项改成 Enabled，在下面的输入框里填 <b>http://${ip}:${info.httpPort}</b><br>
        ③ 按提示重启浏览器，还是用这个 http 地址打开，麦克风就能用了</div>`);
      out.push(`<div class="dg-hint"><b>iPhone 或者别的浏览器：装证书</b><br>
        ① <a class="dg-link" href="/local.cer">下载证书 local.cer</a>，按系统提示装成 CA 证书<br>
        ② 改用 <b>https://${ip}:${info.httpsPort}</b> 打开</div>`);
    } else if (info && ip) {
      out.push(`<div class="dg-hint">想在手机上用，先在电脑上双击一次 <b>make-cert.bat</b> 生成证书，
        然后用 https://${ip}:${info.httpsPort} 打开。</div>`);
    }
  } else {
    out.push(`<div class="dg-ok">✓ 这个地址是安全的，浏览器会给麦克风权限</div>`);
  }

  const hasApi = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  out.push(`<div class="${hasApi ? 'dg-ok' : 'dg-bad'}">${hasApi ? '✓' : '✗'} 麦克风接口：${hasApi ? '可用' : '不可用'}</div>`);

  const ps = await permissionState();
  if (ps) {
    const psText = { granted: '已允许', denied: '已拒绝（浏览器不会再弹授权框）', prompt: '还没问过' }[ps] || ps;
    out.push(`<div class="${ps === 'denied' ? 'dg-bad' : 'dg-ok'}">${ps === 'denied' ? '✗' : '✓'} 站点麦克风权限：${psText}</div>`);
    if (ps === 'denied') {
      out.push(`<div class="dg-hint"><b>办法一：两个地方的权限都要查</b><br>
        ① 浏览器里：地址栏左边的图标（锁 / 盾牌 / 调节图标）→ 权限 / 网站设置 → 麦克风 → 允许。
        找不到这个开关，就在浏览器的清除数据里勾上"网站设置"清一次。<br>
        ② 手机系统：<b>设置 → 应用（应用管理）→ 找到你现在用的浏览器 → 权限 → 麦克风 → 允许</b>。
        国产 ROM 经常默认把浏览器的麦克风权限关掉，这条比上一条更容易中招。</div>`);
      out.push(`<div class="dg-hint"><b>办法二：换个端口，等于换了个站点</b><br>
        浏览器按"协议+域名+端口"记站点权限，端口一变就是全新站点，会重新问一次。
        但这招只解决①，解决不了系统层那条。<br>
        电脑上关掉服务，改成跑 <b>start.bat 1211</b>，
        手机上改开 <b>https://${ip || '<电脑IP>'}:1212</b>。</div>`);
      out.push(`<div class="dg-hint"><b>办法三（最省事）：换个浏览器</b><br>
        手机自带浏览器对 Web Audio 和麦克风的支持经常缺斤少两。
        用 <b>Chrome</b> 或 <b>Edge</b> 打开同一个地址
        <b>https://${ip || '<电脑IP>'}:${(info && info.httpsPort) || 1210}</b>，
        证书是同一张，不用重装。</div>`);
    }
  } else {
    out.push(`<div class="dg-note">站点麦克风权限：这个浏览器查不到（不影响使用）</div>`);
  }

  if (hasApi) {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const ins = devs.filter((d) => d.kind === 'audioinput');
      out.push(`<div class="${ins.length ? 'dg-ok' : 'dg-bad'}">${ins.length ? '✓' : '✗'} 检测到 ${ins.length} 个音频输入设备</div>`);
      ins.forEach((d) => out.push(`<div class="dg-note">· ${d.label || '（授权后才显示名字）'}</div>`));
      if (!ins.length) {
        out.push(`<div class="dg-hint">这台设备上没有任何麦克风。插一个 USB 麦克风，或者用带麦克风的耳机。</div>`);
      }
    } catch (e) {
      out.push(`<div class="dg-bad">列举设备失败：${e.name}</div>`);
    }
  }
  if (S.lastError) {
    out.push(`<div class="dg-bad">上次错误：<b>${S.lastError.name}</b> ${S.lastError.message || ''}</div>`);
  }
  out.push(`<div class="dg-note">浏览器：${(navigator.userAgent || '').slice(0, 90)}</div>`);
  $('diagbody').innerHTML = out.join('');
}

// 麦克风开不了时的统一出口：报错 + 展开说明面板（别让人以为是"点了没反应"）
export async function micFail(msg, err) {
  setVerdict('bad', msg);
  $('btnStart').textContent = '开始';
  await diagnose(err);
  const box = $('diagbox');
  if (box) {
    box.open = true;
    try { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* 老浏览器忽略掉 */ }
  }
}

export function flashRestore(token, text) {
  restoreVerdictAfter(token, FLASH_MS, text);
}
