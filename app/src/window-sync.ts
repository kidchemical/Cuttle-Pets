import { isTauri, invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import type { BehaviorEntryLocation } from './behavior'
import type { DancePreset } from './motion-controller'
import type { CompanionAction } from './companions'

export type PetCommand =
  | { type: 'settings-resizing' }
  | { type: 'animation'; id: string; preset?: DancePreset; mode?: 'once' | 'loop'; durationMs?: number; source?: BehaviorEntryLocation; companions?: CompanionAction[] }
  | { type: 'companion'; action: CompanionAction }
  | { type: 'stop' }
  | { type: 'status' }
  | { type: 'music-preview'; active: boolean }
  | { type: 'bubble-preview' }
  | { type: 'screenshot'; request: string }
const browserBus = typeof window !== 'undefined' && !isTauri() && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cuttle-pet-windows') : null
export function publishPreferences(patch: Record<string, unknown>) {
  if (isTauri()) void emit('pet-preferences', patch).catch(console.warn)
  else browserBus?.postMessage({ name: 'pet-preferences', payload: patch })
}
export function subscribeWindowEvent<T>(name: string, callback: (payload: T) => void, onReady?: () => void): () => void {
  if (isTauri()) {
    let disposed = false
    const pending = listen<T>(name, event => { if (!disposed) callback(event.payload) })
    void pending.then(() => { if (!disposed) onReady?.() }).catch(console.warn)
    return () => { disposed = true; void pending.then(stop => stop()).catch(console.warn) }
  }
  const handler = (event: MessageEvent) => { if (event.data?.name === name) callback(event.data.payload) }
  browserBus?.addEventListener('message', handler)
  onReady?.()
  return () => browserBus?.removeEventListener('message', handler)
}
export function sendPetCommand(command: PetCommand) {
  if (isTauri()) void emitTo('main', 'pet-command', command).catch(console.warn)
  else browserBus?.postMessage({ name: 'pet-command', payload: command })
}
export interface PetStatusPayload {
  state: string
  actionId: string | null
  danceId: string | null
  working: boolean
  sipping: boolean
  musicMotion?: boolean
  /** Frames the pet rendered in the last second. */
  fps?: number
  behaviorEntries?: BehaviorEntryLocation[]
  reaction?: { id: string; index: number }
  companions?: Record<string, { shown: boolean }>
}
const STATUS_CACHE = 'cuttle-pet-playback-status-v1'
/** Last real snapshot only; stale data is shown as connecting instead. */
export function getLastPetStatus(): PetStatusPayload | null {
  try {
    const cached = JSON.parse(localStorage.getItem(STATUS_CACHE) || 'null')
    if (cached && Date.now() - cached.at < 10000 && ['idle', 'working', 'music', 'dancing'].includes(cached.status?.state)) return cached.status
  } catch { /* Status requests still work when storage is unavailable. */ }
  return null
}
/** Main window → settings windows: live "what is the pet doing" snapshot. */
export function publishStatus(status: PetStatusPayload) {
  try { localStorage.setItem(STATUS_CACHE, JSON.stringify({ at: Date.now(), status })) } catch { /* Best-effort cache. */ }
  if (isTauri()) void emit('pet-status', status).catch(console.warn)
  else browserBus?.postMessage({ name: 'pet-status', payload: status })
}
export function replyScreenshot(request: string, image: string | null) {
  const payload = { request, image }
  if (isTauri()) void emitTo('settings', 'pet-screenshot', payload).catch(console.warn)
  else browserBus?.postMessage({ name: 'pet-screenshot', payload })
}
export async function requestScreenshot(): Promise<string | null> {
  const request = crypto.randomUUID()
  let stop = () => {}
  let timer: ReturnType<typeof setTimeout>
  let finish: (image: string | null) => void = () => {}
  const result = new Promise<string | null>(resolve => {
    finish = image => { clearTimeout(timer); stop(); resolve(image) }
  })
  if (isTauri()) {
    stop = await listen<{ request: string; image: string | null }>('pet-screenshot', event => {
      if (event.payload.request === request) finish(event.payload.image)
    })
  } else {
    stop = subscribeWindowEvent<{ request: string; image: string | null }>('pet-screenshot', payload => {
      if (payload.request === request) finish(payload.image)
    })
  }
  timer = setTimeout(() => finish(null), 5000)
  sendPetCommand({ type: 'screenshot', request })
  return result
}
let popup: Window | null = null
export async function openSettingsWindow() {
  if (isTauri()) { await invoke('open_settings_window'); return }
  if (popup && !popup.closed) { popup.focus(); return }
  popup = window.open(`${location.pathname}?settings`, 'cuttle-pet-settings', 'width=1280,height=720,resizable=yes,scrollbars=yes')
  if (!popup) throw new Error('Allow popups to open the settings window.')
}
