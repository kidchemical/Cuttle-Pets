"""Desktop output capture and music lifecycle. PCM stays in memory."""
from __future__ import annotations
import math
import os
import re
import select
import shutil
import struct
import subprocess
import time
import sys

from bridge.beat_detector import BeatDetector, RATE, SAMPLES


def options(settings):
    value = settings.get('musicSettings') or {}
    if not isinstance(value, dict):
        value = {}
    def number(key, fallback, low, high):
        try:
            n = float(value.get(key, fallback))
            return max(low, min(high, n)) if math.isfinite(n) else max(low, min(high, fallback))
        except (TypeError, ValueError):
            return max(low, min(high, fallback))
    minimum = number('minBpm', 60, 40, 239)
    return {
        'enabled': settings.get('musicEnabled', True) is not False and any(value.get(key, True) is not False for key in ('beatSync', 'amplitudeReactive', 'reactOnEnd')),
        'min_bpm': minimum, 'max_bpm': number('maxBpm', 200, minimum + 1, 240),
        'cutoff': number('cutoff', 200, 40, 200),
        'sensitivity': number('sensitivity', 1.5, 1.05, 4),
    }


class SongEndDetector:
    """One reaction after sustained playback and silence, never after capture failure."""
    def __init__(self):
        self.reset()

    def reset(self):
        self.heard = 0.
        self.quiet_since = None
        self.last = None
        self.was_playing = False
        self.sent = False

    def update(self, playing, available, enabled, now):
        if not available or not enabled:
            self.reset()
            return False
        elapsed = min(1., max(0., now - self.last)) if self.last is not None else 0.
        self.last = now
        if playing:
            if self.sent:
                self.heard = 0.
                self.sent = False
            if self.was_playing:
                self.heard += elapsed
            self.quiet_since = None
        elif self.quiet_since is None:
            self.quiet_since = now
        self.was_playing = playing
        if not playing and self.heard >= 10 and not self.sent and now - self.quiet_since >= 2:
            self.sent = True
            return True
        return False


def default_sink():
    result = subprocess.run(['wpctl', 'inspect', '@DEFAULT_AUDIO_SINK@'], capture_output=True,
                            text=True, timeout=2, check=True)
    if not re.search(r'media.class\s*=\s*"Audio/Sink"', result.stdout):
        raise RuntimeError('The default audio device is not a playback sink')
    match = re.search(r'node.name\s*=\s*"([^"]+)"', result.stdout)
    if not match:
        raise RuntimeError('Cannot find the default playback sink')
    return match.group(1)


def capture_command(sink):
    return ['pw-record', '--target', sink, '--properties',
            '{ stream.capture.sink=true node.name=cuttle-pet-beats node.description="Cuttle Pets beat sync" }',
            '--rate', str(RATE), '--channels', '1', '--format', 's16', '--latency', '20ms', '--raw', '-']


class PipeWireCapture:
    def __init__(self):
        if not shutil.which('pw-record') or not shutil.which('wpctl'):
            raise RuntimeError('PipeWire playback capture requires pw-record and wpctl')
        self.sink = default_sink()
        self.process = subprocess.Popen(capture_command(self.sink), stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        os.set_blocking(self.process.stdout.fileno(), False)
        self.pending = b''
        self.clock = None
        self.last_check = time.monotonic()

    def read(self):
        now = time.monotonic()
        if now - self.last_check > 5:
            self.last_check = now
            if default_sink() != self.sink:
                raise RuntimeError('Default playback device changed')
        if self.process.poll() is not None:
            raise RuntimeError('PipeWire playback capture stopped')
        readable, _, _ = select.select([self.process.stdout], [], [], .25)
        if not readable:
            return []
        data = os.read(self.process.stdout.fileno(), SAMPLES * 2 * 8)
        if not data:
            raise RuntimeError('No data from playback monitor')
        self.pending += data
        if self.clock is None or abs(self.clock - now) > .3:
            self.clock = now - len(self.pending) / (2 * RATE)
        frames = []
        while len(self.pending) >= SAMPLES * 2:
            pcm, self.pending = self.pending[:SAMPLES * 2], self.pending[SAMPLES * 2:]
            self.clock += SAMPLES / RATE
            frames.append((struct.unpack('<' + 'h' * SAMPLES, pcm), self.clock))
        return frames

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()  # Only our owned capture child.
            self.process.wait()
        self.process.stdout.close()


def open_capture():
    if sys.platform == 'win32':
        from bridge.wasapi_capture import WasapiCapture
        return WasapiCapture()
    if sys.platform.startswith('linux'):
        return PipeWireCapture()
    raise RuntimeError('Desktop beat capture supports Ubuntu/PipeWire and Windows/WASAPI')


def watch(publish, get_settings, stop=None):
    capture = None
    configuration = None
    detector = None
    last_status = None
    last_settings = last_report = last_audio = -math.inf
    config = None

    def status(name, message):
        nonlocal last_status
        if last_status != (name, message):
            publish({'status': name, 'message': message, 'bpm': None, 'confidence': 0, 'playing': False})
            last_status = (name, message)

    def close():
        nonlocal capture
        if capture is not None:
            try:
                capture.close()
            except (OSError, RuntimeError):
                pass  # A removed output device may also fail while closing.
            finally:
                capture = None

    def pause(seconds):
        if stop is None:
            time.sleep(seconds)
        else:
            stop.wait(seconds)

    try:
        while stop is None or not stop.is_set():
            now = time.monotonic()
            if config is None or now - last_settings > .5:
                config = options(get_settings())
                last_settings = now
            if not config['enabled']:
                close()
                status('disabled', 'Music analysis is off; using fallback tempo.')
                pause(.25)
                continue
            try:
                if capture is None:
                    capture = open_capture()
                    configuration = None
                    last_audio = now
                    status('listening', 'Listening for rhythm in desktop playback.')
                if configuration != config:
                    detector = BeatDetector(**{k: v for k, v in config.items() if k != 'enabled'})
                    configuration = config
                frames = capture.read()
                if not frames:
                    if now - last_audio > 2:
                        raise RuntimeError('Playback capture stopped delivering samples')
                    continue
                last_audio = time.monotonic()
                for pcm, sample_clock in frames:
                    result = detector.process(pcm, sample_clock)
                    if result['beat'] or now - last_report >= .05:
                        # PCM time, beat-grid time, and predicted next pulse are
                        # distinct. Convert all sample-clock times using one offset.
                        offset = time.time() - time.monotonic()
                        for key in ('beat_timestamp', 'next_beat'):
                            if result[key] is not None:
                                result[key] += offset
                        publish({'status': 'listening', **result, 'timestamp': sample_clock + offset})
                        last_report = now
            except (OSError, RuntimeError, ArithmeticError, ValueError, ImportError,
                    subprocess.SubprocessError) as exc:
                close()
                status('unavailable', f'Playback capture unavailable: {exc}. Using fallback tempo.')
                pause(2)
    finally:
        close()
