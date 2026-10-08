import { useCallback, useEffect, useRef, useState } from 'react'
import { useFileDrop, singleModelPath } from '../hooks/useFileDrop'
import { FileDropHint } from './FileDropHint'
import { invoke } from '@tauri-apps/api/core'
import { Plus, Trash2 } from 'lucide-react'
import {
  PROP_ANCHORS, createPropConfig, normalizeProp,
  uniqueCompanionId, type CompanionAction, type PropConfig,
} from '../companions'
import {
  analyzeStoredAsset, importCompanionAsset, listCompanionAssets,
  unconfiguredAssets, type LibraryAsset,
} from '../asset-import'
import { CompanionLibraryPicker, cCard, cMuted, cRow, cSelect, cSmallButton, NumField, SliderField } from './CompanionForm'

interface PropsPanelProps {
  props: PropConfig[]
  onChange: (props: PropConfig[]) => void
  language?: 'zh' | 'en'
  onTest?: (action: CompanionAction) => void
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function PropsPanel({ props, onChange, language = 'zh', onTest }: PropsPanelProps) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const [openId, setOpenId] = useState<string | null>(props[0]?.id ?? null)
  const [importStatus, setImportStatus] = useState('')
  const [importPath, setImportPath] = useState('')
  const [busy, setBusy] = useState(false)
  const importing = useRef(false)
  const [library, setLibrary] = useState<LibraryAsset[]>([])
  const refreshLibrary = useCallback(async () => {
    try { setLibrary(await listCompanionAssets('prop')) } catch { /* picker hides when offline */ }
  }, [])
  useEffect(() => { void refreshLibrary() }, [refreshLibrary])
  const available = unconfiguredAssets(library, props.map(p => p.file))

  const commit = (next: PropConfig[]) => {
    onChange(next.map(p => normalizeProp(p, p.id)).filter((p): p is PropConfig => p !== null))
  }
  const patchProp = (id: string, fn: (prop: PropConfig) => void) => {
    commit(props.map(prop => {
      if (prop.id !== id) return prop
      const next = clone(prop)
      fn(next)
      return next
    }))
  }

