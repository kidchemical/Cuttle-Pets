import json
import unittest
from unittest.mock import patch
from server import server


class ActivitySyncTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.patches = [patch.object(server, '_activity_working', False),
                        patch.object(server, '_activity_seen', -float('inf')),
                        patch.object(server, '_demo_until', 0)]
        for p in self.patches:
            p.start(); self.addCleanup(p.stop)

    def test_reconnecting_renderer_gets_current_working_state(self):
        self.client.post('/pet/sync', json={'state': 'thinking'})
        response = self.client.get('/events', buffered=False)
        try:
            frames = iter(response.response)
            next(frames); next(frames)
            frame = next(frames).decode().removeprefix('data: ')
            self.assertEqual(json.loads(frame), {'activitySync': True, 'working': True})
        finally:
            response.close()

    def test_heartbeats_only_update_working_no_repeated_gesture_or_text(self):
        with patch.object(server, 'broadcast') as emit:
            self.client.post('/pet/sync', json={'state': 'thinking'})
            self.client.post('/pet/sync', json={'state': 'thinking'})
            self.client.post('/pet/sync', json={'state': 'idle'})
        self.assertEqual([c.args[0] for c in emit.call_args_list], [
            {'activitySync': True, 'working': True}, {'activitySync': True, 'working': True},
            {'activitySync': True, 'working': False}])

    def test_demo_remembers_live_working_flag_without_interrupting_demo(self):
        with patch.object(server, '_demo_until', float('inf')), patch.object(server, 'broadcast') as emit:
            self.client.post('/pet/sync', json={'state': 'thinking'})
            emit.assert_not_called()
            self.assertTrue(server.activity_snapshot()['working'])

    def test_stale_activity_is_not_replayed(self):
        with patch.object(server.time, 'monotonic', return_value=10):
            self.client.post('/pet/sync', json={'state': 'thinking'})
        with patch.object(server.time, 'monotonic', return_value=26):
            self.assertFalse(server.activity_snapshot()['working'])
