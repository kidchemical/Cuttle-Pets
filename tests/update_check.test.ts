import assert from 'node:assert/strict'
import { cachedUpdateStatus, checkForUpdates, compareVersions } from '../app/src/update-check'

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

// checkForUpdates with stubbed fetch: 404 (no releases published yet) is
// "up to date", not "couldn't check"; a network failure with an empty cache
// stays unknown; a newer tag reports available.
async function main() {
  const realFetch = (globalThis as any).fetch
  const stubFetch = (fn: () => Promise<unknown>) => {
    ;(globalThis as any).fetch = fn
  }
  const jsonResponse = (status: number, body: unknown) =>
    Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) })

  store.clear()
  stubFetch(() => jsonResponse(404, { message: 'Not Found' }))
  assert.deepEqual(await checkForUpdates('0.1.0', true), { state: 'latest', latest: '0.1.0' })

  store.clear()
  stubFetch(() => Promise.reject(new Error('offline')))
  assert.deepEqual(await checkForUpdates('0.1.0', true), { state: 'unknown' })

  store.clear()
  stubFetch(() =>
    jsonResponse(200, { tag_name: 'v0.2.0', html_url: 'https://example.invalid/r', body: '', published_at: '' }),
  )
  const fresh = await checkForUpdates('0.1.0', true)
  assert.equal(fresh.state, 'available')
  if (fresh.state === 'available') assert.equal(fresh.info.latest, '0.2.0')
  // The fresh result was cached, so a later offline check still knows.
  stubFetch(() => Promise.reject(new Error('offline')))
  assert.equal((await checkForUpdates('0.1.0')).state, 'available')

  // A failed check backs off: the failure is recorded, and a later automatic
  // check returns unknown without spending another network request.
  store.clear()
  let calls = 0
  stubFetch(() => {
    calls++
    return Promise.reject(new Error('offline'))
  })
  assert.deepEqual(await checkForUpdates('0.1.0', true), { state: 'unknown' })
  assert.equal(calls, 1)
  assert.deepEqual(await checkForUpdates('0.1.0'), { state: 'unknown' })
  assert.equal(calls, 1)

  // Forced checks (the manual "Check for updates" button) bypass the backoff.
  assert.deepEqual(await checkForUpdates('0.1.0', true), { state: 'unknown' })
  assert.equal(calls, 2)

  // An old failure marker no longer blocks automatic retries, and a success
  // clears the marker.
  store.set(
    'cuttle-pet-update-check-fail-v1',
    JSON.stringify({ failedAt: Date.now() - 61 * 60 * 1000 }),
  )
  stubFetch(() =>
    jsonResponse(200, { tag_name: 'v0.2.0', html_url: 'https://example.invalid/r', body: '', published_at: '' }),
  )
  assert.equal((await checkForUpdates('0.1.0')).state, 'available')
  assert.equal(store.get('cuttle-pet-update-check-fail-v1'), undefined)

  // A stale success cache still answers while backing off after a failure.
  store.set(
    'cuttle-pet-update-check-v1',
    JSON.stringify({ checkedAt: Date.now() - 7 * 60 * 60 * 1000, latest: '0.1.0', url: 'https://example.invalid/r', notes: '', publishedAt: '' }),
  )
  calls = 0
  stubFetch(() => {
    calls++
    return Promise.reject(new Error('offline'))
  })
  assert.deepEqual(await checkForUpdates('0.1.0', true), { state: 'latest', latest: '0.1.0' })
  assert.equal(calls, 1)
  assert.deepEqual(await checkForUpdates('0.1.0'), { state: 'latest', latest: '0.1.0' })
  assert.equal(calls, 1)
  ;(globalThis as any).fetch = realFetch

  console.log('update_check.test.ts passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
