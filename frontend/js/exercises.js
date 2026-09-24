// ─────────────────────────────────────────────────────────────────────────────
// 练习内容。
//
// 结构：模式 → 难度级 → 组（group）→ 事件（event）
//   组是显示进度用的单位（比如"Em"这一整段 T3231323 就是一个组），
//   事件是实际被判定的一次演奏（一个音，或者一次扫弦）。
//
// T3231323 的读法：T = 拇指，弹根音所在的那根弦；3/2/1 = 第三弦/第二弦/第一弦。
// ─────────────────────────────────────────────────────────────────────────────

import { OPEN_STRING_MIDI, midiToHz, midiToName, CHORD_LIB, chordVoicing } from './engine/data.js?v=0924-1925';

export const LIVE_CHORDS = ['Em', 'Am', 'C', 'G', 'D', 'Dm', 'G5'];

const STR = { 6: '六弦', 5: '五弦', 4: '四弦', 3: '三弦', 2: '二弦', 1: '一弦' };

function noteEvent(string, fret, extra = {}) {
  const midi = OPEN_STRING_MIDI[string] + fret;
  return {
    kind: 'note',
    name: midiToName(midi),
    targetMidi: midi,
    hz: midiToHz(midi),
    string,
    fret,
    where: fret === 0 ? `${STR[string]}空弦` : `${STR[string]} ${fret} 品`,
    tag: extra.tag || '',
    tech: extra.tech || '',
    toleranceCents: extra.toleranceCents ?? null,
    settleMs: extra.settleMs ?? 130,
    hint: extra.hint || '',
    slideFrom: extra.slideFrom ?? null,     // 滑音起点（技巧判过程用）
  };
}

function chordEvent(key, extra = {}) {
  const v = chordVoicing(key);
  const slots = [null, null, null, null, null, null];   // 下标 0 = 六弦
  for (const x of v) slots[6 - x.string] = x.fret;
  return {
    kind: 'chord',
    chord: key,
    name: CHORD_LIB[key].label,
    tag: '',
    frets: slots.map((s) => (s === null ? 'x' : String(s))),
    hint: extra.hint || '',
  };
}

// 一个和弦的 T3231323：根音弦 + 3弦 2弦 3弦 1弦 3弦 2弦 3弦
function arpeggio(key) {
  const v = chordVoicing(key);
  const bass = v[0].string;                 // voicing 按六弦→一弦排，第一个就是最低那根
  const pattern = [bass, 3, 2, 3, 1, 3, 2, 3];
  return pattern.map((s, i) => {
    const hit = v.find((x) => x.string === s) || { fret: 0 };
    return noteEvent(s, hit.fret, {
      tag: s === bass ? 'T' : String(s),
      hint: i === 0 ? '拇指从根音弦开始' : '',
    });
  });
}

const group = (label, events) => ({ label, events });

// 小星星主歌，只用最上面两根弦，0~5 品
const TWINKLE = [
  [2, 1], [2, 1], [1, 3], [1, 3], [1, 5], [1, 5], [1, 3],
  [1, 1], [1, 1], [1, 0], [1, 0], [2, 3], [2, 3], [2, 1],
];

const TECH_GROUPS = [
  group('滑音', [
  // slideFrom：滑音的起点。技巧的本质是**过程**，不是落点 ——
  // 只弹落点不给过（实测就是这么漏的：不滑、直接弹 D3 也判对）。
  noteEvent(5, 5, { tech: '滑音', tag: '滑', toleranceCents: 70, settleMs: 520, slideFrom: 48,
      hint: '按住五弦 3 品拨一下，然后别抬手，直接滑到 5 品，停住' }),
  ]),
  group('击弦', [
    noteEvent(4, 3, { tech: '击弦', tag: '击', toleranceCents: 70, settleMs: 380,
      hint: '按住四弦 2 品拨一下，然后左手用力砸到 3 品——不是拨，是砸下去' }),
  ]),
  group('勾弦', [
    noteEvent(4, 2, { tech: '勾弦', tag: '勾', toleranceCents: 70, settleMs: 380,
      hint: '按住四弦 3 品拨一下，然后左手往斜下方勾回 2 品' }),
  ]),
  group('推弦', [
    noteEvent(3, 7, { tech: '推弦', tag: '推', toleranceCents: 80, settleMs: 650,
      hint: '三弦 7 品拨响后，左手把弦往上推高一个全音，推到和一弦空弦一样高' }),
  ]),
  group('泛音', [
    noteEvent(5, 12, { tech: '泛音', tag: '泛', toleranceCents: 70, settleMs: 300,
      hint: '左手手指轻碰五弦 12 品的品丝正上方，别按下去；右手拨弦后左手立刻抬起' }),
  ]),
];

