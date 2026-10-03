"""Local PipeWire sink-monitor analysis. PCM stays in memory; no mic or audio files."""
from __future__ import annotations
from collections import deque
import math
import os
import re
import select
import shutil
import statistics
import struct
import subprocess
import time

RATE = 8000
SAMPLES = 160  # 20 ms; sufficient resolution for 95–195 BPM.


def options(settings):
    value = settings.get('musicSettings') or {}
    if not isinstance(value, dict):
        value = {}
    def number(key, fallback, low, high):
        try:
            n = float(value.get(key, fallback))
            return max(low, min(high, n)) if math.isfinite(n) else fallback
        except (TypeError, ValueError):
            return fallback
    minimum = number('minBpm', 95, 40, 239)
    return {
        'enabled': settings.get('musicEnabled', True) is not False and any(value.get(key, True) is not False for key in ('beatSync', 'amplitudeReactive', 'reactOnEnd')),
        'min_bpm': minimum, 'max_bpm': number('maxBpm', 195, minimum + 1, 240),
        'cutoff': number('cutoff', 200, 40, 200),
        'sensitivity': number('sensitivity', 1.5, 1.05, 4),
    }


class BeatDetector:
    """Bass RMS peaks with adaptive threshold and consistency-gated tempo lock."""
    def __init__(self, min_bpm=95, max_bpm=195, cutoff=200, sensitivity=1.5):
        self.min_bpm, self.max_bpm, self.sensitivity = min_bpm, max_bpm, sensitivity
        # Butterworth low-pass; two poles attenuate energy above the selected bass band.
        w = 2 * math.pi * cutoff / RATE
        cos, sin = math.cos(w), math.sin(w)
        alpha = sin / math.sqrt(2)
        a0 = 1 + alpha
        self.b0 = (1 - cos) / (2 * a0)
        self.b1, self.b2 = 2 * self.b0, self.b0
        self.a1, self.a2 = -2 * cos / a0, (1 - alpha) / a0
        self.x1 = self.x2 = self.y1 = self.y2 = 0.
        self.dc = 0.
        self.energy = deque(maxlen=50)
        self.onsets = deque(maxlen=24)
        self.previous = self.before_previous = 0.
        self.previous_bass_ratio = 0.
        self.last_onset = -math.inf
        self.last_signal = -math.inf
        self.bpm = None
        self.confidence = 0.

    def estimate(self):
        if len(self.onsets) < 4:
            return None, 0.
        # Use nearby intervals as candidates, then score against the recent pulse train.
        intervals = [b - a for a, b in zip(self.onsets, list(self.onsets)[1:]) if b > a]
        if len(intervals) < 3:
            return None, 0.
        candidates = []
        for interval in intervals:
            bpm = 60 / interval
            if self.min_bpm * .95 <= bpm <= self.max_bpm * 1.05:
                bpm = min(self.max_bpm, max(self.min_bpm, bpm))
            while bpm < self.min_bpm:
                bpm *= 2
            while bpm > self.max_bpm:
                bpm /= 2
            if self.min_bpm <= bpm <= self.max_bpm:
                candidates.append(bpm)
        if not candidates:
            return None, 0.
        def score(bpm):
            period = 60 / bpm
            return sum(abs(delta / period - round(delta / period)) < .12 for delta in intervals) / len(intervals)
        best = max(candidates, key=lambda bpm: (score(bpm), -abs(bpm - (self.bpm or 130))))
        confidence = score(best) * min(1, (len(self.onsets) - 1) / 6)
        period = 60 / best
        matched = [(delta, round(delta / period)) for delta in intervals
                   if abs(delta / period - round(delta / period)) < .12 and round(delta / period) >= 1]
        if not matched or confidence < .35:
            return None, confidence
        refined = 60 * sum(ticks for _, ticks in matched) / sum(delta for delta, _ in matched)
        refined = min(self.max_bpm, max(self.min_bpm, refined))
        return (refined, confidence) if confidence >= .35 else (None, confidence)

    def process(self, samples, now):
        total = input_total = 0.
        for raw in samples:
            x = raw / 32768.
            # Remove DC to avoid treating static bias as bass.
            self.dc += .002 * (x - self.dc)
            x -= self.dc
            input_total += x * x
            y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2
            self.x2, self.x1, self.y2, self.y1 = self.x1, x, self.y1, y
            total += y * y
        rms = math.sqrt(total / max(1, len(samples)))
        background = statistics.mean(self.energy) if self.energy else rms
        peak = self.previous > self.before_previous and self.previous >= rms
        strong = self.previous > max(.0004, background * self.sensitivity) and self.previous_bass_ratio > .08
        onset = peak and strong and now - self.last_onset >= 60 / self.max_bpm * .70
        if math.sqrt(input_total / max(1, len(samples))) > .0008:
            self.last_signal = now
        self.energy.append(rms)
        self.before_previous, self.previous = self.previous, rms
        self.previous_bass_ratio = total / max(input_total, 1e-12)
        if onset:
            self.last_onset = now
            self.onsets.append(now - SAMPLES / RATE)
            self.bpm, self.confidence = self.estimate()
        if now - self.last_onset > 3:
            self.bpm, self.confidence = None, 0.
            self.onsets.clear()
        return {'beat': bool(onset), 'bpm': self.bpm, 'confidence': self.confidence,
                'level': rms, 'amplitude': math.sqrt(input_total / max(1, len(samples))), 'playing': now - self.last_signal < 2}


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


