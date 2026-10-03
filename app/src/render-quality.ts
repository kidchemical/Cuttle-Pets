/** Render quality for the pet viewport.
 *
 * Presets (low/mid/high/ultra) are just shortcuts that fill in every granular
 * control. Any granular change afterwards marks the setup 'custom' — unless the
 * values happen to match a preset exactly, in which case that preset shows as
 * active again.
 *
 * Quality never touches frame rate: the renderer always caps at
 * DEFAULT_MAX_FPS. Older saved settings may still carry a `maxFps` value;
 * it is accepted and ignored for backwards compatibility.
 *
 * Pure module (no three.js / Tauri imports) so it can be unit-tested with plain node.
 */

/** Preset names. */
export type RenderQuality = 'low' | 'mid' | 'high' | 'ultra'

/** Active preset, or 'custom' when granular controls diverge from every preset. */
export type QualityPresetOrCustom = RenderQuality | 'custom'

export const RENDER_QUALITIES: RenderQuality[] = ['low', 'mid', 'high', 'ultra']

/** Fixed frame-rate cap applied by the renderer regardless of quality. */
export const DEFAULT_MAX_FPS = 30

/** Granular controls. */
export interface QualityDetails {
  pixelRatioCap: number
  springBones: boolean
}

export const QUALITY_PRESETS: Record<RenderQuality, QualityDetails> = {
  low: { pixelRatioCap: 1, springBones: true },
  mid: { pixelRatioCap: 1.5, springBones: true },
  high: { pixelRatioCap: 2, springBones: true },
  ultra: { pixelRatioCap: 4, springBones: true },
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
 * A legacy `maxFps` field is ignored (quality never changes FPS). */
export function normalizeQualitySettings(value: unknown): QualitySettings {
  if (typeof value === 'string') return presetSettings(normalizeQuality(value))
  if (value && typeof value === 'object') {
    const v = value as Partial<QualityDetails>
    const pixelRatioCap = typeof v.pixelRatioCap === 'number' && v.pixelRatioCap > 0 ? v.pixelRatioCap : QUALITY_PRESETS.high.pixelRatioCap
    const springBones = typeof v.springBones === 'boolean' ? v.springBones : true
    return { pixelRatioCap, springBones, preset: resolvePreset({ pixelRatioCap, springBones }) }
  }
  return presetSettings('high')
}
