import assert from 'node:assert/strict'

async function main() {
  const memory = new Map<string, string>()
  const order: string[] = []
  const posted: unknown[] = []
  Object.assign(globalThis, {
    window: {},
    localStorage: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    },
    BroadcastChannel: class {
      postMessage(message: unknown) { posted.push(message); order.push('send') }
      addEventListener() { order.push('listen') }
      removeEventListener() { order.push('stop') }
    },
  })
  const { getLastPetStatus, publishStatus, sendPetCommand, subscribeWindowEvent } = await import('../app/src/window-sync')
  assert.equal(getLastPetStatus(), null)
  const status = { state: 'music', actionId: null, danceId: null, working: false, sipping: false }
  publishStatus(status)
  assert.deepEqual(getLastPetStatus(), status, 'A new settings window can read the latest snapshot immediately')
  assert.deepEqual(posted[0], { name: 'pet-status', payload: status })
  order.length = 0
  const stop = subscribeWindowEvent('pet-status', () => {}, () => sendPetCommand({ type: 'status' }))
  assert.deepEqual(order, ['listen', 'send'], 'Request the snapshot only after subscribing')
  stop()
  const originalNow = Date.now
  Date.now = () => originalNow() + 11000
  assert.equal(getLastPetStatus(), null, 'Stale cache must not invent a current state')
  Date.now = originalNow
  memory.set('cuttle-pet-playback-status-v1', '{broken')
  assert.equal(getLastPetStatus(), null)
  console.log('Window status tests passed')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
