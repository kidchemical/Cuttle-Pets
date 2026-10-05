import { actionPresets, dancePresets, localizedPresetLabel, type DancePreset } from './motion-controller'
import type { CustomMotionType } from './custom-dances'
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
  { id: 'dancing', label: 'Dancing', hint: 'Plays a weighted Main pick. When called by another behavior, plays Start → one Main → End, then returns.' },
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

export function behaviorTarget(id: string): BehaviorStateId | null {
  return BEHAVIOR_STATES.find(state => `behavior:${state.id}` === id)?.id ?? null
}

export interface BehaviorEntryLocation {
  state: BehaviorStateId
  phase: 'start' | 'mains' | 'occasionals' | 'end'
  index: number
}

export interface BehaviorEntry {
  /** Animation id, 'random:action', or a 'behavior:idle/working/music/dancing' reference. */
  animation: string
  /** Hold time for one-shot procedural animations (default 5 seconds). */
  durationMs?: number
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

export interface WeightedEntry extends BehaviorEntry {
  /** Relative pick chance each time the state needs its sustaining loop. */
  weight: number
}

export interface StateBehavior {
  start: BehaviorEntry[]
  /** Sustained loop; animation '' means "leave whatever is playing alone". */
  base: BehaviorEntry
  /**
   * Weighted rotation for the sustaining loop. When non-empty, entering the
   * state plays a weighted pick instead of `base`. Empty means `base` (or
   * leave-as-is when `base` is also empty, as with dancing).
   */
  mains: WeightedEntry[]
  occasionals: OccasionalEntry[]
  end: BehaviorEntry[]
}

export interface BehaviorProfile {
  name: string
  states: Record<BehaviorStateId, StateBehavior>
}

export interface ReactionParam {
  /** Template variable name, [a-z0-9_], referenced as {{name}} in say text. */
  name: string
  type: 'string' | 'number' | 'boolean'
  default: string | number | boolean
  description: string
}

export interface ReactionStepProps {
  /** Show the laptop + typing pose for this step. */
  working?: boolean
  /** Play the coffee-sip one-shot on this step. */
  sip?: boolean
}

export interface ReactionStep {
  /** Animation id from the animations catalog ('idle', 'action:x', 'dance:x', 'typing', 'sip', 'music', …) or 'random:action'. */
  animation: string
  /** Emotion id, 'random', or '' for none. */
  emotion?: string
  /** Optional speech-bubble text; may use {{param}} templates. */
  say?: string
  /** How long this step holds before the next one (ms). */
  durationMs: number
  /** Required to replay imported dances (carries the file URLs). */
  preset?: DancePreset
  props?: ReactionStepProps
}

/**
 * An agent-callable one-shot reaction: a named animation/speech sequence with
 * typed parameters. Unlike the four persistent states (idle/working/music/
 * dancing), a reaction plays once and the pet returns to whatever state it
 * was in — e.g. "rocket-launch" or "hat-dance".
 */
export interface CustomReaction {
  /** Stable slug used by the API/CLI: [a-z0-9-_], e.g. "rocket-launch". */
  id: string
  name: string
  /** Shown to agents browsing the catalog so they know when to call it. */
  description: string
  params: ReactionParam[]
  steps: ReactionStep[]
}

export interface BehaviorSettings {
  /** v2 moves legacy music scheduling into the behavior profile. */
  version: 2
  enabled: boolean
  current: BehaviorProfile
  profiles: BehaviorProfile[]
  reactions: CustomReaction[]
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
  if (!knownAnimation(animation) && !behaviorTarget(animation)) return null
  const entry: BehaviorEntry = { animation }
  if (item.durationMs !== undefined) entry.durationMs = bounded(item.durationMs, 5000, 500, 300000)
  const emotion = cleanEmotion(item.emotion)
  if (emotion) entry.emotion = emotion
  if (animation.startsWith('dance:custom:') && item.preset && typeof item.preset === 'object') {
    const preset = item.preset as Partial<DancePreset>
    if (typeof preset.url === 'string' && typeof preset.label === 'string') {
      entry.preset = { label: preset.label, type: motionType(preset.type), url: preset.url, bgm: typeof preset.bgm === 'string' ? preset.bgm : undefined }
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

export const MAX_MAINS = 8

function cleanWeightedEntry(value: unknown): WeightedEntry | null {
  const entry = cleanEntry(value)
  if (!entry) return null
  const weight = (value as Record<string, unknown>)?.weight
  return { ...entry, weight: bounded(weight, 1, 0, 99) }
}

function cleanState(value: unknown, fallback: StateBehavior): StateBehavior {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const start = Array.isArray(source.start) ? source.start.map(cleanEntry).filter((e): e is BehaviorEntry => e !== null).slice(0, 5) : []
  const occasionals = Array.isArray(source.occasionals) ? source.occasionals.map(cleanOccasional).filter((e): e is OccasionalEntry => e !== null).slice(0, 8) : []
  const end = Array.isArray(source.end) ? source.end.map(cleanEntry).filter((e): e is BehaviorEntry => e !== null).slice(0, 5) : []
  // Accept a bare id string for hand-written profiles ("base": "typing").
  const baseSource = typeof source.base === 'string' ? { animation: source.base } : source.base
  const base = cleanEntry(baseSource) ?? { ...fallback.base }
  // Older profiles predate mains: an explicit base migrates to a single
  // weighted entry so Main always shows what actually plays. A state with no
  // base info at all inherits the default rotation (the 3 dances for dancing).
  const mains = Array.isArray(source.mains)
    ? source.mains.map(cleanWeightedEntry).filter((e): e is WeightedEntry => e !== null).slice(0, MAX_MAINS)
    : source.base !== undefined
      ? base.animation ? [{ ...base, weight: 1 }] : []
      : fallback.mains.map(m => ({ ...m }))
  return { start, base, mains, occasionals, end }
}

export function normalizeProfile(value: unknown, fallbackName: string): BehaviorProfile {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const states = source.states && typeof source.states === 'object' ? source.states as Record<string, unknown> : {}
  const fallback = defaultProfileStates()
  const out = {} as Record<BehaviorStateId, StateBehavior>
  // A missing state restores the full default (base + occasionals), not an
  // empty shell — otherwise a fresh install would lose the built-in behavior.
  for (const { id } of BEHAVIOR_STATES) out[id] = cleanState(states[id] ?? fallback[id], fallback[id])
  const name = cleanId(source.name).slice(0, 60)
  return { name: name || fallbackName, states: out }
}

function defaultProfileStates(): Record<BehaviorStateId, StateBehavior> {
  return {
    idle: {
      start: [],
      base: { animation: 'idle' },
      mains: [{ animation: 'idle', weight: 1 }],
      occasionals: [{ animation: RANDOM_ACTION, emotion: RANDOM_EMOTION, everyMin: 45, everyMax: 75, chance: 0.5 }],
      end: [],
    },
    working: {
      start: [],
      base: { animation: 'typing' },
      mains: [{ animation: 'typing', weight: 1 }],
      occasionals: [{ animation: 'sip', everyMin: 40, everyMax: 90, chance: 1 }],
      end: [],
    },
    music: {
      start: [], base: { animation: 'music' }, mains: [{ animation: 'music', weight: 1 }],
      occasionals: [{ animation: 'behavior:dancing', everyMin: 45, everyMax: 90, chance: 1 }],
      end: [{ animation: 'action:clapping' }],
    },
    dancing: {
      start: [],
      base: { animation: 'dance:jile' },
      mains: [
        { animation: 'dance:jile', weight: 1 },
        { animation: 'dance:love', weight: 1 },
        { animation: 'dance:ualDance', weight: 1 },
      ],
      occasionals: [],
      end: [],
    },
  }
}

export function defaultBehaviorProfile(): BehaviorProfile {
  return { name: 'Default', states: defaultProfileStates() }
}

export function normalizeBehaviorSettings(value: unknown, legacyMusic?: { randomDance?: boolean; reactOnEnd?: boolean }): BehaviorSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const profiles = Array.isArray(source.profiles)
    ? source.profiles.map((p, i) => normalizeProfile(p, `Profile ${i + 1}`)).slice(0, 20)
    : []
  const current = normalizeProfile(source.current, 'Default')
  // Named migration: behaviorSettings.version 2 replaces the two hidden music
  // schedulers with explicit Music entries. Existing entries are preserved.
  if (source.version !== 2) {
    const migrate = (profile: BehaviorProfile) => {
      const music = profile.states.music
      // Missing profiles already inherit the new defaults; explicit v1 states
      // need the legacy toggles translated exactly once.
      const raw = source.current as { states?: { music?: unknown } } | undefined
      if (raw?.states?.music || profile !== current) {
        if (music.occasionals.length < 8 && legacyMusic?.randomDance !== false && !music.occasionals.some(e => e.animation === 'behavior:dancing'))
          music.occasionals.push({ animation: 'behavior:dancing', everyMin: 45, everyMax: 90, chance: 1 })
        if (music.end.length < 5 && legacyMusic?.reactOnEnd !== false && !music.end.some(e => e.animation === 'action:clapping'))
          music.end.push({ animation: 'action:clapping' })
      }
      if (legacyMusic?.randomDance === false) music.occasionals = music.occasionals.filter(e => e.animation !== 'behavior:dancing')
      if (legacyMusic?.reactOnEnd === false) music.end = music.end.filter(e => e.animation !== 'action:clapping')
    }
    migrate(current)
    profiles.forEach(migrate)
  }
  return {
    version: 2,
    enabled: source.enabled !== false,
    current,
    profiles,
    reactions: normalizeReactions(source.reactions),
  }
}

// ── Agent-callable reactions ───────────────────────────────────────────────
// New behavior *states* would need new renderer drivers (working/music/
// dancing flags), so user-defined behaviors are transient *reactions* instead:
// a named step sequence an agent triggers by id, optionally with parameters
// (e.g. "rocket-launch", or "hat-dance" with a seconds parameter). The pet
// plays the steps once and returns to its current persistent state.

const REACTION_ID_RE = /^[a-z0-9][a-z0-9-_]{0,39}$/
const REACTION_PARAM_RE = /^[a-z][a-z0-9_]{0,29}$/

export function slugifyReactionId(value: unknown, fallback: string): string {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  if (slug && REACTION_ID_RE.test(slug)) return slug
  return fallback
}

/** Validated motion-file type for imported dances (anything else is VMD). */
function motionType(value: unknown): 'vmd' | 'vrma' | 'fbx' {
  return value === 'vrma' || value === 'fbx' ? value : 'vmd'
}

/**
 * Keystroke-safe id cleanup for the editor: like slugifyReactionId but keeps
 * a trailing separator so "rocket-" can become "rocket-launch". Returns ''
 * when nothing valid remains.
 */
export function editReactionId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^[-_]+/, '').slice(0, 40)
  return REACTION_ID_RE.test(id) ? id : ''
}

export function isValidReactionParamName(name: string): boolean {
  return REACTION_PARAM_RE.test(name)
}

function cleanReactionParam(value: unknown): ReactionParam | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const name = typeof item.name === 'string' ? item.name.trim().toLowerCase() : ''
  if (!REACTION_PARAM_RE.test(name)) return null
  const type = item.type === 'number' ? 'number' : item.type === 'boolean' ? 'boolean' : 'string'
  let coerced: string | number | boolean = type === 'number' ? 0 : type === 'boolean' ? false : ''
  if (type === 'number') {
    const n = Number(item.default)
    coerced = Number.isFinite(n) ? n : 0
  } else if (type === 'boolean') {
    coerced = item.default === true || item.default === 'true' || item.default === 1 || item.default === '1'
  } else if (typeof item.default === 'string' || typeof item.default === 'number' || typeof item.default === 'boolean') {
    coerced = String(item.default).slice(0, 200)
  }
  const description = typeof item.description === 'string' ? item.description.slice(0, 200) : ''
  return { name, type, default: coerced, description }
}

