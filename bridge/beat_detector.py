"""Causal multifeature tempo and pulse tracking using NumPy primitives.

8 kHz signed-16 mono, 160-sample frames, monotonic frame-end timestamps.
Independent spectral bands and bass-energy attacks retain their rhythm evidence.
Ground-truth tempos and benchmark filenames are never inputs to this module.
"""
from collections import deque
import math
import numpy as np
from bridge.pulse_tracker import PulseTracker

RATE = 8000
SAMPLES = 160
HOP = SAMPLES / RATE


class BeatDetector:
    def __init__(self, min_bpm=60, max_bpm=200, cutoff=200, sensitivity=1.5):
        self.min_bpm, self.max_bpm = min_bpm, max_bpm
        self.sensitivity = sensitivity
        self.cutoff = cutoff
        self.window = np.hanning(512)
        frequencies = np.fft.rfftfreq(len(self.window), 1 / RATE)
        self.bands = [(frequencies >= low) & (frequencies < high)
                      for low, high in [(30, cutoff), (cutoff, 800), (800, 1600), (1600, 4001)]]
        self.tempos = np.arange(min_bpm, max_bpm + .001, .25)
        self.reset()

    def reset(self):
        self.pulse = PulseTracker(self.min_bpm, self.max_bpm, self.cutoff, self.sensitivity)
        self.last_clear_pulse = -math.inf
        self.pcm = np.zeros(len(self.window))
        self.spectrum = np.zeros(len(self.window) // 2 + 1)
        self.feature_average = np.zeros(5)
        self.previous_bass = 0.
        self.features = deque(maxlen=800)  # Sixteen seconds, independent channels.
        self.energy = deque(maxlen=50)
        self.onsets = deque(maxlen=96)
        self.previous = self.before_previous = 0.
        self.last_onset = self.last_signal = self.last_estimate = -math.inf
        self.bpm = self.candidate_bpm = self.anchor = None
        self.confidence = 0.
        self.last_beat = -math.inf
        self.last_time = None
        self.pending_bpm = None
        self.pending_count = self.weak_count = 0
        self.tempo_memory = None
        self.preferred_bpm = None
        self.preferred_time = -math.inf

    def estimate(self):
        self.candidate_bpm = None
        if len(self.features) < 50 or len(self.onsets) < 2:
            return None, 0.
        features = np.asarray(self.features)
        smoothed = np.column_stack([np.convolve(features[:, b], [.25, .5, .25], 'same')
                                    for b in range(features.shape[1])])
        evidence = smoothed - smoothed.mean(axis=0)
        power = np.sum(evidence ** 2, axis=0)
        active = power > max(1e-6, float(power.max()) * .01)
        if not active.any():
            return None, 0.
        size = 1 << (2 * len(evidence) - 1).bit_length()
        fft = np.fft.rfft(evidence, n=size, axis=0)
        ac = np.fft.irfft(fft * fft.conj(), n=size, axis=0)[:len(evidence)]
        # Prefix energies normalize every overlapping lag without Python loops.
        cumulative = np.vstack((np.zeros((1, 5)), np.cumsum(evidence ** 2, axis=0)))
        lags = np.arange(len(evidence))
        norm = np.sqrt(cumulative[len(evidence) - lags] * (cumulative[-1] - cumulative[lags]))
        ac /= np.maximum(norm, 1e-9)
        ac[:, ~active] = 0
        periods = 60 / self.tempos
        # A beat can carry a kick, clap, or rest. Score recurrence over a beat,
        # two beats, and four beats instead of requiring identical beat accents.
        scores = np.zeros((len(self.tempos), 5))
        for multiple, weight in ((1, .45), (2, .2), (4, .35)):
            positions = periods / HOP * multiple
            valid = positions < len(evidence) * .65
            for band in range(5):
                scores[:, band] += weight * np.interp(positions, lags, ac[:, band]) * valid
        ordered = np.sort(scores[:, active], axis=1)
        strength = np.mean(ordered[:, -min(3, int(active.sum())):], axis=1)
        if self.tempo_memory is None:
            self.tempo_memory = strength.copy()
        else:
            self.tempo_memory += .25 * (strength - self.tempo_memory)
        strength = .5 * strength + .5 * self.tempo_memory
        # A broad prior resolves octave ambiguity; rhythmic evidence still wins
        # when the slower/faster interpretation is substantially better supported.
        distance = np.maximum(0, abs(np.log2(self.tempos / 120)) - .35)
        prior = .45 * np.exp(-.5 * (distance / .35) ** 2)
        ranking = strength + prior
        if self.bpm:
            ranking += .02 * np.exp(-.5 * (np.log2(self.tempos / self.bpm) / .04) ** 2)
        winner = int(np.argmax(ranking))
        if self.bpm:
            current = int(np.argmin(abs(self.tempos - self.bpm)))
            different = abs(self.tempos[winner] / self.bpm - 1) >= .03
            if different and ranking[winner] - ranking[current] < .08:
                winner = current  # Require a material improvement before switching grids.
        candidate = float(self.tempos[winner])
        self.candidate_bpm = candidate
        confidence = float(np.clip((strength[winner] - np.median(strength)) / .6, 0, 1))
        ready = len(features) >= 400 and len(self.onsets) >= 4

        if (self.preferred_bpm and self.last_time - self.preferred_time < 16
                and abs(candidate / self.preferred_bpm - 1) >= .03 and confidence < .35):
            # Weak competing subdivisions may be displayed, but must not
            # replace a recently supported pulse. Abstain while evidence is weak.
            self.pending_bpm, self.pending_count = None, 0
            return None, min(.34, confidence)
        if confidence >= .15:
            if self.pending_bpm is not None and abs(candidate / self.pending_bpm - 1) < .03:
                self.pending_count += 1
            else:
                self.pending_bpm, self.pending_count = candidate, 1
            self.weak_count = 0
            confidence = min(1., confidence + .2 * min(1., self.pending_count / 16))
            if confidence < .35 or not ready:
                return None, confidence
            if self.bpm and abs(candidate / self.bpm - 1) < .03:
                bpm = self.bpm + .25 * (candidate - self.bpm)
            elif self.pending_count >= 3:
                bpm = candidate
            else:
                bpm = self.bpm
        else:
            self.pending_bpm, self.pending_count = None, 0
            self.weak_count += 1
            bpm = self.bpm if self.weak_count <= 4 and confidence >= .18 else None
        if bpm is None:
            return None, min(.34, confidence)
        # Phase evidence comes from the supported channels, with DC/background
        # removed. This avoids pulling the grid toward every syncopated onset.
        period = 60 / bpm
        band_support = scores[int(np.argmin(abs(self.tempos - bpm)))]
        weights = np.maximum(0, band_support)
        phase_signal = np.maximum(0, smoothed - np.median(smoothed, axis=0)) @ weights
        times = self.last_time - len(self.window) / (2 * RATE) - np.arange(len(features) - 1, -1, -1) * HOP
        origins = np.linspace(0, period, 64, endpoint=False)
        distances = np.abs(((times - times[-1])[:, None] - origins + period / 2) % period - period / 2)
        phase_scores = phase_signal @ np.exp(-.5 * (distances / (.08 * period)) ** 2)
        anchor = float(times[-1] + origins[int(np.argmax(phase_scores))])
        if self.anchor is not None and self.bpm is not None:
            error = (anchor - self.anchor + period / 2) % period - period / 2
            anchor = self.anchor + float(np.clip(error, -.03, .03))
        self.anchor = anchor
        self.preferred_bpm, self.preferred_time = float(bpm), self.last_time
        return float(bpm), max(.35, confidence)

    def process(self, samples, now):
        if self.last_time is not None and abs(now - self.last_time - HOP) > .1:
            self.reset()
        self.last_time = now
        pulse = self.pulse.process(samples, now)
        audio = np.asarray(samples, dtype=float) / 32768
        if len(audio) != SAMPLES:
            raise ValueError('BeatDetector requires 160-sample frames')
        audio = np.nan_to_num(audio)
        amplitude = float(np.sqrt(np.mean(audio ** 2)))
        self.pcm[:-SAMPLES] = self.pcm[SAMPLES:]
        self.pcm[-SAMPLES:] = audio
        centered = self.pcm - self.pcm.mean()
        magnitude = np.abs(np.fft.rfft(centered * self.window)) / self.window.sum()
        # Compare against a local spectral maximum to suppress small frequency
        # movements of sustained notes while preserving new broadband attacks.
        local = np.maximum(self.spectrum, np.maximum(np.roll(self.spectrum, 1), np.roll(self.spectrum, -1)))
        difference = np.maximum(0, magnitude - local)
        spectral = [float(np.mean(difference[band])) if np.any(band) else 0. for band in self.bands]
        bass = float(np.sqrt(np.sum(magnitude[self.bands[0]] ** 2)))
        raw_features = np.array([*spectral, max(0., bass - self.previous_bass)])
        self.feature_average += .02 * (raw_features - self.feature_average)
        features = np.log1p(raw_features / (self.feature_average + 1e-5))
        self.features.append(features if amplitude > .0008 else np.zeros(5))
        flux = float(np.sum(features))
        background = float(np.mean(self.energy)) if self.energy else flux
        onset_time = now - HOP - len(self.window) / (2 * RATE)
        if (self.previous > self.before_previous and self.previous >= flux
                and self.previous > max(.1, background * self.sensitivity)
                and onset_time - self.last_onset >= .08 and amplitude > .0008):
            self.last_onset = onset_time
            self.onsets.append(onset_time)
        self.energy.append(flux)
        self.before_previous, self.previous = self.previous, flux
        self.spectrum, self.previous_bass = magnitude, bass
        if amplitude > .0008:
            self.last_signal = now
        if now - self.last_estimate >= .5:
            self.bpm, self.confidence = self.estimate()
            self.last_estimate = now
        if now - self.last_onset > 3:
            self.bpm, self.candidate_bpm, self.anchor = None, None, None
            self.confidence = 0.
            self.pending_bpm, self.pending_count = None, 0
            self.onsets.clear()
        # A precise peak hypothesis is preferable when individual attacks form
        # a clear pulse. Complex tracks use independent multifeature evidence.
        if pulse['bpm'] is not None and pulse['confidence'] >= .65:
            self.last_clear_pulse = now
            self.preferred_bpm, self.preferred_time = pulse['bpm'], now
        if pulse['bpm'] is not None and now - self.last_clear_pulse < 2:
            self.bpm = self.candidate_bpm = pulse['bpm']
            self.confidence = pulse['confidence']
            self.anchor = self.pulse.anchor
            if pulse['beat']:
                self.last_beat = pulse['beat_timestamp']
            return {**pulse, 'candidate_bpm': pulse['bpm'], 'locked': True}
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
