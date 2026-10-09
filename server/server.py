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
  * ``/assets/<pets|props>/…``  — companion GLB library: stage a local
                                  GLB/glTF/FBX/DAE (+ textures) for the
                                  settings window to convert, then store GLB.
  * ``GET /companions``, ``POST /companion`` — pet/prop catalog + control.

Everything is loopback-only and dependency-light (stdlib + Flask).
"""

from __future__ import annotations

import json
import mimetypes
import os
import queue
import random
import re
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
PETS_DIR = DATA_DIR / "pets"
PROPS_DIR = DATA_DIR / "props"
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


# ── render stats ────────────────────────────────────────────────────────
# The pet posts its measured frame rate and drawing-buffer size every few
# seconds so diagnostics (CLI, agents) can read real numbers headlessly.
_render_stats: dict[str, Any] = {}


@app.post("/render-stats")
def post_render_stats():
    body = request.get_json(force=True, silent=True) or {}
    def scalar(value: Any) -> bool:
        return isinstance(value, (int, float, bool)) or (isinstance(value, str) and len(value) <= 64)
    clean = {k: v for k, v in list(body.items())[:32] if isinstance(k, str) and len(k) <= 32 and scalar(v)}
    _render_stats.clear()
    _render_stats.update(clean)
    _render_stats["_at"] = time.time()
    return jsonify({"ok": True})


@app.get("/render-stats")
def get_render_stats():
    """Last render stats the pet reported (fps, caps, buffer size)."""
    stats = {k: v for k, v in _render_stats.items() if k != "_at"}
    at = _render_stats.get("_at")
    return jsonify({"ok": True, "stats": stats, "ageSeconds": round(time.time() - at, 1) if at else None})


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


def _app_version() -> str:
    try:
        return (REPO_ROOT / "VERSION").read_text().strip()
    except OSError:
        return "dev"


@app.get("/version")
def get_version():
    """Running build version (mirrors the repo-root VERSION file).

    Update flows must treat everything under DATA_DIR (~/.cuttle-pet:
    settings.json, models, dances, audio) as user-owned: replacing the app
    bundle or checking out a new release must never delete, overwrite, or
    migrate those files except through an explicit, documented migration for
    a named setting key.
    """
    return jsonify({"version": _app_version()})


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


# ── agent-callable reactions ───────────────────────────────────────────────
# User-defined one-shot behaviors from Settings → Behavior → Custom reactions
# (stored under settings["behaviorSettings"]["reactions"]). Agents browse them
# with GET /behaviors and play them with POST /behaviors/trigger. This mirrors
# the TypeScript normalization in app/src/behavior.ts — keep the two in sync.

_REACTION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-_]{0,39}$")
_REACTION_PARAM_RE = re.compile(r"^[a-z][a-z0-9_]{0,29}$")
_REACTION_TEMPLATE_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
_KNOWN_REACTION_ANIMATIONS = ("idle", "typing", "sip", "music", "random:action",
                              "hands", "eyes", "blink", "expressions")


def _reaction_animation_known(animation: str) -> bool:
    if not isinstance(animation, str) or not animation:
        return False
    if animation in _KNOWN_REACTION_ANIMATIONS:
        return True
    if animation.startswith("dance:"):
        # Built-in dance names are validated client-side against dancePresets;
        # custom dances carry their preset (URL) on the step itself.
        return len(animation) > len("dance:")
    if animation.startswith("action:"):
        return animation[7:] in PRESET_ACTIONS
    return False


def _normalize_reaction_param(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    name = str(value.get("name", "")).strip().lower()
    if not _REACTION_PARAM_RE.match(name):
        return None
    kind = value.get("type")
    kind = kind if kind in ("string", "number", "boolean") else "string"
    default = value.get("default")
    if kind == "number":
        try:
            num = float(default)
            default = int(num) if num == num and abs(num) != float("inf") and num.is_integer() else (num if num == num and abs(num) != float("inf") else 0)
        except (TypeError, ValueError):
            default = 0
    elif kind == "boolean":
        default = default is True or default in ("true", "1", 1)
    else:
        default = str(default)[:200] if isinstance(default, (str, int, float, bool)) else ""
    description = value.get("description")
    description = str(description)[:200] if isinstance(description, str) else ""
    return {"name": name, "type": kind, "default": default, "description": description}


def _normalize_reaction_step(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    animation = value.get("animation")
    if not isinstance(animation, str) or not _reaction_animation_known(animation):
        return None
    preset = value.get("preset")
    if animation.startswith("dance:custom:") and not (
            isinstance(preset, dict) and isinstance(preset.get("url"), str)
            and isinstance(preset.get("label"), str)):
        return None
    step: dict[str, Any] = {"animation": animation, "durationMs": 3000}
    emotion = value.get("emotion")
    if isinstance(emotion, str) and (emotion in PRESET_EMOTIONS or emotion == "random"):
        step["emotion"] = emotion
    say = value.get("say")
    if isinstance(say, str) and say.strip():
        step["say"] = say[:280]
    try:
        duration = int(value.get("durationMs", value.get("duration_ms", 3000)))
    except (TypeError, ValueError):
        duration = 3000
    step["durationMs"] = max(500, min(30000, duration))
    if animation.startswith("dance:custom:"):
        motion_type = preset.get("type")
        step["preset"] = {"label": preset["label"],
                          "type": motion_type if motion_type in ("vmd", "vrma", "fbx") else "vmd",
                          "url": preset["url"],
                          "bgm": preset.get("bgm") if isinstance(preset.get("bgm"), str) else None}
    companions = _normalize_companion_actions(value.get("companions"))
    if companions:
        step["companions"] = companions
    props = value.get("props")
    if isinstance(props, dict) and (props.get("working") is True or props.get("sip") is True):
        step["props"] = {}
        if props.get("working") is True:
            step["props"]["working"] = True
        if props.get("sip") is True:
            step["props"]["sip"] = True
    return step


def _normalize_reaction(value: Any, fallback_id: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    raw_id = str(value.get("id", "")).strip().lower()
    rid = raw_id if _REACTION_ID_RE.match(raw_id) else fallback_id
    if not _REACTION_ID_RE.match(rid):
        return None
    name = str(value.get("name", ""))[:60] or rid
    description = value.get("description")
    description = str(description)[:280] if isinstance(description, str) else ""
    seen: set[str] = set()
    params: list[dict[str, Any]] = []
    for item in value.get("params", []) if isinstance(value.get("params"), list) else []:
        param = _normalize_reaction_param(item)
        if param and param["name"] not in seen:
            seen.add(param["name"])
            params.append(param)
    params = params[:8]
    steps = []
    for item in value.get("steps", []) if isinstance(value.get("steps"), list) else []:
        step = _normalize_reaction_step(item)
        if step:
            steps.append(step)
    steps = steps[:10]
    if not steps:
        return None
    return {"id": rid, "name": name, "description": description,
            "params": params, "steps": steps}


def _load_reactions() -> list[dict[str, Any]]:
    settings = _load_settings()
    behavior = settings.get("behaviorSettings")
    raw = behavior.get("reactions") if isinstance(behavior, dict) else None
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        reaction = _normalize_reaction(item, f"reaction-{index + 1}")
        if reaction and reaction["id"] not in seen:
            seen.add(reaction["id"])
            out.append(reaction)
    return out[:50]


def _render_reaction_template(text: str, values: dict[str, Any]) -> str:
    def replace(match: re.Match) -> str:
        key = match.group(1).lower()
        return match.group(0) if key not in values else str(values[key])
    return _REACTION_TEMPLATE_RE.sub(replace, text)[:280]


def _coerce_reaction_args(reaction: dict[str, Any], args: Any) -> dict[str, Any]:
    values: dict[str, Any] = {p["name"]: p["default"] for p in reaction["params"]}
    if not isinstance(args, dict):
        return values
    for param in reaction["params"]:
        if param["name"] not in args:
            continue
        raw = args[param["name"]]
        if param["type"] == "number":
            try:
                num = float(raw)
                if num != num or abs(num) == float("inf"):
                    values[param["name"]] = param["default"]
                elif num.is_integer():
                    values[param["name"]] = int(num)
                else:
                    values[param["name"]] = num
            except (TypeError, ValueError):
                values[param["name"]] = param["default"]
        elif param["type"] == "boolean":
            if isinstance(raw, bool):
                values[param["name"]] = raw
            else:
                text = str(raw or "").strip().lower()
                if text in ("true", "1", "yes", "y", "on"):
                    values[param["name"]] = True
                elif text in ("false", "0", "no", "n", "off"):
                    values[param["name"]] = False
                else:
                    values[param["name"]] = param["default"]
        else:
            values[param["name"]] = str(raw)[:280] if raw is not None else param["default"]
    return values


def _reaction_cli_example(rid: str, params: list[dict[str, Any]]) -> str:
    extra = " [--param name=value ...]" if params else ""
    return f"python3 cli/cuttle_pet.py react {rid}{extra}"


def _reaction_catalog_entry(reaction: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": reaction["id"],
        "name": reaction["name"],
        "description": reaction["description"],
        "params": reaction["params"],
        "steps": len(reaction["steps"]),
        "summary": f"{reaction['name']} — {len(reaction['steps'])} step(s)"
                   + (f" · params: {', '.join(p['name'] for p in reaction['params'])}" if reaction["params"] else ""),
        "cli": _reaction_cli_example(reaction["id"], reaction["params"]),
        "http": {"method": "POST", "path": "/behaviors/trigger",
                 "body": {"id": reaction["id"], "params": {p["name"]: p["default"] for p in reaction["params"]}}},
    }


_reaction_generation = 0
_reaction_lock = threading.RLock()


def _play_reaction_sequence(reaction: dict[str, Any], values: dict[str, Any], generation: int) -> None:
    """Broadcast one reactionStep frame per step, then reactionDone.

    The renderer owns playback: it enters a reaction mode (behavior engine
    paused, each step interrupts the previous motion) and restores the pet's
    own working/dancing state on reactionDone. A newer trigger supersedes an
    in-flight sequence between steps; its frames keep the renderer in
    reaction mode, so the superseded run sends no reactionDone.
    """
    steps = reaction["steps"]
    for index, step in enumerate(steps):
        with _reaction_lock:
            if generation != _reaction_generation:
                return
        frame: dict[str, Any] = {"animation": step["animation"], "durationMs": step["durationMs"]}
        if step.get("preset"):
            frame["preset"] = step["preset"]
        if step.get("props"):
            frame["props"] = step["props"]
        if step.get("companions"):
            frame["companions"] = step["companions"]
        payload: dict[str, Any] = {
            "reactionStep": frame, "reaction": reaction["id"],
            "reactionIndex": index, "reactionCount": len(steps),
        }
        emotion = step.get("emotion")
        if emotion:
            payload["emotion"] = random.choice(PRESET_EMOTIONS) if emotion == "random" else emotion
            payload["emotionIntensity"] = 0.8
            payload["emotionDuration"] = step["durationMs"]
        if step.get("say"):
            payload["text"] = _render_reaction_template(step["say"], values)
            if payload.get("emotion"):
                payload["emotionDuration"] = max(payload["emotionDuration"], 5000)
        broadcast(payload)
        time.sleep(step["durationMs"] / 1000.0)
    with _reaction_lock:
        if generation != _reaction_generation:
            return
    broadcast({"reactionDone": True, "reaction": reaction["id"]})


@app.get("/behaviors")
def behaviors_catalog():
    """Agent-browsable library of user-defined reactions (see Settings → Behavior)."""
    reactions = _load_reactions()
    return jsonify({"ok": True, "behaviors": [_reaction_catalog_entry(r) for r in reactions]})


@app.post("/behaviors/trigger")
def behaviors_trigger():
    global _reaction_generation
    body = request.get_json(force=True, silent=True) or {}
    rid = body.get("id")
    if not isinstance(rid, str) or not rid:
        return jsonify({"ok": False, "error": "need reaction id"}), 400
    if isinstance(body.get("reaction"), dict):
        # Inline definition (Settings "Test on pet"): plays the editor's
        # current draft without waiting for the settings save to land.
        reaction = _normalize_reaction({**body["reaction"], "id": rid}, rid)
        if reaction is None:
            return jsonify({"ok": False, "error": "reaction has no playable steps"}), 400
    else:
        reactions = _load_reactions()
        reaction = next((r for r in reactions if r["id"] == rid), None)
        if reaction is None:
            return jsonify({"ok": False, "error": f"unknown reaction {rid!r}",
                            "known": [r["id"] for r in reactions]}), 404
    values = _coerce_reaction_args(reaction, body.get("params"))
    with _reaction_lock:
        _reaction_generation += 1
        generation = _reaction_generation
    rendered = [{**s, "sayRendered": _render_reaction_template(s["say"], values) if s.get("say") else None}
                for s in reaction["steps"]]
    thread = threading.Thread(target=_play_reaction_sequence,
                              args=(reaction, values, generation), daemon=True)
    thread.start()
    return jsonify({"ok": True, "id": rid, "steps": len(rendered),
                    "params": values, "payload": {"steps": rendered}})


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
    return jsonify({"dances": _list_dir(DANCES_DIR, (".vmd", ".vrma", ".fbx"))})


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


# ── companion assets (pets / props) ────────────────────────────────────────
# Stored as GLB under DATA_DIR/pets and DATA_DIR/props (user data: only an
# explicit delete removes files). Importing is two-step because FBX/DAE need
# three.js to convert: /stage copies the source plus its sibling textures into
# a private staging dir the settings window loads from, then /commit (already
# GLB) or /upload (converted GLB bytes) stores the result.
_ASSET_SOURCE_SUFFIXES = (".glb", ".gltf", ".fbx", ".dae")
_ASSET_SIDECAR_SUFFIXES = (".bin", ".png", ".jpg", ".jpeg", ".tga", ".bmp", ".webp", ".gif", ".ktx2", ".dds")
_ASSET_STAGE_LIMIT = 300 * 1024 * 1024
_ASSET_STAGE_TTL = 3600
_STAGE_TOKEN_RE = re.compile(r"^[a-f0-9]{16}$")


def _asset_dir(kind: str) -> Path | None:
    return {"pets": PETS_DIR, "props": PROPS_DIR}.get(kind)


def _asset_stem(name: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(name).stem).strip("-._")[:60]
    return stem or "asset"


def _unique_asset_path(directory: Path, stem: str) -> Path:
    target = directory / f"{stem}.glb"
    n = 2
    while target.exists():
        target = directory / f"{stem}-{n}.glb"
        n += 1
    return target


def _clean_stale_stages(directory: Path) -> None:
    stage_root = directory / ".staging"
    if not stage_root.is_dir():
        return
    cutoff = time.time() - _ASSET_STAGE_TTL
    for entry in stage_root.iterdir():
        try:
            if entry.is_dir() and entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            pass


def _stage_dir(kind: str, token: str) -> Path | None:
    directory = _asset_dir(kind)
    if directory is None or not _STAGE_TOKEN_RE.match(token or ""):
        return None
    stage = directory / ".staging" / token
    return stage if stage.is_dir() else None


@app.get("/assets/<kind>/list")
def asset_list(kind: str):
    directory = _asset_dir(kind)
    if directory is None:
        return jsonify({"ok": False, "error": "kind must be pets or props"}), 404
    _ensure_dirs()
    items = [{"name": p.name, "size": p.stat().st_size, "url": f"/assets/{kind}/serve/{quote(p.name)}"}
             for p in sorted(directory.iterdir()) if p.is_file() and p.suffix.lower() == ".glb"]
    return jsonify({"ok": True, "assets": items})


@app.post("/assets/<kind>/stage")
def asset_stage(kind: str):
    directory = _asset_dir(kind)
    if directory is None:
        return jsonify({"ok": False, "error": "kind must be pets or props"}), 404
    src = (request.get_json(force=True, silent=True) or {}).get("path")
    source = Path(src).expanduser() if isinstance(src, str) and src else None
    if source is None or not source.is_file():
        return jsonify({"ok": False, "error": "need a readable local path"}), 400
    suffix = source.suffix.lower()
    if suffix not in _ASSET_SOURCE_SUFFIXES:
        return jsonify({"ok": False, "error": "Choose a .glb, .gltf, .fbx or .dae file"}), 400
    _ensure_dirs()
    _clean_stale_stages(directory)
    token = os.urandom(8).hex()
    stage = directory / ".staging" / token
    stage.mkdir(parents=True)
    # Textures usually sit beside the model or one folder down (images/,
    # textures/); copy those so relative references resolve while loading.
    files = [source]
    for sibling in source.parent.iterdir():
        if sibling.is_file() and sibling.suffix.lower() in _ASSET_SIDECAR_SUFFIXES:
            files.append(sibling)
        elif sibling.is_dir() and not sibling.name.startswith("."):
            try:
                files.extend(f for f in sibling.iterdir()
                             if f.is_file() and f.suffix.lower() in _ASSET_SIDECAR_SUFFIXES)
            except OSError:
                continue
    total = 0
    for f in files:
        size = f.stat().st_size
        total += size
        if total > _ASSET_STAGE_LIMIT:
            shutil.rmtree(stage, ignore_errors=True)
            return jsonify({"ok": False, "error": "Model folder is too large to import (300 MB limit)"}), 413
        dest = stage / f.relative_to(source.parent)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest)
    return jsonify({"ok": True, "token": token, "format": suffix[1:], "name": source.stem,
                    "url": f"/assets/{kind}/staging/{token}/{quote(source.name)}"})


@app.get("/assets/<kind>/staging/<token>/<path:rel>")
def asset_staging_serve(kind: str, token: str, rel: str):
    stage = _stage_dir(kind, token)
    if stage is None:
        return jsonify({"ok": False, "error": "not found"}), 404
    # Loaders sometimes ask for a texture by bare name or a different case;
    # fall back to a case-insensitive basename match inside the stage.
    target = (stage / rel).resolve()
    if not str(target).startswith(str(stage.resolve()) + os.sep) or not target.is_file():
        wanted = Path(rel.replace("\\", "/")).name.lower()
        target = next((p for p in stage.rglob("*") if p.is_file() and p.name.lower() == wanted), None)
        if target is None:
            return jsonify({"ok": False, "error": "not found"}), 404
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return send_file(target, mimetype=mime)


@app.post("/assets/<kind>/commit")
def asset_commit(kind: str):
    """Store a staged .glb as-is (no conversion needed)."""
    directory = _asset_dir(kind)
    body = request.get_json(force=True, silent=True) or {}
    stage = _stage_dir(kind, str(body.get("token", "")))
    if directory is None or stage is None:
        return jsonify({"ok": False, "error": "unknown staging token"}), 404
    glbs = [p for p in stage.iterdir() if p.is_file() and p.suffix.lower() == ".glb"]
    if len(glbs) != 1:
        return jsonify({"ok": False, "error": "staged import is not a single .glb; convert and upload instead"}), 400
    target = _unique_asset_path(directory, _asset_stem(str(body.get("name") or glbs[0].name)))
    shutil.copy2(glbs[0], target)
    shutil.rmtree(stage, ignore_errors=True)
    return jsonify({"ok": True, "name": target.name, "url": f"/assets/{kind}/serve/{quote(target.name)}"})


@app.post("/assets/<kind>/upload")
def asset_upload(kind: str):
    """Store converted GLB bytes (request body) and drop the staging dir."""
    directory = _asset_dir(kind)
    if directory is None:
        return jsonify({"ok": False, "error": "kind must be pets or props"}), 404
    data = request.get_data(cache=False)
    if len(data) < 12 or data[:4] != b"glTF":
        return jsonify({"ok": False, "error": "body must be a binary glTF (.glb)"}), 400
    if len(data) > _ASSET_STAGE_LIMIT:
        return jsonify({"ok": False, "error": "model too large"}), 413
    _ensure_dirs()
    target = _unique_asset_path(directory, _asset_stem(request.args.get("name", "asset")))
    target.write_bytes(data)
    stage = _stage_dir(kind, request.args.get("token", ""))
    if stage is not None:
        shutil.rmtree(stage, ignore_errors=True)
    return jsonify({"ok": True, "name": target.name, "url": f"/assets/{kind}/serve/{quote(target.name)}"})


@app.post("/assets/<kind>/delete")
def asset_delete(kind: str):
    directory = _asset_dir(kind)
    if directory is None:
        return jsonify({"ok": False, "error": "kind must be pets or props"}), 404
    name = Path(str((request.get_json(force=True, silent=True) or {}).get("name", ""))).name
    target = directory / name
    if name.lower().endswith(".glb") and target.is_file():
        target.unlink()
        return jsonify({"ok": True, "deleted": name})
    return jsonify({"ok": False, "error": "not found"}), 404


@app.get("/assets/<kind>/serve/<path:name>")
def asset_serve(kind: str, name: str):
    directory = _asset_dir(kind)
    if directory is None:
        return jsonify({"ok": False, "error": "not found"}), 404
    return _serve_from(directory, name)


# ── companion control ──────────────────────────────────────────────────────
# Mirrors normalizeCompanionAction in app/src/companions.ts.
_COMPANION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-_]{0,39}$")
PET_ACTIONS = ("show", "hide", "toggle", "expression", "play", "stop", "move")
PROP_ACTIONS = ("show", "hide", "toggle")
PET_MOVES = ("hop", "spin", "flap", "wiggle", "bounce")
PET_ANCHORS = ("shoulder", "head", "beside", "hands", "orbit")


def _normalize_companion_action(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    kind = value.get("kind")
    if kind not in ("pet", "prop"):
        return None
    cid = value.get("id")
    if not isinstance(cid, str) or not _COMPANION_ID_RE.match(cid):
        return None
    act = value.get("action")
    if act not in (PET_ACTIONS if kind == "pet" else PROP_ACTIONS):
        return None
    out: dict[str, Any] = {"kind": kind, "id": cid, "action": act}
    raw = value.get("value")
    raw = raw[:120] if isinstance(raw, str) else ""
    if act in ("expression", "play", "move"):
        if not raw:
            return None
        if act == "move" and raw not in PET_ANCHORS and raw != "home":
            return None
        if act == "play" and raw not in PET_MOVES and not raw.startswith("clip:"):
            return None
        out["value"] = raw
    if act == "play" and value.get("loop") is True:
        out["loop"] = True
    if act == "expression" and value.get("durationMs") is not None:
        try:
            ms = int(float(value["durationMs"]))
        except (TypeError, ValueError):
            ms = 0
        if ms > 0:
            out["durationMs"] = min(ms, 600000)
    return out


def _normalize_companion_actions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [a for a in (_normalize_companion_action(v) for v in value) if a][:6]


def _companion_catalog() -> dict[str, list[dict[str, Any]]]:
    settings = _load_settings()
    pets_raw = (settings.get("petSettings") or {}).get("pets") if isinstance(settings.get("petSettings"), dict) else None
    props_raw = (settings.get("propSettings") or {}).get("props") if isinstance(settings.get("propSettings"), dict) else None
    pets = []
    for pet in pets_raw if isinstance(pets_raw, list) else []:
        if isinstance(pet, dict) and isinstance(pet.get("id"), str):
            clips = (pet.get("asset") or {}).get("clips") if isinstance(pet.get("asset"), dict) else []
            pets.append({
                "id": pet["id"], "name": pet.get("name") or pet["id"], "enabled": pet.get("enabled") is not False,
                "expressions": [e.get("id") for e in pet.get("expressions") or [] if isinstance(e, dict) and e.get("id")],
                "moves": list(PET_MOVES) + [f"clip:{c}" for c in clips or [] if isinstance(c, str)],
                "anchors": list(PET_ANCHORS),
            })
    props = [{"id": p["id"], "name": p.get("name") or p["id"], "enabled": p.get("enabled") is not False}
             for p in (props_raw if isinstance(props_raw, list) else [])
             if isinstance(p, dict) and isinstance(p.get("id"), str)]
    return {"pets": pets, "props": props}


@app.get("/companions")
def companions_catalog():
    """Pets and props an agent can control with POST /companion."""
    return jsonify({"ok": True, **_companion_catalog(),
                    "actions": {"pet": list(PET_ACTIONS), "prop": list(PROP_ACTIONS)}})


@app.post("/companion")
def companion_control():
    body = request.get_json(force=True, silent=True) or {}
    action = _normalize_companion_action(body)
    if action is None:
        return jsonify({"ok": False, "error": "need kind (pet|prop), id, a valid action and its value",
                        "actions": {"pet": list(PET_ACTIONS), "prop": list(PROP_ACTIONS)},
                        "moves": list(PET_MOVES), "anchors": list(PET_ANCHORS)}), 400
    catalog = _companion_catalog()
    known = [c["id"] for c in catalog["pets" if action["kind"] == "pet" else "props"]]
    if action["id"] not in known:
        return jsonify({"ok": False, "error": f"unknown {action['kind']} {action['id']!r}", "known": known}), 404
    if action["kind"] == "pet" and action["action"] == "expression":
        pet = next(p for p in catalog["pets"] if p["id"] == action["id"])
        if action["value"] not in pet["expressions"] and action["value"] != "neutral":
            return jsonify({"ok": False, "error": f"unknown expression {action['value']!r}",
                            "known": pet["expressions"]}), 400
    payload = {"companion": action}
    return jsonify({"ok": True, "delivered": broadcast(payload), "payload": payload})


def _serve_from(directory: Path, name: str) -> Any:
    # Resolve and confirm containment so a crafted name can't escape the dir.
    target = (directory / Path(name).name).resolve()
    if not str(target).startswith(str(directory.resolve()) + os.sep) or not target.is_file():
        return jsonify({"ok": False, "error": "not found"}), 404
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return send_file(target, mimetype=mime)


def _ensure_dirs() -> None:
    for d in (MODELS_DIR, DANCES_DIR, AUDIO_DIR, PETS_DIR, PROPS_DIR):
        d.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "cuttle-pet", "subscribers": len(_subscribers)})


@app.get("/")
def root():
    return jsonify({
        "service": "cuttle-pet",
        "sse": "/events",
        "verbs": ["/emote", "/action", "/say", "/pet/event", "/clear", "/click-through",
                  "/behaviors", "/behaviors/trigger", "/companions", "/companion"],
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