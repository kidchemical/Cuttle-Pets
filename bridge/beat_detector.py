"""Streaming tempo and pulse tracking. NumPy supplies numerical primitives only.

Input is 8 kHz signed-16 mono, in 20 ms frames; times are frame-end times
on a monotonic sample clock. All analysis is causal and bounded in memory.
"""
from collections import deque
import math
import numpy as np

RATE = 8000
SAMPLES = 160
HOP = SAMPLES / RATE


class BeatDetector:
    def __init__(self, min_bpm=60, max_bpm=200, cutoff=200, sensitivity=1.5):
        self.min_bpm, self.max_bpm = min_bpm, max_bpm
        self.sensitivity = sensitivity
        self.window = np.hanning(256)
        self.pcm = np.zeros(256)
        frequencies = np.fft.rfftfreq(256, 1 / RATE)
        self.bands = [(frequencies >= low) & (frequencies < high)
                      for low, high in [(30, cutoff), (cutoff, 1600), (1600, 4001)]]
        self.spectrum = np.zeros(129)
        self.energy = deque(maxlen=50)
        self.odf = deque(maxlen=400)  # Eight seconds of onset evidence.
        self.onsets = deque(maxlen=96)
        self.strengths = deque(maxlen=96)
        self.previous = self.before_previous = 0.
        self.last_onset = self.last_signal = self.last_estimate = -math.inf
        self.bpm = None
        self.candidate_bpm = None
        self.confidence = 0.
        self.anchor = None
        self.last_beat = -math.inf
        self.last_time = None

    def estimate(self):
        self.candidate_bpm = None
        if len(self.onsets) < 2 or len(self.odf) < 50:
            return None, 0.
        evidence = np.asarray(self.odf, dtype=float)
        # Smooth one hop to reduce autocorrelation loss from frame quantization.
        evidence = np.convolve(evidence, [.25, .5, .25], mode='same')
        evidence -= evidence.mean()
        power = float(evidence @ evidence)
        if power < 1e-9:
            return None, 0.
        # Zero padding avoids circular autocorrelation. Normalize each lag by
        # the energy of its overlapping segments (not by total window energy).
        size = 1 << (2 * len(evidence) - 1).bit_length()
        spectrum = np.fft.rfft(evidence, n=size)
        ac = np.fft.irfft(spectrum * spectrum.conj(), n=size)[:len(evidence)]
        low = max(2, int(math.floor(60 / self.max_bpm / HOP)))
        high = min(len(evidence) // 2, int(math.ceil(60 / self.min_bpm / HOP)))
        times = np.asarray(self.onsets)
        weights = np.asarray(self.strengths) if len(self.strengths) == len(times) else np.ones(len(times))
        candidates = []
        deltas = (times[:, None] - times[None, :])[np.tril_indices(len(times), -1)]
        for lag in range(low, high + 1):
            if ac[lag] < ac[lag - 1] or ac[lag] < ac[lag + 1]:
                continue
            denominator = ac[lag - 1] - 2 * ac[lag] + ac[lag + 1]
            offset = .5 * (ac[lag - 1] - ac[lag + 1]) / denominator if abs(denominator) > 1e-9 else 0
            period = (lag + float(np.clip(offset, -.5, .5))) * HOP
            # Refine using several onset spacings. Sample quantization then
            # averages out rather than becoming an error in every beat period.
            ticks = np.rint(deltas / period)
            match = (ticks >= 1) & (np.abs(deltas / period - ticks) < .14)
            if np.count_nonzero(match) >= 3:
                period = float(np.sum(deltas[match] * ticks[match]) / np.sum(ticks[match] ** 2))
            bpm = 60 / period
            if not self.min_bpm * .99 <= bpm <= self.max_bpm * 1.01:
                continue
            bpm = float(np.clip(bpm, self.min_bpm, self.max_bpm))
            period = 60 / bpm
            phases = (times - times[-1]) % period
            # Choose a grid supported by strong onsets, not every onset.
            origins = np.linspace(0, period, 64, endpoint=False)
            distances = np.abs((phases[:, None] - origins + period / 2) % period - period / 2)
            support = np.exp(-.5 * (distances / (.08 * period)) ** 2)
            phase_scores = (support * (weights ** 2)[:, None]).sum(axis=0) / max(np.sum(weights ** 2), 1e-9)
            phase_index = int(np.argmax(phase_scores))
            coherence = float(phase_scores[phase_index])
            overlap = math.sqrt(float(evidence[:-lag] @ evidence[:-lag]) * float(evidence[lag:] @ evidence[lag:]))
            periodicity = max(0., float(ac[lag]) / max(overlap, 1e-9))
            confidence = periodicity * math.sqrt(coherence) * min(1., (len(times) - 1) / 6)
            if coherence < .25:
                confidence = 0.
            # Weak prior resolves near ties; continuity favors the current
            # hypothesis but cannot override substantially stronger evidence.
            prior = .025 * math.exp(-.5 * (math.log2(bpm / 120) / .7) ** 2)
            continuity = .025 if self.bpm and abs(math.log2(bpm / self.bpm)) < .08 else 0
            # A doubled pulse often alternates strong and weak accents.
            # Accent consistency discourages selecting subdivisions.
            origin = times[-1] + origins[phase_index]
            slots = np.rint((times - origin) / period).astype(int)
            aligned = np.abs(times - origin - slots * period) < .12 * period
            even = weights[aligned & (slots % 2 == 0)]
            odd = weights[aligned & (slots % 2 != 0)]
            contrast = 0.
            if min(len(even), len(odd)) >= 3:
                contrast = abs(float(even.mean() - odd.mean())) / max(float(even.mean() + odd.mean()), 1e-9)
            candidates.append((confidence + prior + continuity - .45 * contrast, confidence, bpm,
                               times[-1] + origins[phase_index]))
        if not candidates:
            return None, 0.
        _, confidence, bpm, anchor = max(candidates)
        self.candidate_bpm = bpm
        if confidence < .35 or len(self.onsets) < 4 or len(self.odf) < 100:
            return None, confidence
        if self.anchor is not None and self.bpm is not None:
            period = 60 / bpm
            error = (anchor - self.anchor + period / 2) % period - period / 2
            anchor = self.anchor + float(np.clip(error, -.03, .03))
        self.anchor = anchor
        return bpm, min(1., confidence)

    def process(self, samples, now):
        if self.last_time is not None and abs(now - self.last_time - HOP) > .1:
            # A capture discontinuity must not create a fictitious pulse train.
            self.onsets.clear(); self.strengths.clear(); self.odf.clear()
            self.bpm, self.confidence, self.anchor = None, 0., None
            self.candidate_bpm = None
            self.pcm.fill(0); self.spectrum.fill(0)
            self.energy.clear(); self.previous = self.before_previous = 0.
            self.last_onset = self.last_signal = self.last_beat = self.last_estimate = -math.inf
        self.last_time = now
        audio = np.asarray(samples, dtype=float) / 32768
        if len(audio) != SAMPLES:
            raise ValueError('BeatDetector requires 160-sample frames')
        audio = np.nan_to_num(audio)
        amplitude = float(np.sqrt(np.mean(audio * audio)))
        self.pcm[:-SAMPLES] = self.pcm[SAMPLES:]
        self.pcm[-SAMPLES:] = audio
        centered = self.pcm - self.pcm.mean()
        magnitude = np.abs(np.fft.rfft(centered * self.window)) / self.window.sum()
        compressed = np.log1p(100 * magnitude)
        difference = np.maximum(0, compressed - self.spectrum)
        # Mean per band prevents the many high-frequency bins from drowning
        # bass transients. Broadband evidence remains useful without a kick.
        flux = sum(float(np.mean(difference[band])) for band in self.bands if np.any(band))
        self.spectrum = compressed
        bass = float(np.sqrt(np.sum(magnitude[self.bands[0]] ** 2)))
        background = float(np.mean(self.energy)) if self.energy else flux
        onset = (self.previous > self.before_previous and self.previous >= flux
                 and self.previous > max(.015, background * self.sensitivity)
                 and now - HOP - len(self.window) / (2 * RATE) - self.last_onset >= .08
                 and amplitude > .0008)
        self.odf.append(flux if amplitude > .0008 else 0.)
        if onset:
            # The previous FFT window is centered before this frame's end.
            self.last_onset = now - HOP - len(self.window) / (2 * RATE)
            self.onsets.append(self.last_onset)
            self.strengths.append(self.previous)
        while self.onsets and now - self.onsets[0] > 8:
            self.onsets.popleft(); self.strengths.popleft()
        self.energy.append(flux)
        self.before_previous, self.previous = self.previous, flux
        if amplitude > .0008:
            self.last_signal = now
        if now - self.last_estimate >= .25:
            self.bpm, self.confidence = self.estimate()
            self.last_estimate = now
        if now - self.last_onset > 3:
            self.bpm, self.confidence, self.anchor = None, 0., None
            self.candidate_bpm = None
            self.onsets.clear(); self.strengths.clear()
        beat = False
        beat_time = next_beat = None
        if self.bpm and self.anchor is not None and now - self.last_signal < .2:
            period = 60 / self.bpm
            grid = self.anchor + math.floor((now - self.anchor) / period) * period
            next_beat = grid + period
            if grid > self.last_beat + period * .5 and now - grid < HOP * 1.5:
                beat, beat_time, self.last_beat = True, grid, grid
        return {'beat': beat, 'bpm': self.bpm, 'candidate_bpm': self.candidate_bpm,
                'locked': self.bpm is not None, 'confidence': self.confidence,
                'beat_timestamp': beat_time, 'next_beat': next_beat,
                'level': bass, 'amplitude': amplitude, 'playing': now - self.last_signal < 2}
