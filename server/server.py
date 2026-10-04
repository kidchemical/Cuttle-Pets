"""Cuttle Pet control server.

Replaces the OpenClaw plugin gateway that the vendored app used to talk to.
Responsibilities:

  * ``GET  /events``            — SSE broadcast to the pet (the only inbound
                                  channel; the renderer subscribes here).
  * ``POST /emote``             — set a VRM expression / preset emotion.
  * ``POST /action``            — play a named animation (vrma / fbx / vmd).
  * ``POST /say``               — show text (optionally with TTS audio).
  * ``POST /pet/event``         — high-level chat-activity hook: thinking,
                                  streaming, done, error.
  * ``GET /screen``              — screensaver/lock suspend state; changes are
                                  also broadcast as ``{"suspended": …}`` so the
                                  renderer stops presenting and hides.
  * ``GET/PATCH /settings``     — renderer settings store.
  * ``POST /click-through``     — toggle mouse pass-through.
  * model / dance asset serving + import.

Everything is loopback-only and dependency-light (stdlib + Flask).
"""

from __future__ import annotations

import json
import mimetypes
import os
import queue
import shutil
import tempfile
import threading
import time
import sys
from urllib.parse import quote
from pathlib import Path
from typing import Any, Iterable

from flask import Flask, Response, jsonify, request, send_file

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bridge import connection, music, beats
import screen as screen_monitor

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_PUBLIC = REPO_ROOT / "app" / "public"
DATA_DIR = Path(os.environ.get("CUTTLE_PET_DATA", Path.home() / ".cuttle-pet"))
MODELS_DIR = DATA_DIR / "models"
DANCES_DIR = DATA_DIR / "dances"
AUDIO_DIR = DATA_DIR / "audio"
SETTINGS_PATH = DATA_DIR / "settings.json"

HOST = os.environ.get("CUTTLE_PET_HOST", "127.0.0.1")
PORT = int(os.environ.get("CUTTLE_PET_PORT", "8790"))

# Presets the renderer knows about. Kept here so the CLI can validate early
# and report a useful error instead of a silent no-op.
PRESET_EMOTIONS = (
    "happy", "sad", "angry", "surprised", "think", "awkward", "question",
    "curious", "neutral", "love", "flirty", "greeting", "relaxed",
)
PRESET_ACTIONS = (
    "akimbo", "playFingers", "scratchHead", "stretch",
    "happy", "angry", "greeting", "excited", "shy",
    "point", "salute", "angryPump",
    "waving", "cheering", "clapping", "victory", "praying",
    "defeated", "joyfulJump", "looking", "pointing", "breakdance",
    "sittingIdle", "sittingTalk", "talkingIdle", "phoneCall",
)

# Cuttle chat activity -> (emotion, action, text-template).
# thinking/streaming set "working" so the renderer shows the typing pose
# with the laptop prop; their arm actions stay None to avoid fighting it.
ACTIVITY_MAP: dict[str, dict[str, Any]] = {
    "thinking":  {"emotion": "think",     "action": None,    "duration_ms": 10000, "working": True},
    "streaming": {"emotion": "curious",   "action": None,    "duration_ms": 8000,  "working": True},
    "done":      {"emotion": "happy",     "action": "happy", "duration_ms": 5000,  "working": False},
    "error":     {"emotion": "surprised", "action": "point", "duration_ms": 5000,  "working": False},
    "idle":      {"emotion": "relaxed",   "action": None,    "duration_ms": 4000,  "working": False},
}

app = Flask(__name__)


# ── CORS ───────────────────────────────────────────────────────────────────
# The renderer runs in a Tauri webview whose origin is `tauri://localhost` on
# Linux, `http://tauri.localhost` on Windows/macOS. Those origins are opaque to
# Flask, so every fetch and the EventSource stream need explicit permission.
# The server is loopback-only and unauthenticated, so this does not widen the
# trust boundary meaningfully.
ALLOWED_ORIGINS = os.environ.get(
    "CUTTLE_PET_ORIGINS",
    ",".join([
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
    ]),
).split(",")


