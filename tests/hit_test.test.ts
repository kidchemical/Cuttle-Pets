import assert from 'node:assert/strict'
import { hitTestWithTimeout } from '../app/src/hit-test'

async function main() {
  // Fast hit-test passes its verdict through unchanged.
  assert.equal(await hitTestWithTimeout(async () => true, 10, 20, 1000), true)
  assert.equal(await hitTestWithTimeout(async () => false, 10, 20, 1000), false)

  // A hit-test that never resolves must not hang the caller: it fails OPEN
  // (over-model) so click-through can never freeze the window deaf.
  const never = new Promise<boolean>(() => {})
  const t0 = Date.now()
  assert.equal(await hitTestWithTimeout(() => never, 10, 20, 50), true)
  assert.ok(Date.now() - t0 < 1000, 'timed-out hit-test returns promptly')

  // A rejecting hit-test also fails open instead of wedging the pending gate.
  assert.equal(
    await hitTestWithTimeout(async () => { throw new Error('gl gone') }, 10, 20, 1000),
    true,
  )

  // A late resolution after the timeout must not change the settled verdict.
  let lateResolve!: (v: boolean) => void
  const late = new Promise<boolean>((r) => { lateResolve = r })
  assert.equal(await hitTestWithTimeout(() => late, 10, 20, 20), true)
  lateResolve(false)
  await new Promise((r) => setTimeout(r, 50))

  console.log('Hit-test checks passed: pass-through verdicts, fail-open timeout, rejection fail-open.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
