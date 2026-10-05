import { useRef, useState } from 'react'
import { useFileDrop, singleModelPath } from '../hooks/useFileDrop'
import { FileDropHint } from './FileDropHint'
import { invoke } from '@tauri-apps/api/core'
import { Plus, Trash2 } from 'lucide-react'
import {
  PET_ANCHORS, PET_IDLE_STYLES, PET_MOVES, createPetConfig, normalizePet,
  uniqueCompanionId, type CompanionAction, type PetConfig,
} from '../companions'
import { deleteCompanionAsset, importCompanionAsset } from '../asset-import'
import { EMOTION_OPTIONS } from '../behavior'
import { cCard, cMuted, cRow, cSelect, cSmallButton, NumField, SliderField } from './CompanionForm'

interface PetsPanelProps {
  pets: PetConfig[]
  onChange: (pets: PetConfig[]) => void
  language?: 'zh' | 'en'
  onTest?: (action: CompanionAction) => void
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function PetsPanel({ pets, onChange, language = 'zh', onTest }: PetsPanelProps) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const [openId, setOpenId] = useState<string | null>(pets[0]?.id ?? null)
  const [importStatus, setImportStatus] = useState('')
  const [importPath, setImportPath] = useState('')
  const [busy, setBusy] = useState(false)
  const importing = useRef(false)

  const commit = (next: PetConfig[]) => {
    onChange(next.map(p => normalizePet(p, p.id)).filter((p): p is PetConfig => p !== null))
  }
  const patchPet = (id: string, fn: (pet: PetConfig) => void) => {
    commit(pets.map(pet => {
      if (pet.id !== id) return pet
      const next = clone(pet)
      fn(next)
      return next
    }))
  }

