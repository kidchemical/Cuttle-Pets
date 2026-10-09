import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { AnimationGrounding } from '../app/src/animation-grounding'
import { MotionController } from '../app/src/motion-controller'
import { normalizeAnimations } from '../app/src/animation-settings'
const THREE = createRequire(new URL('../app/package.json', import.meta.url))('three')

async function main() {
  for (const scale of [1, 2]) {
    const scene = new THREE.Group(); scene.scale.setScalar(scale); scene.rotation.y = Math.PI
    const hips = new THREE.Bone(); hips.name = 'hips'; hips.position.y = 1; scene.add(hips)
    const foot = new THREE.Bone(); foot.name = 'foot'; foot.position.y = -1; hips.add(foot)
    const vrm: any = { scene, humanoid: { getNormalizedBoneNode: (name: string) => name === 'hips' ? hips : name === 'leftFoot' ? foot : null, getRawBoneNode: () => null } }
    const grounding = new AnimationGrounding(vrm)
    foot.position.y = -.5 // A seated pose keeps the hips high and raises the feet.
    grounding.apply(1); scene.updateMatrixWorld(true)
    assert.ok(Math.abs(foot.getWorldPosition(new THREE.Vector3()).y) < 1e-6)
    assert.equal(hips.position.y, .5, 'Grounding lowers the body')
    grounding.restore(); assert.equal(hips.position.y, 1)
    grounding.apply(.5); assert.equal(hips.position.y, .75, 'Fade weight eases the floor correction')
    grounding.restore()
    grounding.apply(0); assert.equal(hips.position.y, 1, 'Disabled grounding preserves airborne motion')

    // Exercise real mixer transitions and live toggle, including a clip with
    // no hips position track (correction must not accumulate across frames).
    foot.position.y = -1
    const motion = new MotionController(vrm)
    foot.position.y = -.5
    ;(motion as any).loadClip = async () => new THREE.AnimationClip('seated', 100, [])
    motion.setAnimationSettings(normalizeAnimations({ overrides: { 'action:sittingIdle': { transition: 0 } } }))
    await motion.playAction('sittingIdle')
    for (let i = 0; i < 300; i++) motion.update(.01)
    assert.equal(hips.position.y, .5)
    motion.setAnimationSettings(normalizeAnimations({ overrides: { 'action:sittingIdle': { groundFeet: false } } }))
    motion.update(.01); assert.equal(hips.position.y, 1)
    motion.setAnimationSettings(normalizeAnimations({}))
    motion.update(.01); assert.equal(hips.position.y, .5)
    motion.dispose(); assert.equal(hips.position.y, 1, 'Teardown removes the correction')
  }
  console.log('Animation grounding passed: sitting, scales, fades, live toggles, no drift and teardown.')
}
main().catch(e => { console.error(e); process.exit(1) })
