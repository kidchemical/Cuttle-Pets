// ── Companions: pets and props ──────────────────────────────────────────────
// Both are user-imported GLB assets stored under DATA_DIR (pets/, props/) and
// share the asset metadata below. A *pet* is a persistent character with its
// own placement, idle motion, expressions and reactions. A *prop* is a passive
// object attached to one of the character's bones (hat, guitar) that
// behaviors show and hide. Settings keys: `petSettings`, `propSettings`.

export type CompanionKind = 'pet' | 'prop'

/** Discovered at import time so settings can edit parts without loading the model. */
export interface AssetInfo {
  /** Named nodes that own meshes; their visibility can be toggled. */
  parts: string[]
  /** Animation clip names stored in the GLB. */
  clips: string[]
  /** Skeleton bone names (procedural wing/tail motion). */
  bones: string[]
  /** Material names (per-material recolor). */
  materials: string[]
}

/** Mutually exclusive mesh variants, e.g. the eye or emotion-ball swaps. */
export interface PartGroup {
  id: string
  label: string
  parts: string[]
  /** Part shown when no expression selects another; null hides the group. */
  default: string | null
}

/** Part selections per group; groups not listed keep their default. */
export interface PetExpression {
  id: string
  label: string
  set: Record<string, string | null>
}

export type PetAnchor = 'shoulder' | 'head' | 'beside' | 'hands' | 'orbit'
export type PetIdleStyle = 'float' | 'hop' | 'still'
export type PetMove = 'hop' | 'spin' | 'flap' | 'wiggle' | 'bounce'
export const PET_ANCHORS: { id: PetAnchor; label: string }[] = [
  { id: 'shoulder', label: 'Floating near the shoulder' },
  { id: 'head', label: 'On the head' },
  { id: 'beside', label: 'On the floor beside' },
  { id: 'hands', label: 'Held in the hands' },
  { id: 'orbit', label: 'Circling around' },
]
export const PET_MOVES: { id: PetMove; label: string }[] = [
  { id: 'hop', label: 'Hop' },
  { id: 'spin', label: 'Spin' },
  { id: 'flap', label: 'Flap wings' },
  { id: 'wiggle', label: 'Wiggle' },
  { id: 'bounce', label: 'Bounce' },
]
/** Cap on configured pets (library itself is unbounded). */
export const MAX_PETS = 24
export const PET_IDLE_STYLES: { id: PetIdleStyle; label: string }[] = [
  { id: 'float', label: 'Float and bob' },
  { id: 'hop', label: 'Hop in place' },
  { id: 'still', label: 'Stay still' },
]

export interface PetConfig {
  id: string
  name: string
  /** Loaded into the scene at all. */
  enabled: boolean
  /** Visible at startup; behaviors can show/hide at runtime. */
  visible: boolean
  /** File name under DATA_DIR/pets. */
  file: string
  asset: AssetInfo
  anchor: PetAnchor
  side: 'left' | 'right'
  /** Pet height as a fraction of the character's height. */
  size: number
  /** Extra offset in % of the character's height. */
  offset: { x: number; y: number; z: number }
  /** Extra yaw in degrees (models face different ways). */
  turn: number
  idle: { style: PetIdleStyle; speed: number; amount: number }
  /** Follow time constant in seconds; larger values trail more loosely. */
  followLag: number
  /** Texture-colored shadow lift, scaled by stage illumination (0–1). */
  lighting: number
  /** Relaxed procedural arms/feet; 0 retains the imported bind pose. */
  limbMotion: number
  /** Looping clip from the GLB, or '' for procedural idle only. */
  clip: string
  /** Bones flapped / wagged by the procedural idle (auto-detected). */
  wings: string[]
  tail: string[]
  groups: PartGroup[]
  expressions: PetExpression[]
  /** Group + ordered parts played as a blink, or null. */
  blink: { group: string; frames: string[] } | null
  /** Character emotion → pet expression id. */
  mood: Record<string, string>
  /** Clicking the pet. */
  click: { move: PetMove | ''; expression: string }
  /** Ambient one-shots: every min–max seconds pick one of these moves. */
  occasional: { enabled: boolean; everyMin: number; everyMax: number; moves: PetMove[] }
  /** Material name → #rrggbb tint. */
  colors: Record<string, string>
}

export type PropAnchor = 'head' | 'neck' | 'chest' | 'hips' | 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot' | 'root'
export const PROP_ANCHORS: { id: PropAnchor; label: string }[] = [
  { id: 'head', label: 'Head' },
  { id: 'neck', label: 'Neck' },
  { id: 'chest', label: 'Chest' },
  { id: 'hips', label: 'Hips' },
  { id: 'leftHand', label: 'Left hand' },
  { id: 'rightHand', label: 'Right hand' },
  { id: 'leftFoot', label: 'Left foot' },
  { id: 'rightFoot', label: 'Right foot' },
  { id: 'root', label: 'Body (follows the character)' },
]

export interface PropConfig {
  id: string
  name: string
  enabled: boolean
  /** Worn at startup; behaviors can show/hide at runtime. */
  visible: boolean
  file: string
  asset: AssetInfo
  anchor: PropAnchor
  /** Largest dimension as a fraction of the character's height. */
  size: number
  /** Offset in % of the character's height, in the anchor bone's space. */
  offset: { x: number; y: number; z: number }
  /** Degrees. */
  rotation: { x: number; y: number; z: number }
  colors: Record<string, string>
}

export interface PetSettings { version: 1; pets: PetConfig[] }
export interface PropSettings { version: 1; props: PropConfig[] }

// ── Runtime actions (behaviors, reactions, CLI, settings previews) ──────────

export type PetAction = 'show' | 'hide' | 'toggle' | 'expression' | 'play' | 'stop' | 'move'
export type PropAction = 'show' | 'hide' | 'toggle'
export const PET_ACTIONS: { id: PetAction; label: string }[] = [
  { id: 'show', label: 'Show' },
  { id: 'hide', label: 'Hide' },
  { id: 'toggle', label: 'Toggle' },
  { id: 'expression', label: 'Expression' },
  { id: 'play', label: 'Play move' },
  { id: 'stop', label: 'Stop + go home' },
  { id: 'move', label: 'Move to' },
]
export const PROP_ACTIONS: { id: PropAction; label: string }[] = [
  { id: 'show', label: 'Show' },
  { id: 'hide', label: 'Hide' },
  { id: 'toggle', label: 'Toggle' },
]

/**
 * One pet/prop instruction attached to a behavior entry or reaction step.
 * `value` is the expression id (expression), move id or 'clip:<name>' (play),
 * or anchor id (move). `loop` keeps a move going until stop.
 */
export interface CompanionAction {
  kind: CompanionKind
  id: string
  action: PetAction | PropAction
  value?: string
  loop?: boolean
  /** Expression hold; 0/undefined keeps it until changed. */
  durationMs?: number
}

const ID_RE = /^[a-z0-9][a-z0-9-_]{0,39}$/
const MAX_COMPANION_ACTIONS = 6

export function slugifyCompanionId(value: unknown, fallback: string): string {
  const slug = String(value ?? '').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40)
  return ID_RE.test(slug) ? slug : fallback
}

/** Unique id for a new pet/prop given the ids already taken. */
export function uniqueCompanionId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const root = slugifyCompanionId(base, 'item').slice(0, 34)
  if (!used.has(root)) return root
  let n = 2
  while (used.has(`${root}-${n}`)) n++
  return `${root}-${n}`
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}
function str(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
function strings(value: unknown, max = 400): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200))].slice(0, max) : []
}
function vec(value: unknown, range: number): { x: number; y: number; z: number } {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { x: num(v.x, 0, -range, range), y: num(v.y, 0, -range, range), z: num(v.z, 0, -range, range) }
}
function oneOf<T extends string>(value: unknown, options: readonly { id: T }[], fallback: T): T {
  return options.some(o => o.id === value) ? value as T : fallback
}
const HEX_RE = /^#[0-9a-f]{6}$/i
function colors(value: unknown, materials: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, hex] of Object.entries(value as Record<string, unknown>)) {
    if (materials.includes(key) && typeof hex === 'string' && HEX_RE.test(hex)) out[key] = hex.toLowerCase()
  }
  return out
}

export function normalizeAssetInfo(value: unknown): AssetInfo {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { parts: strings(v.parts), clips: strings(v.clips, 100), bones: strings(v.bones), materials: strings(v.materials, 100) }
}

function cleanGroups(value: unknown, parts: string[]): PartGroup[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: PartGroup[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const g = item as Record<string, unknown>
    const id = slugifyCompanionId(g.id, '')
    if (!id || seen.has(id)) continue
    const members = strings(g.parts).filter(p => parts.includes(p))
    if (members.length < 1) continue
    seen.add(id)
    const def = g.default === null ? null : typeof g.default === 'string' && members.includes(g.default) ? g.default : members[0]
    out.push({ id, label: str(g.label, 60) || id, parts: members, default: def })
  }
  return out.slice(0, 12)
}

