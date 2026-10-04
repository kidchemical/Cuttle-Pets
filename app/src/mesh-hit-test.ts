import { Object3D, Raycaster, SkinnedMesh } from 'three'

/** Raycast animated meshes using bounds from their current pose. */
export function intersectAnimatedModel(raycaster: Raycaster, model: Object3D) {
  model.updateWorldMatrix(true, true)
  model.traverse((object) => {
    const mesh = object as SkinnedMesh
    if (mesh.isSkinnedMesh) {
      mesh.computeBoundingSphere()
      if (mesh.boundingBox !== null) mesh.computeBoundingBox()
    }
  })
  return raycaster.intersectObject(model, true)
}
