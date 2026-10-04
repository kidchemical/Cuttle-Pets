import { useState } from 'react'
import { Play, Repeat, Square } from 'lucide-react'
import { actionPresets, dancePresets, type DancePreset } from '../motion-controller'
import { animationOptions, proceduralSpeed, DEFAULT_ANIMATIONS, DEFAULT_ANIMATION, proceduralAnimations, type AnimationSettings } from '../animation-settings'

export type PreviewMode = 'once' | 'loop'

interface Props {
  settings: AnimationSettings
  onChange: (settings: AnimationSettings) => void
  customDances: { id: string; label: string; vmdUrl: string; bgmUrl?: string }[]
  onPreview?: (id: string, preset?: DancePreset, mode?: PreviewMode) => void
  onStop?: () => void
  /** Live "what is the pet doing" line, when the main window publishes it. */
  statusText?: string | null
}
const button: React.CSSProperties = { padding: '9px 12px', border: '1px solid #505665', borderRadius: 7, background: '#303645', color: 'white', cursor: 'pointer', textAlign: 'left' }
export function AnimationSettingsPanel({ settings, onChange, customDances, onPreview, onStop, statusText }: Props) {
  const [selected, setSelected] = useState('idle')
  const [query, setQuery] = useState('')
  const items: { id: string; label: string; group: string; procedural: boolean; preset?: DancePreset }[] = [
    { id: 'idle', label: 'Idle loop', group: 'Idle', procedural: false },
    ...Object.entries(actionPresets).map(([id, preset]) => ({ id: `action:${id}`, label: preset.label, group: 'Actions', procedural: false })),
    ...Object.entries(dancePresets).map(([id, preset]) => ({ id: `dance:${id}`, label: preset.label, group: 'Dances', procedural: false })),
    ...customDances.map(dance => ({ id: `dance:custom:${dance.id}`, label: dance.label, group: 'Imported dances', procedural: false, preset: { label: dance.label, type: 'vmd' as const, url: dance.vmdUrl, bgm: dance.bgmUrl } })),
    ...proceduralAnimations.map(item => ({ ...item, group: 'Procedural', procedural: true })),
  ]
  const item = items.find(item => item.id === selected) ?? items[0]
  const options = animationOptions(settings, item.id)
  const update = (patch: Partial<typeof options>) => onChange({ ...settings, overrides: { ...settings.overrides, [item.id]: { ...options, ...patch } } })
  const slider = (label: string, value: number, min: number, max: number, step: number, change: (n: number) => void, unit = '×') => (
    <label style={{ display: 'grid', gap: 8 }}>{label}<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={e => change(Number(e.target.value))} style={{ flex: 1, minWidth: 0 }} />
      <output style={{ minWidth: 54 }}>{value.toFixed(2)}{unit}</output>
    </div></label>
  )
  return <div style={{ display: 'grid', gap: 18, fontSize: 14 }}>
    {statusText && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#22303f', border: '1px solid #39465c', borderRadius: 8, padding: '9px 12px' }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: '#7fe08a', display: 'inline-block' }} />
      <span>Now: <strong>{statusText}</strong></span>
    </div>}
    {slider('Global animation speed', settings.speed, .1, 4, .05, speed => onChange({ ...settings, speed }))}
    <p style={{ color: '#adb5c8', lineHeight: 1.5 }}>Global and individual speeds multiply for base clips (idle, actions, dances). Procedural layers (typing, music nod, eyes, blink, …) use only their individual speed. Changes apply immediately. Speech audio stays synchronized; music beat matching works best at 1×.</p>
    <input aria-label="Search animations" placeholder="Search animations…" value={query} onChange={e => setQuery(e.target.value)} style={{ ...button, width: '100%' }} />
    <div className="animation-layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) minmax(180px, 1.3fr)', gap: 16 }}>
      <div className="animation-list" role="listbox" aria-label="Animations" style={{ overflowY: 'auto', height: 330, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {items.filter(item => `${item.label} ${item.group}`.toLowerCase().includes(query.toLowerCase())).map(entry => <div key={entry.id} style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
          <button role="option" aria-selected={item.id === entry.id} onClick={() => setSelected(entry.id)} style={{ ...button, flex: 1, minWidth: 0, background: item.id === entry.id ? '#385a90' : '#262c38' }}>
            {entry.label}<small style={{ display: 'block', marginTop: 4, color: '#b5becf' }}>{entry.group}{settings.overrides[entry.id] ? ' · customized' : ''}</small>
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <button title={`Play ${entry.label} once`} aria-label={`Play ${entry.label} once`} onClick={() => onPreview?.(entry.id, entry.preset, 'once')} style={{ ...button, padding: '4px 7px' }}><Play size={12} /></button>
            <button title={`Play ${entry.label} looped`} aria-label={`Play ${entry.label} looped`} onClick={() => onPreview?.(entry.id, entry.preset, 'loop')} style={{ ...button, padding: '4px 7px' }}><Repeat size={12} /></button>
            <button title={`Stop ${entry.label}`} aria-label={`Stop ${entry.label}`} onClick={() => onStop?.()} style={{ ...button, padding: '4px 7px' }}><Square size={12} /></button>
          </div>
        </div>)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <strong>{item.label}</strong>
        {slider('Individual speed', options.speed, .1, 4, .05, speed => update({ speed }))}
        <span>Effective speed: {(item.procedural ? proceduralSpeed(settings, item.id) : settings.speed * options.speed).toFixed(2)}×{item.procedural ? ' (individual only)' : ''}</span>
        {!item.procedural && slider('Transition duration', options.transition, 0, 3, .05, transition => update({ transition }), 's')}
        {item.id.startsWith('action:') && slider('Held pose duration', options.hold, 0, 60, 1, hold => update({ hold }), 's')}
        {item.id.startsWith('action:') && <small style={{ color: '#adb5c8' }}>Held duration applies when an interaction requests a held pose.</small>}
        <button style={button} onClick={() => onPreview?.(item.id, item.preset, 'once')}>Preview on pet</button>
        <button style={button} onClick={() => onPreview?.(item.id, item.preset, 'loop')}>Preview looped</button>
        <button style={button} onClick={onStop}>Stop preview / return to idle</button>
        <button style={button} onClick={() => { const overrides = { ...settings.overrides }; delete overrides[item.id]; onChange({ ...settings, overrides }) }}>Reset this animation</button>
      </div>
    </div>
    <button style={button} onClick={() => onChange({ ...DEFAULT_ANIMATIONS, overrides: {} })}>Reset all animations</button>
  </div>
}
