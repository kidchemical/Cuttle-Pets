import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from server import server


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir='temp')
        self.addCleanup(self.scratch.cleanup)
        root = Path(self.scratch.name)
        self.project = root / 'project'
        (self.project / 'models').mkdir(parents=True)
        self.library = root / 'library'
        self.library.mkdir()
        for name, value in [('REPO_ROOT', self.project), ('MODELS_DIR', self.library),
                            ('DANCES_DIR', root / 'dances'), ('AUDIO_DIR', root / 'audio')]:
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = server.app.test_client()

    def test_project_model_is_listed_and_servable(self):
        data = b'project model bytes'
        (self.project / 'models' / 'Cosmic Person.vrm').write_bytes(data)
        models = self.client.get('/model/list').get_json()['models']
        self.assertEqual(models[0]['name'], 'Cosmic Person.vrm')
        response = self.client.get(models[0]['url'])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, data)
        response.close()

    def test_imported_model_is_listed_and_servable(self):
        source = self.project / 'model.vrm'
        source.write_bytes(b'imported model bytes')
        imported = self.client.post('/model/import', json={'path': str(source)}).get_json()
        self.assertTrue(imported['ok'])
        models = self.client.get('/model/list').get_json()['models']
        self.assertEqual(models[0]['url'], imported['url'])
        response = self.client.get(imported['url'])
        self.assertEqual(response.data, source.read_bytes())
        response.close()

    def test_model_import_rejects_non_vrm_files(self):
        source = self.project / 'model.txt'
        source.write_text('not a model')
        self.assertEqual(self.client.post('/model/import', json={'path': str(source)}).status_code, 400)

    def test_saved_library_model_takes_precedence_over_same_project_name(self):
        for folder in [self.library, self.project / 'models']:
            (folder / 'same.vrm').write_bytes(b'model')
        self.assertEqual(len(self.client.get('/model/list').get_json()['models']), 1)
