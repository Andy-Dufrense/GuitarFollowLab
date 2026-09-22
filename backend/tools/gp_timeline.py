#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 Guitar Pro 谱面解析成"时间轴"：每个音符在哪一秒、第几弦、第几品、多长。

这是跟弹模式的第一块地基 —— 判定层只认时间轴，不认 .gp 文件本身。
解析出来的 JSON 长这样：

    {
      "meta":     {...},
      "tempoMap": [{ "t": 0.0, "bpm": 74 }],
      "notes":    [ { "t": 0.0, "dur": 0.81, "string": 6, "fret": 0,
                      "midi": 40, "velocity": 95, "measure": 0, "beat": 0 }, ... ]
    }

    t        音符起点（秒，从曲子开头算）
    dur      时值（秒，已按当时的速度换算）
    string   第几弦（GP 的记法：1 = 最细的一弦，6 = 最粗的六弦）
    fret     第几品（0 = 空弦）
    midi     MIDI 音高

用法（注意 PYTHONPATH 和 -X utf8，跟 VirtuCoach 后端一个规矩）：

    set PYTHONPATH=E:\VirtuCoach-Lib
    E:\Python\python.exe -X utf8 backend\tools\gp_timeline.py ".gp\the-beatles-hey_jude.gp3"
    E:\Python\python.exe -X utf8 backend\tools\gp_timeline.py <file.gp3> --json out\timeline.json
    E:\Python\python.exe -X utf8 backend\tools\gp_timeline.py <file.gp3> --track 1 --notes 40

