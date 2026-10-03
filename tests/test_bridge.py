import unittest
from unittest.mock import patch
from bridge import bridge


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.token = patch.object(bridge, 'TOKEN', 'test-token')
        self.saved = patch.object(bridge, 'load_connection', return_value={})
        self.token.start()
        self.saved.start()
        self.addCleanup(self.token.stop)
        self.addCleanup(self.saved.stop)
        sync = patch.object(bridge, 'pet_sync')
        self.sync = sync.start()
        self.addCleanup(sync.stop)

    def test_discovers_owned_chats(self):
        with patch.object(bridge, '_get', return_value={
            'success': True, 'sessions': [{'id': 1}, {'id': 24}]
        }):
            self.assertEqual(bridge.discover_sessions(), ['1', '24'])

    def test_busy_chat_after_first_batch_is_not_dropped(self):
        def get(url):
            ids = url.split('session_ids=')[1].split(',')
            return {'success': True, 'statuses': {
                sid: {'generating': sid == '24', 'status': 'Reading files'}
                for sid in ids
            }}
        with patch.object(bridge, '_get', side_effect=get) as request:
            self.assertEqual(bridge.fetch_state([str(i) for i in range(25)]),
                             ('thinking', 'Reading files'))
            self.assertEqual(request.call_count, 3)

    def test_cancelled_chat_does_not_hide_busy_chat(self):
        data = {'success': True, 'statuses': {
            '1': {'cancelled': True},
            '2': {'generating': True, 'status': 'Reading files'},
            '3': {'generating': True, 'status': 'Done'},
        }}
        with patch.object(bridge, '_get', return_value=data):
            self.assertEqual(bridge.fetch_state(['1', '2', '3']),
                             ('thinking', 'Reading files'))

    def test_once_reports_auth_failure_without_emitting_idle(self):
        def get(url):
            if url.endswith('/health'):
                return {'ok': True}
            raise RuntimeError('401 Not authenticated')
        with patch.object(bridge, '_get', side_effect=get), \
             patch.object(bridge, 'pet_event') as emit:
            self.assertEqual(bridge.main(['--all-chats', '--once']), 1)
            emit.assert_not_called()

    def test_poll_failure_fallback_threshold(self):
        self.assertIsNone(bridge.state_after_poll_failure('thinking', 1))
        self.assertEqual(bridge.state_after_poll_failure('thinking', 2), ('idle', ''))
        self.assertIsNone(bridge.state_after_poll_failure('idle', 5))
        self.assertIsNone(bridge.state_after_poll_failure('done', 5))
        self.assertIsNone(bridge.state_after_poll_failure(None, 5))

    def test_unreachable_cuttle_after_busy_emits_idle_once(self):
        class Stop(Exception):
            pass
        events = []
        calls = 0
        def sleep(_):
            nonlocal calls
            calls += 1
            if calls >= 4:
                raise Stop
        with patch.object(bridge, '_get', return_value={'ok': True}), \
             patch.object(bridge, 'discover_sessions', return_value=['1']), \
             patch.object(bridge, 'fetch_state_for', side_effect=[
                 ('thinking', 'Working'),
                 RuntimeError('refused'), RuntimeError('refused'),
                 RuntimeError('refused'), RuntimeError('refused')]), \
             patch.object(bridge, 'pet_event', side_effect=lambda s, d: events.append(s)), \
             patch.object(bridge.time, 'sleep', side_effect=sleep):
            with self.assertRaises(Stop):
                bridge.main(['--all-chats'])
        self.assertEqual(events, ['thinking', 'idle'])

    def _run_loop(self, fetch_side_effect, monotonic_values, max_sleeps):
        class Stop(Exception):
            pass
        events = []
        sleeps = 0
        def sleep(_):
            nonlocal sleeps
            sleeps += 1
            if sleeps >= max_sleeps:
                raise Stop
        times = iter(monotonic_values)
        with patch.object(bridge, '_get', return_value={'ok': True}), \
             patch.object(bridge, 'discover_sessions', return_value=['1']), \
             patch.object(bridge, 'fetch_state_for', side_effect=fetch_side_effect), \
             patch.object(bridge, 'pet_event', side_effect=lambda s, d: events.append((s, d))), \
             patch.object(bridge.time, 'sleep', side_effect=sleep), \
             patch.object(bridge.time, 'monotonic', side_effect=lambda: next(times)):
            with self.assertRaises(Stop):
                bridge.main(['--all-chats'])
        return events

    def test_busy_heartbeat_refreshes_bubble(self):
        events = self._run_loop(
            [('thinking', 'Working')] * 4, [0.0, 61.0, 62.0, 63.0], 4)
        self.assertEqual([s for s, _ in events], ['thinking', 'thinking'])

    def test_frozen_busy_status_stands_down_then_revives(self):
        events = self._run_loop(
            [('thinking', 'Working')] * 3 + [('thinking', 'New detail'), ('idle', '')],
            [0.0, 901.0, 902.0, 903.0, 904.0], 5)
        self.assertEqual(
            events,
            [('thinking', 'Working'), ('idle', ''),
             ('thinking', 'New detail'), ('done', '')])

    def test_busy_to_idle_emits_done_then_idle(self):
        class Stop(Exception):
            pass
        events = []
        def sleep(_):
            if len(events) == 3:
                raise Stop
        with patch.object(bridge, '_get', return_value={'ok': True}), \
             patch.object(bridge, 'discover_sessions', return_value=['1']), \
             patch.object(bridge, 'fetch_state_for', side_effect=[
                 ('thinking', 'Working'), ('idle', ''), ('idle', '')]), \
             patch.object(bridge, 'pet_event', side_effect=lambda s, d: events.append(s)), \
             patch.object(bridge.time, 'sleep', side_effect=sleep):
            with self.assertRaises(Stop):
                bridge.main(['--all-chats'])
        self.assertEqual(events, ['thinking', 'done', 'idle'])


if __name__ == '__main__':
    unittest.main()
