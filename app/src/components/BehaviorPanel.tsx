import { useEffect, useRef, useState } from 'react'
import { Play, Repeat, Square, Plus, Trash2, Download, Upload, Save, FlaskConical } from 'lucide-react'
import {
  BEHAVIOR_STATES, EMOTION_OPTIONS, RANDOM_ACTION, RANDOM_EMOTION, MAX_MAINS, animationCatalog, animationLabel,
  normalizeProfile, normalizeReaction, defaultBehaviorProfile, exampleReaction,
  slugifyReactionId, editReactionId, isValidReactionParamName, describeReaction, reactionCliExample,
  type AnimationOption, type BehaviorEntry, type BehaviorSettings, type BehaviorStateId,
  type CustomReaction, type OccasionalEntry, type ReactionParam, type StateBehavior, type WeightedEntry,
} from '../behavior'
import type { DancePreset } from '../motion-controller'
import type { PreviewMode } from './AnimationSettingsPanel'
import { petUrl } from '../config'

interface Props {
  settings: BehaviorSettings
  onChange: (value: BehaviorSettings) => void
  customDances: { id: string; label: string; vmdUrl: string; bgmUrl?: string; type?: 'vmd' | 'vrma' | 'fbx' }[]
  statusText: string | null
  onPreview?: (id: string, preset?: DancePreset, mode?: PreviewMode) => void
  onStop?: () => void
  language?: 'zh' | 'en'
}

/** Plain-data clone (profiles are JSON; avoids webview structuredClone gaps). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
const button: React.CSSProperties = { padding: '9px 12px', border: '1px solid #505665', borderRadius: 7, background: '#303645', color: 'white', cursor: 'pointer', textAlign: 'left' }
const smallButton: React.CSSProperties = { ...button, padding: '5px 9px', fontSize: 13 }
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
/* Entry rows mirror the animations-page list rows: a flexible label control
   plus a horizontal icon-button group. */
const iconButton: React.CSSProperties = { ...button, padding: '6px 7px' }
const numberInput: React.CSSProperties = { width: 52, background: '#262c38', border: '1px solid #505665', borderRadius: 7, color: 'white', padding: '5px 6px', fontSize: 13 }
const select: React.CSSProperties = {
  flex: '1 1 160px', minWidth: 0, padding: '6px 10px',
  border: '1px solid #505665', borderRadius: 7, background: '#262c38',
  color: 'white', fontSize: 14, cursor: 'pointer',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}
const muted: React.CSSProperties = { color: '#adb5c8', fontSize: 12 }

