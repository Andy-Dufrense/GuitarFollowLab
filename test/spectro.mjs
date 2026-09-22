// 把若干段录音画成一张**可以放大**的声谱图网页（文字尽量少，图尽量大）。
//
// 用法： node test/spectro.mjs sound_data/f32/*.f32        （不给参数就扫 sound_data/f32）
// 生成  sound_data/f32/看频谱.html  ——  浏览器打开：
//   · 滚轮 = 放大/缩小（时间轴，以鼠标位置为中心）
//   · 拖动 = 平移（上下也能拖，因为放大后要上下看）
//   · 双击 = 复原
//   · 按 O = 显示/隐藏判定链路认为的起音位置

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ── 极简 PNG 编码（不引依赖）：任何看图软件都能打开、都能放大 ────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function writePng(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}
// 色标：黑 → 蓝 → 紫 → 橙 → 白
function ramp(v) {
  const stops = [[0, 0, 0, 0], [0.18, 20, 20, 90], [0.42, 90, 20, 120], [0.68, 220, 90, 20], [0.86, 255, 200, 80], [1, 255, 255, 255]];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], t = (v - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  return [255, 255, 255];
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const { spectrumOf } = await import('file:///E:/GuitarFollowLab/frontend/js/dsp.js');

let files = process.argv.slice(2);
if (!files.length) {
  const dir = path.join(root, 'sound_data', 'f32');
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.f32')).map((f) => path.join(dir, f));
}
const SR = 48000, N = 2048, HOP = 512, MAX_HZ = 3000;
const BINS = Math.round(MAX_HZ / (SR / N));

const clips = [];
for (const f of files) {
  const abs = path.resolve(root, f);
  if (!fs.existsSync(abs)) continue;
  const raw = fs.readFileSync(abs);
  const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const frames = Math.max(1, Math.floor((A.length - N) / HOP));
  const spec = new Float32Array(frames * BINS);
  let mx = 1e-9;
  for (let i = 0; i < frames; i++) {
    const mags = spectrumOf(A.subarray(i * HOP, i * HOP + N));
    for (let b = 0; b < BINS; b++) {
      const v = mags[b] || 0;
      spec[i * BINS + b] = v;
      if (v > mx) mx = v;
    }
  }
  const out = new Uint8Array(frames * BINS);
  for (let i = 0; i < out.length; i++) {
    const db = 20 * Math.log10((spec[i] || 1e-9) / mx);
    out[i] = Math.max(0, Math.min(255, Math.round((db + 70) / 70 * 255)));
  }
  clips.push({
    name: path.basename(abs, '.f32'), seconds: A.length / SR,
    data: {
      index: clips.length, frames, bins: BINS,
      hopMs: (HOP / SR) * 1000, b64: Buffer.from(out).toString('base64'),
      // 低频带（150~600Hz，基频所在）的能量包络 —— **这就是你眼睛在看的那条曲线**：
      // 一坨连续的 = 延音；两坨中间掉下去 = 两次拨弦。5ms 一个点，量化成 0~255。
      env: (() => {
        const EN = 1024, EH = 240, lo = Math.max(1, Math.floor(150 / (SR / EN))), hi = Math.ceil(600 / (SR / EN));
        const vals = [];
        for (let i = 0; i + EN < A.length; i += EH) {
          const mags = spectrumOf(A.subarray(i, i + EN));
          let s = 0;
          for (let b = lo; b <= hi; b++) s += mags[b] * mags[b];
          vals.push(Math.sqrt(s / (hi - lo + 1)));
        }
        const mx = Math.max(...vals) || 1e-9;
        const db = vals.map((v) => 20 * Math.log10(Math.max(v, 1e-12) / mx));   // 0dB = 本段最强
        return {
          hopMs: (EH / SR) * 1000,
          db,
          quant: db.map((v) => Math.max(0, Math.min(255, Math.round((v + 60) / 60 * 255)))),
        };
      })(),
    },
    // PNG 用：原始量化数据 + 尺寸信息
    pngData: out, frames, bins: BINS, hopMs: (HOP / SR) * 1000, seconds: A.length / SR,
  });
  console.log(`${path.basename(abs)}  ${(A.length / SR).toFixed(2)}s  ${frames}×${BINS}`);
}

// ── 按"眼睛"的方式找起音：低频能量曲线上的**峰高 + 中间有没有真的掉下去** ───────
// 用户的原话："每次起音达到的峰值是不一样的……噪音起音达到的峰都很小"
//             "上一个音从峰值开始下降，下一个音的峰值把图抬高了"
// 所以两条门槛：
//   ① 峰的高度：必须在**本段最强峰以下 PEAK_DB 以内**（真拨弦都是响的，噪声晃动的峰很小）；
//   ② 两个峰之间必须真的掉下去过（DIP_DB），否则算同一个音的延续。
// 用户看完标记后的两条补充：
//   ① "多的那些都是弱峰" → 峰高门槛从 22dB 收到 12dB；
//   ② "真正的拨弦有延续性/热感" → 峰之后要有一段还亮着的尾巴（噪声只是一下就没了）。
const PEAK_DB = 12;     // 峰高门槛（相对本段最强峰）
const DIP_DB = 6;       // 两峰之间至少掉这么多 dB 才算两次
const MERGE_MS = 70;    // 这么近的两个峰算同一个音
const TAIL_DB = 15;     // 尾巴判据：峰后这段时间里，能量要一直不低于"峰 - TAIL_DB"
const TAIL_MS = 90;
for (const c of clips) {
  const env = c.data.env;
  const db = env.db, hop = env.hopMs;
  const S = 4;                                        // ±20ms 平滑，滤掉 5ms 尺度的抖动
  const sm = db.map((_, i) => {
    let s = 0, n = 0;
    for (let k = i - S; k <= i + S; k++) if (k >= 0 && k < db.length) { s += db[k]; n++; }
    return s / n;
  });
  const peaks = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] < -PEAK_DB) continue;                   // ① 峰不够高
    let isMax = true;
    for (let k = i - 3; k <= i + 3; k++) if (k >= 0 && k < sm.length && sm[k] > sm[i]) { isMax = false; break; }
    if (!isMax) continue;
    const last = peaks[peaks.length - 1];
    if (last && (i - last.i) * hop < MERGE_MS) { if (sm[i] > sm[last.i]) peaks[peaks.length - 1] = { i, db: sm[i] }; continue; }
    if (last) {                                       // ② 中间掉下去过没有
      let mn = Infinity;
      for (let k = last.i; k <= i; k++) mn = Math.min(mn, sm[k]);
      if (Math.min(last.db, sm[i]) - mn < DIP_DB) { if (sm[i] > last.db) peaks[peaks.length - 1] = { i, db: sm[i] }; continue; }
    }
    // ② 尾巴：峰之后 90ms 内，能量不能掉到"峰 - 15dB"以下（否则是噪声/瞬态，不是拨弦）
    const nTail = Math.round(TAIL_MS / hop);
    let tailOk = true;
    for (let k = i + 1; k <= Math.min(sm.length - 1, i + nTail); k++) {
      if (sm[k] < sm[i] - TAIL_DB) { tailOk = false; break; }
    }
    if (!tailOk) { if (sm[i] > (peaks[peaks.length - 1] || {}).db) continue; continue; }
    peaks.push({ i, db: sm[i] });
  }
  c.peaks = peaks.map((p) => ({ t: +(p.i * hop / 1000).toFixed(3), db: +p.db.toFixed(1) }));
  console.log(`${path.basename(c.name).padEnd(24)} 起音 ${c.peaks.length} 次  `
    + c.peaks.slice(0, 12).map((p) => `${p.t.toFixed(2)}s(${p.db}dB)`).join(' '));
}

