import assert from 'node:assert/strict'
import { BehaviorEngine, type BehaviorPlayback, type EngineClock } from '../app/src/behavior-engine'
import { defaultBehaviorProfile, type BehaviorScene } from '../app/src/behavior'

class Clock implements EngineClock {
  ms = 0
  next = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  now = () => this.ms
  random = () => 0
  setTimeout(callback: () => void, ms: number) {
    const id = ++this.next
    this.timers.set(id, { at: this.ms + ms, callback })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout(id: ReturnType<typeof setTimeout>) { this.timers.delete(id as unknown as number) }
  async flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
  async advance(ms: number) {
    await this.flush()
    const end = this.ms + ms
    for (let count = 0; count < 10000; count++) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      this.ms = next[1].at
      this.timers.delete(next[0]); next[1].callback()
      await this.flush()
    }
    this.ms = end
    await this.flush()
  }
}
function fixture() {
  const time = new Clock()
  const calls: string[] = []
  const statuses: BehaviorPlayback[] = []
  let busyUntil = 0
  let looping = false
  const scene: BehaviorScene = {
    resetPose: () => { calls.push('reset'); busyUntil = 0; looping = false },
    setWorking: active => { calls.push(`working:${active}`) },
    setMusicPreview: active => { calls.push(`music:${active}`) },
    requestCoffeeSip: () => { calls.push('sip'); busyUntil = time.ms + 4500 },
    startSipLoop: () => { calls.push('sipLoop'); looping = true },
    pulseProcedural: id => { calls.push(`pulse:${id}`) },
    playAnimationOnce: name => { calls.push(`once:${name}`); busyUntil = time.ms + 1000 },
    playActionLoop: name => { calls.push(`loop:${name}`); looping = true; busyUntil = Infinity },
    playDance: name => { calls.push(`danceLoop:${name}`); looping = true; busyUntil = Infinity },
    playDanceOnce: name => { calls.push(`danceOnce:${name}`); busyUntil = time.ms + 2000 },
    setEmotionWithReset: emotion => { calls.push(`emotion:${emotion}`) },
    isBusy: () => time.ms < busyUntil,
    isLooping: () => looping,
  }
  const profile = defaultBehaviorProfile()
  for (const state of Object.values(profile.states)) { state.occasionals = []; state.start = []; state.end = [] }
  const engine = new BehaviorEngine(status => statuses.push(status), time)
  const input = { enabled: true, paused: false, state: 'music' as const, profile, scene }
  return { time, calls, statuses, scene, profile, engine, input }
}

