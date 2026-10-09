import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, MoreHorizontal, Save, Trash2 } from 'lucide-react'
import { petUrl } from '../config'

type ProfileSummary = { id: string; name: string; updatedAt?: number | string }
type Props = { settings: Record<string, any>; onLoad: (settings: Record<string, any>) => void; language: 'zh' | 'en' }

const PROFILE_KEYS = [
  'modelPath', 'ttsEnabled', 'musicEnabled', 'musicSettings', 'headphoneFits', 'showText', 'hideUI',
  'tracking', 'gazeGain', 'volume', 'uiAlign', 'hideMood', 'currentDance',
  'customDancePreset', 'language', 'pinned', 'collapsed', 'panelWidth', 'quality', 'bubbleSettings',
  'animationSettings', 'behaviorSettings', 'petSettings', 'propSettings', 'lighting', 'cursorLight',
]
const field: React.CSSProperties = { background: '#262c38', border: '1px solid #505665', borderRadius: 7, color: 'white', padding: '6px 8px', minWidth: 150, maxWidth: 220 }
const button: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 7, color: 'white', padding: '6px 9px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }

async function responseJson(response: Response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

export function SettingsProfiles({ settings, onLoad, language }: Props) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const t = (english: string, chinese: string) => language === 'zh' ? chinese : english

  const refresh = async (selectId?: string) => {
    const data = await responseJson(await fetch(petUrl('/settings-profiles')))
    setProfiles(data.profiles || [])
    if (selectId) setSelected(selectId)
    else if (selected && !(data.profiles || []).some((p: ProfileSummary) => p.id === selected)) setSelected('')
  }

  useEffect(() => { void refresh().catch(error => setMessage(error.message)) }, [])

  const current = profiles.find(profile => profile.id === selected)
  const snapshot = () => Object.fromEntries(PROFILE_KEYS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]))

  const save = async () => {
    const name = window.prompt(t('Save settings profile as:', '保存配置方案为：'), current?.name || '')
    if (name === null || !name.trim()) return
    const existing = profiles.find(profile => profile.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase())
    let id = selected || undefined
    if (existing && existing.id !== selected) {
      if (!window.confirm(t(`Replace the saved profile “${existing.name}”?`, `替换已保存的配置方案“${existing.name}”？`))) return
      id = existing.id
    }
    setBusy(true); setMessage('')
    try {
      const result = await responseJson(await fetch(petUrl('/settings-profiles'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: name.trim(), settings: snapshot() }),
      }))
      await refresh(result.profile.id)
      setMessage(t(`Saved “${result.profile.name}”.`, `已保存“${result.profile.name}”。`))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const load = async () => {
    if (!selected) return
    setBusy(true); setMessage('')
    try {
      const data = await responseJson(await fetch(petUrl(`/settings-profiles/${selected}`)))
      onLoad(data.profile.settings)
      setMessage(t(`Loaded “${data.profile.name}”.`, `已加载“${data.profile.name}”。`))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const exportBundle = async () => {
    if (!selected || !current) return
    setBusy(true); setMessage(t('Preparing portable profile bundle…', '正在准备可分享的配置方案…'))
    try {
      const response = await fetch(petUrl(`/settings-profiles/${selected}/export`))
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Export failed')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `${current.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'Cuttle-Pet-Profile'}.cuttleprofile`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
      setMessage(t(`Exported “${current.name}”.`, `已导出“${current.name}”。`))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const importBundle = async (file: File) => {
    setBusy(true); setMessage(t('Checking profile bundle…', '正在检查配置方案…'))
    let token = ''
    try {
      const form = new FormData(); form.set('file', file)
      const previewData = await responseJson(await fetch(petUrl('/settings-profiles/import/preview'), { method: 'POST', body: form }))
      const preview = previewData.preview
      token = previewData.token
      const added = preview.assets.filter((asset: any) => !asset.alreadyInstalled)
      const reused = preview.assets.length - added.length
      const proposedName = preview.suggestedName
      const nameNote = proposedName !== preview.name ? t(`\nA profile with that name exists; this one will be named “${proposedName}”.`, `\n已有同名方案；此方案将命名为“${proposedName}”。`) : ''
      const categories = (preview.categories || []).join(', ')
      const examples = added.slice(0, 4).map((asset: any) => asset.filename).join(', ')
      const more = added.length > 4 ? `, +${added.length - 4} more` : ''
      const megabytes = (preview.totalBytes / (1024 * 1024)).toFixed(1)
      const summary = language === 'zh'
        ? `导入“${proposedName}”？\n设置：${categories}。\n${preview.assets.length} 个所需文件，共 ${megabytes} MB（安装 ${added.length} 个，复用 ${reused} 个）。${added.length ? `\n新文件：${examples}${more}。` : ''}${nameNote}\n\n方案将加入列表，不会立即应用；选择后请点击“加载”。`
        : `Import “${proposedName}”?\nSettings: ${categories}.\n${preview.assets.length} required assets · ${megabytes} MB total (${added.length} to install, ${reused} already present).${added.length ? `\nNew files: ${examples}${more}.` : ''}${nameNote}\n\nThe profile will be added to your list and will not apply until you load it.`
      if (!window.confirm(summary)) {
        await fetch(petUrl('/settings-profiles/import/cancel'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
        token = ''
        setMessage(t('Import canceled.', '已取消导入。'))
        return
      }
      const result = await responseJson(await fetch(petUrl('/settings-profiles/import/commit'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name: proposedName }),
      }))
      token = ''
      await refresh(result.profile.id)
      setMessage(t(`Imported “${result.profile.name}”. Select Load to apply it.`, `已导入“${result.profile.name}”。选择后点击“加载”即可应用。`))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally {
      if (token) void fetch(petUrl('/settings-profiles/import/cancel'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!current || !window.confirm(t(`Delete the saved profile “${current.name}”? Its asset files will stay in your library.`, `删除已保存的配置方案“${current.name}”？所需文件仍会保留在素材库中。`))) return
    setBusy(true); setMessage('')
    try {
      await responseJson(await fetch(petUrl(`/settings-profiles/${selected}`), { method: 'DELETE' }))
      await refresh()
      setMessage(t(`Deleted “${current.name}”.`, `已删除“${current.name}”。`))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const rename = async () => {
    if (!current) return
    const name = window.prompt(t('Rename settings profile:', '重命名配置方案：'), current.name)
    if (name === null || !name.trim() || name.trim() === current.name) return
    setBusy(true); setMessage('')
    try {
      const data = await responseJson(await fetch(petUrl(`/settings-profiles/${selected}`)))
      const result = await responseJson(await fetch(petUrl('/settings-profiles'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected, name: name.trim(), settings: data.profile.settings }),
      }))
      await refresh(selected)
      setMessage(t(`Renamed to “${result.profile.name}”.`, `已重命名为“${result.profile.name}”。`))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  return <div className="settings-profile-toolbar" data-no-passthrough onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <span className="settings-profile-label">{t('Profiles', '配置方案')}</span>
    <select aria-label={t('Saved settings profile', '已保存的配置方案')} value={selected} onChange={event => setSelected(event.target.value)} style={field} disabled={busy}>
      <option value="">{t('Choose a profile…', '选择配置方案…')}</option>
      {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
    </select>
    <button type="button" style={button} title={t('Apply the selected settings profile', '应用选中的配置方案')} disabled={!selected || busy} onClick={() => void load()}>{t('Load', '加载')}</button>
    <button type="button" style={button} title={t('Save the current setup as a profile on this computer', '将当前设置保存为本机配置方案')} disabled={busy} onClick={() => void save()}><Save size={13} /> {t('Save', '保存')}</button>
    <button type="button" style={button} title={t('Create a portable profile bundle with its required assets', '导出包含所需素材的可分享配置方案')} disabled={!selected || busy} onClick={() => void exportBundle()}><Download size={13} /> {t('Export', '导出')}</button>
    <button type="button" style={button} title={t('Import a portable profile bundle; it will not apply until you Load it', '导入可分享配置方案；点击“加载”后才会应用')} disabled={busy} onClick={() => fileRef.current?.click()}><FolderOpen size={13} /> {t('Import', '导入')}</button>
    <details className="settings-profile-more">
      <summary aria-label={t('More profile actions', '更多配置方案操作')} title={t('More profile actions', '更多配置方案操作')}><MoreHorizontal size={17} /></summary>
      <div className="settings-profile-menu">
        <button type="button" style={button} disabled={!selected || busy} onClick={() => void rename()}>{t('Rename', '重命名')}</button>
        <button type="button" style={button} disabled={!selected || busy} onClick={() => void remove()}><Trash2 size={13} /> {t('Delete', '删除')}</button>
      </div>
    </details>
    <input ref={fileRef} type="file" accept=".cuttleprofile,.zip,application/zip" hidden onChange={event => {
      const file = event.target.files?.[0]; if (file) void importBundle(file); event.target.value = ''
    }} />
    {message && <span role="status" className="settings-profile-message">{message}</span>}
  </div>
}
