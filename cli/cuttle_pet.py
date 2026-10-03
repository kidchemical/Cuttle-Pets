#!/usr/bin/env python3
"""cuttle-pet CLI — drive the desktop pet from a shell, an agent, or Cuttle.

    cuttle-pet emote happy --intensity 0.8
    cuttle-pet action scratchHead
    cuttle-pet say "done!" --emotion happy
    cuttle-pet event thinking --detail "Reading three files…"
    cuttle-pet click-through on
    cuttle-pet models --import ~/pets/reef.vrm
    cuttle-pet watch          # stream pet events to stdout
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge import connection

SERVER = os.environ.get("CUTTLE_PET_SERVER", "http://127.0.0.1:8790").rstrip("/")


class CliError(RuntimeError):
    pass


def _request(method: str, path: str, body: dict | None = None, timeout: float = 8.0):
    url = f"{SERVER}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise CliError(f"{exc.code} {exc.reason}: {detail}") from None
    except urllib.error.URLError as exc:
        raise CliError(f"cannot reach the pet server at {SERVER} ({exc.reason}). "
                       f"Start it with: .venv/bin/python server/server.py") from None
    try:
        return json.loads(raw)
    except ValueError:
        return {"ok": True, "raw": raw}


def _intensity(value: float) -> float:
    return max(0.0, min(1.0, value))


# ── commands ───────────────────────────────────────────────────────────────
def cmd_connect(a: argparse.Namespace) -> int:
    import getpass
    try:
        username = a.username or input("Cuttle username: ").strip()
        password = getpass.getpass("Cuttle password: ")
        result = connection.connect(username, password, a.cuttle_url)
        print(f"Connected as {result['username']}. Future launches reconnect automatically.")
        return 0
    except (connection.ConnectionError, EOFError) as exc:
        raise CliError(str(exc) or "Sign-in cancelled") from None
    except KeyboardInterrupt:
        print("\nSign-in cancelled", file=sys.stderr)
        return 1


def cmd_connection(a: argparse.Namespace) -> int:
    try:
        return _report(connection.disconnect() if a.disconnect else connection.status())
    except connection.ConnectionError as exc:
        raise CliError(str(exc)) from None


def cmd_emote(a: argparse.Namespace) -> int:
    body: dict = {}
    if a.vrchat:
        body["vrchat"] = a.emotion
        body["value"] = _intensity(a.value if a.value is not None else 1.0)
    else:
        body["emotion"] = a.emotion
    if a.intensity is not None:
        body["emotionIntensity"] = _intensity(a.intensity)
    if a.duration is not None:
        body["emotionDuration"] = a.duration
    if a.mood_delta:
        body["moodDelta"] = a.mood_delta
    return _report(_request("POST", "/emote", body))


def cmd_action(a: argparse.Namespace) -> int:
    return _report(_request("POST", "/action", {"action": a.action, "hold": a.hold}))


def cmd_say(a: argparse.Namespace) -> int:
    body: dict = {"text": a.text}
    if a.emotion:
        body["emotion"] = a.emotion
    if a.intensity is not None:
        body["emotionIntensity"] = _intensity(a.intensity)
    if a.duration is not None:
        body["emotionDuration"] = a.duration
    if a.append:
        body["appendText"] = True
    if a.audio:
        body["audioUrl"] = a.audio
    return _report(_request("POST", "/say", body))


def cmd_event(a: argparse.Namespace) -> int:
    body: dict = {"state": a.state}
    if a.detail:
        body["detail"] = a.detail
    if a.emotion:
        body["emotion"] = a.emotion
    if a.action:
        body["action"] = a.action
    if a.intensity is not None:
        body["emotionIntensity"] = _intensity(a.intensity)
    return _report(_request("POST", "/pet/event", body))


def cmd_clear(a: argparse.Namespace) -> int:
    return _report(_request("POST", "/clear", {}))


def cmd_click_through(a: argparse.Namespace) -> int:
    enabled: bool | None
    if a.state == "toggle":
        enabled = None
    else:
        enabled = a.state == "on"
    return _report(_request("POST", "/click-through", {"enabled": enabled}))


def cmd_settings(a: argparse.Namespace) -> int:
    if a.key:
        try:
            value = json.loads(a.value)
        except json.JSONDecodeError:
            value = a.value
        return _report(_request("POST", "/settings", {a.key: value}))
    return _report(_request("GET", "/settings"))


def cmd_models(a: argparse.Namespace) -> int:
    if a.import_path:
        path = os.path.expanduser(a.import_path)
        res = _request("POST", "/model/import", {"path": path})
        print(json.dumps(res, indent=2))
        return 0 if res.get("ok") else 1
    res = _request("GET", "/model/list")
    models = res.get("models", [])
    if not models:
        print("no models yet — add one with:  cuttle-pet models --import <path.vrm>")
        return 0
    for m in models:
        print(f"{m['name']:<28} {m['size'] / 1e6:>7.1f} MB  {m['url']}")
    return 0


def cmd_watch(a: argparse.Namespace) -> int:
    """Stream pet events. Ctrl-C to stop."""
    import http.client
    parsed = urllib.request.urlparse(SERVER)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=None)
    path = (parsed.path or "") + "/events"
    conn.request("GET", path)
    resp = conn.getresponse()
    if resp.status != 200:
        print(f"error: {resp.status} {resp.reason}", file=sys.stderr)
        return 1
    print(f"watching {SERVER}/events  (ctrl-c to stop)", file=sys.stderr)
    try:
        while True:
            line = resp.fp.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").strip()
            if text.startswith("data:"):
                payload = json.loads(text[5:].strip())
                print(f"{time.strftime('%H:%M:%S')}  {json.dumps(payload)}")
    except KeyboardInterrupt:
        print("\nstopped", file=sys.stderr)
    return 0


def cmd_status(a: argparse.Namespace) -> int:
    return _report(_request("GET", "/health"))


def cmd_verbs(a: argparse.Namespace) -> int:
    return _report(_request("GET", "/"))


def _report(res: dict) -> int:
    print(json.dumps(res, indent=2))
    # Endpoints like /settings return bare dicts with no "ok" flag; only an
    # explicit failure reports nonzero (agents check exit codes).
    if res.get("ok", True) is False or "error" in res:
        return 1
    return 0


# ── parser ─────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="cuttle-pet", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--server", help=f"control server (default {SERVER}, or $CUTTLE_PET_SERVER)")
    sub = p.add_subparsers(dest="cmd", required=True)

    connect = sub.add_parser("connect", help="sign in once and remember the Cuttle connection")
    connect.add_argument("--username")
    connect.add_argument("--cuttle-url", default="https://127.0.0.1:8080")
    connect.set_defaults(func=cmd_connect)
    connection_cmd = sub.add_parser("connection", help="check saved Cuttle connection or disconnect")
    connection_cmd.add_argument("--disconnect", action="store_true")
    connection_cmd.set_defaults(func=cmd_connection)

    e = sub.add_parser("emote", help="set an expression")
    e.add_argument("emotion", help="preset name (happy, think, …) or --vrchat expression")
    e.add_argument("--vrchat", action="store_true", help="treat the name as a raw VRChat expression")
    e.add_argument("--value", type=float, help="value for --vrchat (0..1)")
    e.add_argument("--intensity", type=float, help="preset intensity 0..1")
    e.add_argument("--duration", type=int, help="ms before resetting")
    e.add_argument("--mood-delta", type=int, help="shift persistent mood")
    e.set_defaults(func=cmd_emote)

    a = sub.add_parser("action", help="play a named animation")
    a.add_argument("action")
    a.add_argument("--hold", action="store_true", help="hold the pose")
    a.set_defaults(func=cmd_action)

    s = sub.add_parser("say", help="show text in the bubble")
    s.add_argument("text")
    s.add_argument("--emotion")
    s.add_argument("--intensity", type=float)
    s.add_argument("--duration", type=int)
    s.add_argument("--append", action="store_true")
    s.add_argument("--audio", help="audio URL for lip-sync")
    s.set_defaults(func=cmd_say)

    v = sub.add_parser("event", help="Cuttle chat activity -> reaction")
    v.add_argument("state", choices=["thinking", "streaming", "done", "error", "idle"])
    v.add_argument("--detail")
    v.add_argument("--emotion")
    v.add_argument("--action")
    v.add_argument("--intensity", type=float)
    v.set_defaults(func=cmd_event)

    c = sub.add_parser("clear", help="clear the text bubble")
    c.set_defaults(func=cmd_clear)

    ct = sub.add_parser("click-through", help="toggle mouse pass-through")
    ct.add_argument("state", choices=["on", "off", "toggle"])
    ct.set_defaults(func=cmd_click_through)

    st = sub.add_parser("settings", help="read or write renderer settings")
    st.add_argument("key", nargs="?")
    st.add_argument("value", nargs="?")
    st.set_defaults(func=cmd_settings)

    m = sub.add_parser("models", help="list or import .vrm models")
    m.add_argument("--import", dest="import_path", metavar="PATH")
    m.set_defaults(func=cmd_models)

    w = sub.add_parser("watch", help="stream pet events")
    w.set_defaults(func=cmd_watch)

    st2 = sub.add_parser("status", help="server health")
    st2.set_defaults(func=cmd_status)

    vb = sub.add_parser("verbs", help="list server verbs")
    vb.set_defaults(func=cmd_verbs)
    return p


def main(argv: list[str] | None = None) -> int:
    global SERVER
    args = build_parser().parse_args(argv)
    if args.server:
        SERVER = args.server.rstrip("/")
    try:
        return args.func(args)
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())