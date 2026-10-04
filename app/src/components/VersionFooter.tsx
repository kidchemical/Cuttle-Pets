import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-shell'
import { isTauri } from '@tauri-apps/api/core'
import { APP_VERSION } from '../version'
import { cachedUpdateStatus, checkForUpdates, type UpdateStatus } from '../update-check'

export async function openExternal(url: string) {
  if (isTauri()) {
    try {
      await open(url)
      return
    } catch {
      /* fall through to window.open */
    }
  }
  window.open(url, '_blank', 'noopener')
}

/** Small version pill for the settings header. Click to copy. */
export function VersionChip({ language }: { language: 'zh' | 'en' }) {
  const t = (zh: string, en: string) => (language === 'en' ? en : zh)
  const [copied, setCopied] = useState(false)
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`v${APP_VERSION}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the pill text is still selectable */
    }
  }, [])
  return (
    <button
      onClick={() => void copy()}
      title={t('点击复制版本号', 'Click to copy version')}
      style={chipStyle}
    >
      {copied ? t('已复制', 'copied') : `v${APP_VERSION}`}
    </button>
  )
}

export function VersionFooter({ language }: { language: 'zh' | 'en' }) {
  const t = (zh: string, en: string) => (language === 'en' ? en : zh)
  const [status, setStatus] = useState<UpdateStatus>(() => cachedUpdateStatus())
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let active = true
    void checkForUpdates().then(result => {
      if (active) setStatus(result)
    })
    return () => {
      active = false
    }
  }, [])

  const recheck = useCallback(async () => {
    setChecking(true)
    try {
      setStatus(await checkForUpdates(APP_VERSION, true))
    } finally {
      setChecking(false)
    }
  }, [])

  const dotColor =
    status.state === 'available'
      ? '#4da3ff'
      : status.state === 'latest'
        ? '#58d68d'
        : 'rgba(255, 255, 255, 0.35)'

  // One quiet line, no box: status left, a single text action right.
  // (The standalone window places this on its own full-width grid row via
  // .settings-version-footer in settings.css — without that it collapses
  // into the 152px tab rail.)
  return (
    <div className="settings-version-footer" style={footerStyle}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            background: dotColor,
            display: 'inline-block',
          }}
        />
        {status.state === 'available' ? (
          <button
            onClick={() => void openExternal(status.info.url)}
            style={updateBtnStyle}
            title={t('打开更新说明', 'Open release notes')}
          >
            <span style={{ color: '#aebbd0' }}>{t('有新版本 ', 'Update available ')}</span>
            <span style={{ color: '#aebbd0' }}>v{status.info.current}</span>
            <span style={{ color: '#7d8aa0' }}> → </span>
            <span style={{ color: '#4da3ff', fontWeight: 600 }}>v{status.info.latest}</span>
          </button>
        ) : status.state === 'latest' ? (
          <span>
            {t('已是最新版本', 'Up to date')} <span style={{ color: '#7d8aa0' }}>· v{APP_VERSION}</span>
          </span>
        ) : (
          <span>{checking ? t('正在检查更新…', 'Checking…') : t('未能检查更新', "Couldn't check")}</span>
        )}
      </span>
      <button onClick={() => void recheck()} disabled={checking} style={quietStyle}>
        {t('检查更新', 'Check for updates')}
      </button>
    </div>
  )
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 12,
  color: '#aebbd0',
  fontFamily: 'inherit',
}

const chipStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.08)',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  borderRadius: 10,
  color: '#aebbd0',
  fontSize: 11,
  cursor: 'pointer',
  padding: '1px 8px',
  marginLeft: 8,
  verticalAlign: 'middle',
  fontFamily: 'inherit',
}

const updateBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
}

const quietStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#7d8aa0',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
}
