import assert from 'node:assert/strict'
const memory = new Map<string, string>()
Object.assign(globalThis, { localStorage: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v) } })
async function main() {
  let saved: Record<string, any> = {}
  let release: (() => void) | undefined
  let first = true
  let offline = false
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (offline) throw new Error('offline test')
    if (init?.method === 'POST') {
      if (first) { first = false; await new Promise<void>(resolve => { release = resolve }) }
      Object.assign(saved, JSON.parse(init.body as string))
    }
    return { ok: true, json: async () => ({ ...saved, voice: { qwenKey: 'secret-not-for-browser-cache' } }) } as Response
  }) as typeof fetch
  const { saveSettings, loadSettings } = await import('../app/src/settings')
  saveSettings({ hideMood: true })
  saveSettings({ pinned: false })
  const pending = JSON.parse(memory.get('cuttle-pet-pending-preferences-v1')!)
  assert.deepEqual(pending, { hideMood: true, pinned: false }, 'Persist both in-flight and queued changes before exit')
  release!()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(saved, { hideMood: true, pinned: false })
  assert.ok(!memory.get('cuttle-pet-preferences-v1')!.includes('secret'))
  saveSettings({ headphoneFits: { '/cosmic.vrm': { scale: 1.4, y: 8 } }, musicSettings: { minBpm: 95, maxBpm: 195, nod: 24 } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await loadSettings()).headphoneFits['/cosmic.vrm'].scale, 1.4)
  assert.equal((await loadSettings()).musicSettings.maxBpm, 195)
  offline = true
  saveSettings({ volume: 0.3 })
  await new Promise(resolve => setTimeout(resolve, 20))
  const local = await loadSettings()
  assert.equal(local.hideMood, true)
  assert.equal(local.volume, 0.3)
  offline = false
  await new Promise(resolve => setTimeout(resolve, 3200))
  assert.equal(saved.volume, 0.3, 'Offline preferences sync after reconnection')
  console.log('Preferences passed: queued writes, offline persistence, retry, and secret exclusion.')
}
main().catch(e => { console.error(e); process.exit(1) })
