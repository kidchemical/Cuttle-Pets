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
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from flask import Flask, Response, jsonify, request, send_file

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
)

# Cuttle chat activity -> (emotion, action, text-template)
ACTIVITY_MAP: dict[str, dict[str, Any]] = {
    "thinking":  {"emotion": "think",     "action": "scratchHead", "duration_ms": 10000},
    "streaming": {"emotion": "curious",   "action": None,          "duration_ms": 8000},
    "done":      {"emotion": "happy",     "action": "happy",       "duration_ms": 5000},
    "error":     {"emotion": "surprised", "action": "point",       "duration_ms": 5000},
    "idle":      {"emotion": "relaxed",   "action": None,          "duration_ms": 4000},
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


# ── fan-out ────────────────────────────────────────────────────────────────
# One SSE client (the desktop pet) at a time is the expected shape, but keep a
# list so a settings window or second monitor copy can also subscribe.
_subscribers: list[queue.Queue] = []
_sub_lock = threading.Lock()


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


@app.get("/events")
def events():
    q: queue.Queue = queue.Queue(maxsize=64)
    with _sub_lock:
        _subscribers.append(q)

    def gen():
        try:
            # Tell the client we're live before the first real frame.
            yield f": connected {int(time.time())}\n\n"
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
def _load_settings() -> dict[str, Any]:
    try:
        return json.loads(SETTINGS_PATH.read_text())
    except (OSError, ValueError):
        return {}


def _save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = _load_settings()
    current.update(patch)
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(current, indent=2))
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


@app.post("/pet/event")
def pet_event():
    """Map a Cuttle chat activity to an emote + action + text."""
    body = request.get_json(force=True, silent=True) or {}
    key = body.get("state")
    if key not in ACTIVITY_MAP:
        return jsonify({"ok": False, "error": f"unknown state {key!r}",
                        "known": list(ACTIVITY_MAP)}), 400
    spec = ACTIVITY_MAP[key]
    detail = body.get("detail")
    payload: dict[str, Any] = {
        "emotion": body.get("emotion") or spec["emotion"],
        "emotionIntensity": _clamp(body.get("emotionIntensity", 0.8)),
        "emotionDuration": int(body.get("emotionDuration", spec["duration_ms"])),
        "text": detail or spec.get("text", ""),
        "replyDone": key == "done",
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
    return jsonify(_load_settings().get("voice", {"enabled": False}))


@app.get("/persona")
@app.post("/persona")
def persona():
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
    return jsonify({"models": _list_dir(MODELS_DIR, (".vrm",))})


@app.post("/model/import")
def model_import():
    _ensure_dirs()
    src = (request.get_json(force=True, silent=True) or {}).get("path")
    if not src or not Path(src).is_file():
        return jsonify({"ok": False, "error": "need a readable local path"}), 400
    dest = MODELS_DIR / Path(src).name
    if dest.resolve() != Path(src).resolve():
        shutil.copy2(src, dest)
    return jsonify({"ok": True, "name": dest.name, "url": f"/model/serve/{dest.name}"})


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
    print(f"cuttle-pet control server on http://{HOST}:{PORT}  (data: {DATA_DIR})")
    app.run(host=HOST, port=PORT, threaded=True, debug=False)