import subprocess
import unittest
from unittest.mock import patch
from bridge import music


class MusicTests(unittest.TestCase):
    def test_any_playing_player_enables_music(self):
        with patch.object(music, 'bus_call', side_effect=[
            "(['org.mpris.MediaPlayer2.spotify', 'org.mpris.MediaPlayer2.vlc'],)",
            "(<'Paused'>,)", "(<'Playing'>,)"
        ]):
            self.assertTrue(music.is_playing())

    def test_paused_or_no_player_disables_music(self):
        with patch.object(music, 'bus_call', return_value="([],)"):
            self.assertFalse(music.is_playing())
        with patch.object(music, 'bus_call', side_effect=["(['org.mpris.MediaPlayer2.spotify'],)", "(<'Paused'>,)"]):
            self.assertFalse(music.is_playing())

    def test_player_can_disappear_mid_poll(self):
        with patch.object(music, 'bus_call', side_effect=["(['org.mpris.MediaPlayer2.spotify'],)", subprocess.TimeoutExpired('gdbus', 2)]):
            self.assertFalse(music.is_playing())
