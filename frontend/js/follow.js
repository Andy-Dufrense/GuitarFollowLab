// 跟弹窗口：谱面驱动（下一个该弹的音由时间轴给），弹错了不停、只标红。
//
// 判定用的是"已知答案"那条路：起音当场快照（S 里的抬头率）→ 谱上这个音出现了没有。
// 这里刻意不复用练习模式那套"弹错就不往下走"的状态机 —— 跟弹不能停。

import { rms, midiToName } from './engine/dsp.js?v=0924-2015';
import * as audio from './audio.js';
import {
  track, fluxRelOf, resetAnalysis, novelSpectrum, matchNoteByCandidates,
  verifyExpectedNote, getLastMagsFull, getFluxSpec, getBeforeFluxSpec, RISE_WINDOW,
  chordOutsiders,
} from './engine/analysis.js?v=0924-2015';
import { CFG, FLUX_N } from './engine/config.js?v=0924-2015';

const $ = (id) => document.getElementById(id);
// 数据集由 ?song=chords 选择：默认是 Hey Jude 旋律谱，chords 是示范和弦谱。
const wantChords = new URLSearchParams(location.search).get('song') === 'chords';
const song = await (await fetch(wantChords ? './data/chord_practice.json' : './data/hey_jude.json')).json();
const userBpm = Number($('bpmIn').value) || song.meta.tempo;
const notes = (song.notes || []).slice(0, 60);
const chords = wantChords
  ? song.chords.map((c, i) => ({ ...c, t: (i * 4 * 60) / userBpm, d: (4 * 60) / userBpm }))
  : [];

$('title').textContent = song.meta.title;
$('who').textContent = wantChords
  ? `${song.meta.artist} · 每个和弦 4 拍 · 判定：整组和弦 + 有没有外音`
  : `${song.meta.artist} · ${song.meta.tempo} BPM · ${notes.length} 个音（旋律轨）`;
$('bpm').textContent = `${userBpm} BPM`;

const items = wantChords ? chords : notes;
const cells = items.map((n, i) => {
  const el = document.createElement('div');
  el.className = 'n';
  el.innerHTML = wantChords
    ? `<div class="nm">${n.name}</div><div class="fin">4 拍</div>`
    : `<div class="nm">${midiToName(n.midi)}</div><div class="fin">${n.string}弦${n.fret}品</div>`;
  el.onclick = () => { cursor = i; paint(); };
  $('score').appendChild(el);
  return el;
});

let cursor = 0, good = 0, bad = 0, running = false, raf = 0;
let phase = 'waiting', onsetAtMs = 0, lastOnsetMs = -1e9, rise = null, levelHist = [];
let floor = 0.001, gate = 0.01, frames = 0;

function paint(msg, kind) {
  cells.forEach((el, i) => {
    el.className = 'n' + (i === cursor ? ' now' : '') + (i < cursor ? ' past' : '')
      + (el.dataset.r === 'ok' ? ' ok' : '') + (el.dataset.r === 'bad' ? ' bad' : '');
  });
  cells[cursor]?.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('pos').textContent = `${Math.min(cursor + 1, items.length)}/${items.length}`;
  $('good').textContent = good;
  $('bad').textContent = bad;
  $('prog').style.width = `${(cursor / items.length) * 100}%`;
  if (msg) { $('verdict').textContent = msg; $('verdict').className = 'verdict' + (kind ? ' ' + kind : ''); }
}
paint();