// ── 同时输出大尺寸 PNG：每个片段一张，横轴时间、纵轴频率（下=0，上=3kHz）──
const SX = Math.max(2, Math.min(6, Math.round(4200 / Math.max(...clips.map((c) => c.frames)))));
const SY = 7;
const AXIS = 26;                       // 底部留给时间刻度
const pngs = [];
for (const c of clips) {
  const W = c.frames * SX, H = c.bins * SY + AXIS;
  const rgb = new Uint8Array(W * H * 3);
  for (let x = 0; x < c.frames; x++) {
    for (let b = 0; b < c.bins; b++) {
      const v = c.pngData[x * c.bins + b] / 255;
      const [r, g, bl] = ramp(v);
      for (let dy = 0; dy < SY; dy++) {
        const y = (c.bins - 1 - b) * SY + dy;          // 低频在下
        for (let dx = 0; dx < SX; dx++) {
          const k = (y * W + x * SX + dx) * 3;
          rgb[k] = r; rgb[k + 1] = g; rgb[k + 2] = bl;
        }
      }
    }
  }
  // 刻度：时间每 0.5 秒一根短白线；频率每 500Hz 一根短白线（只在最左边）
  const secPerCol = c.hopMs / 1000;
  for (let s = 0; s < c.seconds; s += 0.5) {
    const x = Math.round(s / secPerCol) * SX;
    for (let dy = 0; dy < 10; dy++) for (let dx = 0; dx < 2; dx++) {
      const y = c.bins * SY + AXIS - 1 - dy;
      if (x + dx < W) { const k = (y * W + x + dx) * 3; rgb[k] = 255; rgb[k + 1] = 255; rgb[k + 2] = 255; }
    }
  }
  for (let hz = 500; hz <= 3000; hz += 500) {
    const b = Math.round(hz / (SR / N));
    const y = (c.bins - 1 - b) * SY;
    for (let dx = 0; dx < 10; dx++) for (let dy = 0; dy < 2; dy++) {
      if (y + dy < H) { const k = ((y + dy) * W + dx) * 3; rgb[k] = 255; rgb[k + 1] = 255; rgb[k + 2] = 255; }
    }
  }
  const outPng = path.join(root, 'sound_data', 'f32', c.name + '.png');
  writePng(outPng, W, H, rgb);
  pngs.push(outPng);
  console.log(`PNG ${path.basename(outPng)}  ${W}×${H}`);
}