function cleanReactionStep(value: unknown): ReactionStep | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const animation = cleanId(item.animation)
  if (!knownAnimation(animation)) return null
  const step: ReactionStep = { animation, durationMs: 3000 }
  const emotion = cleanEmotion(item.emotion)
  if (emotion) step.emotion = emotion
  if (typeof item.say === 'string' && item.say.trim()) step.say = item.say.slice(0, 280)
  const durationMs = Number(item.durationMs ?? item.duration_ms ?? 3000)
  step.durationMs = Number.isFinite(durationMs) ? Math.max(500, Math.min(30000, Math.round(durationMs))) : 3000
  if (animation.startsWith('dance:custom:')) {
    // Imported dances are only playable through their preset (file URL).
    const preset = (item.preset && typeof item.preset === 'object' ? item.preset : {}) as Partial<DancePreset>
    if (typeof preset.url !== 'string' || typeof preset.label !== 'string') return null
    step.preset = { label: preset.label, type: motionType(preset.type), url: preset.url, bgm: typeof preset.bgm === 'string' ? preset.bgm : undefined }
  }
  const rawProps = item.props && typeof item.props === 'object' ? item.props as Record<string, unknown> : null
  if (rawProps && (rawProps.working === true || rawProps.sip === true)) {
    step.props = {}
    if (rawProps.working === true) step.props.working = true
    if (rawProps.sip === true) step.props.sip = true
  }
  return step
}