@app.after_request
def add_cors_headers(resp):
    origin = request.headers.get("Origin")
    if origin and (origin in ALLOWED_ORIGINS or origin.startswith("tauri://")):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Credentials"] = "true"
    else:
        # No Origin (curl, CLI, python client) needs no CORS at all.
        resp.headers.setdefault("Access-Control-Allow-Origin", "*")
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Max-Age"] = "600"
    return resp


# Saved credentials are never returned to the renderer. Reject untrusted browser
# origins before any credential access; CORS alone does not prevent writes.
@app.before_request
def guard_connection_requests():
    if request.path.startswith("/cuttle/connection"):
        if request.remote_addr not in ("127.0.0.1", "::1"):
            return jsonify({"ok": False, "error": "Local access required"}), 403
        origin = request.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return jsonify({"ok": False, "error": "Origin not allowed"}), 403
        if request.method == "POST" and not request.is_json:
            return jsonify({"ok": False, "error": "JSON required"}), 415


@app.get("/cuttle/connection")
def cuttle_connection_status():
    try:
        return jsonify(connection.status())
    except connection.ConnectionError as exc:
        return jsonify({"ok": False, "state": "disconnected", "error": str(exc)}), 400


@app.post("/cuttle/connection")
def cuttle_connect():
    body = request.get_json() or {}
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "JSON object required"}), 400
    try:
        return jsonify(connection.connect(body.get("username", ""), body.get("password", ""),
                                           body.get("url") or "https://127.0.0.1:8080"))
    except connection.ConnectionError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/cuttle/connection/disconnect")
def cuttle_disconnect():
    try:
        return jsonify(connection.disconnect())
    except connection.ConnectionError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


# ── fan-out ────────────────────────────────────────────────────────────────
# One SSE client (the desktop pet) at a time is the expected shape, but keep a
# list so a settings window or second monitor copy can also subscribe.
_subscribers: list[queue.Queue] = []
_sub_lock = threading.Lock()
_music_playing = False
_music_player_playing = False
_music_audio_playing = False
_music_player_seen = _music_audio_seen = -float('inf')
_music_lock = threading.RLock()
_song_end_detector = beats.SongEndDetector()
_activity_lock = threading.RLock()
_activity_working = False
_activity_seen = -float('inf')
_music_analysis = {'status': 'starting', 'message': 'Starting playback analysis…', 'bpm': None}


def broadcast(payload: dict[str, Any]) -> int:
    """Push a payload to every subscriber. Returns the delivery count."""
    frame = json.dumps(payload)
    with _sub_lock:
        targets = list(_subscribers)
    delivered = 0
    for q in targets:
        try:
            q.put_nowait(frame)
            delivered += 1
        except queue.Full:
            pass
    return delivered


def _sync_music():
    global _music_playing
    with _music_lock:
        now = time.monotonic()
        # When monitoring works, actual sound takes priority over stale MPRIS
        # "Playing" flags. Otherwise a fresh player status provides fallback.
        if _music_analysis.get('status') == 'listening':
            active = _music_audio_playing and now - _music_audio_seen < 3
        else:
            active = _music_player_playing and now - _music_player_seen < 6
        if active != _music_playing:
            _music_playing = active
            broadcast({"musicPlaying": active})


def publish_music(active: bool):
    global _music_player_playing, _music_player_seen
    with _music_lock:
        _music_player_playing = active
        _music_player_seen = time.monotonic()
        _sync_music()


def publish_analysis(result: dict):
    global _music_analysis, _music_audio_playing, _music_audio_seen
    with _music_lock:
        _music_analysis = {k: v for k, v in result.items() if k != 'beat'}
        _music_audio_playing = result.get('playing', False)
        _music_audio_seen = time.monotonic()
        _sync_music()
    broadcast({'musicAudio': {'amplitude': result.get('amplitude', 0), 'available': result.get('status') == 'listening', 'timestamp': result.get('timestamp', time.time())}})
    if result.get('beat') and _music_playing:
        broadcast({'musicBeat': {'bpm': result.get('bpm'), 'confidence': result.get('confidence'),
                                 'timestamp': result.get('beat_timestamp') if result.get('beat_timestamp') is not None else result.get('timestamp')}})


def sync_activity(state: str):
    global _activity_working, _activity_seen
    with _activity_lock:
        _activity_working = bool(ACTIVITY_MAP[state].get('working', False))
        _activity_seen = time.monotonic()
        if time.monotonic() >= _demo_until:
            broadcast({'activitySync': True, 'working': _activity_working})


