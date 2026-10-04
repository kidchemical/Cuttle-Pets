import { useRef, useState } from 'react'
import { Play, Repeat, Square, Plus, Trash2, Download, Upload, Save } from 'lucide-react'
import {
  BEHAVIOR_STATES, EMOTION_OPTIONS, RANDOM_ACTION, RANDOM_EMOTION, animationCatalog,
  normalizeProfile, defaultBehaviorProfile,
  type AnimationOption, type BehaviorEntry, type BehaviorSettings, type BehaviorStateId,
  type OccasionalEntry, type StateBehavior,
} from '../behavior'
import type { DancePreset } from '../motion-controller'
import type { PreviewMode } from './AnimationSettingsPanel'

interface Props {
  settings: BehaviorSettings
  onChange: (value: BehaviorSettings) => void
  customDances: { id: string; label: string; vmdUrl: string; bgmUrl?: string }[]
  statusText: string | null
  onPreview?: (id: string, preset?: DancePreset, mode?: PreviewMode) => void
  onStop?: () => void
}

/** Plain-data clone (profiles are JSON; avoids webview structuredClone gaps). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
const button: React.CSSProperties = { padding: '9px 12px', border: '1px solid #505665', borderRadius: 7, background: '#303645', color: 'white', cursor: 'pointer', textAlign: 'left' }
const smallButton: React.CSSProperties = { ...button, padding: '5px 9px', fontSize: 13 }
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const select: React.CSSProperties = { flex: '1 1 160px', minWidth: 0 }
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

function EmotionSelect({ value, onPick }: { value: string; onPick: (emotion: string) => void }) {
  return <select aria-label="Emotion" value={value || ''} onChange={e => onPick(e.target.value)} style={{ flex: '0 1 130px', minWidth: 0 }}>
    <option value="">No emotion</option>
    <option value={RANDOM_EMOTION}>Surprise emotion</option>
    {EMOTION_OPTIONS.map(emotion => <option key={emotion} value={emotion}>{emotion}</option>)}
  </select>
}

export function BehaviorPanel({ settings, onChange, customDances, statusText, onPreview, onStop }: Props) {
  const catalog = animationCatalog(customDances)
  const current = settings.current
  const [importError, setImportError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

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

  const setBase = (id: BehaviorStateId, animationId: string) => {
    const picked = pickAnimation(animationId)
    patchState(id, state => { state.base = { animation: picked.animation, preset: picked.preset } })
  }
  const addStart = (id: BehaviorStateId) => patchState(id, state => {
    if (state.start.length < 5) state.start.push({ animation: 'idle' })
  })
  const addOccasional = (id: BehaviorStateId) => patchState(id, state => {
    if (state.occasionals.length < 8) state.occasionals.push({ animation: RANDOM_ACTION, emotion: RANDOM_EMOTION, everyMin: 45, everyMax: 75, chance: 0.5 })
  })
  const addEnd = (id: BehaviorStateId) => patchState(id, state => {
    if (state.end.length < 5) state.end.push({ animation: 'idle' })
  })

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

    {BEHAVIOR_STATES.map(({ id, label, hint }) => {
      const cfg = current.states[id]
      return <section key={id} aria-label={`${label} state`} style={{ border: '1px solid #39465c', borderRadius: 10, padding: 14, display: 'grid', gap: 12, background: '#1a2130' }}>
        <div><strong style={{ fontSize: 15 }}>{label}</strong><div style={muted}>{hint}</div></div>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={muted}>Start — plays once when entering {label.toLowerCase()}:</span>
          {cfg.start.length === 0 && <span style={muted}>Nothing — jumps straight to the base loop.</span>}
          {cfg.start.map((entry, index) => <div key={index} style={row}>
            <AnimationSelect value={entry.animation} catalog={catalog} onPick={animationId => updateEntry(id, 'start', index, pickAnimation(animationId))} />
            <EmotionSelect value={entry.emotion ?? ''} onPick={emotion => updateEntry(id, 'start', index, { emotion })} />
            <button style={smallButton} onClick={() => tryEntry(entry, false)} title="Try once"><Play size={12} /></button>
            <button style={smallButton} onClick={() => patchState(id, state => { state.start.splice(index, 1) })} title="Remove" aria-label="Remove start entry"><Trash2 size={12} /></button>
          </div>)}
          <div><button style={smallButton} onClick={() => addStart(id)}><Plus size={12} style={{ verticalAlign: -2 }} /> Add entry animation</button></div>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={muted}>Main — the sustaining base loop:</span>
          <div style={row}>
            <AnimationSelect value={cfg.base.animation} catalog={catalog} allowLeaveAlone={id === 'dancing'} onPick={animationId => setBase(id, animationId)} />
            <button style={smallButton} onClick={() => onPreview?.(cfg.base.animation, cfg.base.preset, 'loop')} title="Try base looped"><Repeat size={12} /></button>
            <button style={smallButton} onClick={() => onStop?.()} title="Stop"><Square size={12} /></button>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={muted}>Also during {label.toLowerCase()} — occasional one-shots:</span>
          {cfg.occasionals.length === 0 && <span style={muted}>Nothing extra happens.</span>}
          {cfg.occasionals.map((entry, index) => <div key={index} style={row}>
            <AnimationSelect value={entry.animation} catalog={catalog} onPick={animationId => updateOccasional(id, index, pickAnimation(animationId))} />
            <EmotionSelect value={entry.emotion ?? ''} onPick={emotion => updateOccasional(id, index, { emotion })} />
            <label style={{ ...muted, display: 'flex', gap: 4, alignItems: 'center' }}>every
              <input aria-label="Minimum seconds" type="number" min={5} max={3600} value={entry.everyMin} onChange={e => updateOccasional(id, index, { everyMin: Number(e.target.value) })} style={{ width: 56 }} />
              –<input aria-label="Maximum seconds" type="number" min={5} max={3600} value={entry.everyMax} onChange={e => updateOccasional(id, index, { everyMax: Number(e.target.value) })} style={{ width: 56 }} />s
            </label>
            <label style={{ ...muted, display: 'flex', gap: 6, alignItems: 'center' }}>{Math.round(entry.chance * 100)}%
              <input aria-label="Chance percent" type="range" min={0} max={100} step={5} value={Math.round(entry.chance * 100)} onChange={e => updateOccasional(id, index, { chance: Number(e.target.value) / 100 })} style={{ width: 70 }} />
            </label>
            <button style={smallButton} onClick={() => tryEntry(entry, false)} title="Try once"><Play size={12} /></button>
            <button style={smallButton} onClick={() => patchState(id, state => { state.occasionals.splice(index, 1) })} title="Remove" aria-label="Remove occasional"><Trash2 size={12} /></button>
          </div>)}
          <div><button style={smallButton} onClick={() => addOccasional(id)}><Plus size={12} style={{ verticalAlign: -2 }} /> Add occasional</button></div>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={muted}>End — plays once when leaving {label.toLowerCase()}:</span>
          {cfg.end.length === 0 && <span style={muted}>Nothing — hands straight over to the next state.</span>}
          {cfg.end.map((entry, index) => <div key={index} style={row}>
            <AnimationSelect value={entry.animation} catalog={catalog} onPick={animationId => updateEntry(id, 'end', index, pickAnimation(animationId))} />
            <EmotionSelect value={entry.emotion ?? ''} onPick={emotion => updateEntry(id, 'end', index, { emotion })} />
            <button style={smallButton} onClick={() => tryEntry(entry, false)} title="Try once"><Play size={12} /></button>
            <button style={smallButton} onClick={() => patchState(id, state => { state.end.splice(index, 1) })} title="Remove" aria-label="Remove end entry"><Trash2 size={12} /></button>
          </div>)}
          <div><button style={smallButton} onClick={() => addEnd(id)}><Plus size={12} style={{ verticalAlign: -2 }} /> Add exit animation</button></div>
        </div>
      </section>
    })}
  </div>
}
