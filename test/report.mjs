// 把一段录音的分析结果**画成一张网页**，用眼睛看判定到底看见了什么。
//
// 用法：
//   node test/report.mjs sound_data/f32/xxx.f32        （也可直接给 m4a 转出来的 f32）
//   然后打开同目录下生成的 report-xxx.html
//
// 页面上有三块：
//   1. 波形 + 每一次起音的位置（颜色 = 判定结果）——"它到底在哪里听见了东西"；
//   2. 逐次起音的表：电平/门限/周期性/量到的音/判成了什么；
//   3. 每个起音前后的频谱对照（起音前 / 起音后 / **差分**）——
//      差分（后减前）就是"这一下新加进来的东西"，正是用来分辨
//      "新拨了一下"和"上一个音还在响"的那份谱。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const file = process.argv[2];
if (!file) { console.error('用法： node test/report.mjs <录音.f32>'); process.exit(2); }
const abs = path.resolve(root, file);
const raw = fs.readFileSync(abs);
const AUDIO = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const SR = 48000;

// ① 跑一遍判定链路，拿起音台帐（和手机上跑的是同一套代码）
const data = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(here, 'test-follow-real.mjs'), abs],
    { cwd: root, env: { ...process.env, VC_JSON: '1' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', () => {});
  p.on('close', () => {
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    try { resolve(line ? JSON.parse(line.slice(7)) : null); } catch (e) { resolve(null); }
  });
});
if (!data) { console.error('判定链路没跑出结果'); process.exit(1); }

// ② 波形（按峰值抽稀）
const COLS = 1600;
const step = Math.max(1, Math.floor(AUDIO.length / COLS));
const peaks = [];
for (let c = 0; c < COLS; c++) {
  let mx = 0;
  for (let i = c * step; i < Math.min(AUDIO.length, (c + 1) * step); i += 7) {
    const v = Math.abs(AUDIO[i]);
    if (v > mx) mx = v;
  }
  peaks.push(mx);
}
const maxPeak = Math.max(1e-6, ...peaks);
const dur = AUDIO.length / SR;
const xOf = (t) => (t / dur) * 1000;
const yOf = (v) => 100 - (v / maxPeak) * 95;

// ③ 频谱对照（每个起音：前 170ms / 后 170ms / 差分）
const { spectrumOf } = await import('file:///E:/GuitarFollowLab/frontend/js/dsp.js');
const N = 8192;

// ④ 声谱图：横轴时间、纵轴频率、亮度=强度。看它就是"用眼睛看声音"。
// 拨一下 → 一排竖直的谐波线；按住不放 → 一条持续的水平带；两个快音 → 两组紧挨着的竖线。
const SG_N = 2048, SG_HOP = 512;                       // 43ms 窗、10.7ms 一跳
const SG_BINS = Math.round(4000 / (SR / SG_N));        // 只画 0~4kHz
const frames = Math.max(1, Math.floor((AUDIO.length - SG_N) / SG_HOP));
const sgFrames = [];
let sgMax = 1e-9;
for (let f = 0; f < frames; f++) {
  const mags = spectrumOf(AUDIO.subarray(f * SG_HOP, f * SG_HOP + SG_N));
  const arr = new Float32Array(SG_BINS);
  for (let b = 0; b < SG_BINS; b++) {
    arr[b] = mags[b] || 0;
    if (arr[b] > sgMax) sgMax = arr[b];
  }
  sgFrames.push(arr);
}
const sg = new Uint8Array(frames * SG_BINS);
for (let f = 0; f < frames; f++) {
  for (let b = 0; b < SG_BINS; b++) {
    // dB 量化：-60dB 到 0dB 映射到 0~255（对数刻度才看得清弱谐波）
    const db = 20 * Math.log10((sgFrames[f][b] || 1e-9) / sgMax);
    sg[f * SG_BINS + b] = Math.max(0, Math.min(255, Math.round((db + 60) / 60 * 255)));
  }
}
const sgB64 = Buffer.from(sg).toString('base64');
function specAround(t) {
  const at = (endSec) => {
    const end = Math.round(endSec * SR);
    const o = new Float32Array(N);
    for (let i = 0; i < N; i++) { const j = end - N + i; if (j >= 0 && j < AUDIO.length) o[i] = AUDIO[j]; }
    return o;
  };
  return { before: spectrumOf(at(t - 0.02)), after: spectrumOf(at(t + 0.13)) };
}

const onsets = data.onsets2 || [];
const notes = data.log || [];

const oscLine = (id, pts, color) =>
  `<polyline fill="none" stroke="${color}" stroke-width="1" points="${pts}"/>`;

function spectrumSvg(t, idx) {
  const { before, after } = specAround(t);
  const bins = 900;
  const lo = 1, hi = Math.min(before.length, Math.round(4000 / (SR / N)));
  const norm = Math.max(...Array.from(after).slice(lo, hi), 1e-9);
  const P = (arr, color) => {
    const pts = [];
    for (let i = 0; i < bins; i++) {
      const b = lo + Math.floor((i / bins) * (hi - lo));
      const v = Math.min(1, arr[b] / norm);
      pts.push(`${(i / bins) * 1000},${ySvg(v)}`);
    }
    return oscLine('', pts.join(' '), color);
  };
  const diff = new Float32Array(after.length);
  for (let i = 0; i < after.length; i++) diff[i] = Math.max(0, after[i] - before[i]);
  return `<svg viewBox="0 0 1000 120" style="width:100%;height:120px;background:#111">`
    + P(before, '#666') + P(after, '#4c9') + P(diff, '#e95')
    + `<text x="6" y="14" fill="#ccc" font-size="12">#${idx + 1} t=${t.toFixed(2)}s　`
    + `<tspan fill="#666">■</tspan>起音前 <tspan fill="#4c9">■</tspan>起音后 `
    + `<tspan fill="#e95">■</tspan>差分（后−前 = 新加进来的）　横轴 0~4kHz</text></svg>`;
}
const ySvg = (v) => 115 - v * 100;

