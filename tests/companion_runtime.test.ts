import assert from 'node:assert/strict'
import { AnimationClip, Bone, BoxGeometry, Group, Mesh, MeshStandardMaterial, Quaternion, QuaternionKeyframeTrack, Scene, Vector3 } from '../app/node_modules/three/build/three.module.js'
import { CompanionLayer } from '../app/src/companion-runtime'
import { createPetConfig, normalizePet } from '../app/src/companions'

async function makeLayer(clips: AnimationClip[] = []) {
  const scene = new Scene()
  const model = new Group()
  const sourceMaterial = new MeshStandardMaterial({ color: 0x5599dd })
  model.add(new Mesh(new BoxGeometry(1, 2, 1), sourceMaterial))
  const arm = new Bone(); arm.name = 'UpperArm_L'
  const hand = new Bone(); hand.position.x = 1; arm.add(hand); model.add(arm)
  const foot = new Bone(); foot.name = 'Foot_R'; model.add(foot)
  const cfg = createPetConfig('test', 'Test', 'test.glb', { bones: ['UpperArm_L', 'Foot_R'], clips: clips.map(c => c.name), parts: [], materials: [] })
  cfg.occasional.enabled = false
  const rigRoot = new Group()
  scene.add(rigRoot)
  const layer = new CompanionLayer(scene, async () => ({ scene: model, animations: clips }) as any, () => '')
  layer.setCharacter({ root: rigRoot, height: 2, floorY: 0, topY: 2, bone: () => null })
  layer.configure([cfg], [])
  await Promise.resolve()
  layer.update(1)
  const holder = layer.root.children[0]
  const pivot = holder.children[0]
  return { scene, layer, cfg, arm, hand, foot, holder, pivot, sourceMaterial, rigRoot, model }
}

async function main() {
  const pet = await makeLayer()
  const material = (pet.model.children[0] as Mesh).material as MeshStandardMaterial
  assert.notEqual(material, pet.sourceMaterial)
  assert.ok(material.emissiveIntensity > 0)
  assert.equal(pet.sourceMaterial.emissive.getHex(), 0, 'Lighting does not modify shared source material')
  pet.model.updateMatrixWorld(true)
  const direction = pet.hand.getWorldPosition(new Vector3()).sub(pet.arm.getWorldPosition(new Vector3())).normalize()
  assert.ok(direction.y < -0.5, 'Horizontal bind arms relax downward')
  const armBefore = pet.arm.quaternion.clone(), footBefore = pet.foot.quaternion.clone()
  const posBefore = pet.pivot.position.clone(), rotBefore = pet.pivot.quaternion.clone()
  pet.layer.update(0.3)
  assert.ok(pet.arm.quaternion.angleTo(armBefore) > 0.01, 'Arms move')
  assert.ok(pet.foot.quaternion.angleTo(footBefore) > 0.01, 'Feet move')
  assert.ok(Math.abs(pet.pivot.position.x - posBefore.x) > 0.001, 'Floating drifts horizontally')
  assert.ok(Math.abs(pet.pivot.position.z - posBefore.z) > 0.001, 'Floating drifts in depth')
  assert.ok(pet.pivot.quaternion.angleTo(rotBefore) > 0.01, 'Floating tilts and turns')

  // Follow damping is time based, including when render frame rates differ.
  const other = await makeLayer()
  pet.rigRoot.position.x = 1; other.rigRoot.position.x = 1
  pet.layer.update(0.2)
  for (let i = 0; i < 12; i++) other.layer.update(0.2 / 12)
  assert.ok(Math.abs(pet.holder.position.x - other.holder.position.x) < 1e-10)
  assert.ok(pet.holder.position.x < 0.7, 'Companion trails rather than snapping to its new anchor')

  pet.cfg.limbMotion = 0; pet.cfg.lighting = 0; pet.cfg.idle.style = 'still'
  pet.layer.configure([pet.cfg], [])
  pet.layer.update(0.1)
  assert.ok(pet.arm.quaternion.angleTo(new Quaternion()) < 1e-8, 'Turning limb motion off restores the bind pose')
  assert.ok(pet.foot.quaternion.angleTo(new Quaternion()) < 1e-8)
  assert.ok(pet.pivot.position.length() === 0, 'Still idle stays still')
  assert.equal(material.emissiveIntensity, 0, 'Lighting fill can be turned off')

  const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.5)
  const clip = new AnimationClip('Idle', 1, [new QuaternionKeyframeTrack('UpperArm_L.quaternion', [0, 1], [...q.toArray(), ...q.toArray()])])
  const animated = await makeLayer([clip])
  animated.layer.update(0.1)
  assert.ok(animated.arm.quaternion.toArray().every((v, i) => Math.abs(v - q.toArray()[i]) < 1e-7), 'Authored clips take precedence over procedural limbs')
  animated.layer.apply({ kind: 'pet', id: 'test', action: 'hide' })
  animated.layer.update(1)
  assert.equal(animated.holder.visible, false)
  for (const fixture of [pet, other, animated]) fixture.layer.dispose()
  assert.equal(pet.scene.children.some(c => c.name === 'companions'), false)

  const normalized = normalizePet({ file: 'old.glb', followLag: Infinity, lighting: 99, limbMotion: -3 }, 'old')!
  assert.equal(normalized.followLag, 0.6, 'Old/invalid settings gain the loose follow default')
  assert.equal(normalized.lighting, 1)
  assert.equal(normalized.limbMotion, 0)
  console.log('Companion runtime passed: lighting isolation, relaxed moving limbs, 3D drift, frame-independent trailing, clip precedence, visibility, disposal.')
}
main().catch(error => { console.error(error); process.exit(1) })
