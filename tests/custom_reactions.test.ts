import assert from 'node:assert/strict'
import {
  coerceReactionParams, describeReaction, exampleReaction, normalizeBehaviorSettings,
  normalizeReaction, normalizeReactions, reactionCliExample, renderReactionTemplate,
  resolveReactionCall, slugifyReactionId, editReactionId, isValidReactionParamName, playReactionStep,
  type BehaviorScene,
} from '../app/src/behavior'

async function main() {
  // Old settings without reactions stay valid and default to none.
  const legacy = normalizeBehaviorSettings({ current: { name: 'Default' } })
  assert.deepEqual(legacy.reactions, [])

  // Slug rules for agent-facing ids.
  assert.equal(slugifyReactionId('Rocket Launch!', 'fb'), 'rocket-launch')
  assert.equal(slugifyReactionId('!!!', 'fb'), 'fb')

  // Normalization: unknown animations dropped, ranges clamped, params deduped.
  const reaction = normalizeReaction({
    id: 'Hat Dance',
    name: 'Hat dance',
    description: 'Dance for n seconds.',
    params: [
      { name: 'seconds', type: 'number', default: 'abc' },
      { name: 'seconds', type: 'string', default: 'dup' },
      { name: 'Bad Name', type: 'string', default: 'x' },
    ],
    steps: [
      { animation: 'bogus-id', emotion: 'happy' },
      { animation: 'action:cheering', emotion: 'happy', say: 'Go {{seconds}}s!', durationMs: 999999, props: { working: true } },
    ],
  }, 'fb')
  assert.ok(reaction)
  assert.equal(reaction!.id, 'hat-dance')
  assert.deepEqual(reaction!.steps.map(s => s.animation), ['action:cheering'])
  assert.equal(reaction!.steps[0].durationMs, 30000, 'Step duration is clamped')
  assert.deepEqual(reaction!.steps[0].props, { working: true })
  assert.deepEqual(reaction!.params.map(p => p.name), ['seconds'], 'Duplicate/invalid params dropped')
  assert.equal(reaction!.params[0].default, 0, 'Bad number default falls back to 0')

  // Step-less reactions are rejected; duplicate ids deduped; lists capped.
  assert.equal(normalizeReaction({ id: 'x', steps: [] }, 'x'), null)
  const dupes = normalizeReactions([
    { id: 'same', steps: [{ animation: 'idle' }] },
    { id: 'same', steps: [{ animation: 'idle' }] },
  ])
  assert.equal(dupes.length, 1)

  // The shipped example survives a normalize round-trip (editor stability).
  const example = exampleReaction()
  assert.deepEqual(normalizeReaction(JSON.parse(JSON.stringify(example)), 'fb'), example)

  // Templates render caller params; unknown keys are left alone.
  assert.equal(renderReactionTemplate('Dancing {{seconds}}s {{missing}}!', { seconds: 8 }), 'Dancing 8s {{missing}}!')

  // Resolution merges caller args over defaults with type coercion.
  const resolved = resolveReactionCall([example], 'rocket-launch', { message: 'Pushed!' })
  assert.equal(resolved.ok, true)
  if (resolved.ok) {
    assert.equal(resolved.values.message, 'Pushed!')
    assert.equal(resolved.steps[1].sayRendered, 'Pushed!')
  }
  const coerced = coerceReactionParams(
    { ...example, params: [{ name: 'n', type: 'number', default: 5, description: '' }] },
    { n: 'oops', extra: 'ignored' },
  )
  assert.deepEqual(coerced, { n: 5 }, 'Bad numbers fall back; unknown args ignored')

  // Unknown ids are errors with a known-id list, not silent no-ops.
  const missing = resolveReactionCall([example], 'nope')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.deepEqual(missing.known, ['rocket-launch'])

  // Catalog copy: CLI example + one-line summary.
  assert.equal(reactionCliExample('rocket-launch', example.params), 'python3 cli/cuttle_pet.py react rocket-launch [--param name=value ...]')
  assert.equal(reactionCliExample('wave'), 'python3 cli/cuttle_pet.py react wave')
  assert.ok(describeReaction(example).includes('params: message'))

  // Editor id input keeps separators mid-typing ("rocket-" → "rocket-launch").
  assert.equal(editReactionId('Rocket-'), 'rocket-')
  assert.equal(editReactionId('-x'), 'x')
  assert.equal(editReactionId('!!!'), '')
  assert.equal(isValidReactionParamName('seconds'), true)
  assert.equal(isValidReactionParamName('1x'), false)
  assert.equal(isValidReactionParamName(''), false)

  // Imported dances need their preset to be playable.
  const customDance = normalizeReaction({ id: 'd', steps: [
    { animation: 'dance:custom:mine' },
    { animation: 'dance:custom:mine', preset: { label: 'Mine', url: '/d.vmd' } },
  ] }, 'd')
  assert.equal(customDance!.steps.length, 1)
  assert.equal(customDance!.steps[0].preset?.url, '/d.vmd')

  // Every reaction step clears the previous motion first so it can't be
  // skipped by a clip/dance still holding the mixer; props are per step.
  const calls: string[] = []
  const scene = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { calls.push(`${String(name)}(${args.map(a => JSON.stringify(a)).join(',')})`); return false } }) as BehaviorScene
  playReactionStep(scene, { animation: 'action:cheering', durationMs: 2000 })
  assert.deepEqual(calls, ['resetPose()', 'playAnimationOnce("cheering")'])
  calls.length = 0
  playReactionStep(scene, { animation: 'dance:jile', durationMs: 2000, props: { working: true, sip: true } })
  assert.deepEqual(calls, ['resetPose()', 'setWorking(true)', 'requestCoffeeSip()', 'playDanceOnce("jile","dance:jile")'])
  calls.length = 0
  playReactionStep(scene, { animation: 'idle', durationMs: 2000 })
  assert.deepEqual(calls, ['resetPose()'])

  console.log('Custom reactions passed: normalization, slugs, templates, resolution, catalog copy, step playback.')
}
main().catch(error => { console.error(error); process.exit(1) })
