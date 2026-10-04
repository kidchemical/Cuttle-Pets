"""Streaming acceptance fixtures with independent tempo and phase truth."""
import unittest
import numpy as np
from bridge.beat_detector import BeatDetector, RATE, SAMPLES
from bridge.wasapi_capture import MonoFrames


def track(bpm=120, seconds=16, drift=0, offbeat=False, missed=False, seed=2026):
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * RATE)) / RATE
    phase = bpm / 60 * (t + drift * t * t / (2 * seconds))
    beat_times = np.interp(np.arange(int(phase[-1]) + 1), phase, t)
    pulse_age = (phase % 1) * 60 / bpm
    kick_age = ((phase - (.5 if offbeat else 0)) % 1) * 60 / bpm
    kick = .4 * np.exp(-kick_age * 40) * np.sin(2 * np.pi * 75 * t)
    if offbeat:
        kick *= .15
    if missed:
        kick *= (np.floor(phase) % 4 != 2)
    # Eighth-note hats, with a stronger accent on the beat; steady harmonic
    # accompaniment and low noise should not become extra beat events.
    hat_age = ((phase * 2) % 1) * 30 / bpm
    hats = rng.normal(size=len(t)) * np.exp(-hat_age * 110)
    hats *= np.where(phase % 1 < .5, .24, .07)
    audio = kick + hats + .03 * np.sin(2 * np.pi * 440 * t) + .001 * rng.normal(size=len(t))
    return np.rint(np.clip(audio, -.99, .99) * 32767).astype(np.int16), beat_times


def analyze(audio, **kwargs):
    detector = BeatDetector(**kwargs)
    results = []
    for start in range(0, len(audio) - SAMPLES + 1, SAMPLES):
        now = (start + SAMPLES) / RATE
        results.append((now, detector.process(audio[start:start + SAMPLES], now)))
    return detector, results


