// 探针：照"眼睛看图"的方式数起音 —— 只看低频那条带（150~600Hz，基频所在），
// 把它随时间变化的能量曲线拿出来，数"几坨能量、中间有没有暗缝"。
//
// 为什么换这个路子：一维的"电平抬升阈值"分不开"同一个音变响"和"新拨一下"，
// 但**二维图上一眼就能看出**（用户原话："有明显的延音感或者连续两个音的感觉"）。
// 眼睛看的就是这条低频带能量曲线：一坨连续的 = 延音；两坨中间有暗缝 = 两次拨弦。
//
// 用法： node test/probe-onsets.mjs [若干 .f32；不给就扫 sound_data/f32]

import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const { spectrumOf } = await import('file:///E:/GuitarFollowLab/backend/engine/dsp.js');

let files = process.argv.slice(2);
if (!files.length) {
  const dir = path.join(root, 'sound_data', 'f32');
  files = fs.readdirSync(dir).filter((f) => f.startsWith('2弦') && f.endsWith('.f32')).map((f) => path.join(dir, f));
}

const SR = 48000, N = 1024, HOP = 240;          // 21ms 窗、5ms 一跳：够细，能看出 10~20ms 的间隔
const LO = 150, HI = 600;                        // 基频带（吉他常用音区）

for (const f of files) {
  const abs = path.resolve(root, f);
  const raw = fs.readFileSync(abs);
  const A = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const binHz = SR / N;
  const lo = Math.max(1, Math.floor(LO / binHz)), hi = Math.ceil(HI / binHz);
  const env = [];
  for (let i = 0; i + N < A.length; i += HOP) {
    const mags = spectrumOf(A.subarray(i, i + N));
    let s = 0;
    for (let b = lo; b <= hi; b++) s += mags[b] * mags[b];
    env.push({ t: (i + N / 2) / SR, v: Math.sqrt(s / (hi - lo + 1)) });
  }
  // 归一到 0~1（dB），再找"本地峰 + 与上一个峰之间有明显下降"
  const mx = Math.max(...env.map((e) => e.v)) || 1e-9;
  const db = env.map((e) => 20 * Math.log10(Math.max(e.v, 1e-12) / mx));
  const floorDb = Math.max(-60, Math.min(...db));
  const attacks = [];
  const DIP_DB = 6;          // 两个峰之间至少掉这么多 dB 才算"两个音"
  for (let i = 1; i < db.length - 1; i++) {
    if (db[i] < -35) continue;                       // 太轻，不算
    if (db[i] >= db[i - 1] && db[i] > db[i + 1]) {   // 本地峰
      const last = attacks[attacks.length - 1];
      if (!last) { attacks.push(env[i].t); continue; }
      // 看两峰之间有没有掉到 (较小者 - DIP) 以下
      const a = env.findIndex((e) => e.t >= last), b = i;
      let mn = Infinity;
      for (let k = a; k <= b; k++) mn = Math.min(mn, db[k]);
      const peak = Math.min(db[a] == null ? db[b] : db[a], db[b]);
      if (peak - mn >= DIP_DB && env[i].t - last > 0.03) attacks.push(env[i].t);
    }
  }
  const gaps = attacks.slice(1).map((t, i) => Math.round((t - attacks[i]) * 1000));
  console.log(`\n${path.basename(abs).padEnd(26)} 能量曲线落到 ${floorDb.toFixed(0)}dB`
    + `\n  数到 ${attacks.length} 次起音：${attacks.map((t) => t.toFixed(2)).join('  ')}`
    + `\n  相邻间隔(ms)：${gaps.join('  ') || '—'}`);
}
