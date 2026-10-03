export interface AnimationOverride { speed: number; transition: number; hold: number }
export interface AnimationSettings { speed: number; overrides: Record<string, AnimationOverride> }
export const DEFAULT_ANIMATIONS: AnimationSettings = { speed: 1, overrides: {} }
export const DEFAULT_ANIMATION: AnimationOverride = { speed: 1, transition: .3, hold: 10 }
function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}
export function normalizeAnimations(value: unknown): AnimationSettings {
  const source = value && typeof value === 'object' ? value as Partial<AnimationSettings> : {}
  const overrides: Record<string, AnimationOverride> = {}
  if (source.overrides && typeof source.overrides === 'object') for (const [id, item] of Object.entries(source.overrides)) {
    if (!item || typeof item !== 'object') continue
    overrides[id] = { speed: bounded(item.speed, 1, .1, 4), transition: bounded(item.transition, .3, 0, 3), hold: bounded(item.hold, 10, 0, 60) }
  }
  return { speed: bounded(source.speed, 1, .1, 4), overrides }
}
export function animationOptions(settings: AnimationSettings, id: string): AnimationOverride {
  return settings.overrides[id] ?? DEFAULT_ANIMATION
}
export function animationSpeed(settings: AnimationSettings, id: string) {
  return settings.speed * animationOptions(settings, id).speed
}
export const proceduralAnimations = [
  { id: 'hands', label: 'Relaxed hands' }, { id: 'typing', label: 'Working / typing' },
  { id: 'sip', label: 'Coffee sip' }, { id: 'music', label: 'Music nod / sway' },
  { id: 'eyes', label: 'Eye movement' }, { id: 'blink', label: 'Blinking' }, { id: 'expressions', label: 'Expression transitions' },
]