function tick() {
  const buf = audio.readFrame();
  if (!buf) return;
  const lv = rms(buf, buf.length - 1024, 1024);
  frames++;
  if (frames <= 30) floor += (Math.min(lv, 0.05) * 0.9 - floor) * 0.3;
  else if (lv < floor) floor = floor * 0.9 + lv * 0.1;
  else floor = Math.min(floor * 1.0003 + 1e-7, 0.06);
  floor = Math.max(floor, 0.0005);
  gate = Math.max(CFG.absFloor, floor * CFG.onsetSensitivity);

  const flux = fluxRelOf(buf);
  const lagged = levelHist.length >= 3 ? levelHist[levelHist.length - 3] : 0;
  const now = performance.now();
  const onset = lv > gate && (lv > lagged * 1.6 || (flux > 0.16 && lv > lagged * 1.15))
    && now - lastOnsetMs > Math.max(90, CFG.minGapMs);
  levelHist.push(lv);
  if (levelHist.length > 10) levelHist.shift();

  if (onset && phase === 'waiting') {
    const nowSpec = getFluxSpec();
    const prevSpec = getBeforeFluxSpec();
    rise = (nowSpec && prevSpec && nowSpec.length === prevSpec.length)
      ? nowSpec.map((v, i) => v / (prevSpec[i] + 1e-9)) : null;
    phase = 'settling';
    onsetAtMs = now;
    lastOnsetMs = now;
    rise = rise instanceof Float32Array ? rise : Float32Array.from(rise || []);
  }

  // 每 60ms 跟一次本底/显示
  if (now - (tick.last || 0) > 60 && lv > gate * 0.4) {
    tick.last = now;
    const a = track(buf, audio.getDecim(), audio.getRate());
    if (phase === 'settling') {
      const el = items[cursor];
      if (el) {
        const novel = novelSpectrum(a.mags);
        const m = matchNoteByCandidates(novel, audio.getRate(), a.fftN, el.midi);
        const top = m.ranked[0];
        if (top) $('heard').textContent = midiToName(top.midi);
      }
    }
  }

  // 判定：起音后 90ms 出结论（比练习模式快，跟弹不能等太久）
  if (phase === 'settling' && now - onsetAtMs >= 90) {
    const expect = items[cursor];
    phase = 'waiting';
    if (expect) {
      const a = track(buf, audio.getDecim(), audio.getRate());
      const novel = novelSpectrum(a.mags);
      let pass, msg;
      if (wantChords) {
        // 和弦谱不做逐音判：只问"这次起音里有没有和弦外的音"（外音检测）。
        const r = chordOutsiders(novel, audio.getRate(), a.fftN, expect.midis);
        pass = r.ratio >= 0.7;
        msg = pass ? `✓ ${expect.name}（解释 ${(r.ratio * 100).toFixed(0)}%）`
          : `⚠ ${expect.name} 里有和弦外音${r.outsiders[0] ? '（约 ' + r.outsiders[0].hz + 'Hz）' : ''}，继续`;
      } else {
        const v = verifyExpectedNote(novel, null, audio.getRate(), a.fftN, expect.midi,
          rise, (audio.getCtx() ? audio.getCtx().sampleRate : 48000) / FLUX_N);
        pass = v.ratio >= 1.15;
        msg = pass ? `✓ ${midiToName(expect.midi)}` : `✗ 期望 ${midiToName(expect.midi)}（这一下没听到），继续`;
      }
      cells[cursor].dataset.r = pass ? 'ok' : 'bad';
      if (pass) good++; else bad++;
      paint(msg, pass ? 'ok' : 'bad');
      cursor++;                       // 跟弹：不管对错都往下走
      if (cursor >= items.length) { stop(); paint('🎉 整段弹完', 'ok'); }
    }
  }
  raf = requestAnimationFrame(tick);
}

async function start() {
  try { await audio.acquire(); } catch (e) {
    paint('开不了麦克风：' + (e.message || e.name)); return;
  }
  // 自动对拍 · 第一步：四拍提示（用同一个音频时钟排，跟人弹琴一样是稳的）
  const ctx = audio.getCtx();
  if (ctx) {
    // 四拍提示跟着**用户设的速度**走
    const beat = 60 / userBpm;
    for (let i = 0; i < 4; i++) {
      const t = ctx.currentTime + 0.15 + i * beat;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = i === 0 ? 1320 : 880;      // 第一拍重音
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.12);
    }
    paint('四拍后开始 —— 听到第一个音我就跟着走（不卡你，弹快了慢了我都跟）');
  }
  running = true;
  resetAnalysis();
  cursor = 0; good = 0; bad = 0; frames = 0; floor = 0.001; levelHist = [];
  cells.forEach((el) => { delete el.dataset.r; });
  $('btn').textContent = '停止'; $('btn').classList.add('stop');
  raf = requestAnimationFrame(tick);
}

function stop() {
  running = false;
  cancelAnimationFrame(raf);
  audio.release();
  $('btn').textContent = '开始'; $('btn').classList.remove('stop');
}

$('btn').onclick = () => (running ? (stop(), paint('已停止')) : start());
window.__follow = () => ({ cursor, good, bad, phase });
