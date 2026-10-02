import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const THREE = createRequire(new URL('../app/package.json', import.meta.url))('three')
import { buildTypingPoseCache, applyTypingPose, applySipPose, restoreTypingPose } from '../app/src/typing-pose'
import { retargetToVRM } from '../app/src/mixamo-loader'

const nodes = new Map<string, THREE.Object3D>()
for (const name of ['head', 'spine', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm']) nodes.set(name, new THREE.Object3D())
const vrm: any = { humanoid: { getNormalizedBoneNode: (name: string) => nodes.get(name) ?? null } }
const cache = buildTypingPoseCache(vrm)
const head = nodes.get('head')!
for (let frame = 0; frame < 18000; frame++) {
  restoreTypingPose(cache)
  applyTypingPose(cache, frame / 60, 1)
  applySipPose(cache, frame / 60, 0.5)
  assert.ok(head.quaternion.angleTo(new THREE.Quaternion()) < 0.4, 'Head rotation must stay bounded over five minutes')
}
restoreTypingPose(cache)
for (const bone of nodes.values()) assert.ok(bone.quaternion.angleTo(new THREE.Quaternion()) < 1e-6)
head.rotation.y = 0.2
const baseline = head.quaternion.clone()
applyTypingPose(cache, 0, 1)
restoreTypingPose(cache)
assert.ok(head.quaternion.angleTo(baseline) < 1e-6, 'Restore the animated baseline, not a fixed T-pose')

const asset = new THREE.Group()
const hips = new THREE.Bone(); hips.name = 'mixamorigHips'; hips.position.y = 100; asset.add(hips)
const sourceHead = new THREE.Bone(); sourceHead.name = 'mixamorigHead'; hips.add(sourceHead)
asset.updateMatrixWorld(true)
const source = new THREE.QuaternionKeyframeTrack('mixamorigHead.quaternion', [0, 1], [0, 0, 0, 1, 0.1, 0, 0, Math.sqrt(0.99)])
const scale = new THREE.VectorKeyframeTrack('mixamorigHead.scale', [0], [1, 1, 1])
const position = new THREE.VectorKeyframeTrack('mixamorigHead.position', [0], [0, 15, 0])
asset.animations = [new THREE.AnimationClip('mixamo.com', 1, [source, scale, position])]
const dstHips = new THREE.Object3D(); dstHips.position.y = 1
const dstHead = new THREE.Object3D(); dstHead.name = 'normalizedHead'
const target: any = { scene: new THREE.Group(), meta: { metaVersion: '0' }, humanoid: { getNormalizedBoneNode: (name: string) => name === 'hips' ? dstHips : name === 'head' ? dstHead : null } }
const original = Array.from(source.values)
const first = retargetToVRM(asset, target)
const second = retargetToVRM(asset, target)
assert.deepEqual(Array.from(source.values), original, 'Retargeting must not mutate source clips')
assert.deepEqual(Array.from(first.tracks[0].values), Array.from(second.tracks[0].values))
assert.equal(first.tracks.length, 1, 'Do not transfer source skeleton scale or non-hips translations')
console.log('Animation regression checks passed: five-minute pose stability, clean reset, immutable retargeting, safe track filtering.')

// Real Z-up phone pack: root movement must be anchored near the pet, not
// scaled by the source pelvis’s tiny Y coordinate.
const { readFileSync } = createRequire(import.meta.url)('node:fs')
const { FBXLoader } = createRequire(new URL('../app/package.json', import.meta.url))('three/examples/jsm/loaders/FBXLoader.js')
const raw = readFileSync('app/public/ual2.fbx')
const phone = new FBXLoader().parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), '')
const targetNodes = new Map<string, any>()
const fakePhoneVRM: any = {
  scene: new THREE.Group(), meta: { metaVersion: '1' },
  humanoid: { getNormalizedBoneNode: (name: string) => {
    if (!name) return null
    if (!targetNodes.has(name)) {
      const bone = new THREE.Object3D(); bone.name = 'normalized_' + name
      if (name === 'hips') bone.position.y = 1
      targetNodes.set(name, bone)
    }
    return targetNodes.get(name)
  } },
}
const phoneClip = retargetToVRM(phone, fakePhoneVRM, 'Armature|Idle_TalkingPhone_Loop')
assert.ok(phoneClip.tracks.length > 40)
const root = phoneClip.tracks.find(t => t.name === 'normalized_hips.position')!
assert.deepEqual(Array.from(root.values.slice(0, 3)), [0, 1, 0])
for (let i = 0; i < root.values.length; i += 3) {
  assert.ok(Math.hypot(root.values[i], root.values[i + 1] - 1, root.values[i + 2]) < 0.5)
}
console.log('Real phone clip passed: converted Z-up rig and anchored root displacement stays within 0.5m.')

const leftElbow = nodes.get('leftLowerArm')!
const rightElbow = nodes.get('rightLowerArm')!
leftElbow.position.x = 0.3; rightElbow.position.x = -0.3
nodes.get('leftUpperArm')!.add(leftElbow)
nodes.get('rightUpperArm')!.add(rightElbow)
applyTypingPose(cache, 0, 1)
for (const arm of [nodes.get('leftUpperArm')!, nodes.get('rightUpperArm')!]) arm.updateMatrixWorld(true)
const leftHand = new THREE.Object3D(); leftHand.position.x = 0.25; leftElbow.add(leftHand)
const rightHand = new THREE.Object3D(); rightHand.position.x = -0.25; rightElbow.add(rightHand)
for (const elbow of [leftElbow, rightElbow]) assert.ok(elbow.getWorldPosition(new THREE.Vector3()).y < -0.2, 'Upper arms hang down')
for (const hand of [leftHand, rightHand]) assert.ok(hand.getWorldPosition(new THREE.Vector3()).z > 0.2, 'Forearms reach forward')
restoreTypingPose(cache)
console.log('Working pose direction passed: upper arms hang down and forearms reach toward the laptop (+Z).')