function cleanExpressions(value: unknown, groups: PartGroup[]): PetExpression[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: PetExpression[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const id = slugifyCompanionId(e.id, '')
    if (!id || seen.has(id)) continue
    const set: Record<string, string | null> = {}
    const raw = e.set && typeof e.set === 'object' ? e.set as Record<string, unknown> : {}
    for (const group of groups) {
      if (!(group.id in raw)) continue
      const part = raw[group.id]
      if (part === null) set[group.id] = null
      else if (typeof part === 'string' && group.parts.includes(part)) set[group.id] = part
    }
    seen.add(id)
    out.push({ id, label: str(e.label, 60) || id, set })
  }
  return out.slice(0, 40)
}

const PET_MOVE_IDS = new Set(PET_MOVES.map(m => m.id))

export function normalizePet(value: unknown, fallbackId: string): PetConfig | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const file = str(v.file, 200)
  if (!file || file.includes('/') || file.includes('\\')) return null
  const asset = normalizeAssetInfo(v.asset)
  const groups = cleanGroups(v.groups, asset.parts)
  const expressions = cleanExpressions(v.expressions, groups)
  const exprIds = new Set(expressions.map(e => e.id))
  const idle = v.idle && typeof v.idle === 'object' ? v.idle as Record<string, unknown> : {}
  const blinkRaw = v.blink && typeof v.blink === 'object' ? v.blink as Record<string, unknown> : null
  const blinkGroup = blinkRaw ? groups.find(g => g.id === blinkRaw.group) : undefined
  const blinkFrames = blinkGroup ? strings(blinkRaw!.frames).filter(p => blinkGroup.parts.includes(p)).slice(0, 6) : []
  const mood: Record<string, string> = {}
  if (v.mood && typeof v.mood === 'object') {
    for (const [emotion, expr] of Object.entries(v.mood as Record<string, unknown>)) {
      if (typeof expr === 'string' && exprIds.has(expr) && /^[a-z]{1,20}$/.test(emotion)) mood[emotion] = expr
    }
  }
  const click = v.click && typeof v.click === 'object' ? v.click as Record<string, unknown> : {}
  const occ = v.occasional && typeof v.occasional === 'object' ? v.occasional as Record<string, unknown> : {}
  const everyMin = num(occ.everyMin, 20, 3, 3600)
  return {
    id: slugifyCompanionId(v.id, fallbackId),
    name: str(v.name, 60) || fallbackId,
    enabled: v.enabled !== false,
    visible: v.visible !== false,
    file,
    asset,
    anchor: oneOf(v.anchor, PET_ANCHORS, 'shoulder'),
    side: v.side === 'left' ? 'left' : 'right',
    size: num(v.size, 0.22, 0.03, 1.5),
    offset: vec(v.offset, 100),
    turn: num(v.turn, 0, -180, 180),
    idle: {
      style: oneOf(idle.style, PET_IDLE_STYLES, 'float'),
      speed: num(idle.speed, 1, 0.1, 4),
      amount: num(idle.amount, 1, 0, 3),
    },
    followLag: num(v.followLag, 0.6, 0.05, 2),
    lighting: num(v.lighting, 0.35, 0, 1),
    limbMotion: num(v.limbMotion, 1, 0, 2),
    clip: typeof v.clip === 'string' && asset.clips.includes(v.clip) ? v.clip : '',
    wings: strings(v.wings).filter(b => asset.bones.includes(b)).slice(0, 8),
    tail: strings(v.tail).filter(b => asset.bones.includes(b)).slice(0, 8),
    groups,
    expressions,
    blink: blinkGroup && blinkFrames.length ? { group: blinkGroup.id, frames: blinkFrames } : null,
    mood,
    click: {
      move: typeof click.move === 'string' && PET_MOVE_IDS.has(click.move as PetMove) ? click.move as PetMove : '',
      expression: typeof click.expression === 'string' && exprIds.has(click.expression) ? click.expression : '',
    },
    occasional: {
      enabled: occ.enabled === true,
      everyMin,
      everyMax: num(occ.everyMax, Math.max(45, everyMin), everyMin, 3600),
      moves: strings(occ.moves).filter((m): m is PetMove => PET_MOVE_IDS.has(m as PetMove)),
    },
    colors: colors(v.colors, asset.materials),
  }
}

