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

/** Granular controls. */
export interface QualityDetails {
  pixelRatioCap: number
  maxFps: number
  springBones: boolean
}

export const QUALITY_PRESETS: Record<RenderQuality, QualityDetails> = {
  low: { pixelRatioCap: 1, springBones: true, maxFps: DEFAULT_MAX_FPS },
  mid: { pixelRatioCap: 1.5, springBones: true, maxFps: DEFAULT_MAX_FPS },
  high: { pixelRatioCap: 2, springBones: true, maxFps: DEFAULT_MAX_FPS },
  ultra: { pixelRatioCap: 4, springBones: true, maxFps: DEFAULT_MAX_FPS },
}

/** Backwards-compatible alias (v1 stored only the preset name). */
export const QUALITY_CONFIGS = QUALITY_PRESETS

/** Full quality state: granular values plus which preset (if any) they match. */
export interface QualitySettings extends QualityDetails {
  preset: QualityPresetOrCustom
}

export function presetSettings(preset: RenderQuality): QualitySettings {
  return { ...QUALITY_PRESETS[preset], preset }
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
    const springBones = typeof v.springBones === 'boolean' ? v.springBones : true
    return { pixelRatioCap, maxFps, springBones, preset: resolvePreset({ pixelRatioCap, maxFps, springBones }) }
  }
  return presetSettings('high')
}

/** Heal invalid caps while keeping 0 (uncapped) and custom caps. */
export function normalizeMaxFps(value: unknown): number {
  if (value === 0) return 0
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(Math.min(240, Math.max(15, value))) : DEFAULT_MAX_FPS
}
