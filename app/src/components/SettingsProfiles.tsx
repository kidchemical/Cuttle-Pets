import { useRef, useState } from 'react'
import { FolderOpen, Save } from 'lucide-react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { petUrl } from '../config'

type Props = { settings: Record<string, any>; onLoad: (settings: Record<string, any>) => void; language: 'zh' | 'en' }

const PROFILE_KEYS = [
  'modelPath', 'ttsEnabled', 'musicEnabled', 'musicSettings', 'headphoneFits', 'showText', 'hideUI',
  'tracking', 'gazeGain', 'volume', 'uiAlign', 'hideMood', 'currentDance',
  'customDancePreset', 'language', 'pinned', 'collapsed', 'panelWidth', 'quality', 'bubbleSettings',
  'animationSettings', 'behaviorSettings', 'petSettings', 'propSettings', 'lighting', 'cursorLight',
]
const button: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 7, color: 'white', padding: '6px 9px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }

async function responseJson(response: Response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

function profileFilename(name: string) {
  const slug = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 60)
  return `${slug || 'Cuttle-Pet-Profile'}.cuttleprofile`
}

function profileNameFromPath(path: string) {
  const base = path.replace(/\\/g, '/').split('/').pop() || ''
  return base.replace(/\.cuttleprofile$/i, '').trim().slice(0, 60) || 'Cuttle-Pet-Profile'
}

export function SettingsProfiles({ settings, onLoad, language }: Props) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const t = (english: string, chinese: string) => language === 'zh' ? chinese : english

  const snapshot = () => Object.fromEntries(PROFILE_KEYS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]))

  const exportBundle = async (name: string) => {
    const response = await fetch(petUrl('/settings-profiles/export'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, settings: snapshot() }),
    })
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Save failed')
    return response
  }

  const save = async () => {
    setBusy(true); setMessage(t('Preparing portable profile…', '正在准备可分享的配置…'))
    try {
      if (isTauri()) {
        // The native Save As dialog names the file, so the profile name follows
        // the chosen filename instead of a separate JavaScript prompt.
        const path = await invoke<string | null>('choose_profile_save_path', { defaultName: 'Cuttle-Pet-Profile.cuttleprofile' })
        if (!path) { setMessage(t('Save canceled.', '已取消保存。')); return }
        const response = await exportBundle(profileNameFromPath(path))
        const bytes = new Uint8Array(await response.arrayBuffer())
        const savedPath = await invoke<string>('write_settings_profile', bytes)
        setMessage(t(`Saved to ${savedPath}`, `已保存到 ${savedPath}`))
      } else {
        const name = window.prompt(t('Save settings to a profile file as:', '将当前设置保存为配置方案文件：'), '')
        if (name === null || !name.trim()) return
        const trimmed = name.trim()
        const response = await exportBundle(trimmed)
        const url = URL.createObjectURL(await response.blob())
        const link = document.createElement('a')
        link.href = url
        link.download = profileFilename(trimmed)
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
        setMessage(t(`Saved “${trimmed}”.`, `已保存“${trimmed}”。`))
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const load = async (file: File) => {
    setBusy(true); setMessage(t('Checking profile file…', '正在检查配置文件…'))
    let token = ''
    try {
      const form = new FormData(); form.set('file', file)
      const previewData = await responseJson(await fetch(petUrl('/settings-profiles/import/preview'), { method: 'POST', body: form }))
      const preview = previewData.preview
      token = previewData.token
      const added = preview.assets.filter((asset: any) => !asset.alreadyInstalled)
      const reused = preview.assets.length - added.length
      const categories = (preview.categories || []).join(', ')
      const examples = added.slice(0, 4).map((asset: any) => asset.filename).join(', ')
      const more = added.length > 4 ? `, +${added.length - 4} more` : ''
      const megabytes = (preview.totalBytes / (1024 * 1024)).toFixed(1)
      const summary = language === 'zh'
        ? `加载“${preview.name}”？\n设置：${categories}。\n${preview.assets.length} 个所需文件，共 ${megabytes} MB（安装 ${added.length} 个，复用 ${reused} 个）。${added.length ? `\n新文件：${examples}${more}。` : ''}\n\n所需素材将安装到本机并立即应用。`
        : `Load “${preview.name}”?\nSettings: ${categories}.\n${preview.assets.length} required assets · ${megabytes} MB total (${added.length} to install, ${reused} already present).${added.length ? `\nNew files: ${examples}${more}.` : ''}\n\nRequired assets will be installed and the profile applied immediately.`
      if (!window.confirm(summary)) {
        await fetch(petUrl('/settings-profiles/import/cancel'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
        token = ''
        setMessage(t('Load canceled.', '已取消加载。'))
        return
      }
      const result = await responseJson(await fetch(petUrl('/settings-profiles/import/commit'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }))
      token = ''
      onLoad(result.settings)
      setMessage(t(`Loaded “${preview.name}”.`, `已加载“${preview.name}”。`))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally {
      if (token) void fetch(petUrl('/settings-profiles/import/cancel'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      setBusy(false)
    }
  }

  return <div className="settings-profile-toolbar" data-no-passthrough onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <span className="settings-profile-label">{t('Profiles', '配置方案')}</span>
    <button type="button" style={button} title={t('Save the current setup to a portable .cuttleprofile file you can load later or share', '将当前设置保存为可加载或分享的 .cuttleprofile 文件')} disabled={busy} onClick={() => void save()}><Save size={13} /> {t('Save', '保存')}</button>
    <button type="button" style={button} title={t('Load a .cuttleprofile file; its required assets install automatically', '加载 .cuttleprofile 文件；所需素材会自动安装')} disabled={busy} onClick={() => fileRef.current?.click()}><FolderOpen size={13} /> {t('Load', '加载')}</button>
    <input ref={fileRef} type="file" accept=".cuttleprofile,.zip,application/zip" hidden onChange={event => {
      const file = event.target.files?.[0]; if (file) void load(file); event.target.value = ''
    }} />
    {message && <span role="status" className="settings-profile-message">{message}</span>}
  </div>
}
