import { isTauri, invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import type { DancePreset } from './motion-controller'

export type PetCommand =
  | { type: 'animation'; id: string; preset?: DancePreset; mode?: 'once' | 'loop' }
  | { type: 'stop' }
  | { type: 'music-preview'; active: boolean }
  | { type: 'bubble-preview' }
  | { type: 'screenshot'; request: string }
const browserBus = typeof window !== 'undefined' && !isTauri() && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cuttle-pet-windows') : null
export function publishPreferences(patch: Record<string, unknown>) {
  if (isTauri()) void emit('pet-preferences', patch).catch(console.warn)
  else browserBus?.postMessage({ name: 'pet-preferences', payload: patch })
}
export function subscribeWindowEvent<T>(name: string, callback: (payload: T) => void): () => void {
  if (isTauri()) {
    let disposed = false
    const pending = listen<T>(name, event => { if (!disposed) callback(event.payload) })
    return () => { disposed = true; void pending.then(stop => stop()).catch(console.warn) }
  }
  const handler = (event: MessageEvent) => { if (event.data?.name === name) callback(event.data.payload) }
  browserBus?.addEventListener('message', handler)
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
}
/** Main window → settings windows: live "what is the pet doing" snapshot. */
export function publishStatus(status: PetStatusPayload) {
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