function groupedOptions(catalog: AnimationOption[], allowLeaveAlone: boolean) {
  const groups = new Map<string, AnimationOption[]>()
  for (const option of catalog) {
    if (!groups.has(option.group)) groups.set(option.group, [])
    groups.get(option.group)!.push(option)
  }
  return <>
    {allowLeaveAlone && <option value="">— leave playing as-is —</option>}
    {[...groups].map(([group, options]) => <optgroup key={group} label={group}>
      {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </optgroup>)}
  </>
}

function AnimationSelect({ value, catalog, allowLeaveAlone, onPick }: {
  value: string; catalog: AnimationOption[]; allowLeaveAlone?: boolean; onPick: (id: string) => void
}) {
  return <select aria-label="Animation" value={catalog.some(o => o.id === value) || (allowLeaveAlone && value === '') ? value : ''} onChange={e => onPick(e.target.value)} style={select}>
    {value !== '' && !catalog.some(o => o.id === value) && <option value="">— pick an animation —</option>}
    {groupedOptions(catalog, !!allowLeaveAlone)}
  </select>
}

/** Entry phases within one behavior state, each with its own list section. */
type EntryPhase = 'start' | 'mains' | 'occasionals' | 'end'
const PHASES: { id: EntryPhase; label: string; addLabel: string; cap: number }[] = [
  { id: 'start', label: 'Start', addLabel: 'Add entry', cap: 5 },
  { id: 'mains', label: 'Main', addLabel: 'Add loop', cap: MAX_MAINS },
  { id: 'occasionals', label: 'Occasionals', addLabel: 'Add occasional', cap: 8 },
  { id: 'end', label: 'End', addLabel: 'Add exit', cap: 5 },
]

function EmotionSelect({ value, onPick }: { value: string; onPick: (emotion: string) => void }) {
  return <select aria-label="Emotion" value={value || ''} onChange={e => onPick(e.target.value)} style={{ flex: '0 1 130px', minWidth: 0 }}>
    <option value="">No emotion</option>
    <option value={RANDOM_EMOTION}>Surprise emotion</option>
    {EMOTION_OPTIONS.map(emotion => <option key={emotion} value={emotion}>{emotion}</option>)}
  </select>
}

export function BehaviorPanel({ settings, onChange, customDances, statusText, onPreview, onStop, language = 'zh' }: Props) {
  const catalog = animationCatalog(customDances, language)
  const current = settings.current
  const reactions = settings.reactions ?? []
  const [importError, setImportError] = useState('')
  const [reactionMsg, setReactionMsg] = useState('')
  const [testingId, setTestingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /** Inspector selection: one entry in the state/phase list below. */
  const [selected, setSelected] = useState<{ state: BehaviorStateId; phase: EntryPhase; index: number } | null>(null)

  const patchReactions = (fn: (list: CustomReaction[]) => CustomReaction[]) => {
    onChange({ ...settings, reactions: fn(clone(reactions)) })
  }
  const patchReaction = (id: string, fn: (reaction: CustomReaction) => void) => {
    patchReactions(list => {
      const target = list.find(r => r.id === id)
      if (target) fn(target)
      return list
    })
  }
  const addReaction = (template?: CustomReaction) => {
    setReactionMsg('')
    if (reactions.length >= 50) { setReactionMsg('Reaction limit reached (50).'); return }
    const base = clone(template ?? { id: '', name: 'New reaction', description: '', params: [], steps: [{ animation: 'action:excited', emotion: 'happy', durationMs: 3000 }] })
    const taken = new Set(reactions.map(r => r.id))
    let n = reactions.length + 1
    let id = slugifyReactionId(base.id, `reaction-${n}`)
    while (taken.has(id)) { n++; id = `reaction-${n}` }
    base.id = id
    const clean = normalizeReaction(base, id)
    if (!clean) { setReactionMsg('Could not create a reaction — try again.'); return }
    patchReactions(list => [...list, clean])
  }
  const testReaction = async (reaction: CustomReaction) => {
    setTestingId(reaction.id)
    setReactionMsg('')
    try {
      const defaults: Record<string, string | number | boolean> = {}
      for (const p of reaction.params) defaults[p.name] = p.default
      const response = await fetch(petUrl('/behaviors/trigger'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send the draft itself so the test never races the settings save.
        body: JSON.stringify({ id: reaction.id, params: defaults, reaction }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) setReactionMsg(`Test failed: ${data.error ?? response.status}`)
      else setReactionMsg(`Playing “${reaction.name}” on the pet (${data.steps ?? reaction.steps.length} steps).`)
    } catch (error) {
      setReactionMsg(`Test failed: ${String(error)}`)
    } finally {
      setTestingId(null)
    }
  }
  const pickReactionAnimation = (animationId: string): { animation: string; preset?: DancePreset } => {
    const option = catalog.find(o => o.id === animationId)
    return { animation: animationId, preset: option?.preset }
  }

  const patchCurrent = (fn: (profile: typeof current) => typeof current) => {
    onChange({ ...settings, current: fn(clone(current)) })
  }
  const patchState = (id: BehaviorStateId, fn: (state: StateBehavior) => void) => {
    patchCurrent(profile => { fn(profile.states[id]); return profile })
  }

  const pickAnimation = (id: string): { animation: string; preset?: DancePreset } => {
    const option = catalog.find(o => o.id === id)
    return { animation: id, preset: option?.preset }
  }

  /** Keep legacy `base` in sync: first Main entry, or empty for leave-as-is. */
  const syncBase = (state: StateBehavior) => {
    const first = state.mains[0]
    state.base = first ? (first.preset ? { animation: first.animation, preset: first.preset } : { animation: first.animation }) : { animation: '' }
  }
  const setMains = (id: BehaviorStateId, mains: WeightedEntry[]) => {
    patchState(id, state => { state.mains = mains; syncBase(state) })
  }
  const setMainEntry = (id: BehaviorStateId, index: number, patch: Partial<WeightedEntry>) => {
    patchState(id, state => {
      state.mains[index] = { ...state.mains[index], ...patch }
      if (patch.animation !== undefined) {
        const option = catalog.find(o => o.id === patch.animation)
        state.mains[index].preset = option?.preset
      }
      syncBase(state)
    })
  }
  const phaseEntries = (stateId: BehaviorStateId, phase: EntryPhase): BehaviorEntry[] => {
    const cfg = current.states[stateId]
    return phase === 'start' ? cfg.start : phase === 'end' ? cfg.end : phase === 'occasionals' ? cfg.occasionals : cfg.mains
  }

  const addEntry = (stateId: BehaviorStateId, phase: EntryPhase) => {
    const cfg = current.states[stateId]
    if (phase === 'start' && cfg.start.length < 5) {
      patchState(stateId, s => { s.start.push({ animation: 'idle' }) })
      setSelected({ state: stateId, phase, index: cfg.start.length })
    } else if (phase === 'end' && cfg.end.length < 5) {
      patchState(stateId, s => { s.end.push({ animation: 'idle' }) })
      setSelected({ state: stateId, phase, index: cfg.end.length })
    } else if (phase === 'occasionals' && cfg.occasionals.length < 8) {
      patchState(stateId, s => { s.occasionals.push({ animation: RANDOM_ACTION, emotion: RANDOM_EMOTION, everyMin: 45, everyMax: 75, chance: 0.5 }) })
      setSelected({ state: stateId, phase, index: cfg.occasionals.length })
    } else if (phase === 'mains' && cfg.mains.length < MAX_MAINS) {
      patchState(stateId, s => {
        s.mains.push({ animation: stateId === 'dancing' ? 'dance:jile' : 'idle', weight: 1 })
        syncBase(s)
      })
      setSelected({ state: stateId, phase, index: cfg.mains.length })
    }
  }

  const removeEntry = (stateId: BehaviorStateId, phase: EntryPhase, index: number) => {
    const len = phaseEntries(stateId, phase).length
    patchState(stateId, s => {
      if (phase === 'start') s.start.splice(index, 1)
      else if (phase === 'end') s.end.splice(index, 1)
      else if (phase === 'occasionals') s.occasionals.splice(index, 1)
      else { s.mains.splice(index, 1); syncBase(s) }
    })
    // Keep the selection on a neighbor instead of losing it.
    if (selected?.state === stateId && selected?.phase === phase) {
      if (len <= 1) setSelected(null)
      else if (selected.index === index) setSelected({ state: stateId, phase, index: Math.min(index, len - 2) })
      else if (selected.index > index) setSelected({ state: stateId, phase, index: selected.index - 1 })
    }
  }

  /** Preset for previews: stored on the entry, else resolved from the catalog. */
  const presetFor = (entry: BehaviorEntry) => entry.preset ?? catalog.find(o => o.id === entry.animation)?.preset

  /** Small meta line per list row: chance for mains, timing for occasionals, emotion otherwise. */
  const entryMeta = (stateId: BehaviorStateId, phase: EntryPhase, entry: BehaviorEntry): string => {
    if (phase === 'mains') {
      const mains = current.states[stateId].mains
      const total = mains.reduce((sum, e) => sum + Math.max(0, e.weight), 0)
      const weight = Math.max(0, (entry as WeightedEntry).weight ?? 0)
      return total > 0 ? `${Math.round((weight / total) * 100)}%` : '0%'
    }
    if (phase === 'occasionals') {
      const o = entry as OccasionalEntry
      return `every ${o.everyMin}–${o.everyMax}s · ${Math.round(o.chance * 100)}%`
    }
    return entry.emotion || ''
  }

  const updateEntry = (id: BehaviorStateId, list: 'start' | 'end', index: number, patch: Partial<BehaviorEntry>) => {
    patchState(id, state => { state[list][index] = { ...state[list][index], ...patch } })
  }
  const updateOccasional = (id: BehaviorStateId, index: number, patch: Partial<OccasionalEntry>) => {
    patchState(id, state => { state.occasionals[index] = { ...state.occasionals[index], ...patch } })
  }

  const tryEntry = (entry: BehaviorEntry, loop: boolean) => {
    if (loop) onPreview?.(entry.animation, entry.preset, 'loop')
    else onPreview?.(entry.animation, entry.preset, 'once')
  }

  const saveProfile = () => {
    const name = current.name.trim() || 'Untitled'
    const snapshot = normalizeProfile(clone({ ...current, name }), name)
    const profiles = settings.profiles.filter(p => p.name !== snapshot.name)
    onChange({ ...settings, current: snapshot, profiles: [...profiles, snapshot].slice(-20) })
  }
  const loadProfile = (name: string) => {
    const saved = settings.profiles.find(p => p.name === name)
    if (saved) onChange({ ...settings, current: clone(saved) })
  }
  const deleteProfile = (name: string) => {
    onChange({ ...settings, profiles: settings.profiles.filter(p => p.name !== name) })
  }
  const exportProfile = () => {
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${current.name.trim() || 'behavior'}.behavior.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const importProfile = async (file: File) => {
    setImportError('')
    try {
      const parsed = JSON.parse(await file.text())
      const profile = normalizeProfile(parsed?.current ?? parsed, file.name.replace(/\.behavior\.json$/i, '').slice(0, 60) || 'Imported')
      onChange({ ...settings, current: profile })
    } catch {
      setImportError('That file is not a valid behavior profile.')
    }
  }

  // Inspector selection: the explicit choice when still valid, else the topmost entry.
  const selValid = selected && phaseEntries(selected.state, selected.phase)[selected.index] !== undefined ? selected : null
  const selFallback = (() => {
    for (const { id: stateId } of BEHAVIOR_STATES)
      for (const { id: phase } of PHASES)
        if (phaseEntries(stateId, phase).length > 0) return { state: stateId, phase, index: 0 }
    return null
  })()
  const sel = selValid ?? selFallback
  const selEntry = sel ? phaseEntries(sel.state, sel.phase)[sel.index] : undefined
  const selStateLabel = sel ? BEHAVIOR_STATES.find(s => s.id === sel.state)?.label ?? sel.state : ''
  const selPhaseLabel = sel ? PHASES.find(p => p.id === sel.phase)?.label ?? sel.phase : ''

  return <div style={{ display: 'grid', gap: 18, fontSize: 14 }}>
    {statusText && <div role="status" style={{ ...row, background: '#22303f', border: '1px solid #39465c', borderRadius: 8, padding: '9px 12px' }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: '#7fe08a', display: 'inline-block' }} />
      <span>Now: <strong>{statusText}</strong></span>
    </div>}
    <label style={{ ...row, cursor: 'pointer' }}>
      <input type="checkbox" checked={settings.enabled} onChange={e => onChange({ ...settings, enabled: e.target.checked })} />
      <span><strong>Behavior engine enabled</strong><br /><span style={muted}>When off, the pet falls back to its built-in idle behavior.</span></span>
    </label>
    <div style={{ ...row, background: '#1c2330', border: '1px solid #39465c', borderRadius: 8, padding: 12 }}>
      <input aria-label="Profile name" value={current.name} onChange={e => patchCurrent(profile => ({ ...profile, name: e.target.value.slice(0, 60) }))} style={{ flex: '1 1 140px', minWidth: 0 }} />
      <button style={smallButton} onClick={saveProfile} title="Save the current setup as a named profile"><Save size={13} style={{ verticalAlign: -2 }} /> Save profile</button>
      <button style={smallButton} onClick={() => patchCurrent(() => defaultBehaviorProfile())} title="Reset the editor to the default setup">Reset to default</button>
      <button style={smallButton} onClick={exportProfile} title="Download this profile as a JSON file to share"><Download size={13} style={{ verticalAlign: -2 }} /> Export</button>
      <button style={smallButton} onClick={() => fileRef.current?.click()} title="Load a profile from a shared JSON file"><Upload size={13} style={{ verticalAlign: -2 }} /> Import</button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importProfile(file); e.target.value = '' }} />
    </div>
    {importError && <div role="alert" style={{ color: '#ff9d9d' }}>{importError}</div>}
    {settings.profiles.length > 0 && <div style={row}>
      <span style={muted}>Saved profiles:</span>
      {settings.profiles.map(profile => <span key={profile.name} style={{ ...row, gap: 4, background: '#262c38', borderRadius: 7, padding: '3px 4px 3px 9px', border: '1px solid #505665' }}>
        <button style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', padding: 0 }} onClick={() => loadProfile(profile.name)} title={`Load ${profile.name}`}>{profile.name}</button>
        <button style={{ background: 'none', border: 'none', color: '#adb5c8', cursor: 'pointer', padding: '0 4px' }} onClick={() => deleteProfile(profile.name)} title={`Delete ${profile.name}`} aria-label={`Delete ${profile.name}`}><Trash2 size={13} /></button>
      </span>)}
    </div>}

    <section aria-label="Custom reactions" style={{ border: '1px solid #39465c', borderRadius: 10, padding: 14, display: 'grid', gap: 12, background: '#1a2130' }}>
      <div>
        <strong style={{ fontSize: 15 }}>Custom reactions</strong>
        <div style={muted}>One-shot behaviors any agent can call by id — e.g. after a git push. They play once and the pet returns to its current state. Persistent states (idle / working / music / dancing) stay fixed; reactions are the way to add new callable behaviors.</div>
      </div>
      <div style={row}>
        <button style={smallButton} onClick={() => addReaction()}><Plus size={12} style={{ verticalAlign: -2 }} /> New reaction</button>
        <button style={smallButton} onClick={() => addReaction(exampleReaction())} title="Add the rocket-launch celebrate-a-deploy example"><Plus size={12} style={{ verticalAlign: -2 }} /> Add rocket-launch example</button>
        <span style={muted}>Agents browse these with <code>cuttle-pet behaviors</code> and call them with <code>cuttle-pet react &lt;id&gt;</code>.</span>
      </div>
      {reactionMsg && <div role="status" style={{ color: '#9fd6ff' }}>{reactionMsg}</div>}
      {reactions.length === 0 && <span style={muted}>No custom reactions yet — add one, or start from the rocket-launch example.</span>}
      {/* Index keys: the id is editable, and keying on it would remount the card (dropping input focus) on every keystroke. */}
      {reactions.map((reaction, reactionIndex) => <article key={reactionIndex} aria-label={`Reaction ${reaction.id}`} style={{ border: '1px solid #2c3547', borderRadius: 8, padding: 12, display: 'grid', gap: 10, background: '#202839' }}>
        <div style={row}>
          <code style={{ color: '#9fd6ff' }}>{reaction.id}</code>
          <span style={muted}>{describeReaction(reaction)}</span>
          <span style={{ flex: 1 }} />
          <button style={smallButton} onClick={() => void testReaction(reaction)} disabled={testingId === reaction.id} title="Play this reaction on the pet with default parameters"><FlaskConical size={12} style={{ verticalAlign: -2 }} /> {testingId === reaction.id ? 'Playing…' : 'Test on pet'}</button>
          <button style={smallButton} onClick={() => patchReactions(list => list.filter(r => r.id !== reaction.id))} title="Delete" aria-label={`Delete ${reaction.id}`}><Trash2 size={12} /></button>
        </div>
        <div style={row}>
          <input aria-label="Reaction name" value={reaction.name} onChange={e => patchReaction(reaction.id, r => { r.name = e.target.value.slice(0, 60) })} style={{ flex: '1 1 160px', minWidth: 0 }} placeholder="Name" />
          <input aria-label="Reaction id" value={reaction.id} onChange={e => {
            const next = editReactionId(e.target.value)
            if (next && next !== reaction.id && !reactions.some(r => r.id === next)) patchReaction(reaction.id, r => { r.id = next })
          }} style={{ flex: '0 1 160px', minWidth: 0 }} title="Stable id used by the API/CLI (a-z 0-9 - _)" />
        </div>
        <input aria-label="Agent description" value={reaction.description} onChange={e => patchReaction(reaction.id, r => { r.description = e.target.value.slice(0, 280) })} style={{ width: '100%', boxSizing: 'border-box' }} placeholder="Description agents see when browsing (when should they call this?)" />
        <code style={{ ...muted, wordBreak: 'break-all' }}>{reactionCliExample(reaction.id, reaction.params)}</code>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={muted}>Parameters — referenced in speech text as {`{{name}}`}:</span>
          {reaction.params.length === 0 && <span style={muted}>None. Add one for e.g. “dance for n seconds”.</span>}
          {reaction.params.map((param, index) => <ReactionParamRow
            key={index}
            param={param}
            nameTaken={name => reaction.params.some((p, i) => i !== index && p.name === name)}
            fallbackName={`param${index + 1}`}
            onPatch={patch => patchReaction(reaction.id, r => { Object.assign(r.params[index], patch) })}
            onRemove={() => patchReaction(reaction.id, r => { r.params.splice(index, 1) })}
          />)}
          <div><button style={smallButton} onClick={() => patchReaction(reaction.id, r => {
            if (r.params.length < 8) {
              let n = r.params.length + 1
              let name = `param${n}`
              while (r.params.some(p => p.name === name)) { n++; name = `param${n}` }
              r.params.push({ name, type: 'string', default: '', description: '' })
            }
          })}><Plus size={12} style={{ verticalAlign: -2 }} /> Add parameter</button></div>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={muted}>Steps — played in order, then the pet returns to its state:</span>
          {reaction.steps.map((step, index) => <div key={index} style={row}>
            <span style={{ ...muted, minWidth: 18 }}>{index + 1}.</span>
            <AnimationSelect value={step.animation} catalog={catalog} onPick={animationId => patchReaction(reaction.id, r => { r.steps[index] = { ...r.steps[index], ...pickReactionAnimation(animationId) } })} />
            <EmotionSelect value={step.emotion ?? ''} onPick={emotion => patchReaction(reaction.id, r => { r.steps[index].emotion = emotion })} />
            <input aria-label="Speech text" value={step.say ?? ''} onChange={e => patchReaction(reaction.id, r => { r.steps[index].say = e.target.value.slice(0, 280) })} placeholder="Say… ({{param}})" style={{ flex: '1 1 140px', minWidth: 0 }} />
            <label style={{ ...muted, display: 'flex', gap: 4, alignItems: 'center' }}>
              <SecondsInput valueMs={step.durationMs} onCommit={ms => patchReaction(reaction.id, r => { r.steps[index].durationMs = ms })} />s
            </label>
            <label style={{ ...muted, display: 'flex', gap: 4, alignItems: 'center' }} title="Show the laptop + typing pose for this step">
              <input type="checkbox" checked={!!step.props?.working} onChange={e => patchReaction(reaction.id, r => {
                const props = { ...(r.steps[index].props ?? {}) }
                if (e.target.checked) props.working = true
                else delete props.working
                r.steps[index].props = Object.keys(props).length ? props : undefined
              })} /> laptop
            </label>
            <label style={{ ...muted, display: 'flex', gap: 4, alignItems: 'center' }} title="Sip coffee on this step">
              <input type="checkbox" checked={!!step.props?.sip} onChange={e => patchReaction(reaction.id, r => {
                const props = { ...(r.steps[index].props ?? {}) }
                if (e.target.checked) props.sip = true
                else delete props.sip
                r.steps[index].props = Object.keys(props).length ? props : undefined
              })} /> coffee
            </label>
            <button style={smallButton} onClick={() => tryEntry(step, false)} title="Try once"><Play size={12} /></button>
            <button style={smallButton} onClick={() => patchReaction(reaction.id, r => { if (r.steps.length > 1) r.steps.splice(index, 1) })} title="Remove" aria-label="Remove step"><Trash2 size={12} /></button>
          </div>)}
          <div><button style={smallButton} onClick={() => patchReaction(reaction.id, r => {
            if (r.steps.length < 10) r.steps.push({ animation: 'idle', durationMs: 3000 })
          })}><Plus size={12} style={{ verticalAlign: -2 }} /> Add step</button></div>
        </div>
      </article>)}
    </section>

    <div className="animation-layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1.65fr) minmax(150px, 0.85fr)', gap: 16, alignItems: 'stretch' }}>
        <div className="animation-list" role="listbox" aria-label="Behavior animations" style={{ overflowY: 'auto', height: '100%', minHeight: 330, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {BEHAVIOR_STATES.map(({ id: stateId, label: stateLabel, hint }) => (
            <div key={stateId} style={{ display: 'grid', gap: 6 }}>
              <div><strong style={{ fontSize: 13 }}>{stateLabel}</strong><div style={muted}>{hint}</div></div>
              {PHASES.map(({ id: phase, label: phaseLabel, addLabel, cap }) => {
                const entries = phaseEntries(stateId, phase)
                return <div key={phase} style={{ display: 'grid', gap: 4 }}>
                  <span style={muted}>{phaseLabel}</span>
                  {entries.map((entry, index) => {
                    const isSel = sel?.state === stateId && sel?.phase === phase && sel?.index === index
                    const preset = presetFor(entry)
                    const title = animationLabel(entry.animation, customDances, language)
                    return <div key={stateId + ':' + phase + ':' + index} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <button role="option" aria-selected={isSel} onClick={() => setSelected({ state: stateId, phase, index })} style={{ ...button, padding: '6px 10px', flex: 1, minWidth: 0, background: isSel ? '#385a90' : '#262c38', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {title} <small style={{ color: '#b5becf' }}>{entryMeta(stateId, phase, entry)}</small>
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'row', gap: 2, flexShrink: 0 }}>
                        <button title={'Play ' + title + ' once'} aria-label={'Play ' + title + ' once'} onClick={() => onPreview?.(entry.animation, preset, 'once')} style={{ ...button, padding: '6px 7px' }}><Play size={12} /></button>
                        <button title={'Play ' + title + ' looped'} aria-label={'Play ' + title + ' looped'} onClick={() => onPreview?.(entry.animation, preset, 'loop')} style={{ ...button, padding: '6px 7px' }}><Repeat size={12} /></button>
                        <button title={'Stop ' + title} aria-label={'Stop ' + title} onClick={() => onStop?.()} style={{ ...button, padding: '6px 7px' }}><Square size={12} /></button>
                      </div>
                    </div>
                  })}
                  <div><button style={smallButton} disabled={entries.length >= cap} onClick={() => addEntry(stateId, phase)} title={entries.length >= cap ? 'At most ' + cap : undefined}><Plus size={12} style={{ verticalAlign: -2 }} /> {addLabel}</button></div>
                </div>
              })}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {sel && selEntry ? <>
            <div>
              <span style={muted}>{selStateLabel} · {selPhaseLabel} · #{sel.index + 1}</span>
              <div><strong style={{ fontSize: 15 }}>{animationLabel(selEntry.animation, customDances, language)}</strong></div>
            </div>
            <label style={{ display: 'grid', gap: 8 }}>Animation
              <AnimationSelect value={selEntry.animation} catalog={catalog} allowLeaveAlone={sel.state === 'dancing'} onPick={animationId => {
                const picked = pickAnimation(animationId)
                if (sel.phase === 'mains') setMainEntry(sel.state, sel.index, { animation: picked.animation, preset: picked.preset })
                else if (sel.phase === 'occasionals') updateOccasional(sel.state, sel.index, { animation: picked.animation, preset: picked.preset })
                else updateEntry(sel.state, sel.phase, sel.index, { animation: picked.animation, preset: picked.preset })
              }} />
            </label>
            {sel.phase === 'mains' && (() => {
              const mains = current.states[sel.state].mains
              const total = mains.reduce((sum, e) => sum + Math.max(0, e.weight), 0)
              const w = Math.max(0, (selEntry as WeightedEntry).weight ?? 0)
              const pct = total > 0 ? Math.round((w / total) * 100) : 0
              return <label style={{ display: 'grid', gap: 8 }}>Pick weight — {pct}% of {selPhaseLabel}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <input aria-label="Pick weight" type="range" min={0} max={99} step={1} value={w} onChange={e => setMainEntry(sel.state, sel.index, { weight: Number(e.target.value) })} style={{ flex: 1, minWidth: 0 }} />
                  <output style={{ minWidth: 44 }}>×{w}</output>
                </div>
              </label>
            })()}
            {sel.phase !== 'mains' && (
              <label style={{ display: 'grid', gap: 8 }}>Emotion
                <EmotionSelect value={selEntry.emotion ?? ''} onPick={emotion => {
                  if (sel.phase === 'occasionals') updateOccasional(sel.state, sel.index, { emotion })
                  else updateEntry(sel.state, sel.phase as 'start' | 'end', sel.index, { emotion })
                }} />
              </label>
            )}
            {sel.phase === 'occasionals' && (
              <label style={{ display: 'grid', gap: 8 }}>Timing
                <span style={{ ...muted, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>every
                  <input aria-label="Minimum seconds" type="number" min={5} max={3600} value={(selEntry as OccasionalEntry).everyMin} onChange={e => updateOccasional(sel.state, sel.index, { everyMin: Number(e.target.value) })} style={numberInput} />
                  –<input aria-label="Maximum seconds" type="number" min={5} max={3600} value={(selEntry as OccasionalEntry).everyMax} onChange={e => updateOccasional(sel.state, sel.index, { everyMax: Number(e.target.value) })} style={numberInput} />s
                  at {(selEntry as OccasionalEntry).chance !== undefined ? Math.round((selEntry as OccasionalEntry).chance * 100) : 0}%
                  <input aria-label="Chance percent" type="range" min={0} max={100} step={5} value={Math.round((selEntry as OccasionalEntry).chance * 100)} onChange={e => updateOccasional(sel.state, sel.index, { chance: Number(e.target.value) / 100 })} style={{ flex: 1, minWidth: 80 }} />
                </span>
              </label>
            )}
            <button style={button} onClick={() => onPreview?.(selEntry.animation, presetFor(selEntry), 'once')}>Preview once</button>
            <button style={button} onClick={() => onPreview?.(selEntry.animation, presetFor(selEntry), 'loop')}>Preview looped</button>
            <button style={button} onClick={onStop}>Stop preview</button>
            <button style={button} onClick={() => removeEntry(sel.state, sel.phase, sel.index)}>Remove entry</button>
          </> : <span style={muted}>No animations yet — add one from any section on the left.</span>}
        </div>
      </div>
  </div>
}

/** Step length in seconds; keeps a local draft so clearing the box to retype doesn't snap to a default. */
function SecondsInput({ valueMs, onCommit }: { valueMs: number; onCommit: (ms: number) => void }) {
  const parse = (text: string) => {
    const seconds = Number(text)
    return text.trim() && Number.isFinite(seconds) ? Math.max(500, Math.min(30000, Math.round(seconds * 1000))) : null
  }
  const [draft, setDraft] = useState(String(valueMs / 1000))
  // Follow outside changes, but keep an in-progress draft like "1." that already means this value.
  useEffect(() => { setDraft(d => parse(d) === valueMs ? d : String(valueMs / 1000)) }, [valueMs])
  return <input aria-label="Step seconds" type="number" min={0.5} max={30} step={0.5} value={draft}
    onChange={e => {
      setDraft(e.target.value)
      const ms = parse(e.target.value)
      // Commit in-range values while typing; out-of-range ones clamp on blur.
      if (ms !== null && ms === Math.round(Number(e.target.value) * 1000)) onCommit(ms)
    }}
    onBlur={() => {
      const ms = parse(draft)
      if (ms === null) setDraft(String(valueMs / 1000))
      else if (ms !== valueMs) onCommit(ms)
      else setDraft(String(ms / 1000))
    }}
    style={{ width: 52 }} />
}

function ReactionParamRow({ param, nameTaken, fallbackName, onPatch, onRemove }: {
  param: ReactionParam
  nameTaken: (name: string) => boolean
  fallbackName: string
  onPatch: (patch: Partial<ReactionParam>) => void
  onRemove: () => void
}) {
  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
  const smallButton: React.CSSProperties = { padding: '5px 9px', fontSize: 13, border: '1px solid #505665', borderRadius: 7, background: '#303645', color: 'white', cursor: 'pointer', textAlign: 'left' }
  return <div style={row}>
    <input aria-label="Parameter name" value={param.name} onChange={e => {
      const name = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30)
      onPatch({ name })
    }} onBlur={() => {
      // Invalid or duplicate names would be dropped on the next load; replace them now.
      if (isValidReactionParamName(param.name) && !nameTaken(param.name)) return
      let n = 1
      let name = fallbackName
      while (nameTaken(name)) name = `${fallbackName}_${++n}`
      onPatch({ name })
    }} title="Letters, digits and _; must start with a letter" style={{ flex: '0 1 110px', minWidth: 0 }} placeholder="name" />
    <select aria-label="Parameter type" value={param.type} onChange={e => onPatch({ type: e.target.value as ReactionParam['type'] })}>
      <option value="string">string</option>
      <option value="number">number</option>
      <option value="boolean">boolean</option>
    </select>
    <input aria-label="Default value" value={String(param.default)} onChange={e => {
      const raw = e.target.value
      if (param.type === 'number') onPatch({ default: Number.isFinite(Number(raw)) ? Number(raw) : 0 })
      else if (param.type === 'boolean') onPatch({ default: ['true', '1', 'yes', 'y', 'on'].includes(raw.trim().toLowerCase()) })
      else onPatch({ default: raw.slice(0, 200) })
    }} style={{ flex: '0 1 110px', minWidth: 0 }} placeholder="default" />
    <input aria-label="Parameter description" value={param.description} onChange={e => onPatch({ description: e.target.value.slice(0, 200) })} style={{ flex: '1 1 160px', minWidth: 0 }} placeholder="What is this for?" />
    <button style={smallButton} onClick={onRemove} title="Remove" aria-label="Remove parameter"><Trash2 size={12} /></button>
  </div>
}
