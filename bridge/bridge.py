#!/usr/bin/env python3
"""Cuttle bridge — make the pet react to Cuttle chat activity.

Listens to Cuttle's activity stream and, on each change, reads the busy
chats' live status (plain interval polling when the stream is unavailable).
Maps turn state onto pet verbs:

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
import threading
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
    """Discover the authenticated user's chats that Cuttle reports as busy.

    The session list already carries Cuttle's own `generating` flag (the same
    one behind its history spinners), so only those chats need a live-status
    lookup. Older Cuttle builds without the flag fall back to every chat.
    """
    data = _get(f"{CUTTLE}/api/auth/sessions")
    if not data.get("success"):
        raise RuntimeError(f"chat discovery failed: {data.get('error', 'unknown error')}")
    owned = [s for s in data.get("sessions", []) if s.get("id") is not None]
    if owned and all("generating" in s for s in owned):
        owned = [s for s in owned if s.get("generating")]
    return [str(s["id"]) for s in owned]


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


# Consecutive Cuttle poll failures before the pet is told Cuttle went quiet.
# Without this the pet freezes in its last state (e.g. typing forever)
# when Cuttle is closed.
IDLE_AFTER_FAILURES = 2
# While busy, re-assert the state this often so text bubbles and the working
# pose refresh instead of appearing once and going stale.
HEARTBEAT_SEC = 60.0
# A busy status with byte-identical detail this long means the Cuttle-side
# flag is jammed (zombie session): stand the pet down to idle. Any change
# (new detail, done, real idle) revives normal reporting immediately.
STALE_BUSY_SEC = 900.0


# Activity stream: wake the loop on Cuttle changes instead of fixed polling.
# Resync anyway every RESYNC_SEC for changes the stream cannot see (expiry).
RESYNC_SEC = 10.0
STREAM_MIN_GAP_SEC = 0.25
STREAM_READ_TIMEOUT = 45.0
STREAM_RETRY_SEC = 30.0


class ActivityListener:
    """Follows Cuttle's /api/activity/stream and wakes the poll loop on changes.

    Older Cuttle builds without the stream leave it disconnected; the loop then
    falls back to interval polling.
    """

    def __init__(self) -> None:
        self.changed = threading.Event()
        self.connected = False
        self._stop = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._run, name="cuttle-activity", daemon=True).start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                req = urllib.request.Request(f"{CUTTLE}/api/activity/stream", headers=_headers())
                with urllib.request.urlopen(req, timeout=STREAM_READ_TIMEOUT, context=_SSL_CTX) as r:
                    self.connected = True
                    for line in r:
                        if line.startswith(b"event: activity"):
                            self.changed.set()
            except Exception:
                pass
            if self.connected:
                self.connected = False
                self.changed.set()  # resync right after a drop
            self._stop.wait(STREAM_RETRY_SEC)

    def pause(self, interval: float) -> None:
        """Wait for the next poll: until Cuttle reports activity when streaming,
        otherwise for the plain interval."""
        if not self.connected:
            time.sleep(interval)
            return
        self.changed.wait(RESYNC_SEC)
        # Coalesce bursts (live status ticks) into one read; clearing before
        # the read keeps changes that land during it.
        self._stop.wait(STREAM_MIN_GAP_SEC)
        self.changed.clear()


def state_after_poll_failure(last: str | None, failures: int) -> tuple[str, str] | None:
    """Fallback (state, detail) once Cuttle has been unreachable for a while,
    else None to keep waiting silently."""
    if failures >= IDLE_AFTER_FAILURES and last in ("thinking", "streaming"):
        return "idle", ""
    return None


def pet_sync(state: str) -> None:
    _post(f"{PET}/pet/sync", {"state": state})


def fetch_state_for(sessions):
    return fetch_state(sessions)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--session", action="append", default=[],
                    help="Cuttle session id to watch (repeatable); "
                         "also $CUTTLE_PET_SESSIONS; default: all chats")
    ap.add_argument("--all-chats", action="store_true", help="watch all your chats (default without --session)")
    ap.add_argument("--parent-pid", type=int, default=0, help="Exit when the owning launcher exits")
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
    listener = ActivityListener()
    if not a.once:
        listener.start()
    last = None
    announced: tuple[str, str] | None = None
    last_emit = 0.0
    stood_down_from: tuple[str, str] | None = None
    failed = False
    failures = 0
    connection_notice = None
    while True:
        if a.parent_pid:
            try:
                os.kill(a.parent_pid, 0)
            except ProcessLookupError:
                return 0
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
            failures = 0
            if state == "idle" and last in ("thinking", "streaming"):
                state, detail = "done", ""
        except RuntimeError as exc:
            if not failed:
                print(f"cuttle poll failed: {exc}\nOpen pet Settings → Cuttle, or run: .venv/bin/python cli/cuttle_pet.py connect", file=sys.stderr)
            failed = True
            failures += 1
            fallback = state_after_poll_failure(last, failures)
            if fallback is None:
                if a.once:
                    return 1
                time.sleep(a.interval)
                continue
            # Cuttle has been unreachable for a while: report idle so the
            # pet stops working instead of freezing mid-typing.
            state, detail = fallback

        current = (state, detail)
        now = time.monotonic()
        if stood_down_from is not None and current == stood_down_from:
            # Frozen zombie status; stay quiet until something actually changes.
            pass
        elif current != announced:
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
            announced = current
            last = state
            last_emit = now
            stood_down_from = None
        elif state in ("thinking", "streaming"):
            if now - last_emit >= STALE_BUSY_SEC:
                # Same busy detail for 15 minutes: Cuttle-side flag is jammed.
                if a.verbose:
                    print(f"activity: {state} stale, standing down to idle", file=sys.stderr)
                try:
                    pet_event("idle", "")
                except RuntimeError as exc:
                    print(f"pet emit failed: {exc}", file=sys.stderr)
                    if a.once:
                        return 1
                    time.sleep(a.interval)
                    continue
                announced = ("idle", "")
                last_emit = now
                stood_down_from = current
                # Keep `last` as the busy state so a real finish still maps
                # to the done celebration instead of a bare idle.
            elif now - last_emit >= HEARTBEAT_SEC:
                try:
                    pet_event(state, detail)
                except RuntimeError as exc:
                    print(f"pet emit failed: {exc}", file=sys.stderr)
                    if a.once:
                        return 1
                    time.sleep(a.interval)
                    continue
                last_emit = now

        # Reassert the working flag after renderer/server reconnects, without
        # replaying text or one-shot actions on every poll. Uses the last
        # announced state so a zombie stand-down is not overridden.
        try:
            pet_sync(announced[0] if announced else state)
        except RuntimeError as exc:
            print(f"pet sync failed: {exc}", file=sys.stderr)
        if a.once:
            return 0
        listener.pause(a.interval)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nbridge stopped", file=sys.stderr)
        sys.exit(0)
