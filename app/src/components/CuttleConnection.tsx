import { SettingsHelp } from './SettingsHelp'
import { useEffect, useState } from 'react'
import { petUrl } from '../config'

type Connection = {
  state: 'connected' | 'disconnected' | 'expired' | 'offline'
  username?: string
  message?: string
  url?: string
}

export function CuttleConnection() {
  const [connection, setConnection] = useState<Connection>({ state: 'disconnected' })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [url, setUrl] = useState('https://127.0.0.1:8080')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let active = true
    const abort = new AbortController()
    const refresh = async () => {
      try {
        const response = await fetch(petUrl('/cuttle/connection'), { signal: abort.signal })
        const data = await response.json()
        if (!active) return
        if (!response.ok || !data.ok) throw new Error(data.error || 'Cannot check connection.')
        setConnection(data)
        setError('')
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Pet server is unavailable.')
      } finally {
        if (active) setChecking(false)
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 10000)
    return () => { active = false; abort.abort(); window.clearInterval(timer) }
  }, [])

  const update = async (disconnect = false) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(petUrl('/cuttle/connection' + (disconnect ? '/disconnect' : '')), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(disconnect ? {} : { username, password, url }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || 'Connection failed.')
      setConnection(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pet server is unavailable.')
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  const inputStyle = { padding: 8, borderRadius: 6, border: '1px solid #666', background: '#252530', color: '#fff', width: '100%', boxSizing: 'border-box' as const }
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <h3 style={{ margin: 0 }}>Connect to Cuttle<SettingsHelp label="Cuttle connection help">Sign in once to make your pet react to all your Cuttle chats. Your connection is remembered across launches and reboots. Your password is never saved.</SettingsHelp></h3>
    <div role="status" aria-live="polite">
      {checking ? 'Checking connection…' : connection.state === 'connected' ? `Connected as ${connection.username}` : connection.state === 'offline' ? 'Cuttle is offline — reconnecting automatically.' : connection.state === 'expired' ? 'Sign-in expired. Please reconnect.' : 'Not connected'}
    </div>
    {error && <div role="alert" style={{ color: '#ffaaaa' }}>{error}</div>}
    {!checking && (connection.state === 'disconnected' || connection.state === 'expired') &&
      <form onSubmit={e => { e.preventDefault(); void update() }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label>Cuttle username<input required autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} style={inputStyle} disabled={busy} /></label>
        <label>Cuttle password<input required type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} disabled={busy} /></label>
        <details><summary>Cuttle address</summary><input aria-label="Cuttle address" value={url} onChange={e => setUrl(e.target.value)} style={inputStyle} disabled={busy} /></details>
        <button type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect to Cuttle'}</button>
      </form>}
    {(connection.state === 'connected' || connection.state === 'offline' || connection.state === 'expired') &&
      <button disabled={busy} onClick={() => void update(true)}>{busy ? 'Please wait…' : 'Disconnect'}</button>}
    {connection.state === 'connected' && <SettingsHelp>Watching all chats when launched with start_pet.sh. If Cuttle expires or revokes your login, reconnect here.</SettingsHelp>}
  </section>
}
