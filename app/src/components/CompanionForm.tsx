import { SettingsHelp } from './SettingsHelp'
import { useState, type CSSProperties } from 'react'
import type { LibraryAsset } from '../asset-import'

/** Shared controls for the Pets / Props panels and the behavior action editor. */
export const cButton: CSSProperties = { padding: '9px 12px', border: '1px solid #505665', borderRadius: 7, background: '#303645', color: 'white', cursor: 'pointer', textAlign: 'left' }
export const cSmallButton: CSSProperties = { ...cButton, padding: '5px 9px', fontSize: 13 }
export const cRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
export const cMuted: CSSProperties = { color: '#adb5c8', fontSize: 12 }
export const cSelect: CSSProperties = {
  flex: '1 1 160px', minWidth: 0, padding: '6px 10px',
  border: '1px solid #505665', borderRadius: 7, background: '#262c38',
  color: 'white', fontSize: 14, cursor: 'pointer',
}
export const cNumberInput: CSSProperties = { width: 60, background: '#262c38', border: '1px solid #505665', borderRadius: 7, color: 'white', padding: '5px 6px', fontSize: 13 }
export const cCard: CSSProperties = { border: '1px solid #2c3547', borderRadius: 8, padding: 12, display: 'grid', gap: 10, background: '#202839' }

export function NumField({ label, value, min, max, step = 1, width, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number; width?: number
  onCommit: (value: number) => void
}) {
  return <label style={{ ...cMuted, display: 'flex', gap: 4, alignItems: 'center' }}>{label}
    <input aria-label={label} type="number" min={min} max={max} step={step} value={value}
      onChange={e => {
        const next = Number(e.target.value)
        if (Number.isFinite(next)) onCommit(Math.max(min, Math.min(max, next)))
      }}
      style={width ? { ...cNumberInput, width } : cNumberInput} />
  </label>
}

/**
 * Library dropdown shared by the Pets and Props pages (mirrors the Models
 * page: pick an already-imported model, then add it). Lists only files with
 * no config yet; callers pass the filtered list and create the config in
 * onAdd with the same create*Config path as file import.
 */
export function CompanionLibraryPicker({ files, busy, onAdd, t }: {
  files: LibraryAsset[]
  busy: boolean
  onAdd: (file: string) => void
  t: (zh: string, en: string) => string
}) {
  const [selected, setSelected] = useState('')
  if (files.length === 0) return null
  const current = files.some(f => f.name === selected) ? selected : files[0].name
  return <div style={cRow}>
    <label style={{ ...cMuted, display: 'grid', gap: 4 }}>{t('已导入的模型', 'Imported models')}
      <select aria-label={t('已导入的模型', 'Imported models')} value={current}
        onChange={e => setSelected(e.target.value)} style={cSelect}>
        {files.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
      </select>
    </label>
    <button style={cSmallButton} disabled={busy || !current} onClick={() => onAdd(current)}>
      {t('添加', 'Add')}
    </button>
  </div>
}

export function SliderField({ label, value, min, max, step, format, onChange, help }: {
  label: string; value: number; min: number; max: number; step: number
  help?: string; format: (value: number) => string; onChange: (value: number) => void
}) {
  return <label style={{ display: 'grid', gap: 4 }}><span>{label}{help && <SettingsHelp label={`${label} help`}>{help}</SettingsHelp>}</span>
    <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, minWidth: 80 }} />
      <output style={{ minWidth: 52, textAlign: 'right' }}>{format(value)}</output>
    </span>
  </label>
}