async function main() {
  // Nested Start → weighted Main played once → End → restore the same base.
  {
    const f = fixture()
    f.profile.states.music.occasionals = [{ animation: 'behavior:dancing', everyMin: 5, everyMax: 5, chance: 1 }]
    f.profile.states.dancing.start = [{ animation: 'action:greeting' }]
    f.profile.states.dancing.end = [{ animation: 'action:happy' }]
    f.profile.states.dancing.occasionals = [{ animation: 'action:angry', everyMin: .1, everyMax: .1, chance: 1 }]
    f.engine.update(f.input)
    await f.time.advance(9000)
    assert.deepEqual(f.calls.filter(c => /^(once|danceOnce|music):/.test(c)), ['music:true', 'once:greeting', 'danceOnce:jile', 'once:happy', 'music:true'])
    assert.ok(f.statuses.some(s => s.state === 'dancing' && s.owned))
    assert.equal(f.statuses.at(-1)?.state, 'music')
    assert.deepEqual(f.statuses.at(-1)?.entries, [{ state: 'music', phase: 'mains', index: 0 }])
    assert.ok(f.statuses.some(status => status.state === 'dancing' && JSON.stringify(status.entries) === JSON.stringify([
      { state: 'music', phase: 'occasionals', index: 0 }, { state: 'dancing', phase: 'mains', index: 0 },
    ])), 'Highlight the invoking occasional and exact nested Main row together')
    assert.ok(f.statuses.some(status => JSON.stringify(status.entries) === JSON.stringify([
      { state: 'music', phase: 'occasionals', index: 0 }, { state: 'dancing', phase: 'start', index: 0 },
    ])), 'Highlight Start independently from Main')

    assert.ok(!f.calls.includes('once:angry'), 'Nested one-shot does not start its own occasional timers')
    f.engine.dispose(); assert.equal(f.time.timers.size, 0)
  }
  // Work arrives mid-dance: cancel the old run and resume the latest state.
  {
    const f = fixture()
    f.profile.states.music.occasionals = [{ animation: 'behavior:dancing', everyMin: 5, everyMax: 5, chance: 1 }]
    f.engine.update(f.input)
    await f.time.advance(5000)
    assert.ok(f.calls.includes('danceOnce:jile'))
    f.engine.update({ ...f.input, state: 'working' })
    await f.time.advance(20000)
    assert.equal(f.calls.filter(c => c === 'danceOnce:jile').length, 1)
    assert.equal(f.statuses.at(-1)?.state, 'working')
    assert.equal(f.calls.at(-1), 'working:true')
    f.engine.dispose()
  }
  // Procedural one-shots hold for the configured time before restoring Idle.
  {
    const f = fixture()
    f.profile.states.idle.occasionals = [{ animation: 'behavior:working', durationMs: 1500, everyMin: 5, everyMax: 5, chance: 1 }]
    f.engine.update({ ...f.input, state: 'idle' })
    await f.time.advance(6000)
    assert.equal(f.statuses.at(-1)?.state, 'working')
    await f.time.advance(500)
    assert.equal(f.statuses.at(-1)?.state, 'idle')
    f.engine.dispose()
  }
  // Profile edits reschedule immediately; disabled/paused engine has no timers.
  {
    const f = fixture()
    f.profile.states.music.occasionals = [{ animation: 'action:happy', everyMin: 5, everyMax: 5, chance: 1 }]
    f.engine.update(f.input); await f.time.advance(4000)
    const edited = structuredClone(f.profile); edited.states.music.occasionals = []
    f.engine.update({ ...f.input, profile: edited }); await f.time.advance(10000)
    assert.ok(!f.calls.includes('once:happy'))
    f.engine.update({ ...f.input, paused: true }); await f.time.flush()
    assert.equal(f.time.timers.size, 0)
    f.engine.update({ ...f.input, enabled: false }); await f.time.advance(60000)
    assert.equal(f.time.timers.size, 0)
    f.engine.dispose()
  }
  // Indirect cycles terminate, including sustained Main references.
  {
    const f = fixture()
    f.profile.states.music.mains = [{ animation: 'behavior:working', weight: 1 }]
    f.profile.states.working.mains = [{ animation: 'behavior:music', weight: 1 }]
    f.engine.update(f.input); await f.time.advance(10000)
    assert.ok(f.calls.length < 10)
    f.engine.previewEntry({ animation: 'behavior:music' }, false); await f.time.flush()
    assert.ok(f.calls.length < 20)
    f.engine.dispose(); assert.equal(f.time.timers.size, 0)
  }
  // Manual previews hold ownership while input changes; completion uses latest state.
  {
    const f = fixture()
    f.engine.update(f.input); await f.time.flush()
    f.engine.previewEntry({ animation: 'behavior:dancing' }, false, { state: 'music', phase: 'occasionals', index: 0 })
    await f.time.advance(500)
    assert.deepEqual(f.statuses.at(-1)?.entries, [
      { state: 'music', phase: 'occasionals', index: 0 }, { state: 'dancing', phase: 'mains', index: 0 },
    ], 'Settings previews preserve the invoking row')
    f.engine.update({ ...f.input, state: 'working' })
    assert.equal(f.engine.isPreviewing(), true)
    await f.time.advance(1500)
    assert.equal(f.engine.isPreviewing(), false)
    assert.equal(f.statuses.at(-1)?.state, 'working')
    assert.equal(f.calls.at(-1), 'working:true')
    f.engine.previewEntry({ animation: 'behavior:dancing' }, true); await f.time.flush()
    assert.ok(f.calls.includes('danceLoop:jile'))
    f.engine.stopPreview(); await f.time.flush()
    assert.equal(f.statuses.at(-1)?.state, 'working')
    f.engine.dispose()
  }
  // A sustained behavior reference runs its End when the parent state exits,
  // but profile timing edits do not replay Start on an unchanged delegation.
  {
    const f = fixture()
    f.profile.states.music.mains = [{ animation: 'behavior:working', weight: 1 }]
    f.profile.states.working.start = [{ animation: 'action:greeting' }]
    f.profile.states.working.end = [{ animation: 'action:happy' }]
    f.engine.update(f.input); await f.time.advance(1000)
    assert.equal(f.statuses.at(-1)?.state, 'working')
    const edited = structuredClone(f.profile)
    edited.states.music.occasionals = [{ animation: 'action:angry', everyMin: 60, everyMax: 60, chance: 1 }]
    f.engine.update({ ...f.input, profile: edited }); await f.time.flush()
    assert.equal(f.calls.filter(c => c === 'once:greeting').length, 1)
    f.engine.update({ ...f.input, state: 'idle', profile: edited }); await f.time.advance(1000)
    assert.ok(f.calls.includes('once:happy'))
    assert.equal(f.statuses.at(-1)?.state, 'idle')
    f.engine.dispose()
  }
  // Occasionals can interrupt an engine-owned loop, then restore the same
  // weighted Main instead of choosing a different animation on each resume.
  {
    const f = fixture()
    f.time.random = () => .75
    f.profile.states.music.mains = [{ animation: 'action:happy', weight: 1 }, { animation: 'action:angry', weight: 1 }]
    f.profile.states.music.occasionals = [{ animation: 'behavior:dancing', everyMin: 5, everyMax: 5, chance: 1 }]
    f.engine.update(f.input); await f.time.flush()
    assert.equal(f.calls.at(-1), 'loop:angry')
    await f.time.advance(7000)
    assert.equal(f.calls.at(-1), 'loop:angry')
    assert.equal(f.calls.filter(c => c === 'loop:angry').length, 2)
    f.engine.dispose()
  }
  // Coffee finishes naturally; no timer leaks or repeated legacy sip scheduler.
  {
    const f = fixture()
    f.profile.states.working.occasionals = [{ animation: 'sip', everyMin: 5, everyMax: 5, chance: 1 }]
    f.engine.update({ ...f.input, state: 'working' }); await f.time.advance(9000)
    assert.equal(f.calls.filter(c => c === 'sip').length, 1)
    await f.time.advance(500)
    assert.equal(f.calls.at(-1), 'working:true')
    f.engine.update({ ...f.input, state: 'working', enabled: false }); await f.time.advance(60000)
    assert.equal(f.calls.filter(c => c === 'sip').length, 1)
    assert.equal(f.time.timers.size, 0)
    f.engine.dispose()
  }
  // Actual async loading must finish before the engine considers a clip settled.
  {
    const f = fixture()
    let loaded: (() => void) | undefined
    f.scene.playDanceOnce = () => new Promise<void>(resolve => { loaded = resolve })
    f.engine.update(f.input); await f.time.flush()
    f.engine.previewEntry({ animation: 'behavior:dancing' }, false); await f.time.flush()
    await f.time.advance(10000)
    assert.equal(f.engine.isPreviewing(), true)
    f.engine.update({ ...f.input, scene: null }); loaded!(); await f.time.flush()
    assert.equal(f.statuses.at(-1)?.owned, false)
    assert.equal(f.time.timers.size, 0)
    f.engine.dispose()
  }
  console.log('behavior engine tests passed')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
