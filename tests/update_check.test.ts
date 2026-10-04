import assert from 'node:assert/strict'
import { cachedUpdateStatus, compareVersions } from '../app/src/update-check'

// compareVersions: numeric per segment, tolerant of v-prefix and ragged length.
assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
assert.equal(compareVersions('0.2.0', '0.1.0'), 1)
assert.equal(compareVersions('v0.1.0', '0.1.1'), -1)
assert.equal(compareVersions('0.1', '0.1.0'), 0)
assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
assert.equal(compareVersions('1.0.0', '0.9.9'), 1)

// cachedUpdateStatus never hits the network: no cache means unknown.
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}

assert.deepEqual(cachedUpdateStatus('0.1.0'), { state: 'unknown' })

// A cached newer release reports available; a cached same release is latest.
store.set(
  'cuttle-pet-update-check-v1',
  JSON.stringify({ checkedAt: Date.now(), latest: '0.2.0', url: 'https://example.invalid/r', notes: '', publishedAt: '' }),
)
const available = cachedUpdateStatus('0.1.0')
assert.equal(available.state, 'available')
if (available.state === 'available') {
  assert.equal(available.info.latest, '0.2.0')
  assert.equal(available.info.current, '0.1.0')
}

store.set(
  'cuttle-pet-update-check-v1',
  JSON.stringify({ checkedAt: Date.now(), latest: '0.1.0', url: 'https://example.invalid/r', notes: '', publishedAt: '' }),
)
assert.deepEqual(cachedUpdateStatus('0.1.0'), { state: 'latest', latest: '0.1.0' })

// A cached older release never reports an update (local build ahead).
assert.deepEqual(cachedUpdateStatus('0.3.0'), { state: 'latest', latest: '0.1.0' })

console.log('update_check.test.ts passed')
