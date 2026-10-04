import { actionPresets, dancePresets, type DancePreset } from './motion-controller'
import { proceduralAnimations } from './animation-settings'

// ── Behavior profiles ────────────────────────────────────────────────────────
// A profile describes what the pet does in each state: an entry sequence when
// the state starts, a sustaining base loop, occasional one-shots with a
// frequency + chance, and an exit sequence when the state ends.

export type BehaviorStateId = 'idle' | 'working' | 'music' | 'dancing'

export const BEHAVIOR_STATES: { id: BehaviorStateId; label: string; hint: string }[] = [
  { id: 'idle', label: 'Idle', hint: 'Hanging out, no task and no music.' },
  { id: 'working', label: 'Working', hint: 'Typing at the laptop (driven by Cuttle activity).' },
  { id: 'music', label: 'Music', hint: 'Music is playing and the pet is listening.' },
  { id: 'dancing', label: 'Dancing', hint: 'A dance is playing. Base is left alone so the dance is never interrupted.' },
]

export const EMOTION_OPTIONS = [
  'happy', 'sad', 'angry', 'surprised', 'think', 'awkward',
  'question', 'curious', 'neutral', 'love', 'flirty', 'greeting', 'relaxed',
]

/** Pseudo animation: pick a random one-shot action at play time. */
export const RANDOM_ACTION = 'random:action'
/** Pseudo emotion: pick a random emotion at play time. */
export const RANDOM_EMOTION = 'random'

const AMBIENT_IDS = new Set(['hands', 'eyes', 'blink', 'expressions'])

export interface BehaviorEntry {
  /** Animation id from the animations list ('idle', 'action:x', 'dance:x', 'typing', 'sip', 'music', …) or 'random:action'. */
  animation: string
  /** Emotion id, 'random', or '' for none. */
  emotion?: string
  /** Required to replay imported dances (carries the file URLs). */
  preset?: DancePreset
}

export interface OccasionalEntry extends BehaviorEntry {
  everyMin: number
  everyMax: number
  /** 0–1 probability each time the timer fires. */
  chance: number
}

export interface StateBehavior {
  start: BehaviorEntry[]
  /** Sustained loop; animation '' means "leave whatever is playing alone". */
  base: BehaviorEntry
  occasionals: OccasionalEntry[]
  end: BehaviorEntry[]
}

export interface BehaviorProfile {
  name: string
  states: Record<BehaviorStateId, StateBehavior>
}

export interface BehaviorSettings {
  enabled: boolean
  current: BehaviorProfile
  profiles: BehaviorProfile[]
}

export interface PetStatus {
  state: BehaviorStateId
  actionId: string | null
  danceId: string | null
  working: boolean
  sipping: boolean
}

// ── Normalization ────────────────────────────────────────────────────────────

function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function knownAnimation(id: string): boolean {
  if (!id || id === 'idle' || id === RANDOM_ACTION) return true
  if (id === 'typing' || id === 'sip' || id === 'music' || AMBIENT_IDS.has(id)) return true
  if (id.startsWith('dance:custom:')) return true
  if (id.startsWith('dance:')) return dancePresets[id.slice(6)] !== undefined
  if (id.startsWith('action:')) return actionPresets[id.slice(7)] !== undefined
  return false
}

function cleanEmotion(value: unknown): string {
  if (value === RANDOM_EMOTION) return RANDOM_EMOTION
  return typeof value === 'string' && EMOTION_OPTIONS.includes(value) ? value : ''
}

function cleanEntry(value: unknown): BehaviorEntry | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const animation = cleanId(item.animation)
  if (!knownAnimation(animation)) return null
  const entry: BehaviorEntry = { animation }
  const emotion = cleanEmotion(item.emotion)
  if (emotion) entry.emotion = emotion
  if (animation.startsWith('dance:custom:') && item.preset && typeof item.preset === 'object') {
    const preset = item.preset as Partial<DancePreset>
    if (typeof preset.url === 'string' && typeof preset.label === 'string') {
      entry.preset = { label: preset.label, type: 'vmd', url: preset.url, bgm: typeof preset.bgm === 'string' ? preset.bgm : undefined }
    }
  }
  return entry
}

function cleanOccasional(value: unknown): OccasionalEntry | null {
  const entry = cleanEntry(value)
  if (!entry) return null
  const item = value as Record<string, unknown>
  const everyMin = bounded(item.everyMin, 60, 5, 3600)
  return {
    ...entry,
    everyMin,
    everyMax: bounded(item.everyMax, Math.max(60, everyMin), everyMin, 3600),
    chance: bounded(item.chance, 1, 0, 1),
  }
}