  const runImport = async (path: string) => {
    if (!path || importing.current) return
    if (pets.length >= 12) { setImportStatus('Library limit reached.'); return }
    importing.current = true
    setBusy(true)
    setImportStatus(t('正在导入…', 'Importing…'))
    try {
      const imported = await importCompanionAsset('pet', path, setImportStatus)
      const id = uniqueCompanionId(imported.name, pets.map(p => p.id))
      const config = createPetConfig(id, imported.name.slice(0, 60) || id, imported.file, imported.asset)
      onChange([...pets, config])
      setOpenId(id)
      setImportPath('')
      setImportStatus(t('已导入', 'Imported'))
    } catch (error) {
      setImportStatus(String(error instanceof Error ? error.message : error))
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  const dragging = useFileDrop(true, async paths => {
    await runImport(singleModelPath(paths, ['glb', 'gltf', 'fbx', 'dae']))
  }, setImportStatus)

  const pickFile = async () => {
    try {
      const picked = await invoke<string | null>('pick_companion_file')
      if (picked) void runImport(picked)
    } catch {
      setImportStatus(t('需要 Tauri 文件选择器；在下方粘贴路径。', 'Needs the Tauri file picker; paste a path below.'))
    }
  }

  const removePet = async (id: string) => {
    const target = pets.find(p => p.id === id)
    const rest = pets.filter(p => p.id !== id)
    onChange(rest)
    if (openId === id) setOpenId(rest[0]?.id ?? null)
    if (target && !rest.some(p => p.file === target.file)) {
      try { await deleteCompanionAsset('pet', target.file) } catch { /* entry is gone either way */ }
    }
  }

  return <div style={{ display: 'grid', gap: 12, fontSize: 14 }}>
    <div>
      <strong style={{ fontSize: 15 }}>{t('宠物', 'Pets')}</strong>
      <div style={cMuted}>{t(
        '常驻的小伙伴：浮在肩旁、坐在头顶或在身边跟随。有自己的待机动作、表情和点击反应；行为和自定义反应里可以让它登场、表演、退场。',
        'Persistent little companions: float by the shoulder, sit on the head, or follow alongside. They idle, emote, and react to clicks; behaviors and reactions can show, play, and hide them.')}</div>
    </div>
    <FileDropHint dragging={dragging}>{t('拖放模型到此页面导入（GLB / glTF / FBX / DAE）', 'Drop a model anywhere on this page to import (GLB / glTF / FBX / DAE).')}</FileDropHint>
    <div style={cRow}>
      <button style={cSmallButton} disabled={busy || pets.length >= 12} onClick={() => void pickFile()} title={t('GLB 最快；FBX/DAE 会自动转换', 'GLB is fastest; FBX/DAE convert automatically')}>
        <Plus size={12} style={{ verticalAlign: -2 }} /> {t('导入模型…', 'Import model…')}
      </button>
      <span style={cMuted}>GLB / glTF / FBX / DAE</span>
    </div>
    <div style={cRow}>
      <input aria-label={t('模型路径', 'Model path')} value={importPath} onChange={e => setImportPath(e.target.value)}
        placeholder={t('/path/to/chao.fbx（无文件框时用）', '/path/to/chao.fbx (when no file dialog)')}
        style={{ flex: '1 1 200px', minWidth: 0, background: '#262c38', border: '1px solid #505665', borderRadius: 7, color: 'white', padding: '6px 10px', fontSize: 13 }} />
      <button style={cSmallButton} disabled={busy || !importPath.trim()} onClick={() => void runImport(importPath.trim())}>{t('导入路径', 'Import path')}</button>
    </div>
    {importStatus && <div role="status" style={{ color: '#9fd6ff', fontSize: 13 }}>{importStatus}</div>}
    {pets.length === 0 && <span style={cMuted}>{t('还没有宠物 — 导入一个 GLB（或 FBX/DAE，会自动转成 GLB）。', 'No pets yet — import a GLB (or FBX/DAE, auto-converted to GLB).')}</span>}
    {pets.map(pet => <PetCard key={pet.id} pet={pet} open={openId === pet.id}
      onToggleOpen={() => setOpenId(openId === pet.id ? null : pet.id)}
      onPatch={fn => patchPet(pet.id, fn)} onRemove={() => void removePet(pet.id)}
      onTest={onTest ? action => onTest({ ...action, kind: 'pet', id: pet.id }) : undefined} t={t} />)}
  </div>
}

function PetCard({ pet, open, onToggleOpen, onPatch, onRemove, onTest, t }: {
  pet: PetConfig; open: boolean; onToggleOpen: () => void
  onPatch: (fn: (pet: PetConfig) => void) => void; onRemove: () => void
  onTest?: (action: Omit<CompanionAction, 'kind' | 'id'>) => void
  t: (zh: string, en: string) => string
}) {
  return <article aria-label={`Pet ${pet.name}`} style={cCard}>
    <div style={cRow}>
      <input type="checkbox" aria-label={t('启用', 'Enabled')} title={t('启用', 'Enabled')} checked={pet.enabled}
        onChange={e => onPatch(next => { next.enabled = e.target.checked })} />
      <button onClick={onToggleOpen} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', padding: 0, fontSize: 15, flex: '1 1 120px', textAlign: 'left' }}>
        <strong>{pet.name}</strong> <span style={cMuted}>{pet.file}</span>
      </button>
      <label style={{ ...cMuted, display: 'flex', gap: 4, alignItems: 'center' }} title={t('启动时可见', 'Visible at startup')}>
        <input type="checkbox" checked={pet.visible} onChange={e => onPatch(next => { next.visible = e.target.checked })} />{t('显示', 'Show')}
      </label>
      {onTest && <>
        <button style={cSmallButton} onClick={() => onTest({ action: 'show' })}>{t('预览', 'Preview')}</button>
        <button style={cSmallButton} onClick={() => onTest({ action: 'hide' })}>{t('隐藏', 'Hide')}</button>
      </>}
      <button style={cSmallButton} onClick={onRemove} title={t('删除', 'Delete')} aria-label={`Delete ${pet.name}`}><Trash2 size={12} /></button>
    </div>
    {!open && <div style={cMuted}>{PET_ANCHORS.find(a => a.id === pet.anchor)?.label} · {Math.round(pet.size * 100)}% · {pet.expressions.length} {t('表情', 'expressions')}</div>}
    {open && <PetEditor pet={pet} onPatch={onPatch} onTest={onTest} t={t} />}
  </article>
}

function PetEditor({ pet, onPatch, onTest, t }: {
  pet: PetConfig; onPatch: (fn: (pet: PetConfig) => void) => void
  onTest?: (action: Omit<CompanionAction, 'kind' | 'id'>) => void
  t: (zh: string, en: string) => string
}) {
  return <>
    <div style={cRow}>
      <input aria-label={t('名称', 'Name')} value={pet.name} onChange={e => onPatch(next => { next.name = e.target.value.slice(0, 60) })}
        style={{ flex: '1 1 140px', minWidth: 0, background: '#262c38', border: '1px solid #505665', borderRadius: 7, color: 'white', padding: '6px 10px', fontSize: 13 }} />
    </div>
    <div style={cRow}>
      <label style={{ ...cMuted, display: 'grid', gap: 4 }}>{t('位置', 'Placement')}
        <select aria-label={t('位置', 'Placement')} value={pet.anchor} onChange={e => onPatch(next => { next.anchor = e.target.value as PetConfig['anchor'] })} style={cSelect}>
          {PET_ANCHORS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </label>
      <label style={{ ...cMuted, display: 'grid', gap: 4 }}>{t('方向', 'Side')}
        <select aria-label="Side" value={pet.side} onChange={e => onPatch(next => { next.side = e.target.value as 'left' | 'right' })} style={cSelect}>
          <option value="right">{t('右侧', 'Right')}</option>
          <option value="left">{t('左侧', 'Left')}</option>
        </select>
      </label>
      <div style={{ flex: '1 1 160px', minWidth: 120 }}>
        <SliderField label={t('大小（相对角色身高）', 'Size (of character height)')} value={Math.round(pet.size * 100)} min={3} max={150} step={1}
          format={v => `${v}%`} onChange={v => onPatch(next => { next.size = v / 100 })} />
      </div>
    </div>
    <div style={cRow}>
      <NumField label="X%" value={pet.offset.x} min={-100} max={100} onCommit={v => onPatch(next => { next.offset.x = v })} />
      <NumField label="Y%" value={pet.offset.y} min={-100} max={100} onCommit={v => onPatch(next => { next.offset.y = v })} />
      <NumField label="Z%" value={pet.offset.z} min={-100} max={100} onCommit={v => onPatch(next => { next.offset.z = v })} />
      <NumField label={t('朝向°', 'Turn°')} value={pet.turn} min={-180} max={180} onCommit={v => onPatch(next => { next.turn = v })} />
    </div>
    <div style={cRow}>
      <label style={{ ...cMuted, display: 'grid', gap: 4 }}>{t('待机动作', 'Idle motion')}
        <select aria-label={t('待机动作', 'Idle motion')} value={pet.idle.style} onChange={e => onPatch(next => { next.idle.style = e.target.value as PetConfig['idle']['style'] })} style={cSelect}>
          {PET_IDLE_STYLES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      {pet.asset.clips.length > 0 && <label style={{ ...cMuted, display: 'grid', gap: 4 }}>{t('循环剪辑', 'Loop clip')}
        <select aria-label={t('循环剪辑', 'Loop clip')} value={pet.clip} onChange={e => onPatch(next => { next.clip = e.target.value })} style={cSelect}>
          <option value="">{t('仅程序化待机', 'Procedural idle only')}</option>
          {pet.asset.clips.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>}
    </div>
    <div style={{ display: 'grid', gap: 4 }}>
      <SliderField label={t('待机速度', 'Idle speed')} value={pet.idle.speed} min={0.1} max={4} step={0.1} format={v => `×${v.toFixed(1)}`} onChange={v => onPatch(next => { next.idle.speed = v })} />
      <SliderField label={t('待机幅度', 'Idle amount')} value={pet.idle.amount} min={0} max={3} step={0.1} format={v => `×${v.toFixed(1)}`} onChange={v => onPatch(next => { next.idle.amount = v })} />
      <SliderField label={t('肢体动作', 'Limb motion')} value={pet.limbMotion} min={0} max={2} step={0.1} format={v => `×${v.toFixed(1)}`} onChange={v => onPatch(next => { next.limbMotion = v })} />
      <SliderField label={t('跟随延迟（越大越松）', 'Follow lag (higher is looser)')} value={pet.followLag} min={0.05} max={2} step={0.05} format={v => `${v.toFixed(2)}s`} onChange={v => onPatch(next => { next.followLag = v })} />
      <SliderField label={t('补光', 'Lighting fill')} value={pet.lighting} min={0} max={1} step={0.05} format={v => `${Math.round(v * 100)}%`} onChange={v => onPatch(next => { next.lighting = v })} />
    </div>

    {pet.groups.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
      <span style={cMuted}>{t('部位组（同一时间只显示一件）', 'Part groups (one visible at a time)')}</span>
      {pet.groups.map(group => <div key={group.id} style={cRow}>
        <span style={{ minWidth: 90 }}>{group.label}</span>
        <select aria-label={group.label} value={group.default ?? ''} onChange={e => onPatch(next => {
          const g = next.groups.find(g => g.id === group.id)
          if (g) g.default = e.target.value || null
        })} style={cSelect}>
          {!group.default && <option value="">{t('全部隐藏', 'Hide all')}</option>}
          {group.parts.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>)}
      {pet.blink && <span style={cMuted}>{t('检测到眨眼帧，会自动眨眼。', 'Blink frames detected; blinks automatically.')}</span>}
    </div>}

    {pet.expressions.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
      <span style={cMuted}>{t('表情（点击试看）', 'Expressions (click to preview)')}</span>
      <div style={cRow}>
        {pet.expressions.map(expr => <button key={expr.id} style={cSmallButton} title={expr.label}
          onClick={() => onTest?.({ action: 'expression', value: expr.id, durationMs: 2500 })}>{expr.label}</button>)}
      </div>
    </div>}

    <div style={{ display: 'grid', gap: 6 }}>
      <span style={cMuted}>{t('心情映射：角色换表情时宠物跟着换', 'Mood mirror: pet follows the character’s emotion')}</span>
      {EMOTION_OPTIONS.map(emotion => <div key={emotion} style={cRow}>
        <span style={{ minWidth: 90 }}>{emotion}</span>
        <select aria-label={`Mirror ${emotion}`} value={pet.mood[emotion] ?? ''} onChange={e => onPatch(next => {
          if (e.target.value) next.mood[emotion] = e.target.value
          else delete next.mood[emotion]
        })} style={cSelect}>
          <option value="">{t('不跟随', 'Ignore')}</option>
          {pet.expressions.map(expr => <option key={expr.id} value={expr.id}>{expr.label}</option>)}
        </select>
      </div>)}
    </div>

    <div style={cRow}>
      <label style={{ ...cMuted, display: 'grid', gap: 4 }}>{t('点击宠物', 'On click')}
        <select aria-label={t('点击动作', 'Click move')} value={pet.click.move} onChange={e => onPatch(next => { next.click.move = e.target.value as PetConfig['click']['move'] })} style={cSelect}>
          <option value="">{t('不动', 'Nothing')}</option>
          {PET_MOVES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      {pet.expressions.length > 0 && <label style={{ ...cMuted, display: 'grid', gap: 4 }}>{t('点击表情', 'Click expression')}
        <select aria-label={t('点击表情', 'Click expression')} value={pet.click.expression} onChange={e => onPatch(next => { next.click.expression = e.target.value })} style={cSelect}>
          <option value="">{t('不变', 'None')}</option>
          {pet.expressions.map(expr => <option key={expr.id} value={expr.id}>{expr.label}</option>)}
        </select>
      </label>}
      {onTest && <button style={cSmallButton} onClick={() => onTest({ action: 'play', value: 'hop' })}>{t('试跳一下', 'Try hop')}</button>}
    </div>

    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ ...cRow, cursor: 'pointer' }}>
        <input type="checkbox" checked={pet.occasional.enabled} onChange={e => onPatch(next => { next.occasional.enabled = e.target.checked })} />
        <span>{t('偶尔自己动一下', 'Ambient antics')}</span>
        <NumField label={t('每', 'every')} value={pet.occasional.everyMin} min={3} max={3600} width={52} onCommit={v => onPatch(next => { next.occasional.everyMin = v })} />
        <span style={cMuted}>–</span>
        <NumField label={t('到', 'to')} value={pet.occasional.everyMax} min={3} max={3600} width={52} onCommit={v => onPatch(next => { next.occasional.everyMax = v })} />
        <span style={cMuted}>{t('秒', 's')}</span>
      </label>
      {pet.occasional.enabled && <div style={cRow}>
        {PET_MOVES.map(m => <label key={m.id} style={{ ...cMuted, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={pet.occasional.moves.includes(m.id)} onChange={e => onPatch(next => {
            next.occasional.moves = e.target.checked ? [...next.occasional.moves, m.id] : next.occasional.moves.filter(x => x !== m.id)
          })} />{m.label}
        </label>)}
      </div>}
    </div>

    {pet.asset.materials.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
      <span style={cMuted}>{t('材质染色', 'Material tints')}</span>
      {pet.asset.materials.map(name => <div key={name} style={cRow}>
        <span style={{ minWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        <input type="color" aria-label={name} value={pet.colors[name] ?? '#ffffff'} onChange={e => onPatch(next => { next.colors[name] = e.target.value })} />
        {pet.colors[name] && <button style={cSmallButton} onClick={() => onPatch(next => { delete next.colors[name] })}>{t('还原', 'Reset')}</button>}
      </div>)}
    </div>}
  </>
}
