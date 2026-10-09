import assert from 'node:assert/strict'
import { AnimationClip, Bone, BoxGeometry, DataTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, QuaternionKeyframeTrack, Scene, Texture, Vector3 } from '../app/node_modules/three/build/three.module.js'
import { CompanionLayer } from '../app/src/companion-runtime'
import { createPetConfig, normalizePet } from '../app/src/companions'
import { DEFAULT_GLOBAL_LIGHTING } from '../app/src/lighting'

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
  const darkStage = { ...DEFAULT_GLOBAL_LIGHTING, ambientIntensity: 0, keyIntensity: 0, fillIntensity: 0 }
  pet.layer.setStageLighting(darkStage)
  assert.equal(material.emissive.getHex(), 0, 'Stage off removes artificial self illumination')
  pet.layer.configure([pet.cfg], [])
  assert.equal(material.emissive.getHex(), 0, 'Settings sync does not restore fill on a dark stage')
  pet.layer.setStageLighting({ ...DEFAULT_GLOBAL_LIGHTING, ambientColor: '#ff0000', keyColor: '#ff0000', fillColor: '#ff0000' })
  assert.ok(material.emissive.r > 0)
  assert.equal(material.emissive.g, 0, 'Fill follows stage color')
  assert.equal(material.emissive.b, 0)
  pet.layer.setStageLighting(DEFAULT_GLOBAL_LIGHTING)
  assert.ok(material.emissive.toArray().every((v, i) => Math.abs(v - material.color.toArray()[i]) < 1e-12), 'Default stage preserves the existing shadow lift')
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

  // Unlit (basic) pet materials ignore every scene light, so attach upgrades
  // them to matte PBR with tint and transparency preserved; the cached
  // source stays untouched and the albedo fill applies like any lit pet.
  const basicScene = new Scene()
  const basicRigRoot = new Group()
  basicScene.add(basicRigRoot)
  const basicSource = new MeshBasicMaterial({ color: 0xdd8844, transparent: true, opacity: 0.7 })
  basicSource.name = 'chao-body'
  const basicModel = new Group()
  basicModel.add(new Mesh(new BoxGeometry(1, 1, 1), basicSource))
  const basicLayer = new CompanionLayer(basicScene, async () => ({ scene: basicModel, animations: [] }) as any, () => '')
  basicLayer.setCharacter({ root: basicRigRoot, height: 2, floorY: 0, topY: 2, bone: () => null })
  const basicCfg = createPetConfig('basic', 'Basic', 'basic.glb', { bones: [], clips: [], parts: [], materials: [] })
  basicCfg.occasional.enabled = false
  basicLayer.configure([basicCfg], [])
  await new Promise(resolve => setTimeout(resolve, 0))
  const converted = (basicModel.children[0] as Mesh).material as MeshStandardMaterial
  assert.notEqual(converted, basicSource)
  assert.ok(converted.isMeshStandardMaterial, 'Basic pet material upgrades to lit PBR')
  assert.equal(converted.name, 'chao-body')
  assert.equal(converted.color.getHex(), 0xdd8844)
  assert.equal(converted.transparent, true)
  assert.equal(converted.opacity, 0.7)
  assert.equal(converted.roughness, 1)
  assert.ok(basicSource.isMeshBasicMaterial, 'Shared source material is not converted')
  assert.equal(basicSource.color.getHex(), 0xdd8844)
  assert.equal(converted.emissiveIntensity, basicCfg.lighting, 'Upgraded pet joins the albedo fill')
  basicLayer.dispose()

  // Stage settings may arrive before asynchronous GLB loading finishes.
  // Imported emission remains authored; only our artificial fill follows lights.
  const delayedModel = new Group()
  const emissiveSource = new MeshStandardMaterial({ emissive: 0x113355, emissiveIntensity: 0.8 })
  const emissiveTexture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  emissiveSource.emissiveMap = emissiveTexture
  delayedModel.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()))
  delayedModel.add(new Mesh(new BoxGeometry(), emissiveSource))
  let finishLoad!: (gltf: any) => void
  const delayedLayer = new CompanionLayer(new Scene(), () => new Promise(resolve => { finishLoad = resolve }), () => '')
  delayedLayer.setStageLighting(darkStage)
  delayedLayer.configure([basicCfg], [])
  finishLoad({ scene: delayedModel, animations: [] })
  await Promise.resolve()
  const delayedFill = (delayedModel.children[0] as Mesh).material as MeshStandardMaterial
  const authoredEmission = (delayedModel.children[1] as Mesh).material as MeshStandardMaterial
  assert.equal(delayedFill.emissive.getHex(), 0, 'Late loaded pet starts with the current stage illumination')
  assert.ok(authoredEmission.emissive.equals(emissiveSource.emissive), 'Authored emission color is preserved')
  assert.equal(authoredEmission.emissiveIntensity, 0.8)
  assert.equal(authoredEmission.emissiveMap, emissiveTexture)
  delayedLayer.setStageLighting(DEFAULT_GLOBAL_LIGHTING)
  assert.ok(delayedFill.emissive.toArray().every((v, i) => Math.abs(v - delayedFill.color.toArray()[i]) < 1e-12))
  assert.ok(authoredEmission.emissive.equals(emissiveSource.emissive))
  delayedLayer.dispose()

  // Fully metallic PBR with no env map renders near-black (diffuse ~0), so
  // stage and cursor lights can't reach it either — metalness drops unless a
  // metalness map authors the metal look. The cached source stays metallic.
  const metalScene = new Scene()
  const metalRigRoot = new Group()
  metalScene.add(metalRigRoot)
  const metalSource = new MeshStandardMaterial({ color: 0x88aacc, metalness: 1, roughness: 0.85 })
  const metalMap = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  metalMap.needsUpdate = true
  const mappedSource = new MeshStandardMaterial({ color: 0x88aacc, metalness: 1, metalnessMap: metalMap })
  const metalModel = new Group()
  metalModel.add(new Mesh(new BoxGeometry(1, 1, 1), metalSource))
  metalModel.add(new Mesh(new BoxGeometry(1, 1, 1), mappedSource))
  const metalLayer = new CompanionLayer(metalScene, async () => ({ scene: metalModel, animations: [] }) as any, () => '')
  metalLayer.setCharacter({ root: metalRigRoot, height: 2, floorY: 0, topY: 2, bone: () => null })
  const metalCfg = createPetConfig('metal', 'Metal', 'metal.glb', { bones: [], clips: [], parts: [], materials: [] })
  metalCfg.occasional.enabled = false
  metalLayer.configure([metalCfg], [])
  await new Promise(resolve => setTimeout(resolve, 0))
  const [plain, mapped] = (metalModel.children as Mesh[]).map(m => m.material as MeshStandardMaterial)
  assert.equal(plain.metalness, 0, 'Unmapped full metal becomes dielectric')
  assert.equal(plain.roughness, 0.85, 'Authored roughness survives')
  assert.equal(mapped.metalness, 1, 'Authored metalness map keeps its metal')
  assert.equal(metalSource.metalness, 1, 'Shared source stays metallic')
  // Pets attached before the fix keep stale materials across hot reloads;
  // the next configure heals them without a model reload.
  plain.metalness = 1
  metalLayer.configure([metalCfg], [])
  assert.equal(plain.metalness, 0, 'Reconfigure heals stale full metal')
  // Shiny finish: shared reflection map built once, scaled by the stage.
  let envBuilds = 0, envDisposed = false
  metalLayer.setEnvironment(() => { envBuilds++; const t = new Texture(); t.dispose = () => { envDisposed = true }; return t })
  const shinyCfg = { ...metalCfg, shiny: { enabled: true, metalness: 0.8, smoothness: 0.7, reflection: 1.5 } }
  metalLayer.configure([shinyCfg], [])
  assert.equal(plain.metalness, 0.8, 'Shiny sets metalness')
  assert.ok(Math.abs(plain.roughness - 0.3) < 1e-9, 'Smoothness maps to roughness')
  assert.ok(plain.envMap && plain.envMap === mapped.envMap, 'Reflection map is shared')
  assert.equal(plain.envMapIntensity, 1.5, 'Default stage reflects at full strength')
  metalLayer.setStageLighting({ ...DEFAULT_GLOBAL_LIGHTING, ambientIntensity: 0, keyIntensity: 0, fillIntensity: 0 })
  assert.equal(plain.envMapIntensity, 0, 'Stage lights off removes reflections')
  metalLayer.configure([metalCfg], [])
  assert.equal(plain.metalness, 0, 'Shiny off restores the matte finish')
  assert.equal(plain.roughness, 0.85)
  assert.equal(plain.envMap, null)
  assert.equal(envBuilds, 1)
  metalLayer.dispose()
  assert.ok(envDisposed, 'Layer disposes the shared reflection map')

  const normalized = normalizePet({ file: 'old.glb', followLag: Infinity, lighting: 99, limbMotion: -3 }, 'old')!
  assert.equal(normalized.followLag, 0.6, 'Old/invalid settings gain the loose follow default')
  assert.equal(normalized.lighting, 1)
  assert.equal(normalized.limbMotion, 0)
  assert.deepEqual(normalized.shiny, { enabled: false, metalness: 0.8, smoothness: 0.7, reflection: 1 }, 'Old pets stay matte')
  console.log('Companion runtime passed: lighting isolation, relaxed moving limbs, 3D drift, frame-independent trailing, clip precedence, visibility, disposal.')
}
main().catch(error => { console.error(error); process.exit(1) })
