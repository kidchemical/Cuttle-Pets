/** Global cursor position pushed by the Rust cursor monitor (all units match). */
export interface CursorPositionPayload {
  x: number
  y: number
  window_x: number
  window_y: number
  window_w: number
  window_h: number
}

/**
 * Convert a global cursor payload to window client pixels. The Rust monitor
 * reports cursor and window geometry in the same units (physical or CSS),
 * so normalize to 0..1 first, then scale to CSS pixels. Positions outside
 * the window stay out of range (callers raycast them as-is, unclamped).
 */
export function cursorPayloadToClient(
  p: CursorPositionPayload,
  innerWidth: number,
  innerHeight: number,
): { clientX: number; clientY: number } {
  const relX = p.window_w > 0 ? (p.x - p.window_x) / p.window_w : 0
  const relY = p.window_h > 0 ? (p.y - p.window_y) / p.window_h : 0
  return { clientX: relX * innerWidth, clientY: relY * innerHeight }
}

export interface Vec3Like {
  x: number
  y: number
  z: number
}

/**
 * Amplify a gaze target's offset from the view-center point. The raw
 * cursor ray hits a plane just in front of the camera, so small cursor
 * moves barely rotate the eyes; scaling the offset makes the gaze lively
 * while the VRM eye limits still cap the extremes. Gain of 1 is neutral.
 */
export const DEFAULT_GAZE_GAIN = 2
export const MAX_GAZE_GAIN = 4

/** Coerce a persisted gaze gain into the 0..MAX range; falls back to default. */
export function normalizeGazeGain(value: unknown): number {
  const v = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(v)) return DEFAULT_GAZE_GAIN
  return Math.min(MAX_GAZE_GAIN, Math.max(0, v))
}

export function applyGazeGain(target: Vec3Like, center: Vec3Like, gain: number): Vec3Like {
  return {
    x: center.x + (target.x - center.x) * gain,
    y: center.y + (target.y - center.y) * gain,
    z: center.z + (target.z - center.z) * gain,
  }
}
