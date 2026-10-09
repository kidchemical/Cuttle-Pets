import assert from 'node:assert/strict'
import {
  EMOTION_OPTIONS, RANDOM_ACTION, animationLabel, applyBaseById, applyEmotion,
  defaultBehaviorProfile, describeStatus, entryCursorFollow, motionKey, normalizeBehaviorSettings, normalizeProfile,
  pickRandomAction, pickRandomEmotion, pickWeightedEntry, playOnceById, resolveCursorFollow, resolveMain, resolvePetState,
  type BehaviorScene,
} from '../app/src/behavior'

function makeScene() {
  const calls: string[] = []
  const scene: BehaviorScene = {
    resetPose: () => { calls.push('reset') },
    setWorking: (active: boolean, durationMs = 0) => { calls.push(`working:${active}:${durationMs}`) },
    requestCoffeeSip: () => { calls.push('sip') },
    startSipLoop: () => { calls.push('sipLoop') },
    setMusicPreview: (active: boolean, durationMs = 0) => { calls.push(`music:${active}:${durationMs}`) },
    pulseProcedural: (id: string, loop: boolean) => { calls.push(`pulse:${id}:${loop}`) },
    playAnimationOnce: (name: string) => { calls.push(`once:${name}`) },
    playActionLoop: (name: string) => { calls.push(`loop:${name}`) },
    playDance: (nameOrPreset: string | object) => { calls.push(`dance:${typeof nameOrPreset === 'string' ? nameOrPreset : 'preset'}`) },
    playDanceOnce: (nameOrPreset: string | object) => { calls.push(`danceOnce:${typeof nameOrPreset === 'string' ? nameOrPreset : 'preset'}`) },
    setEmotionWithReset: (emotion: string) => { calls.push(`emotion:${emotion}`) },
    isBusy: () => false,
  }
  return { scene, calls }
}

