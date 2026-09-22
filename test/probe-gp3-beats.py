#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 .gp3 里"**用户实际要弹的那些音**"按谱面顺序原样列出来 —— 谱面侧的基准。

为什么要单独有这么一个探针：
  跟弹页（follow-score.js）现在把判定清单和光标拆成两份来源：
    判定 = data/hey_jude.json 的时间轴（118 个音）
    光标 = alphaTab 解析出来的谱面拍点（真机上只有 117 个）
  两份差一个，就会"弹对的判错、弹错的判对"。手机上没法调，只能先在谱面上把
  这一份基准数出来，跟时间轴比。

输出每个音的：序号 / 小节 / 拍 / 起始 tick / 时值 / 弦 / 品 / midi / 是不是延音接续。
延音接续（note.type == tie）表示"上一个音还在响"，**不是**要弹的第二下。

用法（跟 gp_timeline.py 一个规矩）：
    set PYTHONPATH=E:\\VirtuCoach-Lib
    E:\\Python\\python.exe -X utf8 test\\probe-gp3-beats.py ".gp\\the-beatles-hey_jude.gp3" --track 0
"""

import argparse
import sys

try:
    import guitarpro
except ImportError:                                          # pragma: no cover
    sys.exit('缺 PyGuitarPro。装法：pip install --target E:\\VirtuCoach-Lib PyGuitarPro')


NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def midi_name(midi):
    return '%s%d' % (NOTE_NAMES[midi % 12], midi // 12 - 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('guitarpro_file')
    ap.add_argument('--track', type=int, default=0)
    ap.add_argument('--limit', type=int, default=40, help='最多打印多少个音（0 = 全部）')
    ap.add_argument('--raw', action='store_true',
                    help='逐拍原样列（含延音接续），模拟浏览器那边的过滤逻辑用')
    args = ap.parse_args()

    song = guitarpro.parse(args.guitarpro_file)
    track = song.tracks[args.track]
    print('谱面 %s ｜ 轨 %d "%s" ｜ 调弦 %s'
          % (args.guitarpro_file, args.track, track.name,
             ' '.join(midi_name(s.value) for s in track.strings)))

    # 逐个 beat 走一遍，把"要弹的音"和"延音接续"分开数。
    # GP 的记法：延音接续是**独立的一个 beat**（note.type = NoteType.tie），
    # 它的存在说明"上一个音还在响"，不是"再弹一次"。
    playable = []          # 要弹的（拨弦）
    ties = []              # 延音接续（不弹）
    for m_index, measure in enumerate(track.measures):
        for v_index, voice in enumerate(measure.voices):
            for b_index, beat in enumerate(voice.beats):
                if beat.status != guitarpro.BeatStatus.normal:
                    continue
                if not beat.notes:
                    continue
                normal = [n for n in beat.notes if n.type == guitarpro.NoteType.normal]
                tie = [n for n in beat.notes if n.type == guitarpro.NoteType.tie]
                rec = {
                    'm': m_index, 'v': v_index, 'b': b_index,
                    'start': beat.start,
                    'dur': beat.duration.time,
                    'notes': beat.notes,
                    'hammer': bool(getattr(beat.effect, 'hammer', False)),
                }
                if normal:
                    playable.append(rec)
                elif tie:
                    ties.append(rec)

    print('要弹的音 %d 个 ｜ 延音接续 %d 个 ｜ 加起来 %d'
          % (len(playable), len(ties), len(playable) + len(ties)))

    if args.raw:
        # 逐拍原样列：浏览器里那份"谱面拍点表"就是按这个顺序攒出来的，
        # 过滤规则写错就会少一格，拿这个输出可以直接对照。
        n = 0
        for m_index, measure in enumerate(track.measures):
            for v_index, voice in enumerate(measure.voices):
                for b_index, beat in enumerate(voice.beats):
                    if beat.status != guitarpro.BeatStatus.normal or not beat.notes:
                        continue
                    n += 1
                    kinds = ','.join(str(x.type) for x in beat.notes)
                    print('  raw %3d  小节%2d 拍%2d tick%6d 音符%d 类型[%s]'
                          % (n, m_index + 1, b_index + 1, beat.start, len(beat.notes), kinds))
        print('  有音符的拍一共 %d 个' % n)
        return

    # 谱面写法顺序下的前几个音：跟时间轴（data/hey_jude.timeline.json）逐条对，
    # 第一条就该是 Hey Jude 开头那个 2 弦 1 品（C4）。
    show = playable if not args.limit else playable[:args.limit]
    for k, rec in enumerate(show):
        fs = []
        for n in rec['notes']:
            fs.append('%s弦%s品(%s%s)'
                      % (n.string, n.value, midi_name(n.realValue),
                         '' if n.type == guitarpro.NoteType.normal else ' [%s]' % n.type))
        print('%3d  小节%2d 拍%2d  tick%6d 时值%4d  %s%s'
              % (k + 1, rec['m'] + 1, rec['b'] + 1, rec['start'], rec['dur'],
                 ' '.join(fs), '  击弦' if rec['hammer'] else ''))

    # 只打印"连续同一个音"的地方：这里正是"延音被当第二下"最容易出错的位置。
    print('--- 延音接续明细（不弹，但会占一拍）---')
    for k, rec in enumerate(ties):
        fs = ' '.join('%s弦%s品(%s)' % (n.string, n.value, midi_name(n.realValue))
                      for n in rec['notes'])
        print('%3d  小节%2d 拍%2d  tick%6d 时值%4d  %s'
              % (k + 1, rec['m'] + 1, rec['b'] + 1, rec['start'], rec['dur'], fs))


if __name__ == '__main__':
    main()
