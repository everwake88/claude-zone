#!/usr/bin/env python3
"""The launch film's music and sound, made from scratch: no samples, nothing
to license. A warm 112 BPM groove in A minor (Am - F - C - G) that follows the
film: pads while it opens, the beat when the title lands, a breakdown while
the agent is switched off, back in when it is on again, a soft ending. The
order bell, the clicks and the message pops sit on top, on the film's cues.

  python3 music.py cues.json out.wav

cues.json: {"duration": s, "drums_in": s, "break": [start, end], "outro": s,
            "sfx": [[time, "ding" | "click" | "pop" | "send" | "whoosh"], ...]}
"""
import json
import sys
import wave

import numpy as np

SR = 48000
BPM = 112
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)

cues = json.load(open(sys.argv[1]))
DUR = float(cues['duration'])
N = int(DUR * SR) + SR
DRUMS_IN = float(cues['drums_in'])
BREAK = cues.get('break') or [DUR + 1, DUR + 1]
OUTRO = float(cues.get('outro', DUR - 8))


def stem():
    return np.zeros((2, N))


def place(buf, sig, t, gain=1.0, pan=0.0):
    """add a mono or stereo signal at time t (pan -1 left .. 1 right)"""
    i = int(t * SR)
    if i >= N or i + 1 < 0:
        return
    if sig.ndim == 1:
        sig = np.vstack([sig * np.sqrt((1 - pan) / 2), sig * np.sqrt((1 + pan) / 2)]) * np.sqrt(2)
    j = min(N, i + sig.shape[1])
    buf[:, i:j] += gain * sig[:, : j - i]


def spectral(x, lo=None, hi=None, order=4):
    """gentle high/low-pass on a whole buffer, done in the frequency domain"""
    n = x.shape[-1]
    f = np.fft.rfftfreq(n, 1 / SR)
    h = np.ones_like(f)
    if hi:
        h /= np.sqrt(1 + (f / hi) ** (2 * order))
    if lo:
        h *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-3)) ** (2 * order))
    return np.fft.irfft(np.fft.rfft(x, axis=-1) * h, n=n, axis=-1)


def reverb(x, seconds=2.2, damp=5000):
    ir_n = int(seconds * SR)
    t = np.arange(ir_n) / SR
    out = np.zeros_like(x)
    for ch in range(2):
        ir = rng.standard_normal(ir_n) * np.exp(-6.9 * t / seconds)
        ir = spectral(ir, hi=damp, order=1)
        ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
        ir /= np.sqrt(np.sum(ir ** 2))
        size = 1 << int(np.ceil(np.log2(N + ir_n)))
        out[ch] = np.fft.irfft(np.fft.rfft(x[ch], size) * np.fft.rfft(ir, size), size)[:N]
    return out


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def tone(freq, dur, partials=((1, 1.0),), detune=0.0, phase=0.0):
    t = np.arange(int(dur * SR)) / SR
    f = freq * 2 ** (detune / 1200)
    return sum(a * np.sin(2 * np.pi * f * k * t + phase * k) for k, a in partials)


def env(n, attack, release, total):
    e = np.ones(n)
    a = max(1, int(attack * SR))
    r = max(1, int(release * SR))
    e[:a] = np.linspace(0, 1, a)
    e[max(0, n - r):] *= np.linspace(1, 0, min(n, r))
    return e


# Am - F - C - G, voiced close and warm (MIDI notes)
CHORDS = [
    [57, 60, 64, 67],   # A3 C4 E4 G4  (Am7)
    [53, 57, 60, 64],   # F3 A3 C4 E4  (Fmaj7)
    [48, 55, 60, 64],   # C3 G3 C4 E4  (C)
    [55, 59, 62, 67],   # G3 B3 D4 G4  (G)
]
ROOTS = [45, 41, 48, 43]  # A2 F2 C3 G2
bars = int(np.ceil(DUR / BAR)) + 1


def drums_on(t):
    return DRUMS_IN <= t < OUTRO and not (BREAK[0] <= t < BREAK[1])


# ---- pad --------------------------------------------------------------------
pad = stem()
pad_dark = stem()
for b in range(bars):
    t0 = b * BAR
    chord = CHORDS[b % 4]
    for m in chord:
        for side, cents in ((-1, -7), (1, 7)):
            s = tone(hz(m), BAR + 0.9, partials=[(k, 1 / k ** 1.4) for k in range(1, 7)], detune=cents, phase=rng.random() * 6)
            s *= env(len(s), 0.5, 0.9, len(s))
            place(pad, s, t0, 0.05, pan=0.55 * side)
pad_dark = spectral(pad, hi=500, order=2)
pad = spectral(pad, lo=150, hi=2200, order=2)
# the opening sweeps from dark to bright into the title
w = np.clip((np.arange(N) / SR - 1.0) / max(0.1, DRUMS_IN - 1.0), 0, 1)
pad = pad_dark * (1 - w) + pad * w

# ---- plucked arpeggio ---------------------------------------------------------
pluck = stem()
ORDER = [0, 2, 1, 3, 2, 1, 3, 2]
for b in range(bars):
    chord = CHORDS[b % 4]
    for k in range(16):
        t = b * BAR + k * BEAT / 4
        if t >= DUR:
            break
        if t < DRUMS_IN and k % 2:
            continue                       # sparser while the film opens
        if BREAK[0] <= t < BREAK[1] and k % 4:
            continue
        note = chord[ORDER[k % 8]] + 12
        s = tone(hz(note), 0.45, partials=[(1, 1), (2, 0.35), (3, 0.12)])
        s *= np.exp(-np.arange(len(s)) / SR * 9) * env(len(s), 0.003, 0.05, len(s))
        accent = 1.0 if k % 4 == 0 else 0.7
        place(pluck, s, t, 0.055 * accent, pan=0.45 if k % 2 else -0.45)