const html = `<!doctype html><meta charset="utf-8"><title>看频谱</title>
<style>
 body{margin:0;background:#0b0b0d;color:#ddd;font:12px system-ui}
 .c{padding:6px 10px 14px}
 .t{color:#9ab;margin:0 0 4px}
 canvas{width:100%;display:block;background:#000;cursor:crosshair}
 .hint{color:#667;font-size:13px;line-height:1.6}
 button{background:#222;color:#cde;border:1px solid #345;border-radius:4px;padding:2px 8px;margin-right:4px;cursor:pointer}
</style>
<div class="c"><div class="hint">滚轮缩放 · 拖动平移 · 双击看全宽<br>
<b>如果下面的图是黑的：说明这个页面被 Internet Explorer 打开了 —— 请用 Microsoft Edge 打开这个网址：http://localhost:1209/spectro.html</b></div></div>
${clips.map((c, i) => `<div class="c"><p class="t"><b>${c.name}</b>　全长 ${c.seconds.toFixed(2)}s
<button onclick="ZOOM(${i},-1)">＋</button><button onclick="ZOOM(${i},1)">－</button>
<button onclick="FULL(${i})">全宽</button>
<button onclick="HEAD(${i})">前3秒</button></p>
<canvas id="c${i}" data-i="${i}"></canvas>
<div class="hint">↑ 低频带（150~600Hz）能量曲线 —— 这是"延音 / 两个音"最直观的那条线：掉下去再上来就是一次新拨弦</div>
<canvas id="e${i}" data-e="${i}" style="height:130px"></canvas>
<div class="hint">↑ 鼠标在这张图上左右移动 → 下面画出那一刻的频谱曲线（灰=‑30ms 绿=当前 橙=+30ms）</div>
<canvas id="s${i}" data-s="${i}" style="height:300px"></canvas></div>`).join('')}
<script>
const CLIPS = ${JSON.stringify(clips)};
const CTX = [];
const RAMP = (()=>{ // 黑→蓝→紫→橙→白
  const stops=[[0,0,0,0],[.18,20,20,90],[.42,90,20,120],[.68,220,90,20],[.86,255,200,80],[1,255,255,255]];
  return v=>{
    for(let i=1;i<stops.length;i++){
      if(v<=stops[i][0]){
        const a=stops[i-1], b=stops[i], t=(v-a[0])/(b[0]-a[0]);
        return [a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t, a[3]+(b[3]-a[3])*t];
      }
    }
    return [255,255,255];
  };
})();
for (const c of CLIPS) {
  const cv = document.getElementById('c'+c.data.index);
  const raw = Uint8Array.from(atob(c.data.b64), ch=>ch.charCodeAt(0));
  const off = document.createElement('canvas'); off.width=c.data.frames; off.height=c.data.bins;
  const octx = off.getContext('2d'); const im = octx.createImageData(off.width, off.height);
  for (let x=0;x<off.width;x++) for (let y=0;y<off.height;y++) {
    const v = raw[x*off.height + (off.height-1-y)]/255;
    const [r,g,b] = RAMP(v); const k=(y*off.width+x)*4;
    im.data[k]=r; im.data[k+1]=g; im.data[k+2]=b; im.data[k+3]=255;
  }
  octx.putImageData(im,0,0);
  const ctx = cv.getContext('2d');
  cv.width = 1800; cv.height = 440;
  // 默认只显示前 3 秒：快音那种"两下只差一两百毫秒"的东西，全宽看就是糊在一起
  const head = Math.min(off.width, Math.round(3 / (c.data.hopMs / 1000)));
  const view = {x0:0, x1:head, y0:0, y1:off.height};
  CTX[c.data.index] = { view, off, c, draw: () => draw() };
  let showOnsets = false;
  const onsets = null;   // 这批录音和谱面对不上，不叠判定线，只看声音本身
  function draw(){
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle='#000'; ctx.fillRect(0,0,cv.width,cv.height);
    ctx.drawImage(off, view.x0, view.y0, view.x1-view.x0, view.y1-view.y0, 0,0,cv.width,cv.height);
    // 时间刻度
    const spanS = (view.x1-view.x0)*c.data.hopMs/1000;
    const stepS = spanS>6?1:(spanS>2?0.5:(spanS>0.6?0.1:0.02));
    ctx.fillStyle='#9cf'; ctx.font='13px system-ui';
    for (let s=0; s<=spanS+1e-9; s+=stepS) {
      const px = (s/spanS)*cv.width;
      ctx.fillRect(px, 0, 2, 12);
      ctx.fillText((view.x0*c.data.hopMs/1000+s).toFixed(2)+'s', px+3, 16);
    }
    // 左边频率刻度（500Hz 一根）
    ctx.fillStyle='rgba(160,200,240,.9)';
    for (let hz=500; hz<3000; hz+=500) {
      const b = hz/(48000/2048);
      const y = ((off.height-1-b)/(view.y1-view.y0)-view.y0/(view.y1-view.y0))*cv.height;
      if (y<0||y>cv.height) continue;
      ctx.fillRect(0,y,10,2);
      ctx.font='12px system-ui';
      ctx.fillText((hz/1000)+'k', 12, y+4);
    }
    if (showOnsets && onsets) {
      ctx.fillStyle='rgba(80,255,120,.9)';
      for (const t of onsets) {
        const f = t*1000/c.data.hopMs;
        if (f<view.x0||f>view.x1) continue;
        ctx.fillRect(((f-view.x0)/(view.x1-view.x0))*cv.width, 0, 1, cv.height);
      }
    }
  }
  draw();
  cv.onwheel = (e)=>{ e.preventDefault();
    const r=cv.getBoundingClientRect(), px=(e.clientX-r.left)/r.width;
    const k = e.deltaY>0 ? 1.18 : 1/1.18;
    const cx = view.x0 + px*(view.x1-view.x0);
    let n = (view.x1-view.x0)*k;
    n = Math.max(20, Math.min(off.width, n));
    view.x0 = Math.max(0, cx - px*n); view.x1 = Math.min(off.width, view.x0+n);
    view.x0 = Math.max(0, view.x1-n);
    if (e.shiftKey) { const cy=(view.y0+view.y1)/2, m=(view.y1-view.y0)*k;
      view.y0=Math.max(0,cy-m/2); view.y1=Math.min(off.height,view.y0+m); }
    CTX[c.data.index].draw();
  };
  let drag=null;
  cv.onmousedown=(e)=>{ drag={x:e.clientX,y:e.clientY,v0:{...view}}; };
  window.addEventListener('mouseup',()=>{drag=null;});
  window.addEventListener('mousemove',(e)=>{ if(!drag)return;
    const r=cv.getBoundingClientRect();
    const dx=(e.clientX-drag.x)/r.width*(drag.v0.x1-drag.v0.x0);
    const dy=(e.clientY-drag.y)/r.height*(drag.v0.y1-drag.v0.y0);
    const w=drag.v0.x1-drag.v0.x0, h=drag.v0.y1-drag.v0.y0;
    view.x0=Math.max(0,Math.min(off.width-w,drag.v0.x0-dx)); view.x1=view.x0+w;
    view.y0=Math.max(0,Math.min(off.height-h,drag.v0.y0+dy)); view.y1=view.y0+h;
    CTX[c.data.index].draw();
  });
  cv.ondblclick=()=>{ view.x0=0;view.x1=off.width;view.y0=0;view.y1=off.height; CTX[c.data.index].draw(); };
  // ── 曲线频谱：鼠标在声谱图上移动时，画出那一刻的频谱（report 里那种图）──
  const sc = document.getElementById('s'+c.data.index);
  sc.width = 1800; sc.height = 300;
  const sctx = sc.getContext('2d');
  const col = (f) => { f = Math.max(0, Math.min(off.width-1, Math.round(f)));
    return raw.subarray(f*off.height, f*off.height+off.height); };
  function drawSpectrum(f) {
    sctx.fillStyle='#000'; sctx.fillRect(0,0,sc.width,sc.height);
    const bins = off.height, binHz = 48000/2048;
    const X = (b) => (b*binHz/3000)*sc.width;
    const Y = (v) => sc.height-10 - (v/255)*(sc.height-30);
    // 500Hz 一根刻度
    sctx.fillStyle='#345'; sctx.font='12px system-ui';
    for (let hz=500; hz<3000; hz+=500) {
      const x = X(hz/(binHz));
      sctx.fillRect(x,0,1,sc.height); sctx.fillStyle='#7ab';
      sctx.fillText((hz/1000)+'k', x+3, sc.height-12); sctx.fillStyle='#345';
    }
    const line = (arr, color, w) => {
      sctx.strokeStyle=color; sctx.lineWidth=w; sctx.beginPath();
      for (let b=0;b<bins;b++){ const x=X(b), y=Y(arr[b]); b?sctx.lineTo(x,y):sctx.moveTo(x,y); }
      sctx.stroke();
    };
    line(col(f-3), '#666', 1);          // 30ms 前
    line(col(f),   '#4c9', 1.6);        // 这一刻
    line(col(f+3), '#e95', 1);          // 30ms 后
    sctx.fillStyle='#9cf'; sctx.font='13px system-ui';
    sctx.fillText('t='+(f*c.data.hopMs/1000).toFixed(3)+'s', 8, 18);
  }
  drawSpectrum(view.x0 + Math.round((view.x1-view.x0)*0.35));
  cv.onmousemove = (e) => {
    const r = cv.getBoundingClientRect();
    const frac = (e.clientX - r.left)/r.width;
    drawSpectrum(view.x0 + frac*(view.x1-view.x0));
  };
  CTX[c.data.index].spectrum = drawSpectrum;
  // 低频能量曲线：和上图**共用同一段时间轴**（缩放/平移一起动），
  // 这样"两个竖条之间有没有暗缝"和"曲线有没有掉下去"能对上。
  const ec = document.getElementById('e'+c.data.index);
  ec.width = 1800; ec.height = 130;
  const ectx = ec.getContext('2d');
  const envDb = c.data.env.db, envHop = c.data.env.hopMs;
  function drawEnv() {
    ectx.fillStyle='#000'; ectx.fillRect(0,0,ec.width,ec.height);
    ectx.strokeStyle='#345'; ectx.lineWidth=1;
    for (let d=0; d<=60; d+=20) { const y=ec.height-(d/60)*(ec.height-14)-4; ectx.beginPath(); ectx.moveTo(0,y); ectx.lineTo(ec.width,y); ectx.stroke(); }
    ectx.strokeStyle='#7fd'; ectx.lineWidth=1.6; ectx.beginPath();
    const t0 = view.x0*c.data.hopMs/1000, t1 = view.x1*c.data.hopMs/1000;
    for (let i=0;i<envDb.length;i++) {
      const t = i*envHop/1000;
      if (t<t0||t>t1) continue;
      const x = (t-t0)/(t1-t0)*ec.width;
      const y = ec.height - ((255-envDb[i])/255)*(ec.height-14) - 4;   // 高=强
      i?ectx.lineTo(x,y):ectx.moveTo(x,y);
    }
    ectx.stroke();
    ectx.fillStyle='#678'; ectx.font='12px system-ui';
    ectx.fillText('0dB', 4, 14); ectx.fillText('-60dB', 4, ec.height-4);
    // 机器按"峰高 + 中间掉下去"找出来的起音（绿色三角）——和你的眼睛对不对得上，一眼看得出
    const pk = c.peaks || [];
    ectx.fillStyle='rgba(80,255,120,.95)';
    for (const p of pk) {
      if (p.t < t0 || p.t > t1) continue;
      const x = (p.t - t0) / (t1 - t0) * ec.width;
      const y = ec.height - ((255 - (Math.max(0, Math.min(255, Math.round((p.db + 60) / 60 * 255))))) / 255) * (ec.height - 14) - 4;
      ectx.beginPath(); ectx.moveTo(x, y - 9); ectx.lineTo(x - 5, y - 1); ectx.lineTo(x + 5, y - 1); ectx.closePath(); ectx.fill();
    }
    ectx.fillStyle='#7fd'; ectx.font='13px system-ui';
    ectx.fillText('机器数到 ' + pk.length + ' 次', ec.width - 150, 18);
  }
  const oldDraw = draw;
  // 每次重画声谱图时，曲线也跟着重画（共用 view）
  CTX[c.data.index].draw = () => { oldDraw(); drawEnv(); };
  CTX[c.data.index].draw();
}
window.ZOOM = (i, dir) => { const o = CTX[i]; const v = o.view;
  const n = Math.max(canvasMin(o), Math.min(o.off.width, (v.x1-v.x0) * (dir < 0 ? 1/1.4 : 1.4)));
  const cx = (v.x0+v.x1)/2; v.x0 = Math.max(0, cx-n/2); v.x1 = Math.min(o.off.width, v.x0+n); v.x0 = Math.max(0, v.x1-n); o.draw(); };
window.FULL = (i) => { const o = CTX[i]; o.view.x0=0; o.view.x1=o.off.width; o.view.y0=0; o.view.y1=o.off.height; o.draw(); };
window.HEAD = (i) => { const o = CTX[i]; o.view.x0=0; o.view.x1=Math.min(o.off.width, Math.round(3/(o.c.data.hopMs/1000))); o.view.y0=0; o.view.y1=o.off.height; o.draw(); };
function canvasMin(o){ return Math.max(20, Math.round(0.15/(o.c.data.hopMs/1000))); }
</script>`;

// 每个片段把起音时刻也写一份（没有就跳过）
const outPath = path.join(root, 'sound_data', 'f32', '看频谱.html');
fs.writeFileSync(outPath, html);
console.log('已生成：' + outPath);
