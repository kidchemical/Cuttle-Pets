import assert from 'node:assert/strict'
import { EAR_MORPH_DAMPEN, collectEarMorphSlots, dampenEarMorphs } from '../app/src/ear-morph-dampen'

async function main() {
  const earMesh = { name: 'Ear.baked', morphTargetInfluences: [0.9, 0.4] }
  const bodyMesh = { name: 'Body.baked', morphTargetInfluences: [1.0] }
  const noInfluenceMesh = { name: 'Ear accessory' }
  const expressions = [
    { binds: [{ primitives: [earMesh], index: 0 }, { primitives: [bodyMesh], index: 0 }] },
    { binds: [{ primitives: [earMesh], index: 1 }] },
    { binds: [{ primitives: [earMesh], index: 0 }] }, // duplicate slot
    { binds: [{ primitives: [noInfluenceMesh], index: 0 }] },
    { binds: [{ primitives: [earMesh] }] }, // no index
    { binds: null },
  ]
  const slots = collectEarMorphSlots(expressions)
  assert.equal(slots.length, 3, 'ear slots deduped (ear idx0, ear idx1, accessory idx0)')
  assert.ok(slots.every((s) => /ear/i.test(s.mesh.name ?? '')), 'only ear-named meshes collected')
  assert.equal(collectEarMorphSlots(undefined).length, 0)
  assert.equal(collectEarMorphSlots(null).length, 0)

  dampenEarMorphs(slots)
  assert.ok(Math.abs(earMesh.morphTargetInfluences[0] - 0.9 * EAR_MORPH_DAMPEN) < 1e-9)
  assert.ok(Math.abs(earMesh.morphTargetInfluences[1] - 0.4 * EAR_MORPH_DAMPEN) < 1e-9)
  assert.equal(bodyMesh.morphTargetInfluences[0], 1.0, 'non-ear meshes untouched')
  // Missing influence arrays are safe no-ops.
  dampenEarMorphs([{ mesh: {}, index: 0 }])
  dampenEarMorphs([{ mesh: { morphTargetInfluences: [1] }, index: 5 }])
  // Explicit factor respected.
  dampenEarMorphs([{ mesh: earMesh, index: 0 }], 0.5)
  assert.ok(Math.abs(earMesh.morphTargetInfluences[0] - 0.9 * EAR_MORPH_DAMPEN * 0.5) < 1e-9)
  console.log('Ear morph dampen passed: ear-only collection, exact scaling, safe no-ops.')
}
main().catch(e => { console.error(e); process.exit(1) })
