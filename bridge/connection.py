"""Saved Cuttle connection shared by the server, bridge, and terminal CLI.

Login passwords are never persisted. A separate Cuttle login session is stored
in an owner-only file, never included in renderer settings or API responses.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import ssl
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class ConnectionError(RuntimeError):
    pass


class LoginExpired(ConnectionError):
    pass


def connection_path() -> Path:
    return Path(os.environ.get('CUTTLE_PET_DATA', Path.home() / '.cuttle-pet')) / 'cuttle-connection.json'


def validate_url(value: str) -> str:
    if not isinstance(value, str):
        raise ConnectionError('Invalid Cuttle address.')
    value = value.strip().rstrip('/')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise ConnectionError('Use a local Cuttle HTTPS address, such as https://127.0.0.1:8080.')
    try:
        parsed.port
    except ValueError:
        raise ConnectionError('Invalid Cuttle port.') from None
    return value


def load_connection() -> dict:
    try:
        path = connection_path()
        # Tighten permissions on earlier copies too.
        path.chmod(0o600)
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError()
        data['url'] = validate_url(data['url'])
        if not isinstance(data.get('token'), str) or not data['token']:
            raise ValueError()
        return data
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, KeyError, ConnectionError):
        raise ConnectionError('Saved connection cannot be read. Connect to Cuttle again.') from None


def save_connection(data: dict) -> None:
    path = connection_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.cuttle-connection-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def request_cuttle(url: str, path: str, token: str = '', body: dict | None = None) -> dict:
    url = validate_url(url)
    # Local Cuttle uses a self-signed certificate. No remote hosts are accepted.
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    headers = {'Content-Type': 'application/json', 'X-Cuttle-Client': 'mobile'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url + path, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    # Never forward credentials through an HTTP redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))
    try:
        with opener.open(req, timeout=5) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise LoginExpired('Cuttle sign-in expired or was rejected. Connect again.') from None
        if exc.code == 429:
            raise ConnectionError('Too many sign-in attempts. Wait a minute and try again.') from None
        raise ConnectionError(f'Cuttle returned HTTP {exc.code}.') from None
    except (OSError, ValueError):
        raise ConnectionError('Cannot reach Cuttle. Make sure Cuttle is running.') from None
    if not isinstance(data, dict) or not data.get('success'):
        raise ConnectionError('Cuttle rejected the request.')
    return data


def connect(username: str, password: str, url: str = 'https://127.0.0.1:8080') -> dict:
    url = validate_url(url)
    if not isinstance(username, str) or not isinstance(password, str) or not username.strip() or not password:
        raise ConnectionError('Enter your Cuttle username and password.')
    try:
        result = request_cuttle(url, '/api/auth/login', body={'username': username.strip(), 'password': password})
    except LoginExpired:
        raise ConnectionError('Incorrect Cuttle username or password.') from None
    token = result.get('session_token')
    if not isinstance(token, str) or not token:
        raise ConnectionError('Cuttle did not provide a login session.')
    user = result.get('user') or {}
    name = user.get('username') or username.strip()
    save_connection({'url': url, 'token': token, 'username': name})
    return {'ok': True, 'state': 'connected', 'username': name, 'url': url}


def status() -> dict:
    saved = load_connection()
    if not saved:
        return {'ok': True, 'state': 'disconnected'}
    result = {'ok': True, 'url': saved['url'], 'username': saved.get('username', '')}
    try:
        request_cuttle(saved['url'], '/api/auth/me', saved['token'])
        result['state'] = 'connected'
    except LoginExpired:
        result.update(state='expired', message='Sign in again to reconnect.')
    except ConnectionError:
        result.update(state='offline', message='Cuttle is offline. Reconnecting automatically when it returns.')
    return result


def disconnect() -> dict:
    saved = load_connection()
    connection_path().unlink(missing_ok=True)
    if saved:
        try:
            request_cuttle(saved['url'], '/api/auth/logout', saved['token'], {})
        except ConnectionError:
            pass  # Local credential removal succeeds even when Cuttle is offline.
    return {'ok': True, 'state': 'disconnected'}
