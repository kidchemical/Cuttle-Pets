import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from server import server


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir='temp')
        self.addCleanup(self.folder.cleanup)
        self.real_settings_path = server.SETTINGS_PATH
        self.path = Path(self.folder.name) / 'settings.json'
        replacement = patch.object(server, 'SETTINGS_PATH', self.path)
        replacement.start()
        self.addCleanup(replacement.stop)
        self.client = server.app.test_client()

    def test_version_endpoint_mirrors_version_file(self):
        expected = (server.REPO_ROOT / 'VERSION').read_text().strip()
        response = self.client.get('/version')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {'version': expected})

    def test_upgrade_patch_never_resets_existing_customization(self):
        # Simulate a user on an older build with full customization, then an
        # update that only writes one new key: everything else must survive.
        before = {
            'modelPath': '/model/project/test.vrm',
            'currentDance': 'jile',
            'behaviorSettings': {'enabled': True, 'current': 'genki'},
            'animationSettings': {'speed': 1.5},
            'musicSettings': {'minBpm': 95},
            'volume': 0.2,
        }
        self.assertEqual(self.client.post('/settings', json=before).status_code, 200)
        self.assertEqual(self.client.post('/settings', json={'newFlagFromUpdate': True}).status_code, 200)
        after = self.client.get('/settings').get_json()
        self.assertEqual(after, {**before, 'newFlagFromUpdate': True})

    def test_user_data_lives_outside_the_app_bundle(self):
        # Replacing the app bundle / checking out a release must not be able
        # to reach user data: settings, models, dances all sit under DATA_DIR,
        # which is outside the repository checkout.
        data = server.DATA_DIR.resolve()
        repo = server.REPO_ROOT.resolve()
        self.assertNotEqual(data, repo)
        self.assertFalse(data.is_relative_to(repo))
        # NOTE: setUp patches SETTINGS_PATH into temp, so check the real
        # default path saved before patching.
        for path in (self.real_settings_path, server.MODELS_DIR, server.DANCES_DIR):
            self.assertTrue(path.resolve().is_relative_to(data), path)


if __name__ == '__main__':
    unittest.main()
