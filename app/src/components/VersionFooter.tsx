import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-shell'
import { isTauri } from '@tauri-apps/api/core'
import { APP_RELEASES_URL, APP_VERSION } from '../version'
import { cachedUpdateStatus, checkForUpdates, type UpdateStatus } from '../update-check'

async function openExternal(url: string) {
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

export function VersionFooter({ language }: { language: 'zh' | 'en' }) {
  const t = (zh: string, en: string) => (language === 'en' ? en : zh)
  const [status, setStatus] = useState<UpdateStatus>(() => cachedUpdateStatus())
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState(false)

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

  const copyVersion = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`v${APP_VERSION}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the version text is still selectable */
    }
  }, [])

  const dotColor =
    status.state === 'available'
      ? '#4da3ff'
      : status.state === 'latest'
        ? '#58d68d'
        : 'rgba(255, 255, 255, 0.35)'

  return (
    <div style={footerStyle}>
      <button
        onClick={() => void copyVersion()}
        title={t('点击复制版本号', 'Click to copy version')}
        style={versionStyle}
      >
        v{APP_VERSION}
        {copied && <span style={{ color: '#aebbd0' }}> · {t('已复制', 'copied')}</span>}
      </button>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#aebbd0' }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: dotColor,
            display: 'inline-block',
          }}
        />
        {status.state === 'available' && (
          <button onClick={() => void openExternal(status.info.url)} style={linkStyle}>
            {t(`有新版本 v${status.info.latest}`, `Update available: v${status.info.latest}`)}
          </button>
        )}
        {status.state === 'latest' && t('已是最新', 'Up to date')}
        {status.state === 'unknown' && t('未能检查更新', 'Update check unavailable')}
      </span>
      <span style={{ display: 'inline-flex', gap: 8 }}>
        {status.state === 'available' && (
          <button onClick={() => void openExternal(APP_RELEASES_URL)} style={linkStyle}>
            {t('更新说明', 'Release notes')}
          </button>
        )}
        <button onClick={() => void recheck()} disabled={checking} style={checkBtnStyle}>
          {checking ? t('检查中…', 'Checking…') : t('检查更新', 'Check for updates')}
        </button>
      </span>
    </div>
  )
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
  marginTop: 12,
  paddingTop: 10,
  borderTop: '1px solid rgba(255, 255, 255, 0.1)',
}

const versionStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
}

const linkStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#4da3ff',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
  textDecoration: 'underline',
}

const checkBtnStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.08)',
  border: '1px solid rgba(255, 255, 255, 0.15)',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 10px',
  fontFamily: 'inherit',
}
