import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge import connection, bridge
from server.server import app


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        Path('temp').mkdir(exist_ok=True)
        self.folder = tempfile.TemporaryDirectory(dir='temp')
        self.addCleanup(self.folder.cleanup)
        self.env = patch.dict(os.environ, CUTTLE_PET_DATA=self.folder.name)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = app.test_client()

    def connect(self):
        with patch.object(connection, 'request_cuttle', return_value={
            'success': True, 'session_token': 'secret-session', 'user': {'username': 'test'}
        }):
            return self.client.post('/cuttle/connection', json={'username': 'test', 'password': 'secret-password'})

    def test_login_survives_restart_without_exposing_password_or_token(self):
        response = self.connect()
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('secret-session', response.get_data(as_text=True))
        saved = connection.connection_path()
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('secret-password', saved.read_text())
        self.assertEqual(connection.load_connection()['token'], 'secret-session')
        with patch.object(connection, 'request_cuttle', return_value={'success': True}):
            status = self.client.get('/cuttle/connection').get_json()
            self.assertEqual(status['state'], 'connected')
            self.assertNotIn('token', status)
        with patch.object(bridge, 'TOKEN', ''):
            self.assertEqual(bridge._headers()['Authorization'], 'Bearer secret-session')

    def test_expired_login_and_offline_cuttle_keep_saved_connection(self):
        self.connect()
        for error, state in [(connection.LoginExpired('expired'), 'expired'),
                             (connection.ConnectionError('offline'), 'offline')]:
            with patch.object(connection, 'request_cuttle', side_effect=error):
                self.assertEqual(connection.status()['state'], state)
                self.assertTrue(connection.connection_path().exists())

    def test_disconnect_removes_and_revokes_saved_session(self):
        self.connect()
        with patch.object(connection, 'request_cuttle', return_value={'success': True}) as remote:
            response = self.client.post('/cuttle/connection/disconnect', json={})
            self.assertEqual(response.get_json()['state'], 'disconnected')
            self.assertEqual(remote.call_args.args[1], '/api/auth/logout')
            self.assertFalse(connection.connection_path().exists())
        with patch.object(bridge, 'TOKEN', ''):
            self.assertEqual(bridge._headers(), {})

    def test_invalid_login_does_not_overwrite_existing_connection(self):
        self.connect()
        with patch.object(connection, 'request_cuttle', side_effect=connection.LoginExpired('bad password')):
            response = self.client.post('/cuttle/connection', json={'username': 'bad', 'password': 'bad'})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(connection.load_connection()['username'], 'test')

    def test_websites_and_remote_clients_cannot_access_connection(self):
        for path in ['/cuttle/connection', '/cuttle/connection/disconnect']:
            response = self.client.post(path, json={}, headers={'Origin': 'https://attacker.example'})
            self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get('/cuttle/connection', headers={'Origin': 'https://attacker.example'}).status_code, 403)
        self.assertEqual(self.client.get('/cuttle/connection', environ_overrides={'REMOTE_ADDR': '192.168.1.2'}).status_code, 403)
        self.assertEqual(self.client.post('/cuttle/connection', data='username=x').status_code, 415)

    def test_rejects_remote_or_non_https_credential_destinations(self):
        for url in ['https://example.com', 'http://127.0.0.1:8080',
                    'https://127.0.0.1@evil.example', 'https://localhost/path', None]:
            with self.assertRaises(connection.ConnectionError):
                connection.validate_url(url)

    def test_bridge_waits_for_first_connection_without_auth_request(self):
        with patch.object(bridge, 'TOKEN', ''), patch.object(bridge, '_get') as remote:
            self.assertEqual(bridge.main(['--once']), 1)
            self.assertEqual(remote.call_count, 1)  # Pet health only; no unauthenticated Cuttle poll.


if __name__ == '__main__':
    unittest.main()
