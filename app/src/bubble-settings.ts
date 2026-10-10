export type BubbleAlign = 'left' | 'center' | 'right'

/** Bubble chrome/effect preset. `glitch` borrows the Cuttle "Glitch" skin. */
export type BubbleStyle = 'default' | 'glitch'

export interface BubbleSettings {
  /** Visual style: the default subtitle look or the Cuttle "Glitch" skin. */
  bubbleStyle: BubbleStyle
  /** Size multiplier applied to the base bubble (width 50%, height 70px). */
  /** Reveal speed multiplier; 0 reveals text instantly. */
  textSpeed: number
  scale: number
  /** Distance from the bottom of the window, in px. */
  bottom: number
  /** Horizontal placement. */
  align: BubbleAlign
  /** CSS font-family for bubble text. */
  fontFamily: string
  /** Text size in px. */
  fontSize: number
  /** Text color as #rrggbb. */
  textColor: string
  /** Bubble background color as #rrggbb. */
  bubbleColor: string
  /** Bubble background opacity, 0–1. */
  bubbleAlpha: number
  /** Corner roundness in px. */
  borderRadius: number
  /** When false, the bubble chrome (background/border/shadow) is hidden. */
  bubbleEnabled: boolean
  /** When false, no text shadow is rendered (useful with bubble disabled). */
  textShadow: boolean
  /** Text shadow/glow color as #rrggbb. */
  textShadowColor: string
  /** Text shadow strength, 0–1 (alpha of the glow). */
  textShadowIntensity: number
  /** Blur radius of the glow layer in px. */
  textShadowBlur: number
  /** Perf: cap the length of long status/activity text shown in the bubble. */
  limitStatusText: boolean
  /** Perf: skip the bubble's backdrop blur (a repaint cost on some GPUs). */
  disableBubbleBlur: boolean
  /** Perf: skip the per-character pop-in animation. */
  disableCharAnimation: boolean
}

export const DEFAULT_FONT_FAMILY = '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'

export const FONT_CHOICES: { id: string; label: string }[] = [
  { id: DEFAULT_FONT_FAMILY, label: 'Default' },
  { id: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif', label: 'System UI' },
  { id: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif', label: 'CJK Sans' },
  { id: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { id: 'Georgia, "Times New Roman", serif', label: 'Serif' },
  { id: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif', label: 'Elegant Serif' },
  { id: '"Courier New", Courier, monospace', label: 'Monospace' },
  { id: '"Cascadia Code", "Cascadia Mono", "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace', label: 'Code' },
  { id: '"Nunito", "Quicksand", "Segoe UI", system-ui, sans-serif', label: 'Rounded' },
  { id: '"Arial Narrow", "Roboto Condensed", "Segoe UI", sans-serif', label: 'Condensed' },
  { id: '"Press Start 2P", "Courier New", monospace', label: 'Pixel' },
]

export const DEFAULT_BUBBLE_SETTINGS: BubbleSettings = {
  bubbleStyle: 'default',
  textSpeed: 1,
  scale: 1,
  bottom: 80,
  align: 'center',
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 12,
  textColor: '#ffffff',
  bubbleColor: '#000000',
  bubbleAlpha: 0.35,
  borderRadius: 12,
  bubbleEnabled: true,
  textShadow: true,
  textShadowColor: '#ffffff',
  textShadowIntensity: 0.5,
  textShadowBlur: 12,
  limitStatusText: false,
  disableBubbleBlur: false,
  disableCharAnimation: false,
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)

export function normalizeBubbleSettings(raw: unknown): BubbleSettings {
  const d = DEFAULT_BUBBLE_SETTINGS
  if (!raw || typeof raw !== 'object') return { ...d }
  const r = raw as Record<string, unknown>
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback
  return {
    bubbleStyle: r.bubbleStyle === 'glitch' ? 'glitch' : d.bubbleStyle,
    textSpeed: num(r.textSpeed, d.textSpeed, 0, 8),
    scale: num(r.scale, d.scale, 0.5, 2),
    bottom: num(r.bottom, d.bottom, 0, 400),
    align: r.align === 'left' || r.align === 'right' || r.align === 'center' ? r.align : d.align,
    fontFamily: typeof r.fontFamily === 'string' && r.fontFamily.length > 0 ? r.fontFamily : d.fontFamily,
    fontSize: num(r.fontSize, d.fontSize, 8, 28),
    textColor: isHexColor(r.textColor) ? r.textColor : d.textColor,
    bubbleColor: isHexColor(r.bubbleColor) ? r.bubbleColor : d.bubbleColor,
    bubbleAlpha: num(r.bubbleAlpha, d.bubbleAlpha, 0, 1),
    borderRadius: num(r.borderRadius, d.borderRadius, 0, 24),
    bubbleEnabled: typeof r.bubbleEnabled === 'boolean' ? r.bubbleEnabled : d.bubbleEnabled,
    textShadow: typeof r.textShadow === 'boolean' ? r.textShadow : d.textShadow,
    textShadowColor: isHexColor(r.textShadowColor) ? r.textShadowColor : d.textShadowColor,
    textShadowIntensity: num(r.textShadowIntensity, d.textShadowIntensity, 0, 1),
    textShadowBlur: num(r.textShadowBlur, d.textShadowBlur, 0, 30),
    limitStatusText: typeof r.limitStatusText === 'boolean' ? r.limitStatusText : d.limitStatusText,
    disableBubbleBlur: typeof r.disableBubbleBlur === 'boolean' ? r.disableBubbleBlur : d.disableBubbleBlur,
    disableCharAnimation: typeof r.disableCharAnimation === 'boolean' ? r.disableCharAnimation : d.disableCharAnimation,
  }
}

/** Convert #rrggbb + alpha to an rgba() CSS string. */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Cuttle "Glitch" skin accents, used for the chromatic split and border glow. */
export const GLITCH_ACCENT = '#ff2a6d'
export const GLITCH_ACCENT_2 = '#05b8c8'

/** Cuttle "Glitch" skin palette/effects applied when the Glitch style is picked. */
export const GLITCH_BUBBLE_PRESET: Partial<BubbleSettings> = {
  bubbleStyle: 'glitch',
  bubbleColor: '#0b0b10',
  bubbleAlpha: 0.72,
  textColor: '#eaeaf5',
  textShadow: false,
  borderRadius: 4,
}

/** Sample text shown in the bubble while display settings change. */
export const BUBBLE_PREVIEW_TEXT =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'
