#!/usr/bin/env python3
"""Cuttle bridge — make the pet react to Cuttle chat activity.

Polls Cuttle's live-status endpoint and maps turn state onto pet verbs:

    idle        -> relaxed
    thinking    -> think + scratchHead
    streaming   -> curious
    done        -> happy + happy, with the reply's first line as speech
    error       -> surprised + point

Loopback-only, no auth (same trust boundary as the control server).

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

CUTTLE = os.environ.get("CUTTLE_API", "https://127.0.0.1:8080").rstrip("/")
PET = os.environ.get("CUTTLE_PET_SERVER", "http://127.0.0.1:8790").rstrip("/")
TOKEN = os.environ.get("CUTTLE_SESSION_TOKEN", "").strip()
# Comma-separated session ids to watch. Defaults to the busiest recent chat.
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
    return {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}


def _get(url: str, timeout: float = 4.0) -> dict:
    req = urllib.request.Request(url, headers=_headers())
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


def fetch_state() -> tuple[str, str]:
    """Return (activity, detail) from Cuttle's live-status batch feed.

    ``/api/chat-live-status-batch`` requires explicit session ids and answers
    with ``{"success": true, "statuses": {sid: {...}}}``. Per entry we care
    about ``generating``/``active``, ``status`` (free text the agent emits),
    ``cancelled``, and ``supervised_task``.
    """
    if not SESSIONS:
        return "idle", ""
    data = _get(f"{CUTTLE}/api/chat-live-status-batch?session_ids={','.join(SESSIONS[:12])}")
    statuses = data.get("statuses") or {}
    if not statuses:
        return "idle", ""

    # Most interesting pane wins: anything busy beats idle.
    best, best_detail = "idle", ""
    for sid, entry in statuses.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("cancelled"):
            return "idle", ""
        task = entry.get("supervised_task")
        status = str(entry.get("status") or "").strip()
        busy = bool(entry.get("generating") or entry.get("active")) or bool(task)
        if not busy:
            continue
        low = status.lower()
        if any(w in low for w in DONE_WORDS):
            act = "done"
        elif any(w in low for w in BUSY_WORDS):
            act = "thinking"
        else:
            act = "streaming"
        if act == "done" or best == "idle":
            best, best_detail = act, status or (task or {}).get("description", "")
    return best, best_detail


def pet_event(state: str, detail: str = "") -> None:
    _post(f"{PET}/pet/event", {"state": state, "detail": detail})


def fetch_state_for(sessions):
    global SESSIONS
    SESSIONS = sessions
    return fetch_state()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", type=float, default=3.0)
    ap.add_argument("--session", action="append", default=[],
                    help="Cuttle session id to watch (repeatable); "
                         "also $CUTTLE_PET_SESSIONS or $CUTTLE_SESSION_TOKEN")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)

    sessions = a.session or SESSIONS
    if not sessions:
        print("no sessions to watch.\n"
              "  pass --session <id>, or set CUTTLE_PET_SESSIONS=1,2\n"
              "  (get ids with: python -m api.panes_cli list)", file=sys.stderr)
        return 1

    # Fail fast and clearly if either side is down.
    try:
        _get(f"{PET}/health")
    except RuntimeError as exc:
        print(f"pet server unreachable: {exc}\nstart it: python server/server.py", file=sys.stderr)
        return 1

    last = None
    while True:
        try:
            state, detail = fetch_state_for(sessions)
        except RuntimeError as exc:
            if a.verbose:
                print(f"cuttle poll failed: {exc}", file=sys.stderr)
            state, detail = "idle", ""

        if state != last:
            if a.verbose:
                print(f"activity: {last} -> {state} ({detail})", file=sys.stderr)
            try:
                pet_event(state, detail)
            except RuntimeError as exc:
                print(f"pet emit failed: {exc}", file=sys.stderr)
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