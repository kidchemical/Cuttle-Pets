"""Repeatable, causal replay of local reference tracks; FFmpeg is test-only.

Run from the repo root:
  .venv/bin/python tests/benchmark_beats.py --label baseline
Optional --detector loads a saved implementation, --seconds limits exploration.
No track-specific tempo, filename, or ground truth reaches the detector.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_detector(path):
    spec = importlib.util.spec_from_file_location('bench_detector', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def decode(path, cache, executable=None):
    fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
    cached = cache / (fingerprint + '.npy')
    if cached.exists():
        return np.load(cached), fingerprint
    ffmpeg = executable or os.environ.get('CUTTLE_BENCH_FFMPEG') or shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('Install FFmpeg to decode the local benchmark MP3s')
    result = subprocess.run([ffmpeg, '-v', 'error', '-i', str(path), '-f', 's16le',
                             '-ac', '1', '-ar', '8000', '-'], capture_output=True)
    if result.returncode:
        raise RuntimeError('FFmpeg decoding failed. Use --ffmpeg with a build supporting MP3: ' + result.stderr.decode(errors='replace').strip())
    audio = np.frombuffer(result.stdout, dtype='<i2').copy()
    np.save(cached, audio)
    return audio, fingerprint


def summarize(rows, target):
    a = np.asarray(rows)
    # Fixed warm-up exclusion; silence remains in the timeline but only audible
    # playback is scored. Correct coverage penalizes abstention, not just errors.
    audible = (a[:, 0] >= 8) & (a[:, 5] > .0008)
    locked = audible & np.isfinite(a[:, 1])
    correct = locked & (np.abs(a[:, 1] - target) <= 2)
    candidate = audible & np.isfinite(a[:, 2])
    octave = locked & ((np.abs(a[:, 1] - target / 2) <= 2) | (np.abs(a[:, 1] - target * 2) <= 2))
    errors = np.abs(a[locked, 1] - target)
    n = max(1, int(audible.sum()))
    lock_times = a[np.isfinite(a[:, 1]), 0]
    correct_times = a[np.isfinite(a[:, 1]) & (np.abs(a[:, 1] - target) <= 2), 0]
    transitions = np.abs(np.diff(a[:, 1])) > 5
    return {
        'duration_seconds': round(float(a[-1, 0]), 2),
        'scored_seconds': round(int(audible.sum()) * .02, 2),
        'locked_pct': round(100 * int(locked.sum()) / n, 2),
        'correct_locked_pct': round(100 * int(correct.sum()) / n, 2),
        'wrong_locked_pct': round(100 * int((locked & ~correct).sum()) / n, 2),
        'octave_error_pct': round(100 * int(octave.sum()) / n, 2),
        'candidate_correct_pct': round(100 * int((candidate & (np.abs(a[:, 2] - target) <= 2)).sum()) / n, 2),
        'median_locked_error_bpm': round(float(np.median(errors)), 3) if len(errors) else None,
        'p95_locked_error_bpm': round(float(np.percentile(errors, 95)), 3) if len(errors) else None,
        'mean_confidence': round(float(np.mean(a[audible, 3])), 3) if audible.any() else 0,
        'first_lock_seconds': round(float(lock_times[0]), 2) if len(lock_times) else None,
        'first_correct_lock_seconds': round(float(correct_times[0]), 2) if len(correct_times) else None,
        'jumps_over_5_bpm': int(transitions.sum()),
        'lock_losses': int(np.count_nonzero(np.isfinite(a[:-1, 1]) & ~np.isfinite(a[1:, 1]))),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--label', required=True)
    parser.add_argument('--detector', type=Path, default=ROOT / 'bridge/beat_detector.py')
    parser.add_argument('--seconds', type=float)
    parser.add_argument('--ffmpeg', help='Path to an FFmpeg build with MP3 decoding')
    parser.add_argument('--sensitivity', type=float, default=1.5)
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--min-bpm', type=float, default=60)
    parser.add_argument('--max-bpm', type=float, default=200)
    parser.add_argument('--cutoff', type=float, default=200)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]+', args.label):
        parser.error('--label must contain only letters, numbers, underscores, or hyphens')
    if args.start < 0 or (args.seconds is not None and args.seconds <= 0):
        parser.error('--start must be nonnegative and --seconds positive')
    if not 40 <= args.min_bpm < args.max_bpm <= 240 or not 40 <= args.cutoff <= 200 or not 1.05 <= args.sensitivity <= 4:
        parser.error('Use valid Music settings bounds')
    out = ROOT / 'temp/beat-benchmarks'
    out.mkdir(parents=True, exist_ok=True)
    detector_module = load_detector(args.detector)
    report = {'label': args.label, 'source_sha256': hashlib.sha256(args.detector.read_bytes()).hexdigest(),
              'settings': {'min_bpm': args.min_bpm, 'max_bpm': args.max_bpm, 'cutoff': args.cutoff, 'sensitivity': args.sensitivity},
              'start_seconds': args.start, 'numpy_version': np.__version__,
              'protocol': 'Causal 8kHz mono s16; 160-sample frames; score audible frames after 8s; ±2 BPM tolerance.',
              'tracks': []}
    if 'from bridge.pulse_tracker import PulseTracker' in args.detector.read_text():
        report['pulse_tracker_sha256'] = hashlib.sha256((ROOT / 'bridge/pulse_tracker.py').read_bytes()).hexdigest()
    for path in sorted((ROOT / 'tests/benchmark refs').glob('*.mp3')):
        match = re.search(r'\[(\d+(?:\.\d+)?)bpm\]', path.name, re.I)
        if not match:
            continue
        target = float(match[1])
        audio, fingerprint = decode(path, out, args.ffmpeg)
        audio = audio[int(args.start * detector_module.RATE):]
        if args.seconds:
            audio = audio[:int(args.seconds * detector_module.RATE)]
        detector = detector_module.BeatDetector(**report['settings'])
        rows = []
        start = time.perf_counter()
        for index in range(0, len(audio) - detector_module.SAMPLES + 1, detector_module.SAMPLES):
            now = (index + detector_module.SAMPLES) / detector_module.RATE
            r = detector.process(audio[index:index + detector_module.SAMPLES], now)
            rows.append((now, r['bpm'] if r['bpm'] is not None else np.nan,
                         r.get('candidate_bpm') if r.get('candidate_bpm') is not None else np.nan,
                         r['confidence'], float(r['beat']), r['amplitude']))
        record = {'file': path.name, 'audio_sha256': fingerprint, 'target_bpm': target,
                  'compute_seconds': round(time.perf_counter() - start, 3), **summarize(rows, target)}
        np.save(out / f'{args.label}-{int(target)}-timeline.npy', np.asarray(rows))
        report['tracks'].append(record)
        print(json.dumps(record, ensure_ascii=False), flush=True)
    if not report['tracks']:
        parser.error('No MP3 references with [NNbpm] labels found in tests/benchmark refs/')
    (out / f'{args.label}.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
