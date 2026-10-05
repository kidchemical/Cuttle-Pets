import assert from 'node:assert/strict'
import {
  createPetConfig, createPropConfig, describeCompanionAction, normalizeCompanionAction,
  normalizeCompanionActions, normalizePet, normalizePetSettings, normalizeProp, normalizePropSettings,
  resolveExpressionParts, suggestPetSetup, uniqueCompanionId,
  type CompanionAction,
} from '../app/src/companions'

/** Chao-shaped asset: swap meshes share a prefix, wings/tail bones, no clips. */
const CHAO_ASSET = {
  parts: ['Chao_Eye', 'Chao_EyeClose1', 'Chao_EyePtn1', 'Chao_Ball', 'Chao_BallHeart', 'Chao_BallExclamation'],
  clips: [] as string[],
  bones: ['Hips', 'Spine', 'Head', 'Wing_L', 'Wing_R', 'Tail1'],
  materials: ['body', 'eye'],
}

async function main() {
  // Import-time suggestions group the swap meshes.
  const suggested = suggestPetSetup(CHAO_ASSET)
  assert.deepEqual(suggested.groups.map(g => g.id).sort(), ['ball', 'eye'])
  const eye = suggested.groups.find(g => g.id === 'eye')!
  assert.equal(eye.default, 'Chao_Eye')
  assert.deepEqual(suggested.blink, { group: 'eye', frames: ['Chao_EyeClose1'] })
  assert.ok(suggested.expressions.some(e => e.id === 'neutral'))
  assert.ok(suggested.expressions.some(e => JSON.stringify(e.set).includes('Chao_BallHeart')))
  assert.equal(suggested.mood.love, suggested.expressions.find(e => e.id.includes('heart'))!.id)
  assert.equal(suggested.mood.surprised, suggested.expressions.find(e => e.id.includes('exclamation'))!.id)
  assert.deepEqual(suggested.wings.sort(), ['Wing_L', 'Wing_R'])
  assert.deepEqual(suggested.tail, ['Tail1'])
  assert.deepEqual(suggested.click.move, 'hop')

  // A fresh pet starts floating by the shoulder with ambient antics on.
  const pet = createPetConfig('chao', 'Chao', 'chao.glb', CHAO_ASSET)
  assert.equal(pet.anchor, 'shoulder')
  assert.equal(pet.idle.style, 'float')
  assert.equal(pet.occasional.enabled, true)
  assert.deepEqual(pet.colors, {})

  // Validation: path escapes dropped, ranges clamped, colors/materials filtered.
  const settings = normalizePetSettings({
    pets: [
      { id: 'chao', name: 'Chao', file: 'chao.glb', asset: CHAO_ASSET, anchor: 'orbit', size: 99, turn: 500, clip: 'nope', colors: { body: '#ff0000', eye: 'red', ghost: '#00ff00' } },
      { id: 'evil', file: '../evil.glb', asset: CHAO_ASSET },
      { id: 'chao', file: 'dup.glb', asset: CHAO_ASSET },
    ],
  })
  assert.equal(settings.pets.length, 2, 'Path escape dropped, duplicate id uniquified')
  assert.equal(settings.pets[0].size, 1.5)
  assert.equal(settings.pets[0].turn, 180)
  assert.equal(settings.pets[0].clip, '')
  assert.deepEqual(settings.pets[0].colors, { body: '#ff0000' })
  assert.equal(settings.pets[1].id, 'chao-2')

  const props = normalizePropSettings({ props: [{ id: 'hat', file: 'hat.glb', anchor: 'nope', visible: 1 }] })
  assert.equal(props.props[0].anchor, 'head')
  assert.equal(props.props[0].visible, false, 'Props start hidden unless worn')
  assert.equal(normalizeProp({ id: 'x', file: 'x.glb', visible: true }, 'x')!.visible, true)
  assert.equal(normalizePet(undefined, 'x'), null)

  // Action shapes: verbs checked per kind, values required only where needed.
  const show: CompanionAction = { kind: 'pet', id: 'chao', action: 'show' }
  assert.deepEqual(normalizeCompanionAction(show), show)
  assert.deepEqual(normalizeCompanionAction({ kind: 'prop', id: 'hat', action: 'hide' }), { kind: 'prop', id: 'hat', action: 'hide' })
  assert.equal(normalizeCompanionAction({ kind: 'pet', id: 'chao', action: 'expression' }), null, 'Expression needs a value')
  assert.deepEqual(normalizeCompanionAction({ kind: 'pet', id: 'chao', action: 'play', value: 'clip:Idle', loop: true }),
    { kind: 'pet', id: 'chao', action: 'play', value: 'clip:Idle', loop: true })
  assert.equal(normalizeCompanionAction({ kind: 'pet', id: 'chao', action: 'move', value: 'moon' }), null)
  assert.deepEqual(normalizeCompanionAction({ kind: 'pet', id: 'chao', action: 'move', value: 'home' }),
    { kind: 'pet', id: 'chao', action: 'move', value: 'home' })
  assert.deepEqual(normalizeCompanionAction({ kind: 'pet', id: 'chao', action: 'expression', value: 'neutral', durationMs: 999999999 }),
    { kind: 'pet', id: 'chao', action: 'expression', value: 'neutral', durationMs: 600000 })
  assert.equal(normalizeCompanionAction({ kind: 'pet', id: 'chao', action: 'wear' }), null)
  assert.equal(normalizeCompanionAction({ kind: 'prop', id: 'hat', action: 'play', value: 'hop' }), null, 'Props cannot play')
  assert.equal(normalizeCompanionActions([show, null, { kind: 'x' }, show, show, show, show, show, show]).length, 6, 'Capped at 6')

  // Summaries name the target.
  assert.equal(describeCompanionAction(show, { 'pet:chao': 'Chao' }), 'Chao: show')
  assert.equal(describeCompanionAction({ kind: 'pet', id: 'chao', action: 'play', value: 'hop', loop: true }, { 'pet:chao': 'Chao' }), 'Chao: play hop (loop)')

  // Expression resolution: defaults, then the chosen expression, then blink.
  const resolved = resolveExpressionParts(pet, pet.expressions.find(e => e.id.includes('heart'))!.id)
  assert.equal(resolved.eye, 'Chao_Eye')
  assert.ok(String(resolved.ball).includes('Heart'))
  assert.deepEqual(resolveExpressionParts(pet, null).ball, 'Chao_Ball')

  // Prop factory + id helpers.
  const prop = createPropConfig('hat', 'Hat', 'hat.glb', { parts: [], clips: [], bones: [], materials: [] })
  assert.equal(prop.anchor, 'head')
  assert.equal(prop.visible, true)
  assert.equal(uniqueCompanionId('Chao Chao!', ['chao']), 'chao-chao')
  assert.equal(uniqueCompanionId('Chao', ['chao', 'chao-chao']), 'chao-2')

  console.log('Companions passed: import suggestions, pet/prop validation, action shapes, summaries, expression resolution.')
}
main().catch(error => { console.error(error); process.exit(1) })
