/**
 * Mixamo FBX animation loader for VRM models.
 * Ported from lobe-vidol's loadMixamoAnimation.
 */

import type { VRM } from '@pixiv/three-vrm'
import type { VRMHumanBoneName } from '@pixiv/three-vrm-core'
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'

const mixamoVRMRigMap: Record<string, VRMHumanBoneName> = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
}

/**
 * Quaternius Universal Animation Library rig (Blender-style names) to VRM.
 * Same retarget math as Mixamo; only the bone names differ.
 */
const quaterniusVRMRigMap: Record<string, VRMHumanBoneName> = {
  pelvis: 'hips',
  spine_01: 'spine',
  spine_02: 'chest',
  spine_03: 'upperChest',
  neck_01: 'neck',
  Head: 'head',
  clavicle_l: 'leftShoulder',
  upperarm_l: 'leftUpperArm',
  lowerarm_l: 'leftLowerArm',
  hand_l: 'leftHand',
  thumb_01_l: 'leftThumbMetacarpal',
  thumb_02_l: 'leftThumbProximal',
  thumb_03_l: 'leftThumbDistal',
  index_01_l: 'leftIndexProximal',
  index_02_l: 'leftIndexIntermediate',
  index_03_l: 'leftIndexDistal',
  middle_01_l: 'leftMiddleProximal',
  middle_02_l: 'leftMiddleIntermediate',
  middle_03_l: 'leftMiddleDistal',
  ring_01_l: 'leftRingProximal',
  ring_02_l: 'leftRingIntermediate',
  ring_03_l: 'leftRingDistal',
  pinky_01_l: 'leftLittleProximal',
  pinky_02_l: 'leftLittleIntermediate',
  pinky_03_l: 'leftLittleDistal',
  clavicle_r: 'rightShoulder',
  upperarm_r: 'rightUpperArm',
  lowerarm_r: 'rightLowerArm',
  hand_r: 'rightHand',
  thumb_01_r: 'rightThumbMetacarpal',
  thumb_02_r: 'rightThumbProximal',
  thumb_03_r: 'rightThumbDistal',
  index_01_r: 'rightIndexProximal',
  index_02_r: 'rightIndexIntermediate',
  index_03_r: 'rightIndexDistal',
  middle_01_r: 'rightMiddleProximal',
  middle_02_r: 'rightMiddleIntermediate',
  middle_03_r: 'rightMiddleDistal',
  ring_01_r: 'rightRingProximal',
  ring_02_r: 'rightRingIntermediate',
  ring_03_r: 'rightRingDistal',
  pinky_01_r: 'rightLittleProximal',
  pinky_02_r: 'rightLittleIntermediate',
  pinky_03_r: 'rightLittleDistal',
  thigh_l: 'leftUpperLeg',
  calf_l: 'leftLowerLeg',
  foot_l: 'leftFoot',
  ball_l: 'leftToes',
  thigh_r: 'rightUpperLeg',
  calf_r: 'rightLowerLeg',
  foot_r: 'rightFoot',
  ball_r: 'rightToes',
}

const HIP_BONE_NAMES = ['mixamorigHips', 'pelvis']

/**
 * Pure retarget: map one FBX take's tracks onto VRM bone nodes.
 * Rig (Mixamo vs Quaternius) is detected from the hip bone present.
 * Exported for headless verification; prefer loadMixamoAnimation at runtime.
 */
