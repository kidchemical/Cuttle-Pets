import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const THREE = createRequire(new URL('../app/package.json', import.meta.url))('three')
import { defaultViewFromBounds, isValidView } from '../app/src/camera-framing'

// Measured model1.vrm mesh-local bounds (POSITION accessor min/max).
const SIZE = { x: 1.132, y: 1.303, z: 0.719 }
const CENTER = { x: 0, y: 0.6505, z: 0.1825 }
const FEET_Y = -0.001
const HEAD_Y = 1.302

function headNdcY(view: { pivot: [number, number, number]; radius: number; theta: number; phi: number }) {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.position.set(
    view.pivot[0] + view.radius * Math.sin(view.phi) * Math.sin(view.theta),
    view.pivot[1] + view.radius * Math.cos(view.phi),
    view.pivot[2] + view.radius * Math.sin(view.phi) * Math.cos(view.theta),
  )
  camera.lookAt(new THREE.Vector3(...view.pivot))
  return new THREE.Vector3(0, HEAD_Y, CENTER.z).project(camera).y
}

async function main() {
  const view = defaultViewFromBounds(SIZE, CENTER, 40)
  // Pivot near neck height, sane orbit distance.
  assert.ok(Math.abs(view.pivot[1] - 1.058) < 0.01, `pivot.y near neck height, got ${view.pivot[1]}`)
  assert.ok(Math.abs(view.radius - 0.852) < 0.01, `radius fits model height, got ${view.radius}`)
  assert.ok(view.phi > 1.3 && view.phi < 1.5, `phi near eye level, got ${view.phi}`)
  assert.ok(Math.abs(headNdcY(view)) <= 1, 'head stays inside the frame on a fresh load')

  // The reported bug: restoring a snapshot taken before any model finished
  // loading replays the pre-framing orbit defaults (pivot at feet, radius
  // 2m). That parks the camera at foot level: legs-only, head cut off.
  const preFramingDefaults = { pivot: [0, 0, 0] as [number, number, number], radius: 2.0, theta: 0, phi: Math.PI / 2 }
  assert.ok(headNdcY(preFramingDefaults) > 1, 'pre-framing defaults cut the head off (bug geometry)')
  assert.ok(FEET_Y > -0.01, 'sanity: model feet at origin')

  // Snapshot validation: defense in depth on the restore path.
  assert.equal(isValidView(view), true)
  assert.equal(isValidView(null), false)
  assert.equal(isValidView({ pivot: [0, 0, 0], radius: 2, theta: 0, phi: Math.PI / 2 }), true, 'finite defaults pass validation — the snapshot guard (not validation) excludes them')
  assert.equal(isValidView({ pivot: [0, NaN, 0], radius: 2, theta: 0, phi: 1 }), false)
  assert.equal(isValidView({ pivot: [0, 0, 0], radius: 0, theta: 0, phi: 1 }), false)
  assert.equal(isValidView({ pivot: [0, 0, 0], radius: 2, theta: 0, phi: Math.PI }), false)
  console.log('Camera framing passed: neck-height default keeps head in frame; pre-framing snapshot geometry reproduces legs-only.')
}
main().catch(e => { console.error(e); process.exit(1) })
