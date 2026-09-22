// ── 实时诊断面板（页面层里的一块，单独成文件）────────────────────────────────
// 为什么要有：出问题时"说不清是什么造成的"。把 期望音 / 时间窗 / 起音时刻与偏差 /
// 听到的音 / 最后判什么 直接摊在页面上 —— 手机上不用导文件，看一眼（或截图）就知道
// 是"没听到"、"时间不对"还是"音不对"。
//
// 这一层不认识判定，只管"把一行行文字显示出来"：最多留 8 行。
let lines = [];
let getEl = () => null;
const MAX_LINES = 8;

export function initDiag(elGetter) { getEl = typeof elGetter === 'function' ? elGetter : () => null; }

export function diag(line) {
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  const el = getEl();
  if (el) el.textContent = lines.join('\n');
}

export function resetDiag() {
  lines = [];
  const el = getEl();
  if (el) el.textContent = '';
}
