import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from server import server


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir='temp')
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / 'settings.json'
        replacement = patch.object(server, 'SETTINGS_PATH', self.path)
        replacement.start()
        self.addCleanup(replacement.stop)
        self.client = server.app.test_client()

    def test_all_preferences_survive_reload(self):
        prefs = {'hideMood': True, 'hideUI': True, 'showText': False, 'ttsEnabled': False,
                 'pinned': False, 'collapsed': True, 'musicEnabled': False, 'volume': 0.2,
                 'tracking': 'camera', 'language': 'en', 'uiAlign': 'left',
                 'modelPath': '/model/project/test.vrm', 'currentDance': 'ualDance',
                 'screenObserve': False, 'screenObserveInterval': 90}
        for key, value in prefs.items():
            self.assertEqual(self.client.post('/settings', json={key: value}).status_code, 200)
        self.assertEqual(json.loads(self.path.read_text()), prefs)
        self.assertEqual(self.client.get('/settings').get_json(), prefs)

    def test_parallel_patches_cannot_erase_preferences(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i: server._save_settings({f'pref{i}': i}), range(100)))
        self.assertEqual(len(server._load_settings()), 100)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_voice_and_persona_updates_are_saved_and_merged(self):
        self.client.post('/voice', json={'provider': 'edge', 'voice': 'test'})
        self.client.post('/voice', json={'qwenModel': 'test-model'})
        self.assertEqual(self.client.get('/voice').get_json(), {'provider': 'edge', 'voice': 'test', 'qwenModel': 'test-model'})
        self.client.post('/persona', json={'soul': 'test soul'})
        self.client.post('/persona', json={'identity': 'test identity'})
        self.assertEqual(self.client.get('/persona').get_json(), {'soul': 'test soul', 'identity': 'test identity'})
