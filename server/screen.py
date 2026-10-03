"""Screensaver / session-lock detection for the Linux desktop pet.

Why this exists: the renderer's ``document.hidden`` / ``visibilitychange``
handling does NOT fire when a fullscreen screensaver covers the pet window.
The page stays "visible", ``requestAnimationFrame`` keeps presenting WebGL
frames underneath (or above) the screensaver, and both sides fight for the
GPU — the screensaver drops to ~0.5-1fps. The only definitive fix is to
detect the screensaver/lock at OS level and fully suspend the pet (stop the
render loop *and* hide the window so nothing is composited).

Probes, in order (first definitive answer wins; errors mean "unknown" and
abstain rather than flapping):

  1. GNOME/Unity/Mutter ``org.gnome.ScreenSaver`` ``GetActive`` via gdbus.
  2. Freedesktop ``org.freedesktop.ScreenSaver`` ``GetActive`` (covers
     mate-screensaver, light-locker shims, etc.).
  3. logind ``LockedHint`` for our own session (covers GNOME lock screen,
     swaylock, hyprlock, etc. which may not export a ScreenSaver bus name).
  4. ``xscreensaver-command -time`` — "screen blanked" means the X11
     screensaver is covering the display.

Suspend when ANY probe says active/locked; resume only when every working
probe says inactive/unlocked. This hysteresis avoids flapping when one
backend lags behind the others during lock/unlock transitions.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from typing import Callable, Optional

# gdbus prints booleans as "(true,)" / "(false,)".
_GDBUS_TRUE = "(true,)"
_GDBUS_FALSE = "(false,)"

# Poll cadence: fast enough that the pet gets out of the screensaver's way
# within a couple of seconds, slow enough that three tiny subprocess spawns
# every tick are noise.
POLL_INTERVAL = float(os.environ.get("CUTTLE_PET_SCREEN_POLL", "2"))

Runner = Callable[..., "CompletedLike"]


class CompletedLike:
    """Minimal structural type for subprocess results (real or faked)."""

    def __init__(self, returncode: int = 0, stdout: str = ""):
        self.returncode = returncode
        self.stdout = stdout


def _run(cmd: list[str], timeout: float = 3) -> Optional[CompletedLike]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return CompletedLike(proc.returncode, proc.stdout or "")
    except (OSError, subprocess.SubprocessError):
        return None


def probe_gnome_screensaver(run: Runner = _run) -> Optional[bool]:
    """org.gnome.ScreenSaver GetActive. None when unavailable/unknown."""
    try:
        res = run(
            ["gdbus", "call", "--session",
             "--dest", "org.gnome.ScreenSaver",
             "--object-path", "/org/gnome/ScreenSaver",
             "--method", "org.gnome.ScreenSaver.GetActive"],
        )
    except Exception:
        return None
    if res is None or res.returncode != 0:
        return None
    out = (res.stdout or "").strip()
    if _GDBUS_TRUE in out:
        return True
    if _GDBUS_FALSE in out:
        return False
    return None


def probe_freedesktop_screensaver(run: Runner = _run) -> Optional[bool]:
    """org.freedesktop.ScreenSaver GetActive. None when unavailable."""
    try:
        res = run(
            ["gdbus", "call", "--session",
             "--dest", "org.freedesktop.ScreenSaver",
             "--object-path", "/ScreenSaver",
             "--method", "org.freedesktop.ScreenSaver.GetActive"],
        )
    except Exception:
        return None
    if res is None or res.returncode != 0:
        return None
    out = (res.stdout or "").strip()
    if _GDBUS_TRUE in out:
        return True
    if _GDBUS_FALSE in out:
        return False
    return None


def _own_session_id() -> Optional[str]:
    sid = os.environ.get("XDG_SESSION_ID")
    if sid:
        return sid
    # Fall back to loginctl: first session owned by our uid.
    try:
        proc = subprocess.run(
            ["loginctl", "--no-legend", "list-sessions"],
            capture_output=True, text=True, timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    uid = str(os.getuid())
    for line in (proc.stdout or "").splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[2] == uid:
            return parts[0]
    return None


def probe_logind_locked(run: Runner = _run) -> Optional[bool]:
    """logind LockedHint for our own session. None when unavailable."""
    sid = _own_session_id()
    if not sid:
        return None
    try:
        res = run(["loginctl", "show-session", sid, "-p", "LockedHint", "--value"])
    except Exception:
        return None
    if res is None or res.returncode != 0:
        return None
    out = (res.stdout or "").strip().lower()
    if out == "yes":
        return True
    if out == "no":
        return False
    return None


def probe_xscreensaver(run: Runner = _run) -> Optional[bool]:
    """xscreensaver-command -time. True when the screen is blanked."""
    try:
        res = run(["xscreensaver-command", "-time"])
    except Exception:
        return None
    if res is None or res.returncode != 0:
        return None
    out = (res.stdout or "").strip().lower()
    if "blanked" in out and "non-blanked" not in out and "un-blanked" not in out:
        return True
    if "non-blanked" in out:
        return False
    return None


PROBES: tuple[Callable[[Runner], Optional[bool]], ...] = (
    probe_gnome_screensaver,
    probe_freedesktop_screensaver,
    probe_logind_locked,
    probe_xscreensaver,
)


def is_suspended(run: Runner = _run) -> bool:
    """True when any probe definitively reports screensaver-active/locked."""
    for probe in PROBES:
        try:
            if probe(run) is True:
                return True
        except Exception:
            continue
    return False


def watch(on_change: Callable[[bool], None],
          poll_interval: float = POLL_INTERVAL,
          run: Runner = _run,
          stop: Optional[threading.Event] = None) -> None:
    """Poll forever; call on_change(True/False) only on transitions."""
    suspended = is_suspended(run)
    on_change(suspended)
    while True:
        if stop is not None:
            if stop.wait(poll_interval):
                return
        else:
            time.sleep(poll_interval)
        current = is_suspended(run)
        if current != suspended:
            suspended = current
            on_change(suspended)