def activity_snapshot():
    with _activity_lock:
        return {'activitySync': True, 'working': _activity_working and time.monotonic() - _activity_seen < 15}


# ── screensaver / lock suspend ──────────────────────────────────────────
# The renderer cannot see the screensaver (document.hidden never fires under
# a fullscreen saver over an always-on-top window), so the server polls the
# OS and tells the pet to fully suspend (stop presenting + hide) instead.
_screen_lock = threading.RLock()
_screen_suspended = False


def screen_snapshot() -> dict[str, Any]:
    with _screen_lock:
        return {'suspended': _screen_suspended}


def _on_screen_change(suspended: bool) -> None:
    global _screen_suspended
    with _screen_lock:
        if suspended == _screen_suspended:
            return
        _screen_suspended = suspended
    broadcast({'suspended': suspended})


def watch_liveness():
    global _activity_working
    while True:
        _sync_music()
        settings = _load_settings()
        options = settings.get('musicSettings') or {}
        if not isinstance(options, dict):
            options = {}
        enabled = settings.get('musicEnabled', True) is not False and options.get('reactOnEnd', True) is not False
        available = _music_analysis.get('status') == 'listening' and time.monotonic() - _music_audio_seen < 3
        if _song_end_detector.update(_music_playing, available, enabled, time.monotonic()):
            broadcast({'musicEnded': True})
        # Clear a lost bridge's working pose without replaying gestures or text.
        with _activity_lock:
            if _activity_working and time.monotonic() - _activity_seen >= 15 and time.monotonic() >= _demo_until:
                _activity_working = False
                broadcast({'activitySync': True, 'working': False})
        time.sleep(.5)


@app.get("/music")
def music_status():
    _sync_music()
    return jsonify({"ok": True, "playing": _music_playing, "analysis": _music_analysis})


@app.get("/screen")
def screen_status():
    """Screensaver/lock suspend state (also broadcast as {"suspended": …})."""
    snap = screen_snapshot()
    return jsonify({"ok": True, **snap})


@app.get("/events")
def events():
    q: queue.Queue = queue.Queue(maxsize=64)
    with _sub_lock:
        _subscribers.append(q)

    def gen():
        try:
            # Tell the client we're live before the first real frame.
            yield f": connected {int(time.time())}\n\n"
            _sync_music()
            yield "data: " + json.dumps({"musicPlaying": _music_playing}) + "\n\n"
            yield "data: " + json.dumps(activity_snapshot()) + "\n\n"
            yield "data: " + json.dumps(screen_snapshot()) + "\n\n"
            yield "data: " + json.dumps({'musicAudio': {'amplitude': _music_analysis.get('amplitude', 0), 'available': _music_analysis.get('status') == 'listening', 'timestamp': time.time()}}) + "\n\n"
            while True:
                try:
                    frame = q.get(timeout=15)
                except queue.Empty:
                    yield ": keepalive\n\n"  # keeps proxies from closing us
                    continue
                yield f"data: {frame}\n\n"
        finally:
            with _sub_lock:
                if q in _subscribers:
                    _subscribers.remove(q)

    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ── settings ───────────────────────────────────────────────────────────────
_settings_lock = threading.RLock()


def _load_settings() -> dict[str, Any]:
    with _settings_lock:
        try:
            data = json.loads(SETTINGS_PATH.read_text())
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}


