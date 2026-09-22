// 离线分析「导出记录」：不改代码、不碰手机，先把"判定到底发生了什么"用数字摊开。
//
// 用法： node test/analyze-log.mjs                  （分析 json/ 下所有 follow-log-*.json）
//        node test/analyze-log.mjs 某个.json
//
// 每份记录回答五件事：
//   ① 判定统计（对/错/测不准）
//   ② **偏差分布**：量到的音离谱面那个音多少音分（正确演奏时应该都挤在 0 附近）
//   ③ **有多少条贴在搜索边界上**（±80 音分）—— 贴边 = 测量没找到那个音，不是"他弹偏了"
//   ④ 校正值走了多远（它以前会参与判定，会把错音拉回来）
//   ⑤ 起音间隔：有没有"同一个音被算两下"（成对出现、间隔 < 30ms）

import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const files = args.length
  ? args
  : fs.readdirSync(path.join(root, 'json')).filter((f) => f.startsWith('follow-log-')).map((f) => path.join('json', f));

for (const f of files) {
  const abs = path.resolve(root, f);
  if (!fs.existsSync(abs)) continue;
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const notes = j.notes || [];
  const onsets = j.onsets || [];
  console.log('\n════════ ' + path.basename(abs) + ' ════════');
  console.log('  align: ' + JSON.stringify(j.align));
  const by = {};
  for (const n of notes) by[n.result] = (by[n.result] || 0) + 1;
  console.log(`  判定 ${notes.length} 条：` + Object.entries(by).map(([k, v]) => `${k}=${v}`).join(' ') + ` ｜ 起音 ${onsets.length} 次`);

  // ② 偏差分布（20 音分一档）
  const bins = new Map();
  for (const n of notes) {
    if (n.cents == null) continue;
    const b = Math.round(n.cents / 20) * 20;
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  console.log('  偏差分布（音分）:');
  for (const k of keys) {
    console.log(`    ${String(k).padStart(5)} ～ ${String(k + 19).padStart(4)}  ${'█'.repeat(Math.min(40, bins.get(k)))} ${bins.get(k)}`);
  }

  // ③ 贴边（±80 就是搜索范围的边界；放宽过就是 ±1200）
  const edge = notes.filter((n) => Math.abs(n.cents) >= 79).length;
  const near = notes.filter((n) => n.cents != null && Math.abs(n.cents) <= 20).length;
  console.log(`  贴边（|偏差|≥79，测量没找到那个音）：${edge} 条 / ${notes.length}`);
  console.log(`  量得很准（|偏差|≤20 音分）：${near} 条 / ${notes.length}`);

  // ④ 校正走过的范围
  const tuns = notes.map((n) => n.tuning).filter((x) => typeof x === 'number');
  if (tuns.length) {
    console.log(`  校正值：最小 ${Math.min(...tuns)} / 最大 ${Math.max(...tuns)} 音分（它以前参与判定 → 会把错音拉回范围）`);
  }

  // ⑤ 起音间隔：同一个音被算两下
  const ts = onsets.map((o) => o.t).sort((a, b) => a - b);
  let pairs = 0;
  for (let i = 1; i < ts.length; i++) if ((ts[i] - ts[i - 1]) * 1000 < 30) pairs++;
  console.log(`  起音里间隔 <30ms 的成对出现：${pairs} 处（>0 就是"同一个音被算了两下"）`);
}