export function normalizeReaction(value: unknown, fallbackId: string): CustomReaction | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const id = slugifyReactionId(source.id, fallbackId)
  if (!id) return null
  const name = cleanId(source.name).slice(0, 60) || id
  const description = typeof source.description === 'string' ? source.description.slice(0, 280) : ''
  const seen = new Set<string>()
  const params = Array.isArray(source.params)
    ? source.params.map(cleanReactionParam)
      .filter((p): p is ReactionParam => p !== null && !seen.has(p.name) && (seen.add(p.name), true))
      .slice(0, 8)
    : []
  const steps = Array.isArray(source.steps)
    ? source.steps.map(cleanReactionStep).filter((s): s is ReactionStep => s !== null).slice(0, 10)
    : []
  if (steps.length === 0) return null
  return { id, name, description, params, steps }
}

export function normalizeReactions(value: unknown): CustomReaction[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: CustomReaction[] = []
  value.forEach((item, index) => {
    const reaction = normalizeReaction(item, `reaction-${index + 1}`)
    if (reaction && !seen.has(reaction.id)) {
      seen.add(reaction.id)
      out.push(reaction)
    }
  })
  return out.slice(0, 50)
}

/** Example reaction shipped in the editor as a starting point (not persisted). */
export function exampleReaction(): CustomReaction {
  return {
    id: 'rocket-launch',
    name: 'Rocket launch',
    description: 'Celebrate a deploy: cheer, shout the message, then dance. Call after a successful git push or release.',
    params: [{ name: 'message', type: 'string', default: 'Shipped it!', description: 'Shouted in the speech bubble.' }],
    steps: [
      { animation: 'action:excited', emotion: 'happy', durationMs: 2500 },
      { animation: 'action:cheering', emotion: 'happy', say: '{{message}}', durationMs: 3500 },
      { animation: 'dance:jile', emotion: 'happy', durationMs: 8000 },
    ],
  }
}

