import unittest
from unittest.mock import patch
from server import server


class MusicLivenessTests(unittest.TestCase):
    def setUp(self):
        for name, value in {'_music_playing': False, '_music_player_playing': False,
                            '_music_audio_playing': False, '_music_analysis': {'status': 'starting'},
                            '_music_audio_seen': -float('inf'), '_music_player_seen': -float('inf')}.items():
            p = patch.object(server, name, value); p.start(); self.addCleanup(p.stop)
        self.now = 100
        p = patch.object(server.time, 'monotonic', side_effect=lambda: self.now)
        p.start(); self.addCleanup(p.stop)

    def test_dead_audio_thread_cannot_leave_music_latched_on(self):
        server.publish_analysis({'status': 'listening', 'playing': True})
        self.assertTrue(server._music_playing)
        self.now += 4
        server._sync_music()
        self.assertFalse(server._music_playing)

    def test_actual_silence_overrides_mpris_playing(self):
        server.publish_music(True)
        server.publish_analysis({'status': 'listening', 'playing': False})
        self.assertFalse(server._music_playing)

    def test_pause_stops_music_when_monitor_unavailable(self):
        server.publish_analysis({'status': 'unavailable', 'playing': False})
        server.publish_music(True)
        self.assertTrue(server._music_playing)
        server.publish_music(False)
        self.assertFalse(server._music_playing)

    def test_dead_player_poller_also_expires(self):
        server.publish_music(True)
        self.now += 7
        server._sync_music()
        self.assertFalse(server._music_playing)
