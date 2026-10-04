import threading
import unittest
from unittest.mock import patch
import numpy as np
from bridge import beats
from bridge.wasapi_capture import WasapiCapture
from server import server


class FakeContext:
    def __init__(self):
        self.closed = False
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.closed = True
    def record(self, numframes):
        return np.zeros((numframes, 2))


class CaptureTests(unittest.TestCase):
    def test_windows_uses_output_loopback_and_multichannel(self):
        from types import SimpleNamespace
        context = FakeContext()
        calls = []
        microphone = SimpleNamespace(isloopback=True, channels=2,
                                     recorder=lambda **kw: (calls.append(kw) or context))
        speaker = SimpleNamespace(id='output')
        sc = SimpleNamespace(default_speaker=lambda: speaker,
                             get_microphone=lambda **kw: (calls.append(kw) or microphone))
        with patch.dict('sys.modules', {'soundcard': sc}):
            capture = WasapiCapture()
            self.assertEqual(calls[0], {'id': 'output', 'include_loopback': True})
            self.assertEqual(calls[1]['channels'], 2)
            self.assertEqual(len(capture.read()), 1)
            sc.default_speaker = lambda: SimpleNamespace(id='new-output')
            capture.last_check = -float('inf')
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                capture.read()
            capture.close()
            self.assertTrue(context.closed)

    def test_microphone_is_never_accepted_as_loopback(self):
        from types import SimpleNamespace
        sc = SimpleNamespace(default_speaker=lambda: SimpleNamespace(id='output'),
                             get_microphone=lambda **kw: SimpleNamespace(isloopback=False))
        with patch.dict('sys.modules', {'soundcard': sc}):
            with self.assertRaisesRegex(RuntimeError, 'not an output loopback'):
                WasapiCapture()

    def test_capture_failure_reports_unavailable_and_closes(self):
        stop = threading.Event()
        class FailedCapture:
            closed = False
            def read(self):
                raise RuntimeError('device disappeared')
            def close(self):
                self.closed = True
        capture = FailedCapture()
        events = []
        def publish(event):
            events.append(event)
            if event['status'] == 'unavailable':
                stop.set()
        with patch.object(beats, 'open_capture', return_value=capture):
            beats.watch(publish, lambda: {}, stop)
        self.assertTrue(capture.closed)
        self.assertEqual(events[-1]['status'], 'unavailable')
        self.assertFalse(events[-1]['playing'])

    def test_server_forwards_grid_time_separately_from_audio_time(self):
        with patch.object(server, 'broadcast') as publish, patch.object(server, '_sync_music'), \
             patch.object(server, '_music_playing', True), \
             patch.multiple(server, _music_analysis={}, _music_audio_playing=False, _music_audio_seen=0):
            server.publish_analysis({'status': 'listening', 'playing': True, 'beat': True,
                                     'bpm': 120, 'confidence': .9, 'timestamp': 10.04,
                                     'beat_timestamp': 10.0})
        events = [call.args[0] for call in publish.call_args_list]
        self.assertEqual(events[0]['musicAudio']['timestamp'], 10.04)
        self.assertEqual(events[1]['musicBeat']['timestamp'], 10.0)
