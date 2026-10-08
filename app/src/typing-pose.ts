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
  eyeL: THREE.Object3D | null
  eyeR: THREE.Object3D | null
  midInterR: THREE.Object3D | null
  midDistR: THREE.Object3D | null
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
    eyeL: getBone(vrm, 'leftEye'),
    eyeR: getBone(vrm, 'rightEye'),
    midInterR: getBone(vrm, 'rightMiddleIntermediate'),
    midDistR: getBone(vrm, 'rightMiddleDistal'),
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

/** Idle glance toward the cursor: small additive head yaw/pitch on top of
 * whatever pose layer ran this frame (same bases map, so frame restore
 * still removes it). Angles are pre-damped radians; zero is a no-op. */
export function applyHeadTurn(cache: TypingPoseCache, yaw: number, pitch: number) {
  if (!cache.head || (yaw === 0 && pitch === 0)) return
  offset(cache, cache.head, pitch, yaw, 0, 1)
}

/**
 * World-space out-of-the-face direction. Located from the eye bones, which
 * sit on the face by construction on every rig — never from the model root
 * (VRM0 imports carry a π scene rotation that flips root-derived signs)
 * and never from the head bone's +Z (not face-forward on every rig).
 * Falls back to root-derived forward when a model lacks eye bones.
 */
export function faceDirection(cache: TypingPoseCache): THREE.Vector3 {
  const head = cache.head
  if (head && cache.eyeL && cache.eyeR) {
    const c = head.getWorldPosition(new THREE.Vector3())
    const eyes = cache.eyeL.getWorldPosition(new THREE.Vector3())
      .add(cache.eyeR.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5)
    const f = eyes.sub(c)
    f.y = 0
    if (f.lengthSq() > 1e-8) return f.normalize()
  }
  return new THREE.Vector3(0, 0, Math.sign(cache.headForward.z || 1))
}

/**
 * Coffee-sip overlay, layered on top of the typing pose: right hand rises
 * to the mouth, head tips back slightly. Same additive pattern as above.
 */
export function applySipPose(cache: TypingPoseCache, time: number, amount: number, faceOffset = .12) {
  if (amount <= 0) return
  const upperR = cache.upperR
  const lowerR = cache.lowerR
  const handR = cache.handR
  const head = cache.head
  if (!upperR || !lowerR || !handR || !head) return

  // Fade out the right-hand key presses as it lifts the cup. The saved
  // base is the relaxed finger pose before typing; the left hand keeps typing.
  for (const f of cache.fingers) {
    if (f.side !== -1) continue
    const base = cache.bases.get(f.bone)
    if (base) f.bone.quaternion.slerp(base, amount).normalize()
  }

  // Face-forward from the eye bones (see faceDirection): correct in world
  // space on every rig and convention, and tracks the mouth as the head
  // tilts. Root- and head-axis-derived signs both lie on some imports.
  const faceDir = faceDirection(cache)

  // Lips, guaranteed outside the skull: the face distance is measured off
  // the real head mesh (VRMScene raycasts it once per model), so big-head
  // and chibi proportions can't bury the target inside the cranium.
  const mouth = head.getWorldPosition(new THREE.Vector3())
    .addScaledVector(faceDir, faceOffset + .04)
  mouth.y -= .02
  // Drink to the arm's own side of the mouth rather than dead center —
  // a right hand holds the cup right-of-lips, not on the philtrum.
  {
    const side = upperR.getWorldPosition(new THREE.Vector3()).sub(mouth)
    side.y = 0
    if (side.lengthSq() > 1e-8) mouth.addScaledVector(side.normalize(), .06)
  }

  // Bone lengths are rotation-invariant: measure in world space before
  // re-aiming anything, so model scale never matters.
  upperR.updateWorldMatrix(true, false)
  const S = upperR.getWorldPosition(new THREE.Vector3())
  const L1 = lowerR.getWorldPosition(new THREE.Vector3()).distanceTo(S)
  const L2 = handR.getWorldPosition(new THREE.Vector3()).distanceTo(
    lowerR.getWorldPosition(new THREE.Vector3()))
  if (L1 < 1e-6 || L2 < 1e-6) return

  // Two-bone analytic IK. Direction-only aiming lands the wrist at
  // elbow + aim × forearm-length, which overshoots into the skull whenever
  // the forearm out-reaches the elbow→mouth gap — unsolvable with any fixed
  // direction vector. Instead the elbow angle is solved exactly (law of
  // cosines) so the wrist lands ON the lips on every model's proportions.
  const toT = mouth.clone().sub(S)
  const d = toT.length()
  const dir = d > 1e-8 ? toT.divideScalar(d) : faceDir.clone()
  const maxReach = (L1 + L2) * .999
  const reachable = d <= maxReach
  const dc = Math.min(d, maxReach)
  // Elbow pole: down and anatomically outward (shoulder away from spine),
  // slightly back — keeps the elbow out of the torso.
  const spinePos = cache.spine?.getWorldPosition(new THREE.Vector3())
  const out = spinePos ? S.clone().sub(spinePos) : new THREE.Vector3(-1, 0, 0)
  out.y = 0
  if (out.lengthSq() < 1e-8) out.set(-1, 0, 0)
  out.normalize()
  const back = faceDir.clone()
  back.y = 0
  if (back.lengthSq() < 1e-8) back.set(0, 0, -1)
  else back.normalize()
  const pole = out.multiplyScalar(.5).add(new THREE.Vector3(0, -.8, 0)).addScaledVector(back, -.2).normalize()
  const cosA = THREE.MathUtils.clamp((L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc), -1, 1)
  let axis = new THREE.Vector3().crossVectors(dir, pole)
  if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0)
  axis.normalize()
  pointBone(cache, upperR, lowerR, dir.applyAxisAngle(axis, Math.acos(cosA)), amount)

  const elbow = lowerR.getWorldPosition(new THREE.Vector3())
  const toMouth = mouth.clone().sub(elbow)
  if (toMouth.lengthSq() > 1e-10) {
    // Unreachable (arms shorter than shoulder→mouth): stretch toward the
    // mouth but undershoot instead of spearing past it.
    const undershoot = reachable ? 1 : Math.max(.35, dc / Math.max(d, 1e-6))
    pointBone(cache, lowerR, handR, toMouth, amount * undershoot)
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