export function normalizeProp(value: unknown, fallbackId: string): PropConfig | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const file = str(v.file, 200)
  if (!file || file.includes('/') || file.includes('\\')) return null
  const asset = normalizeAssetInfo(v.asset)
  return {
    id: slugifyCompanionId(v.id, fallbackId),
    name: str(v.name, 60) || fallbackId,
    enabled: v.enabled !== false,
    visible: v.visible === true,
    file,
    asset,
    anchor: oneOf(v.anchor, PROP_ANCHORS, 'head'),
    size: num(v.size, 0.15, 0.01, 2),
    offset: vec(v.offset, 100),
    rotation: vec(v.rotation, 180),
    colors: colors(v.colors, asset.materials),
  }
}

function uniqueList<T extends { id: string }>(items: (T | null)[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    if (!item) continue
    if (seen.has(item.id)) item.id = uniqueCompanionId(item.id, seen)
    seen.add(item.id)
    out.push(item)
  }
  return out
}

export function normalizePetSettings(value: unknown): PetSettings {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const pets = uniqueList(Array.isArray(v.pets) ? v.pets.map((p, i) => normalizePet(p, `pet-${i + 1}`)) : []).slice(0, MAX_PETS)
  // One pet at a time: a single model loads, so only the preferred entry
  // stays enabled — the visible one, else the first enabled one.
  const active = pets.find(p => p.enabled && p.visible) ?? pets.find(p => p.enabled)
  for (const pet of pets) pet.enabled = pet === active
  return { version: 1, pets }
}

export function normalizePropSettings(value: unknown): PropSettings {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const props = Array.isArray(v.props) ? v.props.map((p, i) => normalizeProp(p, `prop-${i + 1}`)) : []
  return { version: 1, props: uniqueList(props).slice(0, 40) }
}

const PET_ACTION_IDS = new Set<string>(PET_ACTIONS.map(a => a.id))
const PROP_ACTION_IDS = new Set<string>(PROP_ACTIONS.map(a => a.id))
const PET_ANCHOR_IDS = new Set<string>(PET_ANCHORS.map(a => a.id))

/**
 * Shape-only validation (ids may refer to pets imported later, so they are
 * not checked against settings here; the runtime ignores unknown ids).
 */
export function normalizeCompanionAction(value: unknown): CompanionAction | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const kind: CompanionKind | null = v.kind === 'pet' ? 'pet' : v.kind === 'prop' ? 'prop' : null
  if (!kind) return null
  const id = typeof v.id === 'string' && ID_RE.test(v.id) ? v.id : ''
  if (!id) return null
  const action = typeof v.action === 'string' ? v.action : ''
  if (!(kind === 'pet' ? PET_ACTION_IDS : PROP_ACTION_IDS).has(action)) return null
  const out: CompanionAction = { kind, id, action: action as CompanionAction['action'] }
  const value_ = typeof v.value === 'string' ? v.value.slice(0, 120) : ''
  if (action === 'expression' || action === 'play' || action === 'move') {
    if (!value_) return null
    if (action === 'move' && !PET_ANCHOR_IDS.has(value_) && value_ !== 'home') return null
    if (action === 'play' && !PET_MOVE_IDS.has(value_ as PetMove) && !value_.startsWith('clip:')) return null
    out.value = value_
  }
  if (action === 'play' && v.loop === true) out.loop = true
  if (action === 'expression' && v.durationMs !== undefined) {
    const ms = num(v.durationMs, 0, 0, 600000)
    if (ms > 0) out.durationMs = Math.round(ms)
  }
  return out
}

export function normalizeCompanionActions(value: unknown): CompanionAction[] {
  return Array.isArray(value)
    ? value.map(normalizeCompanionAction).filter((a): a is CompanionAction => a !== null).slice(0, MAX_COMPANION_ACTIONS)
    : []
}

/** "Chao: show", "Hat: hide", "Chao: play hop (loop)" for list summaries. */
export function describeCompanionAction(action: CompanionAction, names: Record<string, string> = {}): string {
  const who = names[`${action.kind}:${action.id}`] ?? action.id
  const verb = action.action === 'play' ? `play ${action.value?.replace(/^clip:/, '')}${action.loop ? ' (loop)' : ''}`
    : action.action === 'expression' ? `expression ${action.value}`
      : action.action === 'move' ? `move to ${action.value}`
        : action.action
  return `${who}: ${verb}`
}

// ── Import-time analysis ─────────────────────────────────────────────────────

