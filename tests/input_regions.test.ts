import assert from 'node:assert/strict'
import { alphaInputRegions } from '../app/src/input-regions'
const pixels = new Uint8Array(4 * 4 * 4)
assert.deepEqual(alphaInputRegions(pixels, 4, 4, 40, 40), [])
// Bottom-left GL pixel maps to bottom-left CSS with a small safety margin.
pixels[3] = 255
assert.deepEqual(alphaInputRegions(pixels, 4, 4, 40, 40), [{ x: 0, y: 20, width: 20, height: 20 }])
pixels.fill(0)
pixels[((3 * 4) + 3) * 4 + 3] = 255
assert.deepEqual(alphaInputRegions(pixels, 4, 4, 40, 40), [{ x: 20, y: 0, width: 20, height: 20 }])
// Adjacent opaque pixels become one run, without claiming the whole window.
pixels[((3 * 4) + 2) * 4 + 3] = 255
assert.deepEqual(alphaInputRegions(pixels, 4, 4, 40, 40), [{ x: 10, y: 0, width: 30, height: 20 }])
console.log('Silhouette input region checks passed.')
