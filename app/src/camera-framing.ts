/** Camera framing helpers for the pet viewport.
 *
 * Pure module (three.js math only, no DOM / Tauri imports) so the framing
 * geometry can be unit-tested with plain node.
 *
 * Background: the default view frames the model from its bounding box
 * (pivot near neck height). A view snapshot taken before a model finishes
 * loading holds the pre-framing orbit defaults (pivot at the origin = feet,
 * radius 2m) — restoring that snapshot parks the camera at foot level and
 * shows legs-only with the head cut off. The scene therefore only snapshots
 * after framing has been applied, and only restores snapshots that pass
 * validation.
 */

/** Orbit-camera view: look-at pivot plus spherical orbit state. */
export interface CameraView {
  pivot: [number, number, number]
  radius: number
  theta: number
  phi: number
}

/** Default view framing a model of the given bounding-box size/center. */
export function defaultViewFromBounds(
  size: { x: number; y: number; z: number },
  center: { x: number; y: number; z: number },
  fovDeg = 40,
): CameraView {
  const radians = ((fovDeg / 2) * Math.PI) / 180
  const offsetX = size.x / 16
  const offsetY = size.y / 10
  const offsetZ = size.y / 4.2 / Math.tan(radians)
  return {
    pivot: [center.x, center.y + size.y / 3.2, center.z],
    radius: offsetZ,
    theta: Math.atan2(offsetX, offsetZ),
    phi: Math.PI / 2 - Math.atan2(offsetY, offsetZ),
  }
}

/** localStorage key carrying the view across pet restarts. */
export const CAMERA_STORAGE_KEY = 'cuttle-pet:camera-v1'

type Getter = Pick<Storage, 'getItem'>
type Setter = Pick<Storage, 'setItem'>

function defaultStorage(): (Getter & Setter) | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    // ignore — private mode etc.
  }
  return null
}

/** Last saved view, or null on first launch / corrupt payload / no storage. */
export function loadSavedCameraView(storage?: Getter | null): CameraView | null {
  const store = storage ?? defaultStorage()
  if (!store) return null
  try {
    const raw = store.getItem(CAMERA_STORAGE_KEY)
    if (!raw) return null
    const view: unknown = JSON.parse(raw)
    return isValidView(view) ? view : null
  } catch {
    return null
  }
}

/** Persist a view; never throws (quota etc. — the session ref still covers). */
export function saveCameraView(view: CameraView, storage?: Setter | null): void {
  const store = storage ?? defaultStorage()
  if (!store) return
  try {
    store.setItem(CAMERA_STORAGE_KEY, JSON.stringify(view))
  } catch {
    // ignore
  }
}

/** Whether a stored snapshot is safe to restore (finite numbers, sane orbit). */
export function isValidView(value: unknown): value is CameraView {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.pivot) || v.pivot.length !== 3) return false
  if (!v.pivot.every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  if (typeof v.radius !== 'number' || !Number.isFinite(v.radius) || v.radius <= 0 || v.radius > 50) return false
  if (typeof v.theta !== 'number' || !Number.isFinite(v.theta)) return false
  if (typeof v.phi !== 'number' || !Number.isFinite(v.phi) || v.phi <= 0 || v.phi >= Math.PI) return false
  return true
}
