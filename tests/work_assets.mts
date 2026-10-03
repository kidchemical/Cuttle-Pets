import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from '../app/node_modules/three/build/three.module.js'
import { GLTFLoader } from '../app/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
import { prepareLaptop, cupPositions } from '../app/src/work-props'
;(globalThis as any).ProgressEvent = class { constructor(public type: string) {} }
const raw=readFileSync('app/public/laptop.glb');const n=raw.readUInt32LE(12)
const json=JSON.parse(raw.subarray(20,20+n).toString());delete json.images;delete json.textures;delete json.materials
for(const mesh of json.meshes??[])for(const primitive of mesh.primitives)delete primitive.material
const encoded=Buffer.from(JSON.stringify(json));const j=Buffer.concat([encoded,Buffer.from(' '.repeat((4-encoded.length%4)%4))])
const bin=raw.subarray(20+n);const b=Buffer.alloc(20+j.length+bin.length)
raw.copy(b,0,0,12);b.writeUInt32LE(b.length,8);b.writeUInt32LE(j.length,12);b.writeUInt32LE(0x4e4f534a,16);j.copy(b,20);bin.copy(b,20+j.length)
const asset=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene
const keyboard=asset.getObjectByName('laptop_3')!
assert.ok(keyboard,'Real asset keyboard mesh exists')
const laptop=prepareLaptop(asset,.5);laptop.position.set(.03,.8,.25);laptop.updateMatrixWorld(true)
const keys=new THREE.Box3().setFromObject(keyboard).getCenter(new THREE.Vector3())
assert.ok(keys.distanceTo(laptop.position)<.001,'Real keyboard center aligns to the typing anchor, not the asset corner')
const cup=cupPositions(keys,new THREE.Vector3(-.15,.8,.25),.5,.1,laptop.userData.keyboardToBase,0)
const bounds=new THREE.Box3().setFromObject(laptop)
assert.ok(cup.x+.06<bounds.min.x+.01,'Mug rests outside the real laptop bounds')
console.log('Real work assets passed: keyboard anchor centered and mug clear of laptop.')
