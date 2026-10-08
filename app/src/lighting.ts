/** Stage + cursor lighting settings.
 *
 * Global lighting mirrors the three static lights created in VRMScene
 * (ambient wash, key directional, fill directional) so the defaults below
 * reproduce the current look exactly. The cursor light is one extra dynamic
 * light that tracks the mouse cursor: either a point light (glow around the
 * cursor) or a spotlight (beam from the cursor onto the pet).
 *
 * Pure module (no three.js imports) so it can be unit-tested with plain node.
 */

/** Which geometry the cursor light uses. */
export type CursorLightKind = 'point' | 'spot'

/** Hard snaps to the cursor; soft eases toward it each frame. */
export type CursorLightAnchor = 'hard' | 'soft'

/** Extra movement applied around the cursor anchor. */
export type CursorLightMotion = 'still' | 'bob' | 'orbit' | 'swirl' | 'fireflies'

/** Named starting points for the cursor light; 'custom' once tweaked. */
export type CursorLightPreset =
  | 'white'
  | 'soft'
  | 'colored'
  | 'rgb'
  | 'flame'
  | 'lightning'
  | 'fireflies'

/** How many individual lights the cursor rig can hold. */
export const MAX_CURSOR_LIGHTS = 6

export interface GlobalLightingSettings {
  ambientColor: string
  ambientIntensity: number
  keyColor: string
  keyIntensity: number
  fillColor: string
  fillIntensity: number
}

export interface CursorLightSettings {
  enabled: boolean
  kind: CursorLightKind
  anchor: CursorLightAnchor
  /** Soft-anchor follow speed (per second); higher = snappier. */
  followSpeed: number
  preset: CursorLightPreset
  color: string
  intensity: number
  /** Point/spot range in world units (0 = infinite). */
  distance: number
  /** Point/spot falloff. */
  decay: number
  /** Spotlight cone angle in degrees. */
  angle: number
  /** Spotlight edge softness (0–1). */
  penumbra: number
  /** Animation rate for rgb/flame/lightning effects (cycles per second-ish). */
  effectSpeed: number
  /** Extra movement around the cursor anchor. */
  motion: CursorLightMotion
  /** How many lights the rig uses (1–6); extras spread hue phase on rgb. */
  lightCount: number
  /** Orbit/swirl radius and bob amplitude in world units. */
  motionRadius: number
  /** Motion cycles per second-ish. */
  motionSpeed: number
  /** Visible glow orb diameter in world units (0 = no orb, light only). */
  glowSize: number
}

export const CURSOR_LIGHT_MOTIONS: CursorLightMotion[] = [
  'still',
  'bob',
  'orbit',
  'swirl',
  'fireflies',
]

export const DEFAULT_GLOBAL_LIGHTING: GlobalLightingSettings = {
  ambientColor: '#ffffff',
  ambientIntensity: 0.6,
  keyColor: '#ffffff',
  keyIntensity: 1.2,
  fillColor: '#ffffff',
  fillIntensity: 0.4,
}

export const DEFAULT_CURSOR_LIGHT: CursorLightSettings = {
  enabled: false,
  kind: 'point',
  anchor: 'soft',
  followSpeed: 8,
  preset: 'white',
  color: '#ffffff',
  intensity: 2,
  distance: 0,
  decay: 2,
  angle: 30,
  penumbra: 0.5,
  effectSpeed: 1,
  motion: 'still',
  lightCount: 1,
  motionRadius: 0.35,
  motionSpeed: 1,
  glowSize: 0,
}

/** Preset starting points (partial: preset name + the values it owns). */
export const CURSOR_LIGHT_PRESETS: Record<CursorLightPreset, Partial<CursorLightSettings>> = {
  white: { kind: 'point', motion: 'still', lightCount: 1, motionRadius: 0.35, motionSpeed: 1, glowSize: 0, color: '#ffffff', intensity: 2, distance: 0, effectSpeed: 1 },
  soft: { kind: 'point', motion: 'still', lightCount: 1, motionRadius: 0.35, motionSpeed: 1, glowSize: 0, color: '#ffd9a0', intensity: 1.2, distance: 4, effectSpeed: 1 },
  colored: { kind: 'point', motion: 'still', lightCount: 1, motionRadius: 0.35, motionSpeed: 1, glowSize: 0, color: '#66aaff', intensity: 2, distance: 0, effectSpeed: 1 },
  rgb: { kind: 'point', motion: 'orbit', lightCount: 3, motionRadius: 0.35, motionSpeed: 1, glowSize: 0, color: '#ff0000', intensity: 2, distance: 0, effectSpeed: 0.4 },
  flame: { kind: 'point', motion: 'bob', lightCount: 1, motionRadius: 0.12, motionSpeed: 1, glowSize: 0, color: '#ff7a1a', intensity: 2.2, distance: 5, effectSpeed: 1 },
  lightning: { kind: 'spot', motion: 'still', lightCount: 1, motionRadius: 0.35, motionSpeed: 1, glowSize: 0, color: '#cfe6ff', intensity: 6, distance: 0, angle: 25, effectSpeed: 1 },
  fireflies: { kind: 'point', motion: 'fireflies', lightCount: 5, motionRadius: 0.6, motionSpeed: 1, glowSize: 0, color: '#d8ff8a', intensity: 1.5, distance: 3, effectSpeed: 1 },
}

export const CURSOR_LIGHT_PRESET_IDS: CursorLightPreset[] = [
  'white',
  'soft',
  'colored',
  'rgb',
  'flame',
  'lightning',
  'fireflies',
]

