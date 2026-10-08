import assert from 'node:assert/strict'
import { unconfiguredAssets, type LibraryAsset } from '../app/src/asset-import'

const library: LibraryAsset[] = [
  { name: 'ChaoNCZ0.glb', size: 100, url: '/assets/pets/serve/ChaoNCZ0.glb' },
  { name: 'ChaoNFF0.glb', size: 200, url: '/assets/pets/serve/ChaoNFF0.glb' },
  { name: 'hat.glb', size: 50, url: '/assets/pets/serve/hat.glb' },
]

// Configured files drop out; order and shape survive.
assert.deepEqual(
  unconfiguredAssets(library, ['ChaoNCZ0.glb']).map(a => a.name),
  ['ChaoNFF0.glb', 'hat.glb'],
)
// Nothing configured: everything is pickable. Everything configured: picker hides.
assert.deepEqual(unconfiguredAssets(library, []).map(a => a.name), ['ChaoNCZ0.glb', 'ChaoNFF0.glb', 'hat.glb'])
assert.deepEqual(unconfiguredAssets(library, ['ChaoNCZ0.glb', 'ChaoNFF0.glb', 'hat.glb']), [])
// Unknown configured files never match; input list is not mutated.
assert.deepEqual(unconfiguredAssets([], ['x.glb']), [])
assert.deepEqual(library.map(a => a.name), ['ChaoNCZ0.glb', 'ChaoNFF0.glb', 'hat.glb'])

console.log('Asset import passed: library minus configured files.')