def _save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    with _settings_lock:
        current = _load_settings()
        for key, value in patch.items():
            if key in ("voice", "persona") and isinstance(value, dict):
                previous = current.get(key, {})
                current[key] = {**(previous if isinstance(previous, dict) else {}), **value}
            else:
                current[key] = value
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, filename = tempfile.mkstemp(prefix=".settings-", dir=SETTINGS_PATH.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(current, stream, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(filename, SETTINGS_PATH)
        finally:
            if os.path.exists(filename):
                os.unlink(filename)
        return current


@app.get("/settings")
def get_settings():
    return jsonify(_load_settings())


@app.patch("/settings")
@app.post("/settings")
def update_settings():
    return jsonify(_save_settings(request.get_json(force=True, silent=True) or {}))


# ── control verbs ──────────────────────────────────────────────────────────
@app.post("/emote")
def emote():
    """Set an expression.

    ``emotion`` is a preset (mapped client-side to VRM expressions);
    ``vrchat`` is a raw VRChat expression name with a 0..1 value, for models
    outside the preset vocabulary.
    """
    body = request.get_json(force=True, silent=True) or {}
    name = body.get("emotion")
    raw = body.get("vrchat")
    if not name and not raw:
        return jsonify({"ok": False, "error": "need emotion or vrchat"}), 400
    if name and name not in PRESET_EMOTIONS:
        return jsonify({"ok": False, "error": f"unknown emotion {name!r}",
                        "known": list(PRESET_EMOTIONS)}), 400

    payload = {
        "emotion": name or raw,
        "emotionIntensity": _clamp(body.get("emotionIntensity", 1.0)),
        "emotionDuration": int(body.get("emotionDuration", 5000)),
    }
    if raw:
        payload["vrchat"] = {"expression": raw, "value": _clamp(body.get("value", 1.0))}
    if body.get("moodDelta"):
        payload["moodDelta"] = int(body["moodDelta"])
    return jsonify({"ok": True, "delivered": broadcast(payload), "payload": payload})


@app.post("/action")
def action():
    body = request.get_json(force=True, silent=True) or {}
    name = body.get("action")
    if not name:
        return jsonify({"ok": False, "error": "need action"}), 400
    if name not in PRESET_ACTIONS and not str(name).startswith("custom:"):
        return jsonify({"ok": False, "error": f"unknown action {name!r}",
                        "known": list(PRESET_ACTIONS)}), 400
    payload = {"playAction": name, "hold": bool(body.get("hold"))}
    return jsonify({"ok": True, "delivered": broadcast(payload), "payload": payload})


@app.post("/say")
def say():
    body = request.get_json(force=True, silent=True) or {}
    text = body.get("text")
    if text is None:
        return jsonify({"ok": False, "error": "need text"}), 400
    payload: dict[str, Any] = {
        "text": str(text),
        "appendText": bool(body.get("appendText")),
        "clearText": bool(body.get("clearText")),
    }
    for k in ("emotion", "audioUrl", "imageUrl", "replyDone"):
        if body.get(k):
            payload[k] = body[k]
    if body.get("emotionIntensity") is not None:
        payload["emotionIntensity"] = _clamp(body["emotionIntensity"])
    if body.get("emotionDuration") is not None:
        payload["emotionDuration"] = int(body["emotionDuration"])
    return jsonify({"ok": True, "delivered": broadcast(payload), "payload": payload})


# Manual animation checks temporarily take priority over live-chat reactions.
_demo_until = 0.0
_demo_generation = 0
_demo_timer = None
_demo_lock = threading.RLock()


@app.post("/demo")
def demo():
    global _demo_until, _demo_generation, _demo_timer
    kind = (request.get_json(silent=True) or {}).get("sequence", "")
    if kind not in (*PRESET_ACTIONS, "typing", "coffee", "stop"):
        return jsonify({"ok": False, "error": "Unknown demo sequence"}), 400
    with _demo_lock:
        _demo_generation += 1
        generation = _demo_generation
        if _demo_timer:
            _demo_timer.cancel()
        _demo_until = time.monotonic() + 30 if kind != "stop" else 0
        payload = {"demoReset": True, "working": kind in ("typing", "coffee")}
        if kind in PRESET_ACTIONS:
            payload["playAction"] = kind
        if kind == "coffee":
            payload["sipCoffee"] = True
        delivered = broadcast(payload)
        if kind != "stop":
            def finish():
                global _demo_until
                with _demo_lock:
                    if generation == _demo_generation:
                        _demo_until = 0
                        broadcast({"demoReset": True, "working": False})
            _demo_timer = threading.Timer(30, finish)
            _demo_timer.daemon = True
            _demo_timer.start()
    return jsonify({"ok": True, "delivered": delivered, "sequence": kind})


@app.post("/pet/sync")
def pet_sync():
    state = (request.get_json(silent=True) or {}).get('state')
    if state not in ACTIVITY_MAP:
        return jsonify({'ok': False, 'error': 'Unknown activity state'}), 400
    sync_activity(state)
    return jsonify({'ok': True})


@app.post("/pet/event")
def pet_event():
    """Map a Cuttle chat activity to an emote + action + text."""
    body = request.get_json(force=True, silent=True) or {}
    key = body.get("state")
    if key not in ACTIVITY_MAP:
        return jsonify({"ok": False, "error": f"unknown state {key!r}",
                        "known": list(ACTIVITY_MAP)}), 400
    sync_activity(key)
    if time.monotonic() < _demo_until:
        return jsonify({"ok": True, "suppressed": "manual demo"})
    spec = ACTIVITY_MAP[key]
    detail = body.get("detail")
    payload: dict[str, Any] = {
        "emotion": body.get("emotion") or spec["emotion"],
        "emotionIntensity": _clamp(body.get("emotionIntensity", 0.8)),
        "emotionDuration": int(body.get("emotionDuration", spec["duration_ms"])),
        "text": detail or spec.get("text", ""),
        "replyDone": key == "done",
        "working": bool(body.get("working", spec.get("working", False))),
    }
    action = body.get("action") or spec["action"]
    if action:
        payload["playAction"] = action
    return jsonify({"ok": True, "delivered": broadcast(payload), "payload": payload})


@app.post("/clear")
def clear():
    return jsonify({"ok": True, "delivered": broadcast({"clearText": True})})


# Endpoints the vendored components still call. They are OpenClaw-shaped
# because the components were not rewritten — they are thin shims, not the
# control surface. Cuttle and the CLI use the verbs above.
@app.route("/touch", methods=["POST"])
@app.route("/mood/adjust", methods=["POST"])
@app.route("/session/memo", methods=["POST"])
@app.route("/context/clear", methods=["POST"])
@app.route("/history", methods=["GET"])
def compat_noop():
    return jsonify({"ok": True})


@app.post("/preview")
def preview():
    """TTS preview. No TTS engine is wired yet; audioUrl is the integration point."""
    return jsonify({"ok": True, "audioUrl": None})


@app.get("/voice")
@app.post("/voice")
def voice():
    if request.method == "POST":
        _save_settings({"voice": request.get_json() or {}})
    return jsonify(_load_settings().get("voice", {"enabled": False}))


@app.get("/persona")
@app.post("/persona")
def persona():
    if request.method == "POST":
        _save_settings({"persona": request.get_json() or {}})
    return jsonify(_load_settings().get("persona", {}))


@app.post("/persona/screenshot")
def persona_screenshot():
    return jsonify({"ok": True})


@app.post("/persona/generate")
def persona_generate():
    return jsonify({"ok": False, "error": "persona generation is Cuttle's job"}), 501


@app.post("/screen/observe")
def screen_observe():
    return jsonify({"ok": False, "error": "Cuttle owns context"}), 501


@app.post("/chat")
def chat():
    """Free text to the pet. Cuttle drives conversation; this just displays it."""
    body = request.get_json(force=True, silent=True) or {}
    text = body.get("text")
    if not text:
        return jsonify({"ok": False, "error": "need text"}), 400
    broadcast({"text": str(text), "replyDone": False})
    return jsonify({"ok": True})


# ── window control ─────────────────────────────────────────────────────────
@app.post("/click-through")
def click_through():
    """Toggle mouse pass-through. The renderer listens and calls Tauri."""
    body = request.get_json(force=True, silent=True) or {}
    enabled = body.get("enabled")
    if enabled is None:
        enabled = not _load_settings().get("clickThrough", False)
    _save_settings({"clickThrough": bool(enabled)})
    broadcast({"setClickThrough": bool(enabled)})
    return jsonify({"ok": True, "clickThrough": bool(enabled)})


@app.get("/window/state")
def window_state():
    """Window geometry, reported by the renderer for gaze tracking / restore."""
    return jsonify({"ok": True, "bounds": _load_settings().get("bounds")})


# ── assets ─────────────────────────────────────────────────────────────────
def _list_dir(directory: Path, suffixes: Iterable[str]) -> list[dict[str, Any]]:
    if not directory.is_dir():
        return []
    suffixes = tuple(suffixes)
    out = []
    for p in sorted(directory.iterdir()):
        if p.is_file() and p.suffix.lower() in suffixes:
            out.append({"name": p.name, "size": p.stat().st_size,
                        "url": f"{'/model' if '.vrm' in p.suffix.lower() else '/dance'}/serve/{p.name}"})
    return out


@app.get("/model/list")
def model_list():
    _ensure_dirs()
    models = _list_dir(MODELS_DIR, (".vrm",))
    known = {m["name"] for m in models}
    for model in _list_dir(REPO_ROOT / "models", (".vrm",)):
        if model["name"] not in known:
            model["url"] = f"/model/project/{quote(model['name'])}"
            models.append(model)
    return jsonify({"models": models})


@app.post("/model/import")
def model_import():
    _ensure_dirs()
    src = (request.get_json(force=True, silent=True) or {}).get("path")
    if not src or not Path(src).is_file():
        return jsonify({"ok": False, "error": "need a readable local path"}), 400
    if Path(src).suffix.lower() != ".vrm":
        return jsonify({"ok": False, "error": "Choose a .vrm model file"}), 400
    dest = MODELS_DIR / Path(src).name
    if dest.resolve() != Path(src).resolve():
        shutil.copy2(src, dest)
    return jsonify({"ok": True, "name": dest.name, "url": f"/model/serve/{quote(dest.name)}"})


@app.get("/model/project/<path:name>")
def project_model_serve(name: str):
    return _serve_from(REPO_ROOT / "models", name)


@app.get("/model/serve/<path:name>")
def model_serve(name: str):
    return _serve_from(MODELS_DIR, name)


@app.get("/dance/list")
def dance_list():
    _ensure_dirs()
    return jsonify({"dances": _list_dir(DANCES_DIR, (".vmd",))})


@app.post("/dance/import")
def dance_import():
    _ensure_dirs()
    src = (request.get_json(force=True, silent=True) or {}).get("path")
    if not src or not Path(src).is_file():
        return jsonify({"ok": False, "error": "need a readable local path"}), 400
    dest = DANCES_DIR / Path(src).name
    shutil.copy2(src, dest)
    return jsonify({"ok": True, "name": dest.name, "url": f"/dance/serve/{dest.name}"})


@app.post("/dance/delete")
def dance_delete():
    name = (request.get_json(force=True, silent=True) or {}).get("name", "")
    target = (DANCES_DIR / Path(name).name)
    if target.is_file():
        target.unlink()
    return jsonify({"ok": True})


@app.get("/dance/serve/<path:name>")
def dance_serve(name: str):
    return _serve_from(DANCES_DIR, name)


@app.get("/audio/<path:name>")
def audio_serve(name: str):
    return _serve_from(AUDIO_DIR, name)


def _serve_from(directory: Path, name: str) -> Any:
    # Resolve and confirm containment so a crafted name can't escape the dir.
    target = (directory / Path(name).name).resolve()
    if not str(target).startswith(str(directory.resolve()) + os.sep) or not target.is_file():
        return jsonify({"ok": False, "error": "not found"}), 404
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return send_file(target, mimetype=mime)


def _ensure_dirs() -> None:
    for d in (MODELS_DIR, DANCES_DIR, AUDIO_DIR):
        d.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "cuttle-pet", "subscribers": len(_subscribers)})


@app.get("/")
def root():
    return jsonify({
        "service": "cuttle-pet",
        "sse": "/events",
        "verbs": ["/emote", "/action", "/say", "/pet/event", "/clear", "/click-through"],
        "emotions": list(PRESET_EMOTIONS),
        "actions": list(PRESET_ACTIONS),
        "activities": list(ACTIVITY_MAP),
    })


def _clamp(v: Any, lo: float = 0.0, hi: float = 1.0) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return hi


if __name__ == "__main__":
    _ensure_dirs()
    threading.Thread(target=watch_liveness, daemon=True).start()
    if os.environ.get("CUTTLE_PET_NO_SCREEN_MONITOR") != "1":
        threading.Thread(target=screen_monitor.watch, args=(_on_screen_change,), daemon=True).start()
    threading.Thread(target=music.watch, args=(publish_music,), daemon=True).start()
    threading.Thread(target=beats.watch, args=(publish_analysis, _load_settings), daemon=True).start()
    print(f"cuttle-pet control server on http://{HOST}:{PORT}  (data: {DATA_DIR})")
    app.run(host=HOST, port=PORT, threaded=True, debug=False)