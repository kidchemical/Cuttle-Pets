import * as THREE from 'three'

/** Normalize the asset around its actual keyboard, rather than its corner origin. */
export function prepareLaptop(asset: THREE.Object3D, targetWidth: number) {
  const box = new THREE.Box3().setFromObject(asset)
  const size = box.getSize(new THREE.Vector3())
  let keyboard = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y + size.y * .08, box.min.z + size.z * .33)
  asset.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    const bounds = new THREE.Box3().setFromObject(object)
    const dimensions = bounds.getSize(new THREE.Vector3())
    if (dimensions.y < size.y * .015 && dimensions.x > size.x * .5 && dimensions.z > size.z * .2) keyboard = bounds.getCenter(new THREE.Vector3())
  })
  const group = new THREE.Group()
  const scale = targetWidth / Math.max(size.x, .001)
  asset.position.sub(keyboard)
  group.add(asset)
  group.scale.setScalar(scale)
  group.userData.width = targetWidth
  group.userData.keyboardToBase = (keyboard.y - box.min.y) * scale
  return group
}

export function cupPositions(keyboard: THREE.Vector3, rightHand: THREE.Vector3, laptopWidth: number, cupHeight: number, keyboardToBase: number, sip: number) {
  const resting = keyboard.clone().add(new THREE.Vector3(-laptopWidth / 2 - cupHeight * .65, cupHeight / 2 - keyboardToBase, 0))
  const held = rightHand.clone().add(new THREE.Vector3(-cupHeight * .45, cupHeight * .10, 0))
  const pickup = THREE.MathUtils.smoothstep(sip, 0, .35)
  return resting.lerp(held, pickup)
}
