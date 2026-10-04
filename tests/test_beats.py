import math
import unittest
from bridge import beats


class BeatTests(unittest.TestCase):
    def kick_track(self, bpm, frequency=75, seconds=12):
        detector = beats.BeatDetector()
        events = 0
        for i in range(int(seconds * beats.RATE / beats.SAMPLES)):
            now = i * beats.SAMPLES / beats.RATE
            pcm = []
            for j in range(beats.SAMPLES):
                t = now + j / beats.RATE
                envelope = math.exp(-(t % (60 / bpm)) * 40)
                pcm.append(int(16000 * envelope * math.sin(2 * math.pi * frequency * t)))
            result = detector.process(pcm, now)
            events += int(result['beat'])
        return detector, result, events

    def test_bass_kicks_lock_across_default_bpm_range(self):
        for bpm in [95, 120, 160, 195]:
            with self.subTest(bpm=bpm):
                detector, result, events = self.kick_track(bpm)
                self.assertAlmostEqual(result['bpm'], bpm, delta=2)
                self.assertGreater(result['confidence'], .8)
                self.assertGreater(events, 10)
                self.assertGreaterEqual(result['bpm'], detector.min_bpm)
                self.assertLessEqual(result['bpm'], detector.max_bpm)

    def test_inconsistent_peaks_never_crash_tempo_estimation(self):
        detector = beats.BeatDetector()
        # Very short/noisy intervals produce no valid phase matches after BPM folding.
        detector.onsets.extend([0, .1, .22, .35])
        bpm, confidence = detector.estimate()
        self.assertIsNone(bpm)
        detector.onsets.clear()
        detector.onsets.extend([1, 1, 1, 1])
        self.assertEqual(detector.estimate(), (None, 0.))

    def test_silence_does_not_trigger_and_clears_lock(self):
        detector, _, _ = self.kick_track(120)
        for i in range(250):
            result = detector.process([0] * beats.SAMPLES, 12 + i * .02)
        self.assertFalse(result['playing'])
        self.assertFalse(result['beat'])
        self.assertIsNone(result['bpm'])
        self.assertEqual(result['confidence'], 0)

    def test_rhythmic_treble_is_tempo_evidence(self):
        _, result, events = self.kick_track(120, frequency=2500)
        self.assertGreater(events, 10)
        self.assertAlmostEqual(result['bpm'], 120, delta=2)

    def test_capture_targets_playback_monitor_explicitly(self):
        command = beats.capture_command('test-output-sink')
        self.assertIn('test-output-sink', command)
        self.assertIn('stream.capture.sink=true', ' '.join(command))
        self.assertEqual(command[-1], '-')  # In-memory pipe, never an audio file.

    def test_invalid_settings_are_bounded_and_toggle_stops_capture(self):
        self.assertEqual(beats.options({})['min_bpm'], 60)
        self.assertEqual(beats.options({})['max_bpm'], 200)
        opts = beats.options({'musicSettings': {'cutoff': 999, 'minBpm': 'invalid', 'sensitivity': float('nan')}})
        self.assertEqual(opts['cutoff'], 200)
        self.assertEqual(opts['min_bpm'], 60)
        self.assertEqual(opts['sensitivity'], 1.5)
        edge = beats.options({'musicSettings': {'minBpm': 239, 'maxBpm': 'invalid'}})
        self.assertEqual(edge['max_bpm'], 240)
        self.assertFalse(beats.options({'musicEnabled': False})['enabled'])
        self.assertFalse(beats.options({'musicSettings': {'beatSync': False, 'amplitudeReactive': False, 'reactOnEnd': False}})['enabled'])
        self.assertTrue(beats.options({'musicSettings': {'beatSync': False, 'amplitudeReactive': True}})['enabled'])