export function retargetToVRM(asset: THREE.Group, vrm: VRM, takeName?: string): THREE.AnimationClip {
  const rigMap = asset.getObjectByName('mixamorigHips') ? mixamoVRMRigMap : quaterniusVRMRigMap
  const hipsBoneName = HIP_BONE_NAMES.find((n) => asset.getObjectByName(n))

  // Explicit take first (multi-take packs), then 'mixamo.com', then first take
  const clip = (takeName && THREE.AnimationClip.findByName(asset.animations, takeName))
    ?? THREE.AnimationClip.findByName(asset.animations, 'mixamo.com')
    ?? asset.animations[0]
  if (!clip) throw new Error('No animation clip found in FBX')

  const tracks: THREE.KeyframeTrack[] = []
  const restRotationInverse = new THREE.Quaternion()
  const parentRestWorldRotation = new THREE.Quaternion()
  const _quatA = new THREE.Quaternion()
  const _vec3 = new THREE.Vector3()

  // Scale based on hips height ratio
  const hipsObj = hipsBoneName ? asset.getObjectByName(hipsBoneName) : null
  if (!hipsObj) throw new Error('No hips bone found in FBX')
  asset.updateMatrixWorld(true)
  vrm.scene.updateMatrixWorld(true)
  const sourceBasis = rigMap === quaterniusVRMRigMap
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
    : new THREE.Quaternion()
  const sourceHipsWorld = hipsObj.getWorldPosition(new THREE.Vector3())
  const sourceRootWorld = asset.getWorldPosition(new THREE.Vector3())
  const motionHipsHeight = Math.abs(sourceHipsWorld.clone().sub(sourceRootWorld).applyQuaternion(sourceBasis).y)
  const targetHips = vrm.humanoid?.getNormalizedBoneNode('hips')
  if (!targetHips) throw new Error('Target model has no hips bone')
  const vrmHipsY = targetHips.getWorldPosition(_vec3).y
  const vrmRootY = vrm.scene.getWorldPosition(_vec3).y
  const vrmHipsHeight = Math.abs(vrmHipsY - vrmRootY)
  if (motionHipsHeight < 1e-5) throw new Error('Source skeleton has no usable world-space hips height')
  const hipsPositionScale = vrmHipsHeight / motionHipsHeight
  const sourceParentScale = hipsObj.parent?.getWorldScale(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1)
  const targetParentScale = targetHips.parent?.getWorldScale(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1)
  const targetParentInverse = targetHips.parent?.getWorldQuaternion(new THREE.Quaternion()).invert() ?? new THREE.Quaternion()

  clip.tracks.forEach((track) => {
    const trackSplitted = track.name.split('.')
    const mixamoRigName = trackSplitted[0]
    const vrmBoneName = rigMap[mixamoRigName]
    const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName)?.name
    const mixamoRigNode = asset.getObjectByName(mixamoRigName)

    if (vrmNodeName != null) {
      const propertyName = trackSplitted[1]

      restRotationInverse.identity()
      parentRestWorldRotation.copy(sourceBasis)
      if (mixamoRigNode) {
        mixamoRigNode.getWorldQuaternion(restRotationInverse).premultiply(sourceBasis).invert()
        if (mixamoRigNode.parent)
          mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation).premultiply(sourceBasis)
      }

      if (track instanceof THREE.QuaternionKeyframeTrack) {
        const convertedValues: number[] = []
        for (let i = 0; i < track.values.length; i += 4) {
          const flatQuaternion = track.values.slice(i, i + 4)
          _quatA.fromArray(flatQuaternion)
          _quatA.premultiply(parentRestWorldRotation).multiply(restRotationInverse)
          _quatA.normalize().toArray(flatQuaternion)
          convertedValues.push(...flatQuaternion)
        }

        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${vrmNodeName}.${propertyName}`,
            Array.from(track.times),
            convertedValues.map((v, i) => (vrm.meta?.metaVersion === '0' && i % 2 === 0 ? -v : v)),
          ),
        )
      } else if (track instanceof THREE.VectorKeyframeTrack && propertyName === 'position' && vrmBoneName === 'hips') {
        // Preserve displacement, not the source rig's absolute hip location.
        // Source parent rotation converts Z-up packs to world space; then
        // convert the movement into the target hip's parent-local coordinates.
        const first = new THREE.Vector3().fromArray(track.values)
        const value: number[] = []
        for (let i = 0; i < track.values.length; i += 3) {
          _vec3.fromArray(track.values, i).sub(first)
            .multiply(sourceParentScale).applyQuaternion(parentRestWorldRotation)
            .multiplyScalar(hipsPositionScale).applyQuaternion(targetParentInverse)
            .divide(targetParentScale).add(targetHips.position)
          value.push(_vec3.x, _vec3.y, _vec3.z)
        }
        tracks.push(
          new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, Array.from(track.times), value),
        )
      }
    }
  })

  return new THREE.AnimationClip('mixamoAnimation', clip.duration, tracks)
}

export async function loadMixamoAnimation(url: string, vrm: VRM, takeName?: string): Promise<THREE.AnimationClip> {
  const loader = new FBXLoader()
  let asset: THREE.Group
  try {
    asset = await loader.loadAsync(url) as THREE.Group
  } catch (err) {
    console.error('[MixamoLoader] FBXLoader.loadAsync failed:', url, err)
    throw err
  }
  return retargetToVRM(asset, vrm, takeName)
}
