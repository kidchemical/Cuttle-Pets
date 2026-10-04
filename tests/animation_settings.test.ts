import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { normalizeAnimations, animationSpeed, animationOptions, proceduralSpeed } from '../app/src/animation-settings'
import { normalizeCustomDances } from '../app/src/custom-dances'
import { MotionController } from '../app/src/motion-controller'
const THREE = createRequire(new URL('../app/package.json', import.meta.url))('three')

async function main() {
  const imported = normalizeCustomDances([{ name: 'My Dance.vmd', url: '/dance/serve/My Dance.vmd' }])[0]
  assert.equal(imported.id, 'My Dance.vmd')
  assert.equal(imported.label, 'My Dance')
  assert.equal(imported.vmdUrl, 'http://127.0.0.1:8790/dance/serve/My Dance.vmd')
  assert.deepEqual(normalizeAnimations(null), { speed: 1, overrides: {} })
  const settings = normalizeAnimations({ speed: 2, overrides: { 'action:happy': { speed: .5, transition: 9, hold: -5 }, bad: null } })
  assert.equal(animationSpeed(settings, 'action:happy'), 1)
  assert.equal(animationSpeed(settings, 'idle'), 2)
  assert.deepEqual(animationOptions(settings, 'action:happy'), { speed: .5, transition: 3, hold: 0 })
  assert.equal(normalizeAnimations({ speed: Infinity }).speed, 1)

  // Procedural (additive) layers ignore the global multiplier: other sliders
  // must never change their tempo (e.g. typing/global speeding up music nod).
  const proc = normalizeAnimations({ speed: 3, overrides: { typing: { speed: 2 }, music: { speed: 1.5 } } })
  assert.equal(proceduralSpeed(proc, 'typing'), 2)
  assert.equal(proceduralSpeed(proc, 'music'), 1.5)
  assert.equal(proceduralSpeed(proc, 'hands'), 1, 'Unset procedural layers run at 1x regardless of global')
  assert.equal(animationSpeed(proc, 'idle'), 3, 'Base clips still honor the global multiplier')

  // Real Three mixer, fake asset loader: no model files, audio, or network.
  const vrm: any = { scene: new THREE.Group(), humanoid: { getRawBoneNode: () => null, getNormalizedBoneNode: () => null } }
  const motion = new MotionController(vrm)
  const internal = motion as any
  internal.loadClip = async () => new THREE.AnimationClip('test', 2, [])
  motion.setAnimationSettings(normalizeAnimations({ speed: .1 }))
  await motion.playAction('happy')
  for (let i = 0; i < 100; i++) motion.update(.05)
  assert.equal(motion.actionPlaying, true, 'Slow clips must survive their original wall-clock duration')
  motion.setAnimationSettings(normalizeAnimations({ speed: 2, overrides: { 'action:happy': { speed: .5 } } }))
  assert.equal(internal.currentAction.getEffectiveTimeScale(), 1, 'Live updates multiply global and individual speeds')
  for (let i = 0; i < 40; i++) motion.update(.05)
  assert.equal(motion.actionPlaying, false, 'Completion returns to idle')

  let release: (clip: any) => void = () => {}
  internal.loadClip = () => new Promise(resolve => { release = resolve })
  const loading = motion.playDance('ualDance')
  motion.resetToIdle()
  release(new THREE.AnimationClip('dance', 2, []))
  await loading
  assert.equal(motion.isDancing, false, 'Stopping a preview cancels an in-flight dance load')

  // One-shot dance: flagged dancing while the clip plays, idle after.
  internal.loadClip = async () => new THREE.AnimationClip('dance-once', 2, [])
  motion.setAnimationSettings(normalizeAnimations({ speed: 1 }))
  await motion.playDanceOnce('ualDance')
  assert.equal(motion.isDancing, true, 'One-shot dance is dancing while the clip plays')
  for (let i = 0; i < 80; i++) motion.update(.05)
  assert.equal(motion.isDancing, false, 'One-shot dance returns to idle after the clip')
  assert.equal(motion.actionPlaying, false, 'One-shot dance leaves no action lock behind')
  motion.dispose()
  console.log('Animation settings passed: normalization, live speed, slow completion, and preview cancellation.')
}
main().catch(error => { console.error(error); process.exit(1) })
