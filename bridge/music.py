"""Linux desktop playback detection via MPRIS; never captures audio."""
from __future__ import annotations
import re
import subprocess
import time


def bus_call(destination: str, path: str, method: str, *args: str) -> str:
    result = subprocess.run(['gdbus', 'call', '--session', '--dest', destination,
                             '--object-path', path, '--method', method, *args],
                            capture_output=True, text=True, timeout=2, check=True)
    return result.stdout


def is_playing() -> bool:
    names = bus_call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames')
    for name in re.findall(r"'(org\.mpris\.MediaPlayer2[^']*)'", names):
        try:
            status = bus_call(name, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties.Get',
                              'org.mpris.MediaPlayer2.Player', 'PlaybackStatus')
            if "'Playing'" in status:
                return True
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def watch(publish, stop=None):
    last = None
    while stop is None or not stop.is_set():
        try:
            active = is_playing()
        except (OSError, subprocess.SubprocessError):
            active = False
        if active != last:
            publish(active)
            last = active
        if stop is None:
            time.sleep(3)
        else:
            stop.wait(3)
