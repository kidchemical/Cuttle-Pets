import * as THREE from 'three'
import { VRMExpressionMaterialColorBind, VRMExpressionTextureTransformBind, type VRM } from '@pixiv/three-vrm'

/** three.js caches one compiled program per material. When one material is
 * drawn by meshes that need different shader variants (skinned vs static,
 * different morph target counts, vertex colors), the renderer switches
 * programs on every draw and re-derives shader parameters each frame — CPU
 * time plus megabytes of garbage per second. VRM exporters commonly share a
 * material between a face mesh with 100+ blend shapes and a body mesh with
 * few or none. */
export function programVariant(mesh: THREE.Mesh, material: THREE.Material): string {
  const geometry = mesh.geometry
  const morph = geometry.morphAttributes
  const color = geometry.attributes.color
  return [
    (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 'skinned' : 'static',
    `morphs:${morph.position?.length ?? 0}`,
    morph.normal ? 'morphNormals' : '',
    morph.color ? 'morphColors' : '',
    material.vertexColors && color ? `colors:${color.itemSize}` : '',
    (mesh as THREE.InstancedMesh).isInstancedMesh ? 'instanced' : '',
  ].join('|')
}

/** Give each shader variant its own material. The first variant keeps the
 * original; others get clones. Returns original → clones. */
export function splitMaterialVariants(root: THREE.Object3D): Map<THREE.Material, THREE.Material[]> {
  const variants = new Map<THREE.Material, Map<string, THREE.Material>>()
  const clones = new Map<THREE.Material, THREE.Material[]>()
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const next = list.map(material => {
      const variant = programVariant(mesh, material)
      let byVariant = variants.get(material)
      if (!byVariant) { byVariant = new Map([[variant, material]]); variants.set(material, byVariant) }
      let assigned = byVariant.get(variant)
      if (!assigned) {
        assigned = material.clone()
        byVariant.set(variant, assigned)
        clones.set(material, [...(clones.get(material) ?? []), assigned])
      }
      return assigned
    })
    mesh.material = Array.isArray(mesh.material) ? next : next[0]
  })
  return clones
}

/** Split shared VRM materials and keep clones in sync with expressions
 * (material color / texture transform binds) and per-frame MToon updates. */
export function splitVrmMaterialVariants(vrm: VRM): number {
  const clones = splitMaterialVariants(vrm.scene)
  if (!clones.size) return 0
  for (const expression of vrm.expressionManager?.expressions ?? []) {
    for (const bind of [...expression.binds]) {
      const copies = clones.get((bind as { material?: THREE.Material }).material as THREE.Material)
      if (!copies) continue
      // Match by shape, not instanceof: binds may come from another build of three-vrm.
      for (const material of copies) {
        if ('targetValue' in bind) {
          const color = bind as VRMExpressionMaterialColorBind
          expression.addBind(new VRMExpressionMaterialColorBind({ material, type: color.type, targetValue: color.targetValue, targetAlpha: color.targetAlpha }))
        } else if ('scale' in bind && 'offset' in bind) {
          const transform = bind as VRMExpressionTextureTransformBind
          expression.addBind(new VRMExpressionTextureTransformBind({ material, scale: transform.scale, offset: transform.offset }))
        }
      }
    }
  }
  const updated = vrm.materials as THREE.Material[] | undefined
  if (updated) {
    for (const [original, copies] of clones) if (updated.includes(original)) updated.push(...copies)
  }
  let count = 0
  for (const copies of clones.values()) count += copies.length
  return count
}
