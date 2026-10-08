import assert from 'node:assert/strict'
import { createExitShutdown } from '../app/src/exit-shutdown'

// Exit shutdown must run synchronously (beforeunload gives no second tick),
// in stop → dispose → lose order, and exactly once: a second unload event
// must not touch released GL resources again.
const calls: string[] = []
const shutdown = createExitShutdown({
  stopFrames: () => { calls.push('stop') },
  dispose: () => { calls.push('dispose') },
  loseContext: () => { calls.push('lose') },
})
shutdown()
assert.deepEqual(calls, ['stop', 'dispose', 'lose'])
shutdown()
shutdown()
assert.deepEqual(calls, ['stop', 'dispose', 'lose'])

// A throwing phase must not skip the later phases, and the guard still
// allows only one run: the first error propagates, context loss still runs.
let attempts = 0
const flaky = createExitShutdown({
  stopFrames: () => { attempts++ },
  dispose: () => { throw new Error('gl gone') },
  loseContext: () => { attempts++ },
})
assert.throws(flaky, /gl gone/)
assert.equal(attempts, 2)
// Second call is a no-op: no further attempts, and nothing thrown.
let threw = false
try { flaky() } catch { threw = true }
assert.equal(threw, false)
assert.equal(attempts, 2)
console.log('Exit shutdown checks passed.')
