import assert from 'node:assert/strict'
import {
  EMOTION_OPTIONS, RANDOM_ACTION, animationLabel, applyBaseById, applyEmotion,
  defaultBehaviorProfile, describeStatus, normalizeBehaviorSettings, normalizeProfile,
  pickRandomAction, pickRandomEmotion, playOnceById, resolvePetState,
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
  assert.equal(defaults.current.states.dancing.base.animation, '', 'Dancing base leaves the playing dance alone')
  assert.deepEqual(defaults.profiles, [])

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

  console.log('Behavior passed: defaults, validation, state priority, labels, once/base mapping, emotions, profile round-trip.')
}
main().catch(error => { console.error(error); process.exit(1) })
