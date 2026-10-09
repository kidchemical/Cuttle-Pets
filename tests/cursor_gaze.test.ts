import assert from 'node:assert/strict'
import { CursorActivity, applyGazeGain, cursorPayloadToClient, normalizeGazeGain, DEFAULT_GAZE_GAIN, MAX_GAZE_GAIN } from '../app/src/cursor-gaze'

// Gaze must follow the global cursor even where no DOM mousemove reaches the
// window (silhouette input regions / click-through). The Rust monitor reports
// cursor and window geometry in the same units, so normalize first.
const center = cursorPayloadToClient(
  { x: 960, y: 540, window_x: 0, window_y: 0, window_w: 1920, window_h: 1080 },
  1920,
  1080,
)
assert.deepEqual(center, { clientX: 960, clientY: 540 })

// Physical pixels from the monitor still map to CSS client pixels.
const scaled = cursorPayloadToClient(
  { x: 1920, y: 1080, window_x: 0, window_y: 0, window_w: 3840, window_h: 2160 },
  1920,
  1080,
)
assert.deepEqual(scaled, { clientX: 960, clientY: 540 })

// Offset fullscreen window.
const offset = cursorPayloadToClient(
  { x: 100, y: 200, window_x: 100, window_y: 100, window_w: 800, window_h: 600 },
  800,
  600,
)
assert.deepEqual(offset, { clientX: 0, clientY: 100 })

// Cursor outside the window stays out of range (gaze raycasts it, no clamping).
const outside = cursorPayloadToClient(
  { x: -100, y: 50, window_x: 0, window_y: 0, window_w: 800, window_h: 600 },
  800,
  600,
)
assert.equal(outside.clientX, -100)
assert.equal(outside.clientY, 50)

// Degenerate window geometry never divides by zero.
const degenerate = cursorPayloadToClient(
  { x: 10, y: 10, window_x: 0, window_y: 0, window_w: 0, window_h: 0 },
  800,
  600,
)
assert.deepEqual(degenerate, { clientX: 0, clientY: 0 })
// Gaze gain: offsets from view-center scale, the center itself is fixed.
assert.deepEqual(applyGazeGain({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }, 2), { x: 1, y: 2, z: 3 })
assert.deepEqual(applyGazeGain({ x: 2, y: 0, z: 3 }, { x: 0, y: 0, z: 3 }, 2), { x: 4, y: 0, z: 3 })
assert.deepEqual(applyGazeGain({ x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 }, 1), { x: 1, y: 1, z: 1 })
// Persisted gain is clamped to 0..MAX, garbage falls back to default.
assert.equal(normalizeGazeGain(2.5), 2.5)
assert.equal(normalizeGazeGain(99), MAX_GAZE_GAIN)
assert.equal(normalizeGazeGain(-1), 0)
assert.equal(normalizeGazeGain(undefined), DEFAULT_GAZE_GAIN)
assert.equal(normalizeGazeGain('junk'), DEFAULT_GAZE_GAIN)
console.log('Cursor gaze mapping checks passed.')

// Attention starts with movement, expires after three seconds, and resumes.
const activity = new CursorActivity()
activity.observe('native', 10, 20, 0)
assert.equal(activity.isActive(0), false)
activity.observe('native', 11, 20, 100)
assert.equal(activity.isActive(3099), true)
activity.observe('native', 11, 20, 3099)
assert.equal(activity.isActive(3100), false)
activity.observe('native', 11, 21, 3200)
assert.equal(activity.isActive(3200), true)
// DOM and native coordinates have separate baselines (DPI units can differ).
activity.observe('dom', 100, 200, 6200)
assert.equal(activity.isActive(6200), false)
activity.observe('dom', 101, 200, 6300)
assert.equal(activity.isActive(6300), true)
assert.equal(activity.isActive(10000), false)
