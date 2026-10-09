/** Render quality for the pet viewport.
 *
 * Presets (low/mid/high/ultra) are just shortcuts that fill in every granular
 * control. Any granular change afterwards marks the setup 'custom' — unless the
 * values happen to match a preset exactly, in which case that preset shows as
 * active again.
 *
 * Frame rate is independent of visual presets and persists with granular settings.
 * maxFps: 0 means render every animation frame (display refresh rate).
 *
 * Pure module (no three.js / Tauri imports) so it can be unit-tested with plain node.
 */

/** Preset names. */
export type RenderQuality = 'low' | 'mid' | 'high' | 'ultra'

/** Active preset, or 'custom' when granular controls diverge from every preset. */
export type QualityPresetOrCustom = RenderQuality | 'custom'

export const RENDER_QUALITIES: RenderQuality[] = ['low', 'mid', 'high', 'ultra']

/** Default frame-rate cap for settings without an explicit choice. */
export const DEFAULT_MAX_FPS = 30

/** Idle cap default; 0 keeps rendering at maxFps while idle. */
export const DEFAULT_IDLE_FPS = 0
/** Foreground settings gets headroom during resize; expires without a timer. */
export const SETTINGS_RESIZE_RECOVERY_MS = 250

/** Granular controls. */
export interface QualityDetails {
  pixelRatioCap: number
  maxFps: number
  /** Cap while nothing is moving the pet (no cursor, gestures, speech, or motion); 0 = maxFps. */
  idleFps: number
  springBones: boolean
}

export const QUALITY_PRESETS: Record<RenderQuality, QualityDetails> = {
  low: { pixelRatioCap: 1, springBones: true, maxFps: DEFAULT_MAX_FPS, idleFps: DEFAULT_IDLE_FPS },
  mid: { pixelRatioCap: 1.5, springBones: true, maxFps: DEFAULT_MAX_FPS, idleFps: DEFAULT_IDLE_FPS },
  high: { pixelRatioCap: 2, springBones: true, maxFps: DEFAULT_MAX_FPS, idleFps: DEFAULT_IDLE_FPS },
  ultra: { pixelRatioCap: 4, springBones: true, maxFps: DEFAULT_MAX_FPS, idleFps: DEFAULT_IDLE_FPS },
}

/** Backwards-compatible alias (v1 stored only the preset name). */
export const QUALITY_CONFIGS = QUALITY_PRESETS

/** Full quality state: granular values plus which preset (if any) they match. */
export interface QualitySettings extends QualityDetails {
  preset: QualityPresetOrCustom
  /** Draw a frame-rate counter in the pet window. */
  showFps: boolean
  fpsPosition: FpsPosition
}

export type FpsPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export const FPS_POSITIONS: FpsPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

/** Switch the visual preset, keeping frame-rate and diagnostic choices. */
export function applyPreset(current: QualitySettings, preset: RenderQuality): QualitySettings {
  const { pixelRatioCap, springBones } = QUALITY_PRESETS[preset]
  return { ...current, pixelRatioCap, springBones, preset }
}

export function presetSettings(preset: RenderQuality): QualitySettings {
  return { ...QUALITY_PRESETS[preset], preset, showFps: false, fpsPosition: 'top-left' }
}

export function normalizeQuality(value: unknown): RenderQuality {
  return RENDER_QUALITIES.includes(value as RenderQuality) ? (value as RenderQuality) : 'high'
}

/** Which preset the details match, or 'custom'. */
export function resolvePreset(details: QualityDetails): QualityPresetOrCustom {
  for (const name of RENDER_QUALITIES) {
    const p = QUALITY_PRESETS[name]
    if (p.pixelRatioCap === details.pixelRatioCap && p.springBones === details.springBones) {
      return name
    }
  }
  return 'custom'
}

/** Accept a stored v1 preset string or a full settings object; always heal to valid settings.
 * Legacy maxFps values are preserved. */
export function normalizeQualitySettings(value: unknown): QualitySettings {
  if (typeof value === 'string') return presetSettings(normalizeQuality(value))
  if (value && typeof value === 'object') {
    const v = value as Partial<QualityDetails>
    const pixelRatioCap = typeof v.pixelRatioCap === 'number' && v.pixelRatioCap > 0 ? v.pixelRatioCap : QUALITY_PRESETS.high.pixelRatioCap
    const maxFps = normalizeMaxFps(v.maxFps)
    const idleFps = normalizeIdleFps(v.idleFps)
    const springBones = typeof v.springBones === 'boolean' ? v.springBones : true
    const extras = value as Partial<QualitySettings>
    return { pixelRatioCap, maxFps, idleFps, springBones, preset: resolvePreset({ pixelRatioCap, maxFps, idleFps, springBones }),
      showFps: extras.showFps === true,
      fpsPosition: FPS_POSITIONS.includes(extras.fpsPosition as FpsPosition) ? extras.fpsPosition as FpsPosition : 'top-left' }
  }
  return presetSettings('high')
}

/** Heal invalid caps while keeping 0 (uncapped) and custom caps. */
export function normalizeMaxFps(value: unknown): number {
  if (value === 0) return 0
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(Math.min(240, Math.max(15, value))) : DEFAULT_MAX_FPS
}

/** Heal invalid idle caps; 0 (off) and 5–240 are valid. */
export function normalizeIdleFps(value: unknown): number {
  if (value === 0) return 0
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(Math.min(240, Math.max(5, value))) : DEFAULT_IDLE_FPS
}

/** Frame cap for this frame: the idle cap applies only when idle and never raises the max. */
export function frameCap(details: Pick<QualityDetails, 'maxFps' | 'idleFps'>, idle: boolean, settingsResizing = false): number {
  const cap = !idle || details.idleFps <= 0 ? details.maxFps
    : details.maxFps === 0 ? details.idleFps : Math.min(details.maxFps, details.idleFps)
  return settingsResizing ? cap === 0 ? 30 : Math.min(cap, 30) : cap
}
