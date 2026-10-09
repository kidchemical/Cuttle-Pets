import { SettingsHelp } from './SettingsHelp'
import { FlaskConical, Plus, Trash2 } from 'lucide-react'
import {
  PET_ACTIONS, PET_ANCHORS, PET_MOVES, PROP_ACTIONS, describeCompanionAction,
  normalizeCompanionAction, type CompanionAction, type CompanionKind,
  type PetConfig, type PropConfig,
} from '../companions'
import { cMuted, cRow, cSelect, cSmallButton, NumField } from './CompanionForm'

interface CompanionActionsEditorProps {
  value: CompanionAction[]
  pets: PetConfig[]
  props: PropConfig[]
  onChange: (value: CompanionAction[]) => void
  onTest?: (action: CompanionAction) => void
  language?: 'zh' | 'en'
}

/**
 * Pet/prop steps on a behavior entry or reaction step — e.g. entry shows the
 * pet, the main loop plays with it, the exit hides it.
 */
export function CompanionActionsEditor({ value, pets, props, onChange, onTest, language = 'zh' }: CompanionActionsEditorProps) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const names: Record<string, string> = {}
  for (const pet of pets) names[`pet:${pet.id}`] = pet.name
  for (const prop of props) names[`prop:${prop.id}`] = prop.name

  const patchOne = (index: number, draft: CompanionAction) => {
    const clean = normalizeCompanionAction(draft)
    if (!clean) return
    onChange(value.map((action, i) => i === index ? clean : action))
  }

  return <div style={{ display: 'grid', gap: 6 }}>
    <span style={cMuted}>{t('宠物 / 道具', 'Pets / props')}<SettingsHelp>Instructions run in order.</SettingsHelp></span>
    {value.length === 0 && <span style={cMuted}>{t('无 — 加一步让宠物登场或戴上道具。', 'None — add a step to bring in the pet or equip a prop.')}</span>}
    {value.map((action, index) => <div key={index} style={cRow}>
      <TargetSelect action={action} pets={pets} props={props} onPick={(kind, id) => {
        const fallback = kind === 'pet' ? 'show' : 'show'
        patchOne(index, { ...action, kind, id, action: fallback, value: undefined, loop: undefined, durationMs: undefined })
      }} />
      <ActionSelect action={action} onPick={next => patchOne(index, { ...action, ...next })} />
      <ValueControl action={action} pets={pets} onPick={patch => patchOne(index, { ...action, ...patch })} />
      <span style={cMuted} title={describeCompanionAction(action, names)}>{describeCompanionAction(action, names)}</span>
      {onTest && <button style={cSmallButton} onClick={() => onTest(action)} title={t('在宠物身上试运行', 'Try on the pet')} aria-label="Try companion action"><FlaskConical size={12} /></button>}
      <button style={cSmallButton} onClick={() => onChange(value.filter((_, i) => i !== index))} title={t('删除', 'Remove')} aria-label="Remove companion action"><Trash2 size={12} /></button>
    </div>)}
    {(pets.length > 0 || props.length > 0) && value.length < 6 &&
      <div><button style={cSmallButton} onClick={() => {
        const first = pets[0] ? { kind: 'pet' as const, id: pets[0].id } : { kind: 'prop' as const, id: props[0].id }
        const clean = normalizeCompanionAction({ ...first, action: 'show' })
        if (clean) onChange([...value, clean])
      }}><Plus size={12} style={{ verticalAlign: -2 }} /> {t('加宠物/道具步骤', 'Add pet/prop step')}</button></div>}
    {pets.length === 0 && props.length === 0 &&
      <span style={cMuted}>{t('先去「宠物 / 道具」选项卡导入模型。', 'Import a model in the Pets / Props tabs first.')}</span>}
  </div>
}

function TargetSelect({ action, pets, props, onPick }: {
  action: CompanionAction; pets: PetConfig[]; props: PropConfig[]
  onPick: (kind: CompanionKind, id: string) => void
}) {
  const target = `${action.kind}:${action.id}`
  return <select aria-label="Pet or prop" value={target} onChange={e => {
    const [kind, ...rest] = e.target.value.split(':')
    if ((kind === 'pet' || kind === 'prop') && rest.length) onPick(kind, rest.join(':'))
  }} style={{ ...cSelect, flex: '1 1 130px' }}>
    {pets.length > 0 && <optgroup label="Pets">
      {pets.map(pet => <option key={pet.id} value={`pet:${pet.id}`}>{pet.name}</option>)}
    </optgroup>}
    {props.length > 0 && <optgroup label="Props">
      {props.map(prop => <option key={prop.id} value={`prop:${prop.id}`}>{prop.name}</option>)}
    </optgroup>}
  </select>
}

function ActionSelect({ action, onPick }: {
  action: CompanionAction; onPick: (patch: Partial<CompanionAction>) => void
}) {
  const options = action.kind === 'pet' ? PET_ACTIONS : PROP_ACTIONS
  return <select aria-label="Companion action" value={action.action} onChange={e => {
    const next = e.target.value
    // Changing verb clears the old verb's payload.
    if (next === 'expression' || next === 'play' || next === 'move') {
      const fallback = next === 'expression' ? 'neutral' : next === 'play' ? 'hop' : 'home'
      onPick({ action: next as CompanionAction['action'], value: fallback, loop: undefined, durationMs: undefined })
    } else {
      onPick({ action: next as CompanionAction['action'], value: undefined, loop: undefined, durationMs: undefined })
    }
  }} style={{ ...cSelect, flex: '0 1 130px' }}>
    {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select>
}

function ValueControl({ action, pets, onPick }: {
  action: CompanionAction; pets: PetConfig[]
  onPick: (patch: Partial<CompanionAction>) => void
}) {
  if (action.kind === 'prop') return null
  const pet = pets.find(p => p.id === action.id)
  if (action.action === 'expression') {
    return <>
      <select aria-label="Expression" value={action.value ?? 'neutral'} onChange={e => onPick({ value: e.target.value })} style={{ ...cSelect, flex: '0 1 130px' }}>
        <option value="neutral">Neutral</option>
        {(pet?.expressions ?? []).map(expr => <option key={expr.id} value={expr.id}>{expr.label}</option>)}
      </select>
      <NumField label="hold s" value={Math.round((action.durationMs ?? 0) / 1000)} min={0} max={600} width={48}
        onCommit={v => onPick(v > 0 ? { durationMs: v * 1000 } : { durationMs: undefined })} />
    </>
  }
  if (action.action === 'play') {
    const clips = pet?.asset.clips ?? []
    return <>
      <select aria-label="Move or clip" value={action.value ?? 'hop'} onChange={e => onPick({ value: e.target.value })} style={{ ...cSelect, flex: '0 1 130px' }}>
        {PET_MOVES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        {clips.map(c => <option key={c} value={`clip:${c}`}>{c}</option>)}
      </select>
      <label style={{ ...cMuted, display: 'flex', gap: 4, alignItems: 'center' }}>
        <input type="checkbox" checked={!!action.loop} onChange={e => onPick({ loop: e.target.checked ? true : undefined })} /> loop
      </label>
    </>
  }
  if (action.action === 'move') {
    return <select aria-label="Move to" value={action.value ?? 'home'} onChange={e => onPick({ value: e.target.value })} style={{ ...cSelect, flex: '0 1 130px' }}>
      <option value="home">Home (configured anchor)</option>
      {PET_ANCHORS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
    </select>
  }
  return null
}