  const runImport = async (path: string) => {
    if (!path || importing.current) return
    if (props.length >= 40) { setImportStatus('Library limit reached.'); return }
    importing.current = true
    setBusy(true)
    setImportStatus(t('正在导入…', 'Importing…'))
    try {
      const imported = await importCompanionAsset('prop', path, setImportStatus)
      const id = uniqueCompanionId(imported.name, props.map(p => p.id))
      const config = createPropConfig(id, imported.name.slice(0, 60) || id, imported.file, imported.asset)
      onChange([...props, config])
      setOpenId(id)
      setImportPath('')
      setImportStatus(t('已导入', 'Imported'))
      void refreshLibrary()
    } catch (error) {
      setImportStatus(String(error instanceof Error ? error.message : error))
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  const addFromLibrary = async (file: string) => {
    if (!file || importing.current) return
    if (props.length >= 40) { setImportStatus('Library limit reached.'); return }
    importing.current = true
    setBusy(true)
    setImportStatus(t('正在添加…', 'Adding…'))
    try {
      const asset = await analyzeStoredAsset('prop', file)
      const stem = file.replace(/\.glb$/i, '')
      const id = uniqueCompanionId(stem, props.map(p => p.id))
      const config = createPropConfig(id, stem.slice(0, 60) || id, file, asset)
      onChange([...props, config])
      setOpenId(id)
      setImportStatus(t('已添加', 'Added'))
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

  /** Removing drops the config only — the GLB stays in the library. */
  const removeProp = (id: string) => {
    const rest = props.filter(p => p.id !== id)
    onChange(rest)
    if (openId === id) setOpenId(rest[0]?.id ?? null)
  }

  return <div style={{ display: 'grid', gap: 12, fontSize: 14 }}>
    <div>
      <strong style={{ fontSize: 15 }}>{t('道具', 'Props')}</strong>
      <div style={cMuted}>{t(
        '戴在角色身上的小物件：帽子、吉他、眼镜……固定在骨骼上跟随动作。平时戴着或藏着，行为和自定义反应里可以穿戴/摘下。',
        'Wearables for your character: hats, guitars, glasses… pinned to a bone and following the motion. Worn or hidden; behaviors and reactions can equip/remove them.')}</div>
    </div>
    <FileDropHint dragging={dragging}>{t('拖放模型到此页面导入（GLB / glTF / FBX / DAE）', 'Drop a model anywhere on this page to import (GLB / glTF / FBX / DAE).')}</FileDropHint>
    <div style={cRow}>
      <button style={cSmallButton} disabled={busy || props.length >= 40} onClick={() => void pickFile()} title={t('GLB 最快；FBX/DAE 会自动转换', 'GLB is fastest; FBX/DAE convert automatically')}>
        <Plus size={12} style={{ verticalAlign: -2 }} /> {t('导入模型…', 'Import model…')}
      </button>
      <span style={cMuted}>GLB / glTF / FBX / DAE</span>
    </div>
    <div style={cRow}>
      <input aria-label={t('模型路径', 'Model path')} value={importPath} onChange={e => setImportPath(e.target.value)}
        placeholder={t('/path/to/hat.glb（无文件框时用）', '/path/to/hat.glb (when no file dialog)')}
        style={{ flex: '1 1 200px', minWidth: 0, background: '#262c38', border: '1px solid #505665', borderRadius: 7, color: 'white', padding: '6px 10px', fontSize: 13 }} />
      <button style={cSmallButton} disabled={busy || !importPath.trim()} onClick={() => void runImport(importPath.trim())}>{t('导入路径', 'Import path')}</button>
    </div>
    {available.length > 0 && <CompanionLibraryPicker files={available} busy={busy} onAdd={file => void addFromLibrary(file)} t={t} />}
    {importStatus && <div role="status" style={{ color: '#9fd6ff', fontSize: 13 }}>{importStatus}</div>}
    {props.length === 0 && <span style={cMuted}>{t('还没有道具 — 导入一个 GLB 帽子试试。', 'No props yet — import a GLB hat to try.')}</span>}
    {props.map(prop => {
      const open = openId === prop.id
      return <article key={prop.id} aria-label={`Prop ${prop.name}`} style={cCard}>
        <div style={cRow}>
          <input type="checkbox" aria-label={t('启用', 'Enabled')} title={t('启用', 'Enabled')} checked={prop.enabled}
            onChange={e => patchProp(prop.id, next => { next.enabled = e.target.checked })} />
          <button onClick={() => setOpenId(open ? null : prop.id)} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', padding: 0, fontSize: 15, flex: '1 1 120px', textAlign: 'left' }}>
            <strong>{prop.name}</strong> <span style={cMuted}>{prop.file}</span>
          </button>
          <label style={{ ...cMuted, display: 'flex', gap: 4, alignItems: 'center' }} title={t('启动时佩戴', 'Worn at startup')}>
            <input type="checkbox" checked={prop.visible} onChange={e => patchProp(prop.id, next => { next.visible = e.target.checked })} />{t('佩戴', 'Wear')}
          </label>
          {onTest && <>
            <button style={cSmallButton} onClick={() => onTest({ kind: 'prop', id: prop.id, action: 'show' })}>{t('戴上', 'Equip')}</button>
            <button style={cSmallButton} onClick={() => onTest({ kind: 'prop', id: prop.id, action: 'hide' })}>{t('摘下', 'Remove')}</button>
          </>}
          <button style={cSmallButton} onClick={() => void removeProp(prop.id)} title={t('删除', 'Delete')} aria-label={`Delete ${prop.name}`}><Trash2 size={12} /></button>
        </div>
        {!open && <div style={cMuted}>{PROP_ANCHORS.find(a => a.id === prop.anchor)?.label} · {Math.round(prop.size * 100)}%</div>}
        {open && <>
          <div style={cRow}>
            <input aria-label={t('名称', 'Name')} value={prop.name} onChange={e => patchProp(prop.id, next => { next.name = e.target.value.slice(0, 60) })}
              style={{ flex: '1 1 140px', minWidth: 0, background: '#262c38', border: '1px solid #505665', borderRadius: 7, color: 'white', padding: '6px 10px', fontSize: 13 }} />
            <label style={{ ...cMuted, display: 'grid', gap: 4 }}>{t('固定在', 'Attach to')}
              <select aria-label={t('固定在', 'Attach to')} value={prop.anchor} onChange={e => patchProp(prop.id, next => { next.anchor = e.target.value as PropConfig['anchor'] })} style={cSelect}>
                {PROP_ANCHORS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            <div style={{ flex: '1 1 160px', minWidth: 120 }}>
              <SliderField label={t('大小（相对角色身高）', 'Size (of character height)')} value={Math.round(prop.size * 100)} min={1} max={200} step={1}
                format={v => `${v}%`} onChange={v => patchProp(prop.id, next => { next.size = v / 100 })} />
            </div>
          </div>
          <div style={cRow}>
            <NumField label="X%" value={prop.offset.x} min={-100} max={100} onCommit={v => patchProp(prop.id, next => { next.offset.x = v })} />
            <NumField label="Y%" value={prop.offset.y} min={-100} max={100} onCommit={v => patchProp(prop.id, next => { next.offset.y = v })} />
            <NumField label="Z%" value={prop.offset.z} min={-100} max={100} onCommit={v => patchProp(prop.id, next => { next.offset.z = v })} />
          </div>
          <div style={cRow}>
            <NumField label={t('转X°', 'Rot X°')} value={prop.rotation.x} min={-180} max={180} onCommit={v => patchProp(prop.id, next => { next.rotation.x = v })} />
            <NumField label={t('转Y°', 'Rot Y°')} value={prop.rotation.y} min={-180} max={180} onCommit={v => patchProp(prop.id, next => { next.rotation.y = v })} />
            <NumField label={t('转Z°', 'Rot Z°')} value={prop.rotation.z} min={-180} max={180} onCommit={v => patchProp(prop.id, next => { next.rotation.z = v })} />
          </div>
          {prop.asset.materials.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
            <span style={cMuted}>{t('材质染色', 'Material tints')}</span>
            {prop.asset.materials.map(name => <div key={name} style={cRow}>
              <span style={{ minWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
              <input type="color" aria-label={name} value={prop.colors[name] ?? '#ffffff'} onChange={e => patchProp(prop.id, next => { next.colors[name] = e.target.value })} />
              {prop.colors[name] && <button style={cSmallButton} onClick={() => patchProp(prop.id, next => { delete next.colors[name] })}>{t('还原', 'Reset')}</button>}
            </div>)}
          </div>}
        </>}
      </article>
    })}
  </div>
}
