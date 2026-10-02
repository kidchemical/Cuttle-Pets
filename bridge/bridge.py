#!/usr/bin/env python3
"""Cuttle bridge — make the pet react to Cuttle chat activity.

Polls Cuttle's live-status endpoint and maps turn state onto pet verbs:

    idle        -> relaxed
    thinking    -> think + scratchHead
    streaming   -> curious
    done        -> happy + happy, with available status detail as speech
    error       -> surprised + point

Pet writes are loopback-only. Cuttle reads require a login token.

    python bridge/bridge.py --once      # single poll, for testing
    python bridge/bridge.py             # follow until Ctrl-C
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.connection import load_connection

CUTTLE = os.environ.get("CUTTLE_API", "https://127.0.0.1:8080").rstrip("/")
PET = os.environ.get("CUTTLE_PET_SERVER", "http://127.0.0.1:8790").rstrip("/")
TOKEN = os.environ.get("CUTTLE_SESSION_TOKEN", "").strip()
# Optional comma-separated session ids; otherwise discover all owned chats.
SESSIONS = [s for s in os.environ.get("CUTTLE_PET_SESSIONS", "").split(",") if s.strip()]

# Cuttle is HTTPS with a self-signed cert on 8080.
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

# Cuttle reports busy as active/generating; there is no explicit "thinking"
# flag, so we infer stages from the status string the agent emits.
BUSY_WORDS = ("thinking", "reasoning", "reading", "searching", "calling", "running",
              "generating", "waiting", "escalat", "thinking ")
DONE_WORDS = ("done", "complete", "finished", "ready")


def _headers() -> dict[str, str]:
    saved = load_connection()
    token = saved.get("token", "") or TOKEN
    return {"Authorization": f"Bearer {token}"} if token else {}


def _get(url: str, timeout: float = 4.0) -> dict:
    req = urllib.request.Request(url, headers=_headers() if url.startswith(CUTTLE + "/") else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(f"{url} -> {exc.code} {exc.reason}: {body[:160]}") from None
    except Exception as exc:  # noqa: BLE001 - connection refused is normal
        raise RuntimeError(f"{url} -> {exc}") from None


def _post(url: str, body: dict, timeout: float = 4.0) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"{url} -> {exc}") from None


def discover_sessions() -> list[str]:
    """Discover all chats owned by the authenticated Cuttle user, including new chats."""
    data = _get(f"{CUTTLE}/api/auth/sessions")
    if not data.get("success"):
        raise RuntimeError(f"chat discovery failed: {data.get('error', 'unknown error')}")
    return [str(s["id"]) for s in data.get("sessions", []) if s.get("id") is not None]


def fetch_state(sessions: list[str] | None = None) -> tuple[str, str]:
    sessions = SESSIONS if sessions is None else sessions
    statuses = {}
    # Cuttle accepts at most 12 sessions in each batch. Never drop later chats.
    for offset in range(0, len(sessions), 12):
        data = _get(f"{CUTTLE}/api/chat-live-status-batch?session_ids={','.join(sessions[offset:offset + 12])}")
        if not data.get("success"):
            raise RuntimeError(f"live status failed: {data.get('error', 'unknown error')}")
        statuses.update(data.get("statuses") or {})
    best, detail = "idle", ""
    rank = {"idle": 0, "done": 1, "streaming": 2, "thinking": 3}
    for entry in statuses.values():
        if not isinstance(entry, dict) or entry.get("cancelled"):
            continue
        task = entry.get("supervised_task")
        status = str(entry.get("status") or "").strip()
        if not (entry.get("generating") or entry.get("active") or task):
            continue
        low = status.lower()
        act = ("done" if any(w in low for w in DONE_WORDS) else
               "thinking" if any(w in low for w in BUSY_WORDS) else "streaming")
        if rank[act] > rank[best]:
            best = act
            detail = status or (task.get("description", "") if isinstance(task, dict) else "")
    return best, detail


def pet_event(state: str, detail: str = "") -> None:
    _post(f"{PET}/pet/event", {"state": state, "detail": detail})


def fetch_state_for(sessions):
    return fetch_state(sessions)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", type=float, default=3.0)
    ap.add_argument("--session", action="append", default=[],
                    help="Cuttle session id to watch (repeatable); "
                         "also $CUTTLE_PET_SESSIONS; default: all chats")
    ap.add_argument("--all-chats", action="store_true", help="watch all your chats (default without --session)")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)

    sessions = a.session or SESSIONS
    all_chats = a.all_chats or not sessions
    if a.interval <= 0:
        ap.error("--interval must be positive")

    # Fail fast and clearly if either side is down.
    try:
        _get(f"{PET}/health")
    except RuntimeError as exc:
        print(f"pet server unreachable: {exc}\nstart it: .venv/bin/python server/server.py", file=sys.stderr)
        return 1

    global CUTTLE
    last = None
    failed = False
    connection_notice = None
    while True:
        try:
            saved = load_connection()
            if not TOKEN and not saved:
                if connection_notice != "disconnected":
                    print("Pet is ready. Connect to Cuttle in pet Settings, or run: .venv/bin/python cli/cuttle_pet.py connect", file=sys.stderr)
                connection_notice = "disconnected"
                last = None
                if a.once:
                    return 1
                time.sleep(a.interval)
                continue
            connection_notice = None
            CUTTLE = saved.get("url") or os.environ.get("CUTTLE_API") or CUTTLE
            if all_chats:
                sessions = discover_sessions()
            state, detail = fetch_state_for(sessions)
            failed = False
            if state == "idle" and last in ("thinking", "streaming"):
                state, detail = "done", ""
        except RuntimeError as exc:
            if not failed:
                print(f"cuttle poll failed: {exc}\nOpen pet Settings → Cuttle, or run: .venv/bin/python cli/cuttle_pet.py connect", file=sys.stderr)
            failed = True
            if a.once:
                return 1
            time.sleep(a.interval)
            continue

        if state != last:
            if a.verbose:
                print(f"activity: {last} -> {state} ({detail})", file=sys.stderr)
            try:
                pet_event(state, detail)
            except RuntimeError as exc:
                print(f"pet emit failed: {exc}", file=sys.stderr)
                if a.once:
                    return 1
                time.sleep(a.interval)
                continue
            last = state

        if a.once:
            return 0
        time.sleep(a.interval)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nbridge stopped", file=sys.stderr)
        sys.exit(0)
