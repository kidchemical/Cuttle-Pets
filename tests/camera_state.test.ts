import assert from 'node:assert/strict'
import { loadSavedCameraView, saveCameraView, CAMERA_STORAGE_KEY } from '../app/src/camera-framing'

function stubStore(initial?: Record<string, string>) {
  const data = { ...(initial ?? {}) }
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
  }
}

const view = { pivot: [0.1, 1.2, 0.3] as [number, number, number], radius: 2.1, theta: 0.4, phi: 1.2 }

// Round-trip survives a simulated restart (fresh module-level read).
const store = stubStore()
saveCameraView(view, store)
assert.equal(store.data[CAMERA_STORAGE_KEY], JSON.stringify(view))
assert.deepEqual(loadSavedCameraView(store), view)

// Corrupt / malformed payloads fall back to model-fitted defaults (null).
assert.equal(loadSavedCameraView(stubStore()), null)
assert.equal(loadSavedCameraView(stubStore({ [CAMERA_STORAGE_KEY]: 'not-json{' })), null)
assert.equal(loadSavedCameraView(stubStore({ [CAMERA_STORAGE_KEY]: JSON.stringify({ ...view, radius: 0 }) })), null)
assert.equal(loadSavedCameraView(stubStore({ [CAMERA_STORAGE_KEY]: JSON.stringify({ ...view, pivot: [0, 1] }) })), null)
assert.equal(loadSavedCameraView(stubStore({ [CAMERA_STORAGE_KEY]: JSON.stringify({ ...view, theta: 'x' }) })), null)
assert.equal(loadSavedCameraView(stubStore({ [CAMERA_STORAGE_KEY]: JSON.stringify({ ...view, pivot: [0, NaN, 0] }) })), null)

// Missing storage (SSR/private mode) never throws.
assert.equal(loadSavedCameraView(null), null)
saveCameraView(view, null)

console.log('Camera state checks passed: restart round-trip, corrupt-payload fallback, storage-less no-op.')
