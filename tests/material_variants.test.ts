import assert from 'node:assert/strict'
import { BoxGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Skeleton, SkinnedMesh, Vector2 } from '../app/node_modules/three/build/three.module.js'
import { VRMExpression, VRMExpressionMaterialColorBind, VRMExpressionTextureTransformBind } from '../app/node_modules/@pixiv/three-vrm/lib/three-vrm.module.js'
import { programVariant, splitMaterialVariants, splitVrmMaterialVariants } from '../app/src/material-variants'

function morphed(count: number) {
  const geometry = new BoxGeometry()
  geometry.morphAttributes.position = Array.from({ length: count }, () => new Float32BufferAttribute(geometry.attributes.position.array.slice(), 3))
  return geometry
}

// Same variant keeps sharing; a different morph count gets its own clone.
const shared = new MeshStandardMaterial({ color: 0x336699 })
shared.name = 'Body'
const root = new Group()
const face = new Mesh(morphed(110), shared)
const body = new Mesh(morphed(9), shared)
const sock = new Mesh(morphed(9), shared)
const plain = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
root.add(face, body, sock, plain)
assert.notEqual(programVariant(face, shared), programVariant(body, shared))
const clones = splitMaterialVariants(root)
assert.equal(face.material, shared, 'First variant keeps the original')
assert.notEqual(body.material, shared, 'Other variant gets a clone')
assert.equal(body.material, sock.material, 'Meshes with the same variant share the clone')
assert.equal((body.material as MeshStandardMaterial).color.getHex(), 0x336699, 'Clone keeps the look')
assert.equal(clones.get(shared)?.length, 1)
assert.equal(splitMaterialVariants(root).size, 0, 'Already split: no further clones')

// Skinned vs static and multi-material meshes are handled.
const multi = new MeshStandardMaterial()
const skinned = new SkinnedMesh(new BoxGeometry(), [multi, multi])
skinned.bind(new Skeleton([]))
const still = new Mesh(new BoxGeometry(), multi)
const root2 = new Group(); root2.add(skinned, still)
splitMaterialVariants(root2)
assert.deepEqual((skinned.material as MeshStandardMaterial[]).map(m => m === multi), [true, true])
assert.notEqual(still.material, multi)

// VRM: expression binds and per-frame material updates follow the clones.
const vrmMaterial = new MeshStandardMaterial({ color: 0xffffff })
const vrmRoot = new Group()
const vrmFace = new Mesh(morphed(5), vrmMaterial)
const vrmBody = new Mesh(new BoxGeometry(), vrmMaterial)
vrmRoot.add(vrmFace, vrmBody)
const blush = new VRMExpression('blush')
blush.addBind(new VRMExpressionMaterialColorBind({ material: vrmMaterial, type: 'color', targetValue: new Color(1, 0, 0) }))
blush.addBind(new VRMExpressionTextureTransformBind({ material: vrmMaterial, scale: new Vector2(1, 1), offset: new Vector2(0.5, 0) }))
const materials = [vrmMaterial]
const count = splitVrmMaterialVariants({ scene: vrmRoot, materials, expressionManager: { expressions: [blush] } } as any)
assert.equal(count, 1)
const bodyClone = vrmBody.material as MeshStandardMaterial
assert.ok(materials.includes(bodyClone), 'Clone joins vrm.materials for per-frame updates')
assert.equal(blush.binds.length, 4, 'Each bind is mirrored onto the clone')
blush.weight = 1
blush.applyWeight()
assert.equal(bodyClone.color.getHex(), 0xff0000, 'Expression color reaches the clone')
assert.equal((vrmFace.material as MeshStandardMaterial).color.getHex(), 0xff0000)
console.log('Material variant split passed: per-variant clones, sharing within a variant, skinned/static, VRM expression binds, vrm.materials.')