export const MODES = [
  {
    id: 'single',
    name: '单音',
    sub: '一根一根弹',
    levels: [
      {
        name: '空弦六音',
        tip: '从六弦一路弹到一弦。每弹响一个就停住别消音，等它听完再弹下一个。',
        groups: [6, 5, 4, 3, 2, 1].map((s) =>
          group(midiToName(OPEN_STRING_MIDI[s]), [noteEvent(s, 0, { tag: String(s) })])),
      },
      {
        name: '小星星',
        tip: '主歌两句，只用到二弦和一弦，最远 5 品。一个音一个音弹，弹对自动往下走。',
        groups: TWINKLE.map(([s, f], i) =>
          group('第' + (i + 1) + '音', [noteEvent(s, f)])),
      },
    ],
  },
  {
    id: 'tech',
    name: '技巧',
    sub: '滑音 / 击弦 / 勾弦 / 推弦 / 泛音',
    levels: [
      {
        name: '五种技巧',
        tip: '这些手法没有拨弦瞬态，音头非常弱，是最容易识别失败的地方。滑音只判你最后停住的落点。',
        groups: TECH_GROUPS,
      },
    ],
  },
  {
    id: 'chord',
    name: '和弦',
    sub: '一个和弦的 T3231323',
    levels: [
      {
        name: 'T3231323',
        tip: '每个和弦弹一整段 T3231323，八个音按顺序来。T 是拇指弹的那根根音弦，慢慢弹，弹对自动往下走。',
        groups: ['Em', 'Am', 'C', 'G'].map((k) => group(CHORD_LIB[k].label, arpeggio(k))),
      },
    ],
  },
  {
    id: 'strum',
    name: '扫弦',
    sub: '一个和弦扫四下',
    levels: [
      {
        name: '单和弦扫弦',
        tip: '按好和弦，从六弦扫到一弦，扫完停住。每个和弦扫四下，每一下都单独判。',
        groups: ['Em', 'Am', 'C', 'G'].map((k) =>
          group(CHORD_LIB[k].label, [1, 2, 3, 4].map(() => chordEvent(k)))),
      },
    ],
  },
  {
    id: 'change',
    name: '转换',
    sub: '和弦切换跟得上吗',
    levels: [
      {
        name: '四个和弦转换',
        tip: 'C → G → Am → Em，每个和弦扫一下。不看谱凭感觉换，看它能不能一直跟上你。',
        groups: ['C', 'G', 'Am', 'Em'].map((k) => group(CHORD_LIB[k].label, [chordEvent(k)])),
      },
    ],
  },
];

// 把"组"摊平成一条判定队列：每个事件都带上自己在哪个组、组内第几个
export function buildRun(mode, levelIndex = 0) {
  const level = mode.levels[levelIndex] || mode.levels[0];
  const flat = [];
  level.groups.forEach((g, gi) => {
    g.events.forEach((ev, ei) => {
      flat.push({
        ...ev,
        groupLabel: g.label,
        groupIndex: gi,
        indexInGroup: ei,
        groupSize: g.events.length,
        groupEvents: g.events,
      });
    });
  });
  return { level, flat, groupCount: level.groups.length };
}