/** `{{name}}` templates in say text, rendered with the call's parameters. */
export function renderReactionTemplate(text: string, values: Record<string, string | number | boolean>): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, key: string) => {
    const value = values[key.toLowerCase()]
    return value === undefined ? match : String(value)
  })
}

function coerceParamValue(type: ReactionParam['type'], raw: unknown, fallback: string | number | boolean): string | number | boolean {
  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    const s = String(raw ?? '').trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(s)) return false
    return fallback
  }
  if (raw === undefined || raw === null) return fallback
  return String(raw).slice(0, 280)
}

/** Merge caller args over a reaction's param defaults (unknown args ignored). */
export function coerceReactionParams(reaction: CustomReaction, args: Record<string, unknown>): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {}
  for (const param of reaction.params) values[param.name] = param.default
  for (const param of reaction.params) {
    if (args[param.name] !== undefined) values[param.name] = coerceParamValue(param.type, args[param.name], param.default)
  }
  return values
}

export interface ResolvedReactionStep extends ReactionStep {
  sayRendered?: string
}

/** Validate + render a reaction call into playable steps. Unknown ids and unknown animations are errors, not silent no-ops. */
export function resolveReactionCall(
  reactions: CustomReaction[],
  id: string,
  args: Record<string, unknown> = {},
): { ok: true; reaction: CustomReaction; values: Record<string, string | number | boolean>; steps: ResolvedReactionStep[] } | { ok: false; error: string; known: string[] } {
  const known = reactions.map(r => r.id)
  const reaction = reactions.find(r => r.id === id)
  if (!reaction) return { ok: false, error: `unknown reaction ${JSON.stringify(id)}`, known }
  const values = coerceReactionParams(reaction, args)
  const steps = reaction.steps.map(step => ({
    ...step,
    sayRendered: step.say ? renderReactionTemplate(step.say, values).slice(0, 280) : undefined,
  }))
  return { ok: true, reaction, values, steps }
}