class TrackingTests(unittest.TestCase):
    def test_mixed_grooves_have_stable_tempo_and_grid(self):
        for bpm in (75, 95, 120, 170, 195):
            for variant in ({}, {'offbeat': True}, {'missed': True}):
                with self.subTest(bpm=bpm, **variant):
                    audio, truth = track(bpm, **variant)
                    _, results = analyze(audio)
                    locked = [(now, r) for now, r in results if now > 8 and r['bpm']]
                    self.assertGreater(len(locked), 250)
                    self.assertLess(np.percentile([abs(r['bpm'] - bpm) for _, r in locked], 95), 2)
                    pulses = [r['beat_timestamp'] for now, r in results if now > 8 and r['beat']]
                    self.assertGreater(len(pulses), 7)
                    errors = [min(abs(truth - pulse)) for pulse in pulses]
                    self.assertLess(np.percentile(errors, 95), .08)
                    self.assertGreater(min(np.diff(pulses)), 60 / bpm * .7)

    def test_randomized_hat_textures_keep_tempo(self):
        for seed in (7, 999):
            for bpm in (75, 95, 170, 195):
                with self.subTest(seed=seed, bpm=bpm):
                    audio, _ = track(bpm, offbeat=True, seed=seed)
                    _, results = analyze(audio)
                    tail = [r for now, r in results if now > 8 and r['bpm']]
                    self.assertGreater(len(tail), 250)
                    self.assertLess(np.percentile([abs(r['bpm'] - bpm) for r in tail], 95), 2)

    def test_tentative_tempo_is_available_before_motion_lock(self):
        audio, _ = track(120, seconds=6)
        _, results = analyze(audio)
        tentative = [r for _, r in results if r['candidate_bpm'] is not None and r['bpm'] is None]
        self.assertTrue(tentative)
        self.assertTrue(all(not r['locked'] and not r['beat'] for r in tentative))
        self.assertTrue(any(r['locked'] for _, r in results))

    def test_lock_time_and_gradual_drift(self):
        audio, truth = track(drift=.02, seconds=24)
        _, results = analyze(audio)
        first = next(now for now, r in results if r['bpm'])
        self.assertLess(first, 6)
        tail = [r for now, r in results if now > 18 and r['bpm']]
        self.assertGreater(len(tail), 200)
        self.assertLess(abs(tail[-1]['bpm'] - 122.4), 2)

    def test_noise_tone_and_silence_do_not_lock(self):
        rng = np.random.default_rng(12)
        t = np.arange(RATE * 12) / RATE
        for audio in (np.zeros(len(t)), .1 * rng.normal(size=len(t)), .2 * np.sin(2 * np.pi * 440 * t)):
            with self.subTest(kind=float(np.std(audio))):
                _, results = analyze(np.rint(audio * 32767).astype(np.int16))
                self.assertFalse(any(r['bpm'] for _, r in results))

    def test_release_needs_sustained_disagreement_not_one_weak_frame(self):
        # A single dip in confidence must not drop a supported pulse, while a
        # candidate that has moved away, or silence, still releases it.
        detector = BeatDetector()
        detector.bpm = 120.
        detector.weak_count = 1
        self.assertEqual(detector.retain(120., .05), 120., 'one weak frame dropped the lock')
        self.assertIsNone(detector.retain(93., .05), 'a different tempo should release')
        self.assertIsNone(detector.retain(None, 0.), 'no evidence should release')
        detector.weak_count = 13
        self.assertIsNone(detector.retain(120., .05), 'sustained weakness should release')
        detector.bpm = None
        detector.weak_count = 1
        self.assertIsNone(detector.retain(120., .5), 'nothing to retain')

    def test_stable_challenger_eventually_wins_a_contested_lock(self):
        # Incumbent protection must not freeze the challenger's accumulator:
        # confidence is boosted by candidate consistency, so clearing it while
        # the challenger is merely weaker than the recent pulse deadlocks it.
        # A beat buried in noise: the candidate stays correct while confidence is too
        # low to switch, which is exactly when incumbent protection engages.
        rng = np.random.default_rng(5)
        span = np.arange(int(24 * RATE)) / RATE
        buried = .5 * np.exp(-(span % (60 / 93)) * 30) * np.sin(2 * np.pi * 75 * span)
        buried = buried + .7 * rng.normal(size=len(span))
        detector, results = analyze(np.rint(np.clip(buried, -.99, .99) * 32767).astype(np.int16))
        weak = [r['confidence'] for now, r in results if now > 12]
        self.assertLess(np.mean(weak), .35, 'fixture must sit in the contested band')
        detector.preferred_bpm, detector.preferred_time = 125., 1e9
        detector.last_time = 1e9
        # The guard abstains from switching, but must leave the challenger's
        # accumulator intact so a consistent candidate can still earn the lock.
        counts = []
        for _ in range(6):
            detector.estimate()
            counts.append(detector.pending_count)
            self.assertLess(abs(detector.candidate_bpm - 93), 3)
        self.assertEqual(counts, sorted(counts), 'accumulator went backwards while contested')
        self.assertGreaterEqual(counts[-1], 6,
                                'contested accumulator was reset, deadlocking the challenger')
        self.assertIsNotNone(detector.pending_bpm)

    def test_new_tempo_replaces_old_window_evidence(self):
        first, _ = track(120, seconds=10)
        second, _ = track(170, seconds=18)
        _, results = analyze(np.concatenate((first, second)))
        tail = [r for now, r in results if now > 23 and r['bpm']]
        self.assertGreater(len(tail), 150)
        self.assertLess(np.percentile([abs(r['bpm'] - 170) for r in tail], 95), 2)

    def test_user_bounds_and_capture_discontinuity(self):
        audio, _ = track(75)
        detector, results = analyze(audio, min_bpm=95, max_bpm=195)
        self.assertTrue(all(r['bpm'] is None or 95 <= r['bpm'] <= 195 for _, r in results))
        result = detector.process(np.zeros(SAMPLES), 100)
        self.assertIsNone(result['bpm'])
        self.assertFalse(result['beat'])
        self.assertFalse(result['playing'])


class ConversionTests(unittest.TestCase):
    def test_chunk_boundaries_preserve_pcm_and_sample_clock(self):
        rng = np.random.default_rng(42)
        audio = rng.normal(0, .1, (48000, 2))
        def convert(chunks):
            converter = MonoFrames()
            frames = []
            start = 0
            for length in chunks:
                frames.extend(converter.feed(audio[start:start+length], 10 + (start + length) / 48000))
                start += length
            return frames
        whole = convert([48000])
        split = convert([317] * 151 + [133])
        self.assertEqual(len(whole), 50)
        np.testing.assert_array_equal(np.concatenate([a for a, _ in whole]), np.concatenate([a for a, _ in split]))
        np.testing.assert_allclose([t for _, t in whole], [t for _, t in split], atol=1e-9)
        np.testing.assert_allclose(np.diff([t for _, t in whole]), .02, atol=1e-9)

    def test_downsampling_rejects_out_of_band_energy(self):
        t = np.arange(48000) / 48000
        def rms(frequency):
            mono = .4 * np.sin(2 * np.pi * frequency * t)
            frames = MonoFrames().feed(np.column_stack((mono, mono)), 1)
            return np.std(np.concatenate([pcm for pcm, _ in frames])[160:])
        self.assertLess(rms(10000), rms(1000) * .01)
