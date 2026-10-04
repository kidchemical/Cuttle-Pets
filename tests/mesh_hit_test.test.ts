import assert from 'node:assert/strict'
import { Bone, BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, MeshBasicMaterial, Raycaster, Skeleton, SkinnedMesh, Vector3 } from '../app/node_modules/three/build/three.module.js'
import { intersectAnimatedModel } from '../app/src/mesh-hit-test'

const geometry = new BufferGeometry()
geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3))
geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(12).fill(0), 4))
geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4))
const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial())
const bone = new Bone()
mesh.add(bone)
mesh.bind(new Skeleton([bone]))
mesh.updateMatrixWorld(true)
mesh.computeBoundingBox()
mesh.computeBoundingSphere()
const ray = new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1))
assert.equal(ray.intersectObject(mesh).length, 1)

// Simulate animation carrying visible triangles outside the cached bounds.
bone.position.x = 4
mesh.updateMatrixWorld(true)
ray.ray.origin.x = 4
assert.equal(ray.intersectObject(mesh).length, 0, 'reproduce rejection of an animated visible mesh')
assert.equal(intersectAnimatedModel(ray, mesh).length, 1, 'current pose stays interactive')
ray.ray.origin.x = 0
assert.equal(intersectAnimatedModel(ray, mesh).length, 0, 'empty space remains a miss')
geometry.dispose()
mesh.material.dispose()
console.log('Animated mesh hit-test regression passed.')