/** Copy-paste CLI invocation for a reaction, for the editor + API catalog. */
export function reactionCliExample(id: string, params: ReactionParam[] = []): string {
  const extra = params.length ? ' [--param name=value ...]' : ''
  return `python3 cli/cuttle_pet.py react ${id}${extra}`
}

/** One-line editor/catalog summary, e.g. "Rocket launch — 3 steps · params: message". */
export function describeReaction(reaction: CustomReaction): string {
  const bits = [`${reaction.steps.length} step${reaction.steps.length === 1 ? '' : 's'}`]
  if (reaction.params.length) bits.push(`params: ${reaction.params.map(p => p.name).join(', ')}`)
  return `${reaction.name} — ${bits.join(' · ')}`
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

export function animationCatalog(customDances: { id: string; label: string; vmdUrl: string; bgmUrl?: string; type?: CustomMotionType }[], language: 'zh' | 'en' = 'zh'): AnimationOption[] {
  return [
    { id: 'idle', label: 'Idle loop', group: 'Idle', procedural: false },
    ...Object.entries(actionPresets).map(([id, preset]) => ({ id: `action:${id}`, label: localizedPresetLabel(preset, language), group: 'Actions', procedural: false as const })),
    ...Object.entries(dancePresets).map(([id, preset]) => ({ id: `dance:${id}`, label: localizedPresetLabel(preset, language), group: 'Dances', procedural: false as const })),
    ...customDances.map(dance => ({ id: `dance:custom:${dance.id}`, label: dance.label, group: 'Imported dances', procedural: false as const, preset: { label: dance.label, type: dance.type ?? 'vmd', url: dance.vmdUrl, bgm: dance.bgmUrl } })),
    { id: RANDOM_ACTION, label: 'Surprise me (random action)', group: 'Actions', procedural: false },
    ...proceduralAnimations.map(item => ({ ...item, group: 'Procedural', procedural: true as const })),
  ]
}

export function animationLabel(id: string | null, customDances: { id: string; label: string }[] = [], language: 'zh' | 'en' = 'zh'): string {
  if (!id) return ''
  const target = behaviorTarget(id)
  if (target) return `${BEHAVIOR_STATES.find(s => s.id === target)!.label} (behavior)`
  if (id === 'idle') return 'Idle loop'
  if (id === RANDOM_ACTION) return 'Surprise action'
  if (id === 'typing') return 'Working / typing'
  if (id === 'sip') return 'Coffee sip'
  if (id === 'music') return 'Music nod / sway'
  if (id.startsWith('action:')) {
    const preset = actionPresets[id.slice(7)]
    return preset ? localizedPresetLabel(preset, language) : id
  }
  if (id.startsWith('dance:custom:')) return customDances.find(d => `dance:custom:${d.id}` === id)?.label ?? id
  if (id.startsWith('dance:')) {
    const preset = dancePresets[id.slice(6)]
    return preset ? localizedPresetLabel(preset, language) : id
  }
  const procedural = proceduralAnimations.find(p => p.id === id)
  return procedural?.label ?? id
}

/**
 * Weighted pick from a state's Main rotation. Zero-weight entries never play;
 * when nothing is eligible (or the list is empty) returns null so the caller
 * falls back to `base` / leave-as-is.
 */
export function pickWeightedEntry(entries: WeightedEntry[], rand: () => number = Math.random): WeightedEntry | null {
  const eligible = entries.filter(e => e.weight > 0)
  const total = eligible.reduce((sum, e) => sum + e.weight, 0)
  if (total <= 0) return null
  let roll = rand() * total
  for (const entry of eligible) {
    roll -= entry.weight
    if (roll < 0) return entry
  }
  return eligible[eligible.length - 1]
}

/** The sustaining loop a state should play: weighted Main pick, else base, else null (leave as-is). */
export function resolveMain(state: StateBehavior, rand: () => number = Math.random): BehaviorEntry | null {
  return pickWeightedEntry(state.mains, rand) ?? (state.base.animation ? state.base : null)
}

/** One-line "Working — typing · sipping coffee" summary for the settings banner. */
export function describeStatus(status: PetStatus, customDances: { id: string; label: string }[] = [], language: 'zh' | 'en' = 'zh'): string {
  const stateLabel = { idle: 'Idle', working: 'Working', music: 'Listening to music', dancing: 'Dancing' }[status.state]
  const bits: string[] = []
  if (status.danceId) bits.push(animationLabel(status.danceId, customDances, language))
  else if (status.actionId && status.actionId !== 'idle') bits.push(animationLabel(status.actionId, customDances, language))
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
  playAnimationOnce(name: string): void | Promise<void>
  playActionLoop(name: string): void
  playDance(nameOrPreset: string | DancePreset, preferenceKey?: string): void
  playDanceOnce(nameOrPreset: string | DancePreset, preferenceKey?: string): void | Promise<void>
  setEmotionWithReset(emotion: string, durationMs: number, intensity?: number): void
  isBusy(): boolean
  isLooping?(): boolean
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
  if (id === RANDOM_ACTION) { return scene.playAnimationOnce(pickRandomAction()) }
  if (id === 'typing') { scene.setWorking(true, previewMs); return }
  if (id === 'sip') { scene.setWorking(true); scene.requestCoffeeSip(); return }
  if (id === 'music') { scene.setMusicPreview(true, previewMs); return }
  if (AMBIENT_IDS.has(id)) { scene.pulseProcedural(id, false); return }
  if (id.startsWith('action:')) { return scene.playAnimationOnce(id.slice(7)) }
  if (id.startsWith('dance:')) { return scene.playDanceOnce(preset ?? id.slice(6), id) }
  scene.resetPose()
}

/** One step of a reaction as broadcast by the server (`reactionStep` frame). */
export interface ReactionStepFrame {
  animation: string
  durationMs: number
  preset?: DancePreset
  props?: ReactionStepProps
}

/**
 * Play a reaction step. Each step first clears the previous motion (a clip
 * still finishing, a dance, the laptop) so it can't be silently skipped by
 * the one-at-a-time action/dance locks; props apply to this step only.
 */
export function playReactionStep(scene: BehaviorScene, step: ReactionStepFrame) {
  scene.resetPose()
  const id = step.animation
  if (step.props?.working || step.props?.sip) scene.setWorking(true)
  if (step.props?.sip && id !== 'sip') scene.requestCoffeeSip()
  if (!id || id === 'idle') return
  playOnceById(scene, id, step.preset, id === 'typing' || id === 'music' ? step.durationMs : 0)
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
