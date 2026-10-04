"""Windows output loopback. SoundCard stays isolated from the shared DSP core."""
import time
import numpy as np

from bridge.beat_detector import RATE, SAMPLES


class MonoFrames:
    """48 kHz multichannel float PCM -> anti-aliased 8 kHz s16 frames.

    A causal windowed-sinc filter preserves its state across arbitrary chunks.
    Timestamping includes filter delay; chunk boundaries never change samples.
    """
    SOURCE_RATE = 48000
    DECIMATION = SOURCE_RATE // RATE

    def __init__(self):
        taps = 97
        x = np.arange(taps) - (taps - 1) / 2
        kernel = np.sinc(x / self.DECIMATION) * np.hamming(taps)
        self.kernel = kernel / kernel.sum()
        self.history = np.zeros(taps - 1)
        self.source_count = 0
        self.pending = np.empty(0)
        self.start = None
        self.output_count = 0
        self.delay = (taps - 1) / (2 * self.SOURCE_RATE)

    def feed(self, data, end_time):
        data = np.asarray(data, dtype=float)
        if data.ndim != 2 or not data.shape[1]:
            raise ValueError('Loopback capture must provide frames by channels')
        mono = np.nan_to_num(data.mean(axis=1))
        if not len(mono):
            return []
        if self.start is None:
            self.start = end_time - len(mono) / self.SOURCE_RATE
        extended = np.concatenate((self.history, mono))
        filtered = np.convolve(extended, self.kernel, mode='valid')
        self.history = extended[-len(self.history):].copy()
        first = (-self.source_count) % self.DECIMATION
        self.source_count += len(mono)
        self.pending = np.concatenate((self.pending, filtered[first::self.DECIMATION]))
        frames = []
        while len(self.pending) >= SAMPLES:
            pcm, self.pending = self.pending[:SAMPLES], self.pending[SAMPLES:]
            self.output_count += SAMPLES
            frames.append((np.rint(np.clip(pcm, -1, 32767 / 32768) * 32768).astype(np.int16),
                           self.start + self.output_count / RATE - self.delay))
        return frames


class WasapiCapture:
    def __init__(self):
        import soundcard as sc
        self.sc = sc
        speaker = sc.default_speaker()
        if speaker is None:
            raise RuntimeError('No default Windows playback device')
        self.device_id = speaker.id
        loopback = sc.get_microphone(id=speaker.id, include_loopback=True)
        if not loopback.isloopback:
            raise RuntimeError('Selected Windows device is not an output loopback')
        # SoundCard documents broken single-channel WASAPI capture. Open every
        # output channel, then downmix in our code rather than asking for mono.
        if loopback.channels < 2:
            raise RuntimeError('SoundCard loopback requires a multichannel playback device')
        self.context = loopback.recorder(samplerate=48000, channels=loopback.channels,
                                        blocksize=1920)
        self.recorder = self.context.__enter__()
        self.converter = MonoFrames()
        self.last_check = time.monotonic()

    def read(self):
        now = time.monotonic()
        if now - self.last_check > 5:
            self.last_check = now
            speaker = self.sc.default_speaker()
            if speaker is None or speaker.id != self.device_id:
                raise RuntimeError('Default Windows playback device changed')
        data = self.recorder.record(numframes=960)  # 20 ms, below capture block size.
        end = time.monotonic()
        if self.converter.start is not None:
            expected = self.converter.start + (self.converter.source_count + len(data)) / 48000
            if abs(expected - end) > .3:
                self.converter = MonoFrames()  # Discard history after a capture stall.
        return self.converter.feed(data, end)

    def close(self):
        self.context.__exit__(None, None, None)