pluck = spectral(pluck, lo=180, hi=5000)

# ---- a bell motif every eight bars --------------------------------------------
bell = stem()
MOTIF = [(0, 76), (1, 74), (2, 72), (3.5, 69), (6, 67), (7, 69), (8, 72)]
for b in range(0, bars, 8):
    t0 = b * BAR
    if t0 < DRUMS_IN or t0 >= OUTRO:
        continue
    for beat, m in MOTIF:
        s = tone(hz(m), 1.6, partials=[(1, 1), (2.76, 0.18), (5.4, 0.05)])
        s *= np.exp(-np.arange(len(s)) / SR * 3.2) * env(len(s), 0.004, 0.2, len(s))
        place(bell, s, t0 + beat * BEAT / 2, 0.05, pan=0.2)

# ---- bass ---------------------------------------------------------------------
bass = stem()
PATTERN = [1, 0, 1, 1, 0, 1, 1, 0]
for b in range(bars):
    root = ROOTS[b % 4] - 12
    for k in range(8):
        t = b * BAR + k * BEAT / 2
        if not PATTERN[k] or not drums_on(t):
            continue
        s = tone(hz(root), 0.26, partials=[(1, 1), (2, 0.3), (3, 0.08)])
        s = np.tanh(1.6 * s) * env(len(s), 0.004, 0.08, len(s))
        place(bass, s, t, 0.16)
bass = spectral(bass, hi=900)

# ---- drums --------------------------------------------------------------------
drums = stem()
kick_times = []
tk = np.arange(int(0.42 * SR)) / SR
kick = np.sin(2 * np.pi * np.cumsum(46 + 95 * np.exp(-tk * 32)) / SR) * np.exp(-tk * 7.5)
kick[: int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
th = np.arange(int(0.08 * SR)) / SR
hat = spectral(rng.standard_normal(len(th)), lo=7000) * np.exp(-th * 60)
tc = np.arange(int(0.25 * SR)) / SR
clap = spectral(rng.standard_normal(len(tc)), lo=900, hi=5000) * np.exp(-tc * 24)
clap = clap + 0.5 * np.roll(clap, int(0.011 * SR)) + 0.3 * np.roll(clap, int(0.023 * SR))
n_beats = int(DUR / BEAT) + 1
for i in range(n_beats):
    t = i * BEAT
    if not drums_on(t):
        continue
    place(drums, kick, t, 0.42)
    kick_times.append(t)
    if i % 4 in (1, 3):
        place(drums, clap, t, 0.07)
    place(drums, hat, t + BEAT / 2, 0.05, pan=0.3)
    if i % 2:
        place(drums, hat, t + BEAT * 0.75, 0.025, pan=-0.3)

# a riser into the beat coming back after the breakdown
riser = stem()
if BREAK[1] < DUR:
    rl = 2 * BAR
    tr = np.arange(int(rl * SR)) / SR
    noise = spectral(rng.standard_normal(len(tr)), lo=600, hi=6000)
    place(riser, noise * (tr / rl) ** 2.2 * 0.06, BREAK[1] - rl)

# ---- sidechain: the music breathes with the kick ------------------------------
duck = np.ones(N)
for t in kick_times:
    i = int(t * SR)
    j = min(N, i + int(0.3 * SR))
    duck[i:j] = np.minimum(duck[i:j], 1 - 0.55 * np.exp(-np.arange(j - i) / SR * 11))

music = (pad * 1.0 + pluck * 0.9 + bass) * duck + drums + bell + riser
music += 0.22 * reverb(pad * 0.6 + pluck + bell * 1.5 + drums * 0.15)

# ---- sound effects ------------------------------------------------------------
sfx = stem()
for t, kind in cues.get('sfx', []):
    if kind == 'ding':
        for k, m in enumerate((88, 93)):        # E6 then A6
            s = tone(hz(m), 1.2, partials=[(1, 1), (2.0, 0.25), (3.0, 0.1)])
            place(sfx, s * np.exp(-np.arange(len(s)) / SR * 4.5) * env(len(s), 0.002, 0.1, len(s)), t + k * 0.13, 0.16)
    elif kind == 'click':
        tt = np.arange(int(0.03 * SR)) / SR
        s = np.sin(2 * np.pi * 2900 * tt) * np.exp(-tt * 260) + 0.4 * rng.standard_normal(len(tt)) * np.exp(-tt * 900)
        place(sfx, s, t, 0.09)
    elif kind in ('pop', 'send'):
        tt = np.arange(int(0.09 * SR)) / SR
        f0, f1 = (700, 1100) if kind == 'pop' else (1000, 1500)
        s = np.sin(2 * np.pi * np.cumsum(f0 + (f1 - f0) * (tt / tt[-1])) / SR) * np.exp(-tt * 45)
        place(sfx, s * env(len(s), 0.003, 0.02, len(s)), t, 0.07)
    elif kind == 'whoosh':
        tt = np.arange(int(0.5 * SR)) / SR
        s = spectral(rng.standard_normal(len(tt)), lo=500, hi=4000) * np.sin(np.pi * tt / tt[-1]) ** 2
        place(sfx, s, t - 0.25, 0.035)
sfx += 0.15 * reverb(sfx, seconds=1.2)

mix = music + sfx
# fades: in over the first second, out over the last six
tt = np.arange(N) / SR
mix *= np.clip(tt / 1.0, 0, 1) * np.clip((DUR - tt) / 6.0, 0, 1)
mix = np.tanh(1.15 * mix)
mix *= 0.89 / max(1e-6, np.max(np.abs(mix)))
mix = mix[:, : int(DUR * SR)]

with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print(f'wrote {sys.argv[2]}: {DUR:.1f}s')