依赖：PyGuitarPro（LGPL-3.0）。它只负责读文件，不进产品运行时 ——
产品里如果要解析，用同族的 alphaTab（MPL-2.0，能在浏览器里直接跑）。
"""

import argparse
import json
import sys

try:
    import guitarpro
except ImportError:                                          # pragma: no cover
    sys.exit('缺 PyGuitarPro。装法：pip install --target E:\\VirtuCoach-Lib PyGuitarPro')


NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
TICKS_PER_QUARTER = 960        # Guitar Pro 内部的时间刻度


def midi_name(midi):
    return '%s%d' % (NOTE_NAMES[midi % 12], midi // 12 - 1)


def duration_seconds(duration, bpm):
    """GP 的时值 -> 秒。

    注意：PyGuitarPro 的 duration.time 是 **tick 数**（960 tick = 一个四分音符），
    不是"几个四分音符"。拿它当四分音符用会差 960 倍 —— 第一次跑就是这么错的。
    """
    ticks = getattr(duration, 'time', None)
    if ticks is None:
        ticks = (4.0 / duration.value) * TICKS_PER_QUARTER
    return ticks / float(TICKS_PER_QUARTER) * (60.0 / bpm)


def tick_seconds(tick, bpm):
    return (tick / float(TICKS_PER_QUARTER)) * (60.0 / bpm)


def collect_notes(song, track):
    """把一条轨上的音符摊平成事件表（按时间排序）。

    说明：这里给的是**线性时间轴**（谱面从头到尾的写法顺序）。
    反复记号（repeat）、D.S./Coda 还没展开 —— 真跟弹时要先按演奏顺序展开，
    把 meta.repeats 里的信息用上。先把这一步留出来，不假装已经处理了。
    """
    bpm = float(song.tempo)
    notes = []
    for m_index, measure in enumerate(track.measures):
        for v_index, voice in enumerate(measure.voices):
            for b_index, beat in enumerate(voice.beats):
                if beat.status != guitarpro.BeatStatus.normal:
                    continue                       # 休止/空拍
                start = tick_seconds(beat.start, bpm)
                dur = duration_seconds(beat.duration, bpm)
                for note in beat.notes:
                    # 延音（tie）**不能丢**：GP 里延音是"另一个 beat，note.type=NoteType.tie"，
                    # 它表示"上一个音还在响"，不是"再弹一次"。
                    # 正确处理：并进上一个音（把时值延长），这样时间轴里一个音对应一次拨弦。
                    # 曾经的写法是 `if note.type != normal: continue` —— 把延音全丢了，
                    # 于是"该按住不放的地方"在时间轴里凭空少了一拍。Hey Jude 这份谱实测有
                    # 426 个这样的接续音（占总音符 1166 的三分之一还多）。
                    if note.type == guitarpro.NoteType.tie:
                        prev = None
                        for cand in reversed(notes):
                            if cand['string'] == note.string and cand['midi'] == note.realValue:
                                prev = cand
                                break
                        if prev is not None:
                            tail = start + dur
                            prev['dur'] = round(max(prev['dur'], tail - prev['t']), 4)
                            prev['tie'] = True          # 标记：这个音后面接着延音
                            prev['tieTo'] = round(tail, 4)
                            continue
                        # 找不到上一音（少见：谱面本身有问题）时，按普通音收下，别丢
                    elif note.type != guitarpro.NoteType.normal:
                        continue                   # 装饰音/幽灵音/闷音先不进时间轴
                    notes.append({
                        't': round(start, 4),
                        'dur': round(dur, 4),
                        'string': note.string,
                        'fret': note.value,
                        'midi': note.realValue,
                        'velocity': note.velocity,
                        'measure': m_index,
                        'beat': b_index,
                        'voice': v_index,
                        'tie': False,
                    })
    notes.sort(key=lambda n: (n['t'], n['string']))
    return notes


def tempo_map(song, track):
    """速度表。GP3 通常只有开头一个速度；GP4/5 可能中途变速。"""
    changes = [{'t': 0.0, 'bpm': float(song.tempo)}]
    for m_index, measure in enumerate(track.measures):
        for voice in measure.voices:
            for beat in voice.beats:
                mix = getattr(beat.effect, 'mixTableChange', None)
                tempo = getattr(mix, 'tempo', None) if mix else None
                if tempo:
                    changes.append({
                        't': round(tick_seconds(beat.start, float(song.tempo)), 4),
                        'bpm': float(tempo.value),
                        'measure': m_index,
                    })
    return changes


def time_signatures(song):
    """拍号取自 song.measureHeaders（所有轨共用）。"""
    out = []
    for m_index, header in enumerate(song.measureHeaders):
        sig = '%d/%d' % (header.timeSignature.numerator,
                         header.timeSignature.denominator.value)
        if not out or out[-1][1] != sig:
            out.append((m_index + 1, sig))
    return out


def repeats(song, track):
    """反复记号的位置。跟弹必须按演奏顺序展开时间轴，这些信息不能丢。"""
    out = []
    for m_index, measure in enumerate(track.measures):
        if measure.isRepeatOpen or measure.repeatClose:
            out.append({
                'measure': m_index + 1,
                'open': bool(measure.isRepeatOpen),
                'close': int(measure.repeatClose or 0),
            })
    return out


def track_summary(song, track):
    tuning = [s.value for s in track.strings]
    return {
        'index': song.tracks.index(track),
        'name': track.name,
        'strings': len(track.strings),
        'tuning': [midi_name(m) for m in tuning],
        'tuning_midi': tuning,
        'is_percussion': bool(getattr(track, 'isPercussionTrack', False)),
    }


def main():
    ap = argparse.ArgumentParser(description='把 Guitar Pro 谱面解析成时间轴')
    ap.add_argument('guitarpro_file')
    ap.add_argument('--json', help='把时间轴写到这个 JSON 文件')
    ap.add_argument('--track', type=int, default=None,
                    help='只看这一条轨（默认取第一条非打击轨）')
    ap.add_argument('--notes', type=int, default=24, help='打印前多少个音符事件')
    args = ap.parse_args()

    song = guitarpro.parse(args.guitarpro_file)

    print('=' * 72)
    print('谱面：%s' % args.guitarpro_file)
    print('=' * 72)
    print('标题   %s' % song.title)
    print('艺人   %s' % song.artist)
    print('专辑   %s' % song.album)
    print('速度   %g BPM' % song.tempo)
    print('小节   %d' % len(song.measureHeaders))
    print('拍号   %s' % ', '.join('第%d小节起 %s' % (a, b) for a, b in time_signatures(song)))

    target_track = song.tracks[args.track] if args.track is not None else None
    if target_track is None:
        for track in song.tracks:
            if not getattr(track, 'isPercussionTrack', False):
                target_track = track
                break

    changes = tempo_map(song, target_track) if target_track is not None else []
    if len(changes) > 1:
        print('变速   %s' % ', '.join('%ss→%gBPM' % (c['t'], c['bpm']) for c in changes[1:]))

    print('\n--- 轨道 ---')
    for track in song.tracks:
        info = track_summary(song, track)
        notes = collect_notes(song, track)
        print('  [%d] %-22s %d 弦  调弦 %-26s 音符 %4d %s'
              % (info['index'], (info['name'] or '?')[:22], info['strings'],
                 ' '.join(info['tuning']), len(notes),
                 '（打击轨）' if info['is_percussion'] else ''))

    target = target_track
    if target is None:
        print('\n没有可用的旋律/伴奏轨。')
        return 0

    notes = collect_notes(song, target)
    info = track_summary(song, target)
    print('\n--- 时间轴：轨 [%d] %s ---' % (info['index'], info['name']))
    if notes:
        end = notes[-1]['t'] + notes[-1]['dur']
        print('  跨度   %.2fs ～ %.2fs（共 %.2fs）' % (notes[0]['t'], end, end - notes[0]['t']))
        hi = max(n['midi'] for n in notes)
        lo = min(n['midi'] for n in notes)
        print('  音域   %s ～ %s' % (midi_name(lo), midi_name(hi)))
        per_measure = len(notes) / float(max(1, len(song.measureHeaders)))
        print('  密度   平均每小节 %.1f 个音符' % per_measure)
        chained = [notes[i + 1]['t'] - notes[i]['t'] for i in range(len(notes) - 1)]
        chained = [g for g in chained if g > 0]
        if chained:
            srt = sorted(chained)
            print('  音间隔 中位 %.0fms，最短 %.0fms' % (srt[len(srt) // 2] * 1000, srt[0] * 1000))
        print('  前 %d 个音符：' % min(args.notes, len(notes)))
        print('     %-9s %-8s %-5s %-5s %s' % ('时间', '时值', '弦', '品', '音'))
        for n in notes[:args.notes]:
            print('     %7.2fs  %6.2fs  %4d  %5d  %-4s'
                  % (n['t'], n['dur'], n['string'], n['fret'], midi_name(n['midi'])))

    if args.json:
        payload = {
            'meta': {
                'file': args.guitarpro_file,
                'title': song.title,
                'artist': song.artist,
                'album': song.album,
                'tempo': float(song.tempo),
                'measures': len(song.measureHeaders),
                'timeSignatures': [{'measure': a, 'sig': b} for a, b in time_signatures(song)],
                'repeats': repeats(song, target),
                'track': info,
            },
            'tempoMap': changes,
            'notes': notes,
        }
        with open(args.json, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
        print('\n时间轴已写出：%s（%d 个音符）' % (args.json, len(notes)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
