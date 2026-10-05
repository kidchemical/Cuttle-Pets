import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from '../app/node_modules/three/build/three.module.js'
import { GLTFLoader } from '../app/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '../app/node_modules/@pixiv/three-vrm/lib/three-vrm.module.js'
import { anchorVMDMotion, parseVMDAnimation, bindVMDToVRM, type VMDAnimationData } from '../app/src/vmd-loader'
import { VRMIKHandler } from '../app/src/vrm-ik-handler'

// A root reversal between sparse foot keys must also be removed between keys.
const source: VMDAnimationData = { duration: 2, timelines: [
  { name: 'hips', type: 'position', times: [0, 1, 2], values: [2, 1, 3, 4, 1.2, -1, 2, .9, 3] },
  { name: 'leftFoot', type: 'position', isIK: true, times: [0, 2], values: [2.1, .1, 3.2, 2.3, .2, 3.4] },
] }
const original = structuredClone(source)
const anchored = anchorVMDMotion(source, [.01, 1, -.02])
assert.deepEqual(source, original, 'Cached source data must remain unchanged')
const hips = anchored.timelines[0]
assert.deepEqual(hips.values, [.01, 1, -.02, .01, 1.2, -.02, .01, .9, -.02])
const foot = anchored.timelines[1]
assert.deepEqual(foot.times, [0, 1, 2], 'IK must include root keys as well as its own')
const before = new THREE.LinearInterpolant(original.timelines[1].times, original.timelines[1].values, 3)
const root = new THREE.LinearInterpolant(original.timelines[0].times, original.timelines[0].values, 3)
const after = new THREE.LinearInterpolant(foot.times, foot.values, 3)
for (let t = 0; t <= 2; t += .05) {
  const a = before.evaluate(t), b = root.evaluate(t), c = after.evaluate(t)
  assert.ok(Math.abs((a[0] - b[0]) - (c[0] - .01)) < 1e-6, 'Keep feet aligned horizontally')
  assert.ok(Math.abs((a[2] - b[2]) - (c[2] + .02)) < 1e-6)
  assert.ok(Math.abs(a[1] - c[1]) < 1e-6, 'Keep vertical footwork')
}

// Load the actual bundled model, stripping materials for headless GLTF parsing.
;(globalThis as any).ProgressEvent = class { constructor(public type: string) {} }
const raw = readFileSync('app/public/model1.vrm')
const jsonLength = raw.readUInt32LE(12)
const json = JSON.parse(raw.subarray(20, 20 + jsonLength).toString())
delete json.images; delete json.textures; delete json.materials
for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives) delete primitive.material
const text = JSON.stringify(json)
const chunk = Buffer.from(text + ' '.repeat((4 - Buffer.byteLength(text) % 4) % 4))
const binary = raw.subarray(20 + jsonLength)
const glb = Buffer.alloc(20 + chunk.length + binary.length)
raw.copy(glb, 0, 0, 12); glb.writeUInt32LE(glb.length, 8)
glb.writeUInt32LE(chunk.length, 12); glb.writeUInt32LE(0x4e4f534a, 16)
chunk.copy(glb, 20); binary.copy(glb, 20 + chunk.length)
const loader = new GLTFLoader()
loader.register(p => new VRMLoaderPlugin(p))
const { userData } = await loader.parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '')
const vrm = userData.vrm
VRMUtils.rotateVRM0(vrm)
const hip = vrm.humanoid.getNormalizedBoneNode('hips')
const rest = hip.position.clone()
const savedFetch = globalThis.fetch
globalThis.fetch = async url => new Response(readFileSync('app/public/' + String(url).replace(/^\//, '')))
try {
  for (const name of ['love', 'jile']) {
    // Loading during another animation must use rest offsets and leave its pose alone.
    const baseline = await parseVMDAnimation('/' + name + '.vmd', vrm)
    hip.position.add(new THREE.Vector3(3, -5, 2))
    const previousPose = hip.position.clone()
    const data = await parseVMDAnimation('/' + name + '.vmd', vrm)
    assert.deepEqual(hip.position, previousPose, 'Loading must restore the current pose')
    assert.deepEqual(data, baseline, 'Dance offsets must not depend on the preceding pose')
    hip.position.copy(rest)
    const ik = VRMIKHandler.get(vrm)
    const clip = bindVMDToVRM(data, vrm, ik)
    const mixer = new THREE.AnimationMixer(vrm.scene)
    const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true; action.play()
    let minY = Infinity, maxY = -Infinity
    for (let frame = 0; frame < Math.ceil(data.duration * 30); frame++) {
      mixer.update(1 / 30); ik.update(); vrm.humanoid.update(); vrm.scene.updateMatrixWorld(true)
      assert.ok(Math.abs(hip.position.x - rest.x) < 1e-6 && Math.abs(hip.position.z - rest.z) < 1e-6, name + ': hips stay in place')
      const head = vrm.humanoid.getRawBoneNode('head').getWorldPosition(new THREE.Vector3())
      assert.ok(head.toArray().every(Number.isFinite), name + ': finite rendered pose')
      assert.ok(Math.hypot(head.x, head.z) < .65, name + ': head stays near the viewport centre')
      minY = Math.min(minY, hip.position.y); maxY = Math.max(maxY, hip.position.y)
    }
    assert.ok(maxY - minY > .15, name + ': preserve dance dips and jumps')
    mixer.stopAllAction(); ik.disableAll(); vrm.humanoid.resetNormalizedPose(); vrm.humanoid.update()
    console.log(name + ': complete bundled dance stays anchored, keeps footwork, and loads independently of the preceding pose')
  }
} finally { globalThis.fetch = savedFetch }
