// ─────────────────────────────────────────────────────────────────────────────
// 音高表和和弦指法库。
//
// 标准调弦 EADGBE（注意不是 EADBE，那是少了一根弦的写法）：
//   六弦 E2 = 82.41 Hz    五弦 A2 = 110.00 Hz   四弦 D3 = 146.83 Hz
//   三弦 G3 = 196.00 Hz   二弦 B3 = 246.94 Hz   一弦 E4 = 329.63 Hz
//
// 品 n 的音高 = 空弦音 + n 个半音；加变调夹整体再升 capo 个半音。
// 但推弦 / 滑音 / 泛音 / 闷音 都不服从这个规则，要单独处理
// （比如 12 品自然泛音是空弦音升八度，不是升 12 个半音）。
// ─────────────────────────────────────────────────────────────────────────────

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// 弦号 → 空弦音的 MIDI 音高（MIDI 60 = C4 = 261.63Hz）
export const OPEN_STRING_MIDI = { 6: 40, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 };

export const STRING_LABEL = {
  6: '六弦低E', 5: '五弦A', 4: '四弦D', 3: '三弦G', 2: '二弦B', 1: '一弦高E',
};

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiToPC = (m) => ((Math.round(m) % 12) + 12) % 12;
export const pcName = (pc) => NOTE_NAMES[((pc % 12) + 12) % 12];

export function midiToName(m) {
  const r = Math.round(m);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

// ── 和弦指法库 ───────────────────────────────────────────────────────────────
// strings 里每一项是 [弦号, 品]，六弦 → 一弦。带 x 的低音弦不弹，所以不列。
// 只用原位和弦：音级集合互不混淆，不需要靠低音分辨转位。
// （C 和 C/G 的音级集合完全一样，只有低音不同，那需要额外的低音估计才分得开。）
export const CHORD_LIB = {
  Em:  { label: 'Em',  strings: [[6, 0], [5, 2], [4, 2], [3, 0], [2, 0], [1, 0]], note: '小三和弦，六根弦全响' },
  Am:  { label: 'Am',  strings: [[5, 0], [4, 2], [3, 2], [2, 1], [1, 0]], note: '小三和弦' },
  C:   { label: 'C',   strings: [[5, 3], [4, 2], [3, 0], [2, 1], [1, 0]], note: '大三和弦，根音在五弦三品' },
  G:   { label: 'G',   strings: [[6, 3], [5, 2], [4, 0], [3, 0], [2, 0], [1, 3]], note: '大三和弦，开放把位' },
  D:   { label: 'D',   strings: [[4, 0], [3, 2], [2, 3], [1, 2]], note: '大三和弦，六弦五弦不弹' },
  Dm:  { label: 'Dm',  strings: [[4, 0], [3, 2], [2, 3], [1, 1]], note: '小三和弦' },
  G5:  { label: 'G5',  strings: [[6, 3], [5, 5], [4, 5]], note: '强力和弦，只有根音和五度' },
};

export function chordVoicing(key) {
  const lib = CHORD_LIB[key];
  if (!lib) throw new Error('未知和弦: ' + key);
  return lib.strings.map(([string, fret]) => ({
    string,
    fret,
    midi: OPEN_STRING_MIDI[string] + fret,
  }));
}
