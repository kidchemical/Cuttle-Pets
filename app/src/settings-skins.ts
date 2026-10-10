/** Settings-window skins. Colors are consumed as CSS variables in settings.css
 * via the `data-settings-skin` attribute; all skins are static (no keyframe
 * animations) because a second animating webview competes with the pet
 * renderer for the GPU. */

export type SettingsSkinId = 'default' | 'midnight' | 'glitch' | 'matrix' | 'synthwave' | 'nord'

export interface SettingsSkin {
  id: SettingsSkinId
  /** English/Chinese labels. */
  label: string
  labelZh: string
  icon: string
  /** [accent, background] swatch shown in the picker. */
  swatch: [string, string]
}

export const SETTINGS_SKINS: SettingsSkin[] = [
  { id: 'default', label: 'Default', labelZh: '默认', icon: '🌙', swatch: ['#84b6ff', '#171c26'] },
  { id: 'midnight', label: 'Midnight', labelZh: '午夜', icon: '🌑', swatch: ['#8b5cf6', '#0f1117'] },
  { id: 'glitch', label: 'Glitch', labelZh: '故障', icon: '📺', swatch: ['#ff2a6d', '#0b0b10'] },
  { id: 'matrix', label: 'Matrix', labelZh: '矩阵', icon: '💾', swatch: ['#00ff41', '#000a02'] },
  { id: 'synthwave', label: 'Synthwave', labelZh: '合成波', icon: '🌆', swatch: ['#ff4fa3', '#140a24'] },
  { id: 'nord', label: 'Nordic', labelZh: '北欧', icon: '❄️', swatch: ['#88c0d0', '#2e3440'] },
]

export const DEFAULT_SETTINGS_SKIN: SettingsSkinId = 'default'

export function normalizeSettingsSkin(value: unknown): SettingsSkinId {
  return typeof value === 'string' && SETTINGS_SKINS.some((skin) => skin.id === value)
    ? value as SettingsSkinId
    : DEFAULT_SETTINGS_SKIN
}
