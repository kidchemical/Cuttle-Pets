/** Render quality for the pet viewport.
 *
 * Presets (low/mid/high/ultra) are just shortcuts that fill in every granular
 * control. Any granular change afterwards marks the setup 'custom' — unless the
 * values happen to match a preset exactly, in which case that preset shows as
 * active again.
 *
 * Pure module (no three.js / Tauri imports) so it can be unit-tested with plain node.
 */

/** Preset names. */
export type RenderQuality = 'low' | 'mid' | 'high' | 'ultra'

/** Active preset, or 'custom' when granular controls diverge from every preset. */
export type QualityPresetOrCustom = RenderQuality | 'custom'

export const RENDER_QUALITIES: RenderQuality[] = ['low', 'mid', 'high', 'ultra']

/** Granular controls. `maxFps: 0` = uncapped (render every animation frame). */
export interface QualityDetails {
  pixelRatioCap: number
  maxFps: number
  springBones: boolean
}

export const QUALITY_PRESETS: Record<RenderQuality, QualityDetails> = {
  low: { pixelRatioCap: 1, maxFps: 24, springBones: true },
  mid: { pixelRatioCap: 1.5, maxFps: 30, springBones: true },
  high: { pixelRatioCap: 2, maxFps: 60, springBones: true },
  ultra: { pixelRatioCap: 4, maxFps: 0, springBones: true },
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
    if (p.pixelRatioCap === details.pixelRatioCap && p.maxFps === details.maxFps && p.springBones === details.springBones) {
      return name
    }
  }
  return 'custom'
}

/** Accept a stored v1 preset string or a full settings object; always heal to valid settings. */
export function normalizeQualitySettings(value: unknown): QualitySettings {
  if (typeof value === 'string') return presetSettings(normalizeQuality(value))
  if (value && typeof value === 'object') {
    const v = value as Partial<QualityDetails>
    const pixelRatioCap = typeof v.pixelRatioCap === 'number' && v.pixelRatioCap > 0 ? v.pixelRatioCap : QUALITY_PRESETS.high.pixelRatioCap
    const maxFps = typeof v.maxFps === 'number' && v.maxFps >= 0 ? v.maxFps : QUALITY_PRESETS.high.maxFps
    const springBones = typeof v.springBones === 'boolean' ? v.springBones : true
    return { pixelRatioCap, maxFps, springBones, preset: resolvePreset({ pixelRatioCap, maxFps, springBones }) }
  }
  return presetSettings('high')
}