function cleanState(value: unknown, fallbackBase: BehaviorEntry): StateBehavior {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const start = Array.isArray(source.start) ? source.start.map(cleanEntry).filter((e): e is BehaviorEntry => e !== null).slice(0, 5) : []
  const occasionals = Array.isArray(source.occasionals) ? source.occasionals.map(cleanOccasional).filter((e): e is OccasionalEntry => e !== null).slice(0, 8) : []
  const end = Array.isArray(source.end) ? source.end.map(cleanEntry).filter((e): e is BehaviorEntry => e !== null).slice(0, 5) : []
  // Accept a bare id string for hand-written profiles ("base": "typing").
  const baseSource = typeof source.base === 'string' ? { animation: source.base } : source.base
  const base = cleanEntry(baseSource) ?? { ...fallbackBase }
  return { start, base, occasionals, end }
}

export function normalizeProfile(value: unknown, fallbackName: string): BehaviorProfile {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const states = source.states && typeof source.states === 'object' ? source.states as Record<string, unknown> : {}
  const fallback = defaultProfileStates()
  const out = {} as Record<BehaviorStateId, StateBehavior>
  // A missing state restores the full default (base + occasionals), not an
  // empty shell — otherwise a fresh install would lose the built-in behavior.
  for (const { id } of BEHAVIOR_STATES) out[id] = cleanState(states[id] ?? fallback[id], fallback[id].base)
  const name = cleanId(source.name).slice(0, 60)
  return { name: name || fallbackName, states: out }
}

function defaultProfileStates(): Record<BehaviorStateId, StateBehavior> {
  return {
    idle: {
      start: [],
      base: { animation: 'idle' },
      occasionals: [{ animation: RANDOM_ACTION, emotion: RANDOM_EMOTION, everyMin: 45, everyMax: 75, chance: 0.5 }],
      end: [],
    },
    working: {
      start: [],
      base: { animation: 'typing' },
      occasionals: [{ animation: 'sip', everyMin: 40, everyMax: 90, chance: 1 }],
      end: [],
    },
    music: { start: [], base: { animation: 'music' }, occasionals: [], end: [] },
    dancing: { start: [], base: { animation: '' }, occasionals: [], end: [] },
  }
}

export function defaultBehaviorProfile(): BehaviorProfile {
  return { name: 'Default', states: defaultProfileStates() }
}

export function normalizeBehaviorSettings(value: unknown): BehaviorSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const profiles = Array.isArray(source.profiles)
    ? source.profiles.map((p, i) => normalizeProfile(p, `Profile ${i + 1}`)).slice(0, 20)
    : []
  return {
    enabled: source.enabled !== false,
    current: normalizeProfile(source.current, 'Default'),
    profiles,
  }
}

// ── State resolution ─────────────────────────────────────────────────────────

export function resolvePetState(flags: { dancing: boolean; working: boolean; music: boolean }): BehaviorStateId {
  if (flags.dancing) return 'dancing'
  if (flags.working) return 'working'
  if (flags.music) return 'music'
  return 'idle'
}

// ── Animation catalog + labels (shared by the animations list and editor) ───

export interface AnimationOption {
  id: string
  label: string
  group: string
  procedural: boolean
  preset?: DancePreset
}

export function animationCatalog(customDances: { id: string; label: string; vmdUrl: string; bgmUrl?: string }[]): AnimationOption[] {
  return [
    { id: 'idle', label: 'Idle loop', group: 'Idle', procedural: false },
    ...Object.entries(actionPresets).map(([id, preset]) => ({ id: `action:${id}`, label: preset.label, group: 'Actions', procedural: false as const })),
    ...Object.entries(dancePresets).map(([id, preset]) => ({ id: `dance:${id}`, label: preset.label, group: 'Dances', procedural: false as const })),
    ...customDances.map(dance => ({ id: `dance:custom:${dance.id}`, label: dance.label, group: 'Imported dances', procedural: false as const, preset: { label: dance.label, type: 'vmd' as const, url: dance.vmdUrl, bgm: dance.bgmUrl } })),
    { id: RANDOM_ACTION, label: 'Surprise me (random action)', group: 'Actions', procedural: false },
    ...proceduralAnimations.map(item => ({ ...item, group: 'Procedural', procedural: true as const })),
  ]
}

