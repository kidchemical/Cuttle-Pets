import { readFileSync, existsSync } from 'node:fs'
import { GLTFLoader } from '../app/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
import assert from 'node:assert/strict'
import * as THREE from '../app/node_modules/three/build/three.module.js'
import { buildTypingPoseCache, applyTypingPose, applySipPose, restoreTypingPose, applyMusicPose } from '../app/src/typing-pose'
import { prepareLaptop, cupPositions } from '../app/src/work-props'
import { VRMLoaderPlugin, VRMUtils } from '../app/node_modules/@pixiv/three-vrm/lib/three-vrm.module.js'
;(globalThis as any).ProgressEvent = class { constructor(public type: string) {} }
for (const file of ['models/CosmicPerson.vrm', 'app/public/model1.vrm']) {
 if(!existsSync(file)) continue
 const raw=readFileSync(file); const n=raw.readUInt32LE(12); const json=JSON.parse(raw.subarray(20,20+n).toString());
 delete json.images; delete json.textures; delete json.materials;
 for(const mesh of json.meshes??[]) for(const prim of mesh.primitives) delete prim.material;
 const j=Buffer.from(JSON.stringify(json)+' '.repeat((4-JSON.stringify(json).length%4)%4)); const bin=raw.subarray(20+n); const b=Buffer.alloc(20+j.length+bin.length);raw.copy(b,0,0,12); b.writeUInt32LE(b.length,8);b.writeUInt32LE(j.length,12);b.writeUInt32LE(0x4e4f534a,16);j.copy(b,20);bin.copy(b,20+j.length);
 const loader=new GLTFLoader();loader.register(p=>new VRMLoaderPlugin(p));const gltf=await loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');const vrm=gltf.userData.vrm;
 VRMUtils.rotateVRM0(vrm)
 const cache=buildTypingPoseCache(vrm)
 applyTypingPose(cache,0,1);vrm.scene.updateMatrixWorld(true)
 for(const side of ['left','right']) {
  const upper=vrm.humanoid.getNormalizedBoneNode(side+'UpperArm').getWorldPosition(new THREE.Vector3())
  const elbow=vrm.humanoid.getNormalizedBoneNode(side+'LowerArm').getWorldPosition(new THREE.Vector3())
  const hand=vrm.humanoid.getNormalizedBoneNode(side+'Hand').getWorldPosition(new THREE.Vector3())
  assert.ok(elbow.y<upper.y-.1,`${file}: ${side} elbow must be below shoulder`)
  assert.ok(hand.z>elbow.z+.1,`${file}: ${side} forearm must point forward`)
 }
 for (const hand of [cache.handL!, cache.handR!]) {
  const palm=cache.palmNormals.get(hand)!.clone().applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()))
  assert.ok(palm.dot(new THREE.Vector3(0,-1,0))>.95,`${file}: palms face the keyboard`)
 }
 const gaze=cache.headForward.clone().applyQuaternion(cache.head!.getWorldQuaternion(new THREE.Quaternion()))
 assert.ok(gaze.y<-.15 && gaze.z>.9,`${file}: head looks slightly down, not up`)
 const asset = new THREE.Group()
 const keyboard = new THREE.Mesh(new THREE.PlaneGeometry(.3,.15).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial())
 keyboard.position.set(-.15,.013,.075);asset.add(keyboard)
 const screen = new THREE.Mesh(new THREE.BoxGeometry(.3,.15,.01),new THREE.MeshBasicMaterial())
 screen.position.set(-.15,.09,.16);asset.add(screen)
 const laptop=prepareLaptop(asset,.4)
 const target=cache.keyboardL!.getWorldPosition(new THREE.Vector3()).add(cache.keyboardR!.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5)
 laptop.position.copy(target);laptop.updateMatrixWorld(true)
 assert.ok(keyboard.getWorldPosition(new THREE.Vector3()).distanceTo(target)<.001,`${file}: keyboard aligns to the real hands`)
 const cupHeight=.1
 const handPosition=cache.handR!.getWorldPosition(new THREE.Vector3())
 const restingCup=cupPositions(target,handPosition,.4,cupHeight,laptop.userData.keyboardToBase,0)
 const heldCup=cupPositions(target,handPosition,.4,cupHeight,laptop.userData.keyboardToBase,1)
 assert.ok(Math.abs(restingCup.x-target.x)>.2,`${file}: mug rests beside the laptop, outside the palms`)
 assert.ok(heldCup.distanceTo(handPosition)<cupHeight,`${file}: mug reaches the grip during a sip`)
 const mouth=cache.head!.getWorldPosition(new THREE.Vector3());mouth.z+=.06
 const distanceBefore=cache.handR!.getWorldPosition(new THREE.Vector3()).distanceTo(mouth)
 applySipPose(cache,0,1);vrm.scene.updateMatrixWorld(true)
 const distanceAfter=cache.handR!.getWorldPosition(new THREE.Vector3()).distanceTo(mouth)
 assert.ok(distanceAfter<distanceBefore*.6,`${file}: coffee sip must bring hand closer to mouth`)
 for(let frame=0;frame<1800;frame++) {
  restoreTypingPose(cache);applyTypingPose(cache,frame/60,1);applyMusicPose(cache,frame/30,.65)
  assert.ok(cache.head!.quaternion.angleTo(new THREE.Quaternion())<.7, 'Working nod remains bounded')
 }
 restoreTypingPose(cache)
 console.log(file+': upper arms down, forearms forward, sip toward mouth, palms down, downward gaze, keyboard at hands, visible mug position, stable working music overlay')
}
