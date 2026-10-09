import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

/** Anchor the lowest foot, toe or knee to the model's standing floor.
 * Applied to normalized hips before humanoid.update(), never the scene/camera.
 * The previous correction is removed before the next mixer sample, including
 * clips without a position track. Disabled for jumps/dances by default.
 */
export class AnimationGrounding {
  private hips: THREE.Object3D | null
  private contacts: THREE.Object3D[]
  private floor: number
  private correction = new THREE.Vector3()
  private point = new THREE.Vector3()
  private local = new THREE.Vector3()
  private inverse = new THREE.Matrix4()
  constructor(vrm: VRM) {
    this.hips = vrm.humanoid?.getNormalizedBoneNode('hips') ?? null
    this.contacts = (['leftFoot', 'rightFoot', 'leftToes', 'rightToes', 'leftLowerLeg', 'rightLowerLeg'] as const)
      .flatMap(name => { const bone = vrm.humanoid?.getNormalizedBoneNode(name); return bone ? [bone] : [] })
    this.floor = this.contactHeight()
  }
  restore() {
    this.hips?.position.sub(this.correction)
    this.correction.set(0, 0, 0)
  }
  private contactHeight() {
    let height = Infinity
    for (const bone of this.contacts) {
      bone.updateWorldMatrix(true, false)
      bone.getWorldPosition(this.point)
      height = Math.min(height, this.point.y)
    }
    return height
  }
  apply(weight: number) {
    if (!this.hips?.parent || !this.contacts.length || weight <= 0 || !Number.isFinite(this.floor)) return
    const displacement = (this.floor - this.contactHeight()) * Math.min(1, weight)
    this.hips.parent.updateWorldMatrix(true, false)
    // Transform a world-space vertical displacement to hips-parent local space.
    this.inverse.copy(this.hips.parent.matrixWorld).invert()
    this.local.set(0, 0, 0).applyMatrix4(this.inverse)
    this.correction.set(0, displacement, 0).applyMatrix4(this.inverse).sub(this.local)
    this.hips.position.add(this.correction)
  }
}