const rows = onsets.map((o, i) => {
  const col = o.result === 'ok' ? '#2e7d32' : o.dropped ? '#888' : '#c62828';
  return `<tr><td>${i + 1}</td><td>${o.t}</td><td>${o.level}</td><td>${o.gate ?? ''}</td>`
    + `<td>${o.clarity ?? '—'}</td><td>${o.hnr ?? ''}</td>`
    + `<td>${o.expect ?? ''}</td><td>${o.measured ?? o.dropped ?? '—'}</td>`
    + `<td style="color:${col}">${o.result || o.dropped || '—'}</td></tr>`;
}).join('\n');

const wave = peaks.map((v, i) => `${(i / COLS) * 1000},${yOf(v)}`).join(' ');
const marks = onsets.map((o, i) => {
  const col = o.result === 'ok' ? '#2e7d32' : o.dropped ? '#999' : '#c62828';
  return `<line x1="${xOf(o.t)}" y1="0" x2="${xOf(o.t)}" y2="100" stroke="${col}" stroke-width="0.7" opacity="0.85"/>`;
}).join('');

const detail = onsets.slice(0, 10).map((o, i) => spectrumSvg(o.t, i)).join('\n');

const html = `<!doctype html><meta charset="utf-8"><title>分析：${path.basename(abs)}</title>
<style>body{font:13px/1.5 system-ui;background:#fafafa;color:#222;margin:16px}
svg{display:block}table{border-collapse:collapse;font-variant-numeric:tabular-nums}
td,th{border:1px solid #ddd;padding:2px 6px;text-align:right}th{background:#eee}
.sum{font-size:15px;margin:8px 0 14px}</style>
<h2>${path.basename(abs)}　<span style="color:#666;font-size:14px">${dur.toFixed(1)}s</span></h2>
<div class="sum">起音 ${data.onsets} 次　<span style="color:#2e7d32">对 ${data.good}</span>
　<span style="color:#c62828">错 ${data.bad}</span>　测不准 ${data.unclear}　漏 ${data.missed}</div>
<h3>声谱图（横轴时间、纵轴频率 0~4kHz、越亮越强）</h3>
<div style="font-size:12px;color:#666">拨一下 = 一排竖直的谐波线；按住不放 = 一条持续的水平带；
两个挨得近的音 = 两组紧挨着的竖线。红色竖线是判定链路认为的"起音"。</div>
<canvas id="sg" style="width:100%;height:340px;background:#000;border:1px solid #ccc"></canvas>
<script>
const W=${frames}, H=${SG_BINS}, HOP=${(SG_HOP / SR * 1000).toFixed(2)}, MAXHZ=4000;
const raw=Uint8Array.from(atob(${JSON.stringify(sgB64)}), c=>c.charCodeAt(0));
const onsets=${JSON.stringify(onsets.map((o) => ({ t: o.t, r: !!o.result, d: !!o.dropped })))};
const cv=document.getElementById('sg'), ctx=cv.getContext('2d');
cv.width=W; cv.height=H;
const img=ctx.createImageData(W,H);
for(let x=0;x<W;x++){
  for(let y=0;y<H;y++){
    const v=raw[x*H+(H-1-y)]/255;            // 纵轴翻过来：低频在下
    const i=(y*W+x)*4;
    img.data[i]=Math.min(255,Math.round(v*255*1.2));      // R
    img.data[i+1]=Math.min(255,Math.round(Math.pow(v,1.4)*255));  // G
    img.data[i+2]=Math.min(255,Math.round(Math.pow(v,3.5)*255));  // B（弱信号偏红，强信号发白）
    img.data[i+3]=255;
  }
}
ctx.putImageData(img,0,0);
const totalSec=W*HOP/1000;
for(const o of onsets){
  const x=Math.round(o.t/totalSec*W);
  ctx.fillStyle = o.d ? 'rgba(180,180,180,.9)' : (o.r ? 'rgba(60,220,90,.95)' : 'rgba(255,60,60,.95)');
  ctx.fillRect(x,0,1,H);
}
</script>
<div style="font-size:12px;color:#666">纵轴刻度：4kHz 在顶部、0 在底部。整张图横跨 0~${dur.toFixed(1)}s。</div>
<div style="font-size:12px;color:#666">波形 + 起音位置（绿=判对 灰=当成噪声丢掉 红=判错）</div>
<svg viewBox="0 0 1000 100" style="width:100%;height:150px;background:#fff;border:1px solid #eee">
${oscLine('', wave, '#9cf')}${marks}</svg>
<h3>逐次起音</h3>
<table><tr><th>#</th><th>时刻s</th><th>电平</th><th>门限</th><th>周期性</th><th>谐噪比</th>
<th>期望</th><th>量到</th><th>结果</th></tr>${rows}</table>
<h3>前 10 个起音的频谱对照</h3>
<div style="font-size:12px;color:#666;margin-bottom:6px">
差分那条（橙）就是"这一下新加进来的东西"。如果橙线上能看到一根根立着的谱线 →
说明这一下是一根弦（能单独量出音高）；如果橙线是毛的 → 那一下更像噪声/瞬态。</div>
${detail}`;

const outPath = path.join(path.dirname(abs), 'report-' + path.basename(abs).replace(/\.[^.]+$/, '') + '.html');
fs.writeFileSync(outPath, html);
console.log('已生成：' + outPath);
console.log('用浏览器打开它就能看到波形、每次起音、以及每个起音前后的频谱与差分。');