def watch(publish, get_settings, stop=None):
    process = None
    configuration = None
    config = None
    last_settings = -math.inf
    detector = None
    last_status = None
    pending = b''
    last_report = last_check = 0.
    sink = None
    sample_clock = None
    def status(name, message):
        nonlocal last_status
        if last_status != (name, message):
            publish({'status': name, 'message': message, 'bpm': None, 'confidence': 0, 'playing': False})
            last_status = (name, message)
    def close():
        nonlocal process, pending, sample_clock
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()  # Only our owned pw-record child.
                process.wait()
            process.stdout.close()
            process = None
        pending = b''
        sample_clock = None
    try:
        while stop is None or not stop.is_set():
            now = time.monotonic()
            if config is None or now - last_settings > .5:
                config = options(get_settings())
                last_settings = now
            if not config['enabled']:
                close()
                status('disabled', 'Beat sync is off; using fallback tempo.')
                time.sleep(.25)
                continue
            if not shutil.which('pw-record') or not shutil.which('wpctl'):
                status('unavailable', 'PipeWire playback capture unavailable; using fallback tempo.')
                time.sleep(3)
                continue
            try:
                if not process or now - last_check > 5:
                    new_sink = default_sink()
                    last_check = now
                    if process and sink != new_sink:
                        close()
                    sink = new_sink
                if not process:
                    process = subprocess.Popen(capture_command(sink), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                    os.set_blocking(process.stdout.fileno(), False)
                    configuration = None
                    status('listening', 'Listening for bass peaks in desktop playback.')
                if configuration != config:
                    detector = BeatDetector(**{k: v for k, v in config.items() if k != 'enabled'})
                    configuration = config
                if process.poll() is not None:
                    raise RuntimeError('PipeWire playback capture stopped')
                readable, _, _ = select.select([process.stdout], [], [], .25)
                if not readable:
                    if now - last_report > 1:
                        publish({'status': 'listening', 'bpm': None, 'confidence': 0, 'playing': False})
                        last_report = now
                    continue
                data = os.read(process.stdout.fileno(), SAMPLES * 2 * 8)
                if not data:
                    raise RuntimeError('No data from playback monitor')
                pending += data
                if sample_clock is None or abs(sample_clock - time.monotonic()) > .3:
                    sample_clock = time.monotonic() - len(pending) / (2 * RATE)
                while len(pending) >= SAMPLES * 2:
                    pcm, pending = pending[:SAMPLES * 2], pending[SAMPLES * 2:]
                    sample_clock += SAMPLES / RATE
                    result = detector.process(struct.unpack('<' + 'h' * SAMPLES, pcm), sample_clock)
                    if result['beat'] or now - last_report >= .05:
                        publish({'status': 'listening', **result, 'timestamp': time.time() - max(0, time.monotonic() - sample_clock)})
                        last_report = now
            except (OSError, RuntimeError, ArithmeticError, ValueError, subprocess.SubprocessError) as exc:
                close()
                status('unavailable', f'Playback capture unavailable: {exc}. Using fallback tempo.')
                time.sleep(2)
    finally:
        close()
