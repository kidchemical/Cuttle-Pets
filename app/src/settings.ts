import { petUrl } from './config'
type Settings = Record<string, any>
const CACHE = 'cuttle-pet-preferences-v1'
const PENDING = 'cuttle-pet-pending-preferences-v1'
const keys = new Set(['modelPath','ttsEnabled','musicEnabled','musicSettings','headphoneFits','showText','hideUI','tracking','volume','uiAlign','hideMood','screenObserve','screenObserveInterval','currentDance','customDancePreset','language','pinned','collapsed','quality','bubbleSettings','panelWidth'])
const preferences = (data: Settings): Settings => Object.fromEntries(Object.entries(data).filter(([key]) => keys.has(key)))
function read(key: string): Settings {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {} } catch { return {} }
}
function write(key: string, data: Settings) {
  try { localStorage.setItem(key, JSON.stringify(data)) } catch { /* Backend persistence still works if browser storage is unavailable. */ }
}
let pending = read(PENDING)
let saving = false
let inFlight: Settings = {}
let retry: ReturnType<typeof setTimeout> | undefined
async function flush() {
  if (saving || !Object.keys(pending).length) return
  if (retry) { clearTimeout(retry); retry = undefined }
  saving = true
  const batch = pending
  inFlight = batch
  pending = {}
  try {
    const response = await fetch(petUrl('/settings'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) })
    if (!response.ok) throw new Error('Settings save failed')
    const saved = preferences(await response.json())
    write(CACHE, { ...saved, ...pending })
    inFlight = {}
    write(PENDING, pending)
  } catch (error) {
    inFlight = {}
    pending = { ...batch, ...pending }
    write(PENDING, pending)
    console.warn('Preferences saved locally; retrying server sync', error)
    retry = setTimeout(() => { retry = undefined; void flush() }, 3000)
  } finally {
    saving = false
  }
  if (!retry && Object.keys(pending).length) void flush()
}
export function saveSettings(patch: Settings) {
  const clean = preferences(Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value])))
  pending = { ...pending, ...clean }
  write(CACHE, { ...read(CACHE), ...clean })
  write(PENDING, { ...inFlight, ...pending })
  void flush()
}
export async function loadSettings(): Promise<Settings> {
  try {
    const response = await fetch(petUrl('/settings'))
    if (!response.ok) throw new Error('Settings load failed')
    const saved = preferences(await response.json())
    // Changes made before/during hydration and offline changes always win.
    const merged = { ...saved, ...read(PENDING), ...pending }
    write(CACHE, merged)
    void flush()
    return merged
  } catch {
    void flush()
    return { ...read(CACHE), ...pending }
  }
}