function num(value: unknown, fallback: number, min: number, max: number): number {
  const v = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

function color(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return value
  return fallback
}

/** World-space offset of rig light `index` around the cursor anchor at time `t`.
 *
 * Pure function of (motion, index, count, radius, speed, elapsed) so motion
 * shape and per-light phase spread are unit-testable without three.js.
 */
export function cursorLightOffset(
  motion: CursorLightMotion,
  index: number,
  count: number,
  radius: number,
  speed: number,
  elapsed: number,
): [number, number, number] {
  const t = elapsed
  const phase = (index / Math.max(1, count)) * Math.PI * 2
  switch (motion) {
    case 'bob':
      return [0, Math.sin(t * 2 * speed + phase) * radius, 0]
    case 'orbit': {
      const a = t * 2 * speed + phase
      return [Math.cos(a) * radius, Math.sin(t * 1.3 * speed + phase) * radius * 0.25, Math.sin(a) * radius]
    }
    case 'swirl': {
      const a = t * 2.2 * speed + phase
      const rr = radius * (0.6 + 0.4 * Math.sin(t * 0.9 * speed + phase))
      return [Math.cos(a) * rr, Math.sin(t * 2 * speed + phase * 2) * radius * 0.7, Math.sin(a) * rr]
    }
    case 'fireflies': {
      const seed = index * 12.9898
      return [
        (Math.sin(t * 0.9 * speed + seed) * 0.6 + Math.sin(t * 1.7 * speed + seed * 1.7) * 0.4) * radius,
        (Math.sin(t * 1.1 * speed + seed * 2.3) * 0.6 + Math.sin(t * 2.1 * speed + seed * 0.6) * 0.4) * radius * 0.7,
        (Math.sin(t * 0.7 * speed + seed * 1.3) * 0.6 + Math.sin(t * 1.3 * speed + seed * 2.1) * 0.4) * radius,
      ]
    }
    case 'still':
    default:
      return [0, 0, 0]
  }
}

/** Firefly blink multiplier (0.35–1): each rig light pulses out of phase. */
export function fireflyBlink(elapsed: number, speed: number, index: number): number {
  const k = 0.5 + 0.5 * Math.sin(elapsed * (1.5 + speed) + index * 2.4)
  return 0.35 + 0.65 * k * k
}

/** Apply a named preset on top of the current cursor-light settings. */
export function applyCursorLightPreset(
  current: CursorLightSettings,
  preset: CursorLightPreset,
): CursorLightSettings {
  return normalizeCursorLight({ ...current, ...CURSOR_LIGHT_PRESETS[preset], preset })
}

/** Heal any stored/foreign value into valid global lighting settings. */
export function normalizeGlobalLighting(value: unknown): GlobalLightingSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<GlobalLightingSettings>
  return {
    ambientColor: color(v.ambientColor, DEFAULT_GLOBAL_LIGHTING.ambientColor),
    ambientIntensity: num(v.ambientIntensity, DEFAULT_GLOBAL_LIGHTING.ambientIntensity, 0, 3),
    keyColor: color(v.keyColor, DEFAULT_GLOBAL_LIGHTING.keyColor),
    keyIntensity: num(v.keyIntensity, DEFAULT_GLOBAL_LIGHTING.keyIntensity, 0, 5),
    fillColor: color(v.fillColor, DEFAULT_GLOBAL_LIGHTING.fillColor),
    fillIntensity: num(v.fillIntensity, DEFAULT_GLOBAL_LIGHTING.fillIntensity, 0, 5),
  }
}

/** Heal any stored/foreign value into valid cursor-light settings. */
export function normalizeCursorLight(value: unknown): CursorLightSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<CursorLightSettings>
  const kind: CursorLightKind = v.kind === 'spot' ? 'spot' : 'point'
  const anchor: CursorLightAnchor = v.anchor === 'hard' ? 'hard' : 'soft'
  const preset: CursorLightPreset = CURSOR_LIGHT_PRESET_IDS.includes(v.preset as CursorLightPreset)
    ? (v.preset as CursorLightPreset)
    : 'white'
  const motion: CursorLightMotion = CURSOR_LIGHT_MOTIONS.includes(v.motion as CursorLightMotion)
    ? (v.motion as CursorLightMotion)
    : 'still'
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_CURSOR_LIGHT.enabled,
    kind,
    anchor,
    followSpeed: num(v.followSpeed, DEFAULT_CURSOR_LIGHT.followSpeed, 1, 30),
    preset,
    color: color(v.color, DEFAULT_CURSOR_LIGHT.color),
    intensity: num(v.intensity, DEFAULT_CURSOR_LIGHT.intensity, 0, 20),
    distance: num(v.distance, DEFAULT_CURSOR_LIGHT.distance, 0, 20),
    decay: num(v.decay, DEFAULT_CURSOR_LIGHT.decay, 0, 4),
    angle: num(v.angle, DEFAULT_CURSOR_LIGHT.angle, 5, 90),
    penumbra: num(v.penumbra, DEFAULT_CURSOR_LIGHT.penumbra, 0, 1),
    effectSpeed: num(v.effectSpeed, DEFAULT_CURSOR_LIGHT.effectSpeed, 0.1, 5),
    motion,
    lightCount: Math.round(num(v.lightCount, DEFAULT_CURSOR_LIGHT.lightCount, 1, MAX_CURSOR_LIGHTS)),
    motionRadius: num(v.motionRadius, DEFAULT_CURSOR_LIGHT.motionRadius, 0, 1.5),
    motionSpeed: num(v.motionSpeed, DEFAULT_CURSOR_LIGHT.motionSpeed, 0.1, 5),
    glowSize: num(v.glowSize, DEFAULT_CURSOR_LIGHT.glowSize, 0, 0.6),
  }
}
