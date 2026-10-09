/** Idle head-turn toward the cursor.
 *
 * The eyes already follow the mouse through VRM lookAt; this turns the head
 * bone slightly the same way while the pet is idle. Angles stay small
 * (glances, not stares) and NDC input is clamped so an off-window cursor
 * parks at the extreme instead of over-rotating.
 *
 * Pure module (no three.js imports) so it can be unit-tested with plain node.
 */

/** Head yaw at the cursor extremes, radians (~12.6 degrees). */
export const HEAD_TURN_MAX_YAW = 0.22
/** Head pitch at the cursor extremes, radians (~6.9 degrees). */
export const HEAD_TURN_MAX_PITCH = 0.12
/** Follow responsiveness per second; higher = snappier. */
export const HEAD_TURN_DAMP_SPEED = 6
/** Head-turn strength multiplier: 0 parks the head, 1 is the tuned glance. */
export const DEFAULT_HEAD_TURN_GAIN = 1
export const MAX_HEAD_TURN_GAIN = 2

/** Coerce a persisted head-turn gain into the 0..MAX range; falls back to default. */
export function normalizeHeadTurnGain(value: unknown): number {
  const v = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(v)) return DEFAULT_HEAD_TURN_GAIN
  return Math.min(MAX_HEAD_TURN_GAIN, Math.max(0, v))
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(-1, value))
}

/** Target head rotation for cursor NDC (-1..1, up positive).
 *
 * The avatar faces +Z, so turning toward the cursor's screen side is +Y
 * rotation and looking up is +X rotation on the head bone. Returns
 * `{ yaw, pitch }` in radians.
 */
export function headTurnTarget(ndcX: number, ndcY: number, gain = DEFAULT_HEAD_TURN_GAIN): { yaw: number; pitch: number } {
  const g = Number.isFinite(gain) ? Math.min(MAX_HEAD_TURN_GAIN, Math.max(0, gain)) : DEFAULT_HEAD_TURN_GAIN
  const yaw = clampUnit(ndcX) * HEAD_TURN_MAX_YAW * g
  const pitch = clampUnit(ndcY) * HEAD_TURN_MAX_PITCH * g
  // Normalize -0 so comparisons and serialization stay canonical.
  return { yaw: yaw + 0, pitch: pitch + 0 }
}

/** Ease the applied angle toward its target; frame-rate independent. */
export function dampAngle(current: number, target: number, delta: number, speed = HEAD_TURN_DAMP_SPEED): number {
  if (!(delta > 0)) return current
  return current + (target - current) * (1 - Math.exp(-delta * speed))
}
