import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

// ── Typing / working pose ────────────────────────────────────────────────────
// Procedural pose applied every frame AFTER mixer.update() (and after the
// relaxed hand pose), same layering pattern VRMScene already uses: each frame
// we restore the previous overlay before the mixer runs, then add a
// scaled offset on top. At amount 0 the bones are untouched, so nothing gets
// stuck when typing stops.
//
// Assumes the VRM faces +Z (true after rotateVRM0): arms swing forward via
// upper-arm Y rotation, elbows bend up via lower-arm Z rotation, head nods
// down via X rotation.

export interface TypingPoseCache {
  bases: Map<THREE.Object3D, THREE.Quaternion>
  upperL: THREE.Object3D | null
  upperR: THREE.Object3D | null
  lowerL: THREE.Object3D | null
  lowerR: THREE.Object3D | null
  head: THREE.Object3D | null
  spine: THREE.Object3D | null
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
  return {
    bases: new Map(),
    upperL: getBone(vrm, 'leftUpperArm'),
    upperR: getBone(vrm, 'rightUpperArm'),
    lowerL: getBone(vrm, 'leftLowerArm'),
    lowerR: getBone(vrm, 'rightLowerArm'),
    head: getBone(vrm, 'head'),
    spine: getBone(vrm, 'spine'),
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

function pose(cache: TypingPoseCache, bone: THREE.Object3D | null, x: number, y: number, z: number, amount: number) {
  if (!bone || amount <= 0) return
  if (!cache.bases.has(bone)) cache.bases.set(bone, bone.quaternion.clone())
  offsetQuaternion.setFromEuler(offsetEuler.set(x, y, z))
  bone.quaternion.slerp(offsetQuaternion, amount).normalize()
}

export function applyTypingPose(cache: TypingPoseCache, time: number, amount: number) {
  if (amount <= 0) return
  // Normalized VRM bind pose has arms horizontal. Lower upper arms toward
  // the sides, then bend elbows forward without twisting shoulders inward.
  const tap = Math.sin(time * 6.5) * 0.025
  pose(cache, cache.upperL, 0, 0, -1.40, amount)
  pose(cache, cache.upperR, 0, 0, 1.40, amount)
  pose(cache, cache.lowerL, tap, -1.45, 0, amount)
  pose(cache, cache.lowerR, -tap, 1.45, 0, amount)
  // Lean in slightly, look down at the screen.
  offset(cache, cache.spine, 0.08, 0, 0, amount)
  offset(cache, cache.head, 0.28 + Math.sin(time * 1.3) * 0.02, 0, 0, amount)
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
  const sway = Math.sin(time * 2.2) * 0.02
  pose(cache, cache.upperR, sway, 0.25, 0.65, amount)
  pose(cache, cache.lowerR, 0, 2.60, 0, amount)
  offset(cache, cache.head, -0.14, 0, 0, amount)
}

/** Gentle bounded listening pose, sharing the reversible overlay layer. */
export function applyMusicPose(cache: TypingPoseCache, time: number, amount: number) {
  offset(cache, cache.head, Math.sin(time * 3.5) * 0.07, 0, Math.sin(time * 1.75) * 0.035, amount)
}