async function main() {
  // Defaults mirror the built-in ambient behavior.
  const defaults = normalizeBehaviorSettings(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.current.name, 'Default')
  assert.equal(defaults.current.states.working.base.animation, 'typing')
  assert.deepEqual(defaults.current.states.working.occasionals[0], { animation: 'sip', everyMin: 40, everyMax: 90, chance: 1 })
  assert.equal(defaults.current.states.dancing.base.animation, 'dance:jile', 'Dancing base mirrors the first rotation entry for legacy readers')
  assert.deepEqual(defaults.profiles, [])

  // Cursor follow is per entry: idle and the music sway follow by default,
  // typing / actions / dances look ahead, and explicit values are clamped.
  assert.deepEqual(entryCursorFollow(defaults.current.states.idle.mains[0]), { eyes: 2, head: 1 })
  assert.deepEqual(entryCursorFollow(defaults.current.states.music.mains[0]), { eyes: 2, head: 1 })
  assert.deepEqual(entryCursorFollow(defaults.current.states.working.mains[0]), { eyes: 0, head: 0 })
  assert.deepEqual(entryCursorFollow(defaults.current.states.dancing.mains[0]), { eyes: 0, head: 0 })
  const tuned = normalizeProfile({ states: {
    working: { mains: [{ animation: 'typing', weight: 1, follow: { eyes: 9, head: 0.5 } }], start: [], occasionals: [], end: [] },
    idle: { mains: [{ animation: 'idle', weight: 1, follow: { eyes: 'x', head: -1 } }], start: [], occasionals: [], end: [] },
  } }, 'fb')
  assert.deepEqual(tuned.states.working.mains[0].follow, { eyes: 4, head: 0.5 }, 'Explicit follow survives normalization, clamped')
  assert.deepEqual(tuned.states.idle.mains[0].follow, { eyes: 2, head: 0 }, 'Invalid follow fields fall back to the animation default')
  assert.equal(normalizeProfile({ states: { idle: { mains: [{ animation: 'idle', weight: 1 }] } } }, 'fb').states.idle.mains[0].follow, undefined, 'No follow key stays default')

  // The innermost playing entry decides; references and empty playback defer to the renderer.
  assert.deepEqual(resolveCursorFollow(tuned, [{ state: 'working', phase: 'mains', index: 0 }]), { eyes: 4, head: 0.5 })
  assert.deepEqual(resolveCursorFollow(defaults.current, [
    { state: 'idle', phase: 'mains', index: 0 },
    { state: 'idle', phase: 'occasionals', index: 0 },
  ]), { eyes: 0, head: 0 }, 'A random-action occasional looks ahead over the idle loop')
  assert.equal(resolveCursorFollow(defaults.current, [{ state: 'music', phase: 'occasionals', index: 0 }]), null, 'Behavior reference defers')
  assert.equal(resolveCursorFollow(defaults.current, []), null)
  assert.equal(resolveCursorFollow(defaults.current, [{ state: 'idle', phase: 'end', index: 3 }]), null, 'Stale location defers')
  assert.equal(motionKey({ animation: 'idle', follow: { eyes: 1, head: 1 } }), motionKey({ animation: 'idle' }), 'Follow tuning is not a motion change')

  // Validation: unknown ids dropped, ranges clamped, lists capped, bad base falls back.
  const dirty = normalizeBehaviorSettings({
    enabled: 'yes',
    current: {
      name: 'x'.repeat(100),
      states: {
        idle: {
          start: [{ animation: 'action:happy' }, { animation: 'nope' }, 42],
          base: 'bogus',
          occasionals: [{ animation: 'sip', everyMin: 1, everyMax: 99999, chance: 7 }],
          end: new Array(9).fill({ animation: 'idle' }),
        },
      },
    },
    profiles: new Array(30).fill({ name: 'p' }),
  })
  assert.equal(dirty.enabled, true, 'Non-boolean enabled falls back to on')
  assert.ok(dirty.current.name.length <= 60)
  assert.deepEqual(dirty.current.states.idle.start.map(e => e.animation), ['action:happy'])
  assert.equal(dirty.current.states.idle.base.animation, 'idle', 'Bad base falls back per state')
  assert.deepEqual(
    [dirty.current.states.idle.occasionals[0].everyMin, dirty.current.states.idle.occasionals[0].everyMax, dirty.current.states.idle.occasionals[0].chance],
    [5, 3600, 1],
  )
  assert.equal(dirty.current.states.idle.end.length, 5, 'End sequences are capped')
  assert.equal(dirty.profiles.length, 20, 'Saved profiles are capped')
  assert.equal(normalizeProfile({ states: { working: { base: 'typing' } } }, 'fb').states.working.base.animation, 'typing', 'Bare string bases are accepted')

  // State priority: dancing beats working beats music beats idle.
  assert.equal(resolvePetState({ dancing: false, working: false, music: false }), 'idle')
  assert.equal(resolvePetState({ dancing: false, working: false, music: true }), 'music')
  assert.equal(resolvePetState({ dancing: false, working: true, music: true }), 'working')
  assert.equal(resolvePetState({ dancing: true, working: true, music: true }), 'dancing')

  // Labels + status line for the settings banner.
  assert.equal(animationLabel('action:happy'), 'Happy')
  assert.equal(animationLabel('dance:jile'), '极乐净土')
  assert.equal(animationLabel('typing'), 'Working / typing')
  assert.equal(animationLabel(RANDOM_ACTION), 'Surprise action')
  assert.equal(describeStatus({ state: 'idle', actionId: 'idle', danceId: null, working: false, sipping: false }), 'Idle')
  assert.equal(
    describeStatus({ state: 'working', actionId: null, danceId: null, working: true, sipping: true }),
    'Working — typing · sipping coffee',
  )
  assert.equal(
    describeStatus({ state: 'dancing', actionId: null, danceId: 'dance:jile', working: false, sipping: false }),
    'Dancing — 极乐净土',
  )

  // Once-mapping: settings preview path per animation kind.
  let { scene, calls } = makeScene()
  playOnceById(scene, 'action:happy')
  playOnceById(scene, 'dance:jile')
  playOnceById(scene, 'typing', undefined, 15000)
  playOnceById(scene, 'sip')
  playOnceById(scene, 'music', undefined, 15000)
  playOnceById(scene, 'eyes')
  playOnceById(scene, 'bogus-id')
  assert.deepEqual(calls, ['once:happy', 'danceOnce:jile', 'working:true:15000', 'working:true:0', 'sip', 'music:true:15000', 'pulse:eyes:false', 'reset'])
  ;({ scene, calls } = makeScene())
  playOnceById(scene, RANDOM_ACTION)
  assert.match(calls[0], /^once:[a-zA-Z]+$/, 'Random action resolves to a real one-shot')

  // Base-mapping: looped/sustained path per animation kind.
  ;({ scene, calls } = makeScene())
  applyBaseById(scene, 'action:happy')
  applyBaseById(scene, 'dance:jile')
  applyBaseById(scene, 'typing')
  applyBaseById(scene, 'sip')
  applyBaseById(scene, 'music')
  applyBaseById(scene, 'eyes')
  applyBaseById(scene, '')
  assert.deepEqual(calls, ['loop:happy', 'dance:jile', 'working:true:0', 'sipLoop', 'music:true:0', 'pulse:eyes:true'])

  // Emotions: none skipped, random resolves to a real emotion.
  ;({ scene, calls } = makeScene())
  applyEmotion(scene, '')
  applyEmotion(scene, 'happy')
  applyEmotion(scene, 'random', () => 0)
  assert.deepEqual(calls, ['emotion:happy', `emotion:${EMOTION_OPTIONS[0]}`])
  assert.ok(EMOTION_OPTIONS.includes(pickRandomEmotion(() => 0.99)))
  assert.ok(pickRandomAction(() => 0).length > 0)

  // Default profile survives a normalize round-trip (export/import stability).
  const roundTrip = normalizeProfile(JSON.parse(JSON.stringify(defaultBehaviorProfile())), 'fb')
  assert.deepEqual(roundTrip, defaultBehaviorProfile())

  // Weighted Main rotation: dancing ships with the 3 dances at equal chance.
  const danceMains = defaults.current.states.dancing.mains
  assert.deepEqual(danceMains.map(e => e.animation), ['dance:jile', 'dance:love', 'dance:ualDance'])
  assert.deepEqual(danceMains.map(e => e.weight), [1, 1, 1])
  assert.deepEqual(defaults.current.states.working.mains, [{ animation: 'typing', weight: 1 }])
  // Weighted picks: first/second/third third of the roll, zero weights never play.
  const rotation = [
    { animation: 'dance:jile', weight: 1 },
    { animation: 'dance:love', weight: 2 },
    { animation: 'dance:ualDance', weight: 0 },
  ]
  assert.equal(pickWeightedEntry(rotation, () => 0).animation, 'dance:jile')
  assert.equal(pickWeightedEntry(rotation, () => 0.5).animation, 'dance:love')
  assert.equal(pickWeightedEntry(rotation, () => 0.99).animation, 'dance:love')
  assert.equal(pickWeightedEntry([], () => 0), null)
  assert.equal(pickWeightedEntry([{ animation: 'idle', weight: 0 }], () => 0), null)
  // resolveMain prefers the rotation, then base, then leave-as-is.
  assert.equal(resolveMain(defaults.current.states.dancing, () => 0).animation, 'dance:jile')
  assert.equal(resolveMain({ start: [], base: { animation: 'typing' }, mains: [], occasionals: [], end: [] }).animation, 'typing')
  assert.equal(resolveMain({ start: [], base: { animation: '' }, mains: [], occasionals: [], end: [] }), null)
  // Legacy profiles without mains migrate from their explicit base.
  const migrated = normalizeProfile({ name: 'old', states: { working: { base: 'typing', start: [], occasionals: [], end: [] } } }, 'fb')
  assert.deepEqual(migrated.states.working.mains, [{ animation: 'typing', weight: 1 }])
  const migratedDance = normalizeProfile({ name: 'old', states: { dancing: { base: '', start: [], occasionals: [], end: [] } } }, 'fb')
  assert.deepEqual(migratedDance.states.dancing.mains, [])
  // Every state accepts both animations and behavior references.
  const sanitized = normalizeProfile({ name: 'old', states: { dancing: { base: { animation: 'action:defeated' }, start: [], occasionals: [], end: [] } } }, 'fb')
  assert.deepEqual(sanitized.states.dancing.mains.map(e => e.animation), ['action:defeated'])
  assert.equal(sanitized.states.dancing.base.animation, 'action:defeated')
  // Explicit dancing mains preserve all supported assignments.
  const mixed = normalizeProfile({ name: 'm', states: { dancing: { base: '', mains: [{ animation: 'action:happy', weight: 3 }, { animation: 'dance:love', weight: 2 }], start: [], occasionals: [], end: [] } } }, 'fb')
  assert.deepEqual(mixed.states.dancing.mains, [{ animation: 'action:happy', weight: 3 }, { animation: 'dance:love', weight: 2 }])
  // Explicitly emptied dancing mains stay empty (leave playing as-is).
  const emptied = normalizeProfile({ name: 'm', states: { dancing: { base: '', mains: [], start: [], occasionals: [], end: [] } } }, 'fb')
  assert.deepEqual(emptied.states.dancing.mains, [])
  assert.equal(emptied.states.dancing.base.animation, '')
  const references = normalizeProfile({ states: { music: {
    mains: [{ animation: 'behavior:working', weight: 1 }],
    start: [{ animation: 'behavior:idle', durationMs: 7000 }],
    occasionals: [{ animation: 'behavior:dancing', everyMin: 20, everyMax: 30, chance: .5 }],
    end: [{ animation: 'behavior:nope' }],
  } } }, 'References')
  assert.equal(references.states.music.mains[0].animation, 'behavior:working')
  assert.equal(references.states.music.start[0].durationMs, 7000)
  assert.equal(references.states.music.occasionals[0].animation, 'behavior:dancing')
  assert.deepEqual(references.states.music.end, [])
  const oldSettings = { current: { states: { music: { base: 'music', occasionals: [{ animation: 'action:happy', everyMin: 15, everyMax: 15, chance: 1 }], end: [] } } } }
  const upgraded = normalizeBehaviorSettings(oldSettings)
  assert.equal(upgraded.version, 2)
  assert.deepEqual(upgraded.current.states.music.occasionals.map(e => e.animation), ['action:happy', 'behavior:dancing'])
  assert.deepEqual(normalizeBehaviorSettings(upgraded), upgraded, 'Migration is idempotent')
  const optedOut = normalizeBehaviorSettings(oldSettings, { randomDance: false, reactOnEnd: false })
  assert.deepEqual(optedOut.current.states.music.occasionals.map(e => e.animation), ['action:happy'])
  assert.deepEqual(optedOut.current.states.music.end, [])
  // Mains weights are cleaned (clamped, capped, unknown animations dropped).
  const messy = normalizeProfile({ name: 'm', states: { idle: { base: 'idle', mains: [{ animation: 'idle', weight: 500 }, { animation: 'nope', weight: 1 }, { animation: 'action:happy' }], start: [], occasionals: [], end: [] } } }, 'fb')
  assert.deepEqual(messy.states.idle.mains, [{ animation: 'idle', weight: 99 }, { animation: 'action:happy', weight: 1 }])
  assert.equal(messy.states.idle.base.animation, 'idle', 'Base is preserved for older clients')

  console.log('Behavior passed: defaults, validation, state priority, labels, once/base mapping, emotions, profile round-trip, weighted mains.')
}
main().catch(error => { console.error(error); process.exit(1) })
