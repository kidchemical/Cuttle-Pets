import { useState } from 'react'
import { Play, Repeat, Square } from 'lucide-react'
import { actionPresets, dancePresets, localizedPresetLabel, type DancePreset } from '../motion-controller'
import { animationOptions, proceduralSpeed, DEFAULT_ANIMATIONS, DEFAULT_ANIMATION, proceduralAnimations, type AnimationSettings } from '../animation-settings'

export type PreviewMode = 'once' | 'loop'

interface Props {
  settings: AnimationSettings
  onChange: (settings: AnimationSettings) => void
  customDances: { id: string; label: string; vmdUrl: string; bgmUrl?: string; type?: 'vmd' | 'vrma' | 'fbx' }[]
  onPreview?: (id: string, preset?: DancePreset, mode?: PreviewMode) => void
  onStop?: () => void
  language?: 'zh' | 'en'
}
const button: React.CSSProperties = { padding: '9px 12px', border: '1px solid #505665', borderRadius: 7, background: '#303645', color: 'white', cursor: 'pointer', textAlign: 'left' }
export function AnimationSettingsPanel({ settings, onChange, customDances, onPreview, onStop, language = 'zh' }: Props) {
  const [selected, setSelected] = useState('idle')
  const [query, setQuery] = useState('')
  const items: { id: string; label: string; group: string; procedural: boolean; preset?: DancePreset }[] = [
    { id: 'idle', label: 'Idle loop', group: 'Idle', procedural: false },
    ...Object.entries(actionPresets).map(([id, preset]) => ({ id: `action:${id}`, label: localizedPresetLabel(preset, language), group: 'Actions', procedural: false })),
    ...Object.entries(dancePresets).map(([id, preset]) => ({ id: `dance:${id}`, label: localizedPresetLabel(preset, language), group: 'Dances', procedural: false })),
    ...customDances.map(dance => ({ id: `dance:custom:${dance.id}`, label: dance.label, group: 'Imported dances', procedural: false, preset: { label: dance.label, type: dance.type ?? 'vmd', url: dance.vmdUrl, bgm: dance.bgmUrl } })),
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
    {slider('Global animation speed', settings.speed, .1, 4, .05, speed => onChange({ ...settings, speed }))}
    <p style={{ color: '#adb5c8', lineHeight: 1.5 }}>Global and individual speeds multiply for base clips (idle, actions, dances). Procedural layers (typing, music nod, eyes, blink, …) use only their individual speed. Changes apply immediately. Speech audio stays synchronized; music beat matching works best at 1×.</p>
    <input aria-label="Search animations" placeholder="Search animations…" value={query} onChange={e => setQuery(e.target.value)} style={{ ...button, width: '100%' }} />
    <div className="animation-layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1.65fr) minmax(150px, 0.85fr)', gap: 16, alignItems: 'stretch' }}>
      <div className="animation-list" role="listbox" aria-label="Animations" style={{ overflowY: 'auto', height: '100%', minHeight: 330, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.filter(item => `${item.label} ${item.group}`.toLowerCase().includes(query.toLowerCase())).map(entry => <div key={entry.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button role="option" aria-selected={item.id === entry.id} onClick={() => setSelected(entry.id)} style={{ ...button, padding: '6px 10px', flex: 1, minWidth: 0, background: item.id === entry.id ? '#385a90' : '#262c38', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {entry.label} <small style={{ color: '#b5becf' }}>{entry.group}{settings.overrides[entry.id] ? ' · customized' : ''}</small>
          </button>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 2, flexShrink: 0 }}>
            <button title={`Play ${entry.label} once`} aria-label={`Play ${entry.label} once`} onClick={() => onPreview?.(entry.id, entry.preset, 'once')} style={{ ...button, padding: '6px 7px' }}><Play size={12} /></button>
            <button title={`Play ${entry.label} looped`} aria-label={`Play ${entry.label} looped`} onClick={() => onPreview?.(entry.id, entry.preset, 'loop')} style={{ ...button, padding: '6px 7px' }}><Repeat size={12} /></button>
            <button title={`Stop ${entry.label}`} aria-label={`Stop ${entry.label}`} onClick={() => onStop?.()} style={{ ...button, padding: '6px 7px' }}><Square size={12} /></button>
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
