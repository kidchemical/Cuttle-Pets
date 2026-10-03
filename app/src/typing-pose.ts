import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

// ── Typing / working pose ────────────────────────────────────────────────────
// Procedural pose applied every frame AFTER mixer.update() (and after the
// relaxed hand pose), same layering pattern VRMScene already uses: each frame
// we restore the previous overlay before the mixer runs, then add a
// scaled offset on top. At amount 0 the bones are untouched, so nothing gets
// stuck when typing stops.
//
// The displayed avatar faces +Z after rotateVRM0. Aim bones using actual
// child axes and parent world transforms, so mirrored bind axes work too.

export interface TypingPoseCache {
  bases: Map<THREE.Object3D, THREE.Quaternion>
  palmNormals: Map<THREE.Object3D, THREE.Vector3>
  headForward: THREE.Vector3
  upperL: THREE.Object3D | null
  upperR: THREE.Object3D | null
  lowerL: THREE.Object3D | null
  lowerR: THREE.Object3D | null
  head: THREE.Object3D | null
  spine: THREE.Object3D | null
  keyboardL: THREE.Object3D | null
  keyboardR: THREE.Object3D | null
  handL: THREE.Object3D | null
  handR: THREE.Object3D | null
  fingers: { bone: THREE.Object3D; phase: number; side: number }[]
}

function getBone(vrm: VRM, name: string): THREE.Object3D | null {
  return vrm.humanoid?.getNormalizedBoneNode(name as never) ?? null
}

export function buildTypingPoseCache(vrm: VRM): TypingPoseCache {
  const fingers: TypingPoseCache['fingers'] = []
  const segments = ['Proximal', 'Intermediate', 'Distal'] as const
  let i = 0
  for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
    for (const finger of ['Index', 'Middle', 'Ring', 'Little'] as const) {
      for (const seg of segments) {
        const bone = getBone(vrm, `${side}${finger}${seg}`)
        if (!bone) continue
        fingers.push({ bone, phase: i++ * 1.7, side: sign })
      }
    }
  }
  const palmNormals = new Map<THREE.Object3D, THREE.Vector3>()
  for (const side of ['left', 'right']) {
    const hand = getBone(vrm, side + 'Hand')
    const index = getBone(vrm, side + 'IndexProximal')
    const little = getBone(vrm, side + 'LittleProximal')
    if (hand) {
      const normal = index && little ? index.position.clone().cross(little.position).normalize() : new THREE.Vector3(0, -1, 0)
      if (normal.y > 0) normal.negate()
      palmNormals.set(hand, normal)
    }
  }
  const rootRotation = vrm.scene?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion()
  return {
    bases: new Map(),
    palmNormals,
    headForward: new THREE.Vector3(0, 0, 1).applyQuaternion(rootRotation.invert()),
    upperL: getBone(vrm, 'leftUpperArm'),
    upperR: getBone(vrm, 'rightUpperArm'),
    lowerL: getBone(vrm, 'leftLowerArm'),
    lowerR: getBone(vrm, 'rightLowerArm'),
    head: getBone(vrm, 'head'),
    spine: getBone(vrm, 'spine'),
    keyboardL: getBone(vrm, 'leftMiddleProximal') ?? getBone(vrm, 'leftHand'),
    keyboardR: getBone(vrm, 'rightMiddleProximal') ?? getBone(vrm, 'rightHand'),
    handL: getBone(vrm, 'leftHand'),
    handR: getBone(vrm, 'rightHand'),
    fingers,
  }
}

/** Remove only our previous frame's layer BEFORE the animation mixer runs. */
export function restoreTypingPose(cache: TypingPoseCache) {
  for (const [bone, base] of cache.bases) bone.quaternion.copy(base)
  cache.bases.clear()
}

const offsetQuaternion = new THREE.Quaternion()
const offsetEuler = new THREE.Euler()
function offset(cache: TypingPoseCache, b: THREE.Object3D | null, dx: number, dy: number, dz: number, amount: number) {
  if (!b || amount <= 0) return
  if (!cache.bases.has(b)) cache.bases.set(b, b.quaternion.clone())
  offsetQuaternion.setFromEuler(offsetEuler.set(dx * amount, dy * amount, dz * amount))
  b.quaternion.multiply(offsetQuaternion).normalize()
}

/** Aim the real child-bone axis in world space; VRM0/VRM1 and rigs have different arm signs. */
function pointBone(cache: TypingPoseCache, bone: THREE.Object3D | null, child: THREE.Object3D | null, direction: THREE.Vector3, amount: number) {
  if (!bone || !child || child.position.lengthSq() < 1e-10 || amount <= 0) return
  if (!cache.bases.has(bone)) cache.bases.set(bone, bone.quaternion.clone())
  bone.parent?.updateWorldMatrix(true, false)
  const parent = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion()
  const localTarget = direction.clone().normalize().applyQuaternion(parent.invert())
  const target = new THREE.Quaternion().setFromUnitVectors(child.position.clone().normalize(), localTarget)
  bone.quaternion.slerp(target, amount).normalize()
  bone.updateWorldMatrix(false, true)
}

/** Twist around the forearm's length without moving the elbow or wrist. */
function palmDown(cache: TypingPoseCache, lower: THREE.Object3D | null, hand: THREE.Object3D | null, amount: number) {
  if (!lower || !hand || hand.position.lengthSq() < 1e-10 || amount <= 0) return
  const normal = cache.palmNormals.get(hand)
  if (!normal) return
  lower.updateWorldMatrix(true, true)
  const axis = hand.getWorldPosition(new THREE.Vector3()).sub(lower.getWorldPosition(new THREE.Vector3())).normalize()
  const palm = normal.clone().applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()))
  palm.addScaledVector(axis, -palm.dot(axis)).normalize()
  const down = new THREE.Vector3(0, -1, 0); down.addScaledVector(axis, -down.dot(axis)).normalize()
  const angle = Math.atan2(axis.dot(palm.clone().cross(down)), palm.dot(down))
  if (!cache.bases.has(lower)) cache.bases.set(lower, lower.quaternion.clone())
  lower.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(hand.position.clone().normalize(), angle * amount)).normalize()
  lower.updateWorldMatrix(false, true)
}

function lookDown(cache: TypingPoseCache, amount: number) {
  if (!cache.head) return
  const head = cache.head
  if (!cache.bases.has(head)) cache.bases.set(head, head.quaternion.clone())
  head.parent?.updateWorldMatrix(true, false)
  const parent = head.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion()
  const direction = new THREE.Vector3(0, -.22, 1).normalize().applyQuaternion(parent.invert())
  head.quaternion.slerp(new THREE.Quaternion().setFromUnitVectors(cache.headForward, direction), amount).normalize()
}

export function applyTypingPose(cache: TypingPoseCache, time: number, amount: number) {
  if (amount <= 0) return
  // Aim upper arms down and forearms toward the laptop (+Z in the scene),
  // using each avatar's actual axes instead of hard-coded left/right rotations.
  const tap = Math.sin(time * 6.5) * 0.025
  pointBone(cache, cache.upperL, cache.lowerL, new THREE.Vector3(0, -1, .10), amount)
  pointBone(cache, cache.upperR, cache.lowerR, new THREE.Vector3(0, -1, .10), amount)
  pointBone(cache, cache.lowerL, cache.handL, new THREE.Vector3(0, .04 + tap, 1), amount)
  pointBone(cache, cache.lowerR, cache.handR, new THREE.Vector3(0, .04 - tap, 1), amount)
  // Lean in slightly, look down at the screen.
  offset(cache, cache.spine, 0.08, 0, 0, amount)
  palmDown(cache, cache.lowerL, cache.handL, amount)
  palmDown(cache, cache.lowerR, cache.handR, amount)
  lookDown(cache, amount)
  // Alternating key-press wiggle per finger.
  for (const f of cache.fingers) {
    offset(cache, f.bone, 0, 0, Math.sin(time * 13 + f.phase) * 0.07 * f.side, amount)
  }
}

/**
 * Coffee-sip overlay, layered on top of the typing pose: right hand rises
 * to the mouth, head tips back slightly. Same additive pattern as above.
 */
export function applySipPose(cache: TypingPoseCache, time: number, amount: number) {
  if (amount <= 0) return
  // Flare the elbow out to the side so the forearm approaches the mouth
  // from front-side, never straight through the face.
  pointBone(cache, cache.upperR, cache.lowerR, new THREE.Vector3(-.38, -.55, .60), amount)
  if (cache.head && cache.lowerR) {
    // Aim at a standoff point in FRONT of the mouth, not the head center.
    // pointBone only sets the forearm direction — a long forearm overshoots
    // past the target into the skull — so the target sits well clear of the
    // lips and the forearm deliberately undershoots (0.85) with the elbow
    // flared, leaving the hand parked at the lips instead of inside the face.
    const facing = Math.sign(cache.headForward.z || 1)
    const mouth = cache.head.getWorldPosition(new THREE.Vector3())
    const elbow = cache.lowerR.getWorldPosition(new THREE.Vector3())
    mouth.y -= .05
    mouth.z += .24 * facing
    mouth.x += Math.sign(elbow.x - mouth.x || 1) * .03
    pointBone(cache, cache.lowerR, cache.handR, mouth.sub(elbow), amount * .85)
  }
  offset(cache, cache.head, -0.14 * Math.sign(cache.headForward.z || 1), 0, 0, amount)
}

/** One clear pitch nod per beat with a small, slower roll. Reversible each frame. */
export function applyMusicPose(cache: TypingPoseCache, phase: number, amount: number, nodDegrees = 24, swayDegrees = 4) {
  const pitch = Math.cos(phase * Math.PI * 2) * THREE.MathUtils.degToRad(nodDegrees)
  const roll = Math.sin(phase * Math.PI) * THREE.MathUtils.degToRad(swayDegrees)
  offset(cache, cache.head, pitch, 0, roll, amount)
}

export function applyMusicAngles(cache: TypingPoseCache, pitch: number, roll: number) {
  offset(cache, cache.head, pitch * Math.sign(cache.headForward.z || 1), 0, roll, 1)
}
