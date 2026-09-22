// 量一下：环境噪声的音量 和 真弹时的音量 差多少 —— 用来定"绝对音量门槛"。
//
// 用户的观察：录音机里看到的周围杂音，和他对着手机弹，音量差很多。
// 那么起音判据除了"相对地板抬高多少倍"，还应该有一条**绝对的音量下限**：
// 低于这条线的响动根本不用看。
//
// 用法： node test/probe-levels.mjs [若干 .f32；不给就扫 sound_data/f32]

import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
let files = process.argv.slice(2);
if (!files.length) {
  const dir = path.join(root, 'sound_data', 'f32');
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.f32')).map((f) => path.join(dir, f));
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('文件', 26) + pad('开头0.5s', 11) + pad('安静90分位', 12) + pad('弹奏峰值', 11) + '峰/环境');
for (const f of files) {
  const abs = path.resolve(root, f);
  const raw = fs.readFileSync(abs);
  const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const rms = (from, len) => {
    let s = 0, n = 0;
    for (let i = from; i < Math.min(A.length, from + len); i++) { s += A[i] * A[i]; n++; }
    return Math.sqrt(s / Math.max(1, n));
  };
  const frames = [];
  for (let i = 0; i + 1024 < A.length; i += 1024) frames.push(rms(i, 1024));   // 21ms 一格
  const sorted = frames.slice().sort((a, b) => a - b);
  const head = rms(0, 1024 * 23);                                        // 开头（还没弹）
  const quiet = sorted[Math.floor(sorted.length * 0.9)];                 // 90 分位 = 安静时的底噪
  const peak = sorted[sorted.length - 1];
  console.log(pad(path.basename(abs, '.f32').slice(0, 24), 26)
    + pad(head.toFixed(5), 11) + pad(quiet.toFixed(5), 12) + pad(peak.toFixed(5), 11)
    + (peak / Math.max(quiet, 1e-9)).toFixed(1) + ' 倍');
}