export function animationLabel(id: string | null, customDances: { id: string; label: string }[] = []): string {
  if (!id) return ''
  if (id === 'idle') return 'Idle loop'
  if (id === RANDOM_ACTION) return 'Surprise action'
  if (id === 'typing') return 'Working / typing'
  if (id === 'sip') return 'Coffee sip'
  if (id === 'music') return 'Music nod / sway'
  if (id.startsWith('action:')) return actionPresets[id.slice(7)]?.label ?? id
  if (id.startsWith('dance:custom:')) return customDances.find(d => `dance:custom:${d.id}` === id)?.label ?? id
  if (id.startsWith('dance:')) return dancePresets[id.slice(6)]?.label ?? id
  const procedural = proceduralAnimations.find(p => p.id === id)
  return procedural?.label ?? id
}

/** One-line "Working — typing · sipping coffee" summary for the settings banner. */
export function describeStatus(status: PetStatus, customDances: { id: string; label: string }[] = []): string {
  const stateLabel = { idle: 'Idle', working: 'Working', music: 'Listening to music', dancing: 'Dancing' }[status.state]
  const bits: string[] = []
  if (status.danceId) bits.push(animationLabel(status.danceId, customDances))
  else if (status.actionId && status.actionId !== 'idle') bits.push(animationLabel(status.actionId, customDances))
  if (status.working) bits.push(status.sipping ? 'typing · sipping coffee' : 'typing')
  return bits.length ? `${stateLabel} — ${bits.join(' · ')}` : stateLabel
}

// ── Scene playback mapping ───────────────────────────────────────────────────
// Structural scene interface (a subset of VRMSceneHandle) so the settings
// preview path and the behavior engine share one mapping.

export interface BehaviorScene {
  resetPose(): void
  setWorking(active: boolean, durationMs?: number): void
  requestCoffeeSip(): void
  startSipLoop(): void
  setMusicPreview(active: boolean, durationMs?: number): void
  pulseProcedural(id: string, loop: boolean): void
  playAnimationOnce(name: string): void
  playActionLoop(name: string): void
  playDance(nameOrPreset: string | DancePreset, preferenceKey?: string): void
  playDanceOnce(nameOrPreset: string | DancePreset, preferenceKey?: string): void
  setEmotionWithReset(emotion: string, durationMs: number, intensity?: number): void
  isBusy(): boolean
}

export function pickRandomAction(rand: () => number = Math.random): string {
  const ids = Object.keys(actionPresets)
  return ids.length ? ids[Math.floor(rand() * ids.length) % ids.length] : 'greeting'
}

export function pickRandomEmotion(rand: () => number = Math.random): string {
  return EMOTION_OPTIONS[Math.floor(rand() * EMOTION_OPTIONS.length) % EMOTION_OPTIONS.length]
}

export function applyEmotion(scene: BehaviorScene, emotion: string | undefined, rand: () => number = Math.random) {
  if (!emotion) return
  scene.setEmotionWithReset(emotion === RANDOM_EMOTION ? pickRandomEmotion(rand) : emotion, 4000, 0.6)
}

/** Play an animation a single time (settings preview, engine sequences). */
export function playOnceById(scene: BehaviorScene, id: string, preset?: DancePreset, previewMs = 0) {
  if (!id || id === 'idle') { scene.resetPose(); return }
  if (id === RANDOM_ACTION) { scene.playAnimationOnce(pickRandomAction()); return }
  if (id === 'typing') { scene.setWorking(true, previewMs); return }
  if (id === 'sip') { scene.setWorking(true); scene.requestCoffeeSip(); return }
  if (id === 'music') { scene.setMusicPreview(true, previewMs); return }
  if (AMBIENT_IDS.has(id)) { scene.pulseProcedural(id, false); return }
  if (id.startsWith('action:')) { scene.playAnimationOnce(id.slice(7)); return }
  if (id.startsWith('dance:')) { scene.playDanceOnce(preset ?? id.slice(6), id); return }
  scene.resetPose()
}

/** Sustain an animation until stopped (engine state base, looped preview). */
export function applyBaseById(scene: BehaviorScene, id: string, preset?: DancePreset) {
  if (!id) return
  if (id === 'idle') { scene.resetPose(); return }
  if (id === RANDOM_ACTION) { scene.playActionLoop(pickRandomAction()); return }
  if (id === 'typing') { scene.setWorking(true); return }
  if (id === 'sip') { scene.startSipLoop(); return }
  if (id === 'music') { scene.setMusicPreview(true); return }
  if (AMBIENT_IDS.has(id)) { scene.pulseProcedural(id, true); return }
  if (id.startsWith('action:')) { scene.playActionLoop(id.slice(7)); return }
  if (id.startsWith('dance:')) { scene.playDance(preset ?? id.slice(6), id); return }
  scene.resetPose()
}
