import unittest
from bridge.beats import SongEndDetector


class SongEndTests(unittest.TestCase):
    def play(self, detector, seconds):
        for i in range(seconds * 2 + 1):
            self.assertFalse(detector.update(True, True, True, i / 2))

    def test_long_playback_then_sustained_silence_reacts_once(self):
        d = SongEndDetector(); self.play(d, 15)
        results = [d.update(False, True, True, 15.5 + i / 2) for i in range(20)]
        self.assertEqual(sum(results), 1)
        self.assertFalse(results[0])

    def test_notification_and_short_pause_do_not_trigger(self):
        d = SongEndDetector(); self.play(d, 2)
        self.assertFalse(any(d.update(False, True, True, 2.5 + i / 2) for i in range(20)))
        d = SongEndDetector(); self.play(d, 15)
        for t in [15.5,16,16.5]: self.assertFalse(d.update(False,True,True,t))
        self.assertFalse(d.update(True,True,True,17))

    def test_capture_failure_and_disabled_setting_do_not_celebrate(self):
        for available, enabled in [(False,True),(True,False)]:
            d=SongEndDetector();self.play(d,15)
            self.assertFalse(any(d.update(False,available,enabled,16+i) for i in range(10)))

    def test_next_song_can_react_after_previous_song(self):
        d=SongEndDetector();self.play(d,15)
        self.assertFalse(d.update(False,True,True,16))
        self.assertTrue(d.update(False,True,True,18))
        for i in range(31): self.assertFalse(d.update(True,True,True,20+i*.5))
        self.assertFalse(d.update(False,True,True,36))
        self.assertTrue(d.update(False,True,True,38))