/** Longest shared "Prefix_" among part names, e.g. "ChaoNCZ0_". */
function commonPrefix(names: string[]): string {
  if (names.length < 2) return ''
  let prefix = names[0]
  for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1)
  // "Chao" + "Chao_Eye" + "Chao_Ball": the base part is the bare prefix.
  if (prefix && names.every(name => name === prefix || name.startsWith(`${prefix}_`))) return `${prefix}_`
  const cut = prefix.lastIndexOf('_')
  return cut >= 0 ? prefix.slice(0, cut + 1) : ''
}

function words(name: string): string {
  return name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
}

/** Keyword hints mapping character emotions to likely pet expressions. */
const MOOD_HINTS: Record<string, string[]> = {
  love: ['heart', 'love'],
  flirty: ['heart', 'love'],
  happy: ['heart', 'happy', 'smile', 'joy'],
  surprised: ['exclamation', 'surprise', 'shock'],
  question: ['question', 'confus'],
  curious: ['question', 'exclamation'],
  angry: ['angry', 'anger', 'mad'],
  sad: ['sad', 'cry', 'tear'],
}

/**
 * Suggested pet setup from the asset alone: swap-mesh variant groups
 * ("Eye", "EyeClose1", "EyePtn2" → one Eye group), a blink from closed-eye
 * variants, one expression per variant, emotion mirroring by keyword, and
 * wing/tail bones for the procedural idle.
 */
export function suggestPetSetup(asset: AssetInfo): Pick<PetConfig, 'groups' | 'expressions' | 'blink' | 'mood' | 'wings' | 'tail' | 'click' | 'clip'> {
  const prefix = commonPrefix(asset.parts)
  const byKey = new Map<string, string[]>()
  for (const part of asset.parts) {
    const rest = prefix && part.startsWith(prefix) ? part.slice(prefix.length) : part
    const key = /^([A-Z][a-z]+|[a-z]+)/.exec(rest)?.[1]
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(part)
  }
  const groups: PartGroup[] = []
  for (const [key, parts] of byKey) {
    if (parts.length < 2) continue
    const sorted = [...parts].sort((a, b) => a.length - b.length || a.localeCompare(b))
    const base = sorted.find(p => p === `${prefix}${key}`) ?? sorted[0]
    groups.push({ id: slugifyCompanionId(key, `group-${groups.length + 1}`), label: key, parts: sorted, default: base })
  }
  const expressions: PetExpression[] = [{ id: 'neutral', label: 'Neutral', set: {} }]
  let blink: PetConfig['blink'] = null
  for (const group of groups) {
    const closed = group.parts.filter(p => /close|blink|shut/i.test(p)).sort()
    if (!blink && closed.length) blink = { group: group.id, frames: closed }
    for (const part of group.parts) {
      if (part === group.default || closed.includes(part)) continue
      const rest = prefix && part.startsWith(prefix) ? part.slice(prefix.length) : part
      const id = slugifyCompanionId(words(rest).toLowerCase(), '')
      if (!id || expressions.some(e => e.id === id)) continue
      expressions.push({ id, label: words(rest), set: { [group.id]: part } })
    }
  }
  const mood: Record<string, string> = {}
  for (const [emotion, hints] of Object.entries(MOOD_HINTS)) {
    const hit = expressions.find(e => hints.some(h => e.id.includes(h)))
    if (hit) mood[emotion] = hit.id
  }
  const heart = expressions.find(e => e.id.includes('heart'))
  return {
    groups,
    expressions,
    blink,
    mood,
    wings: asset.bones.filter(b => /wing/i.test(b)).slice(0, 8),
    tail: asset.bones.filter(b => /tail/i.test(b)).slice(0, 8),
    click: { move: 'hop', expression: heart?.id ?? '' },
    clip: asset.clips.find(c => /idle/i.test(c)) ?? '',
  }
}

/** A fresh pet config for a newly imported asset. */
export function createPetConfig(id: string, name: string, file: string, asset: AssetInfo): PetConfig {
  return normalizePet({ id, name, file, asset, ...suggestPetSetup(asset), occasional: { enabled: true, everyMin: 20, everyMax: 60, moves: ['hop', 'flap', 'wiggle'] } }, id)!
}

export function createPropConfig(id: string, name: string, file: string, asset: AssetInfo): PropConfig {
  return normalizeProp({ id, name, file, asset, visible: true }, id)!
}

/** Parts visible for an expression (null = all group defaults). */
export function resolveExpressionParts(pet: Pick<PetConfig, 'groups' | 'expressions'>, expressionId: string | null): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const group of pet.groups) out[group.id] = group.default
  const expression = expressionId ? pet.expressions.find(e => e.id === expressionId) : undefined
  if (expression) Object.assign(out, expression.set)
  return out
}
