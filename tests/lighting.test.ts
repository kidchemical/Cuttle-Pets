import assert from 'node:assert/strict'
import {
  CURSOR_LIGHT_PRESETS,
  DEFAULT_CURSOR_LIGHT,
  DEFAULT_GLOBAL_LIGHTING,
  applyCursorLightPreset,
  cursorLightOffset,
  fireflyBlink,
  normalizeCursorLight,
  normalizeGlobalLighting,
} from '../app/src/lighting'

// Defaults must reproduce the previous static rig: ambient 0.6, key 1.2,
// fill 0.4, all white. The cursor light ships disabled.
assert.deepEqual(DEFAULT_GLOBAL_LIGHTING, {
  ambientColor: '#ffffff',
  ambientIntensity: 0.6,
  keyColor: '#ffffff',
  keyIntensity: 1.2,
  fillColor: '#ffffff',
  fillIntensity: 0.4,
})
assert.equal(DEFAULT_CURSOR_LIGHT.enabled, false)

// Every preset heals to a valid full settings object.
for (const [id, partial] of Object.entries(CURSOR_LIGHT_PRESETS)) {
  const applied = applyCursorLightPreset(DEFAULT_CURSOR_LIGHT, id as keyof typeof CURSOR_LIGHT_PRESETS)
  assert.equal(applied.preset, id)
  for (const [key, value] of Object.entries(partial)) {
    if (key === 'preset') continue
    assert.deepEqual(applied[key as keyof typeof applied], value, `${id}.${key}`)
  }
  assert.deepEqual(normalizeCursorLight(applied), applied, `${id} round-trips`)
}

// Preset application forces the light on through the panel's patch path.
const enabled = applyCursorLightPreset(
  { ...DEFAULT_CURSOR_LIGHT, enabled: true },
  'lightning',
)
assert.equal(enabled.enabled, true)
assert.equal(enabled.kind, 'spot')

// Garbage heals to safe ranges instead of throwing or leaking NaN.
const healedLight = normalizeCursorLight({
  enabled: 'yes',
  kind: 'laser',
  anchor: 'magnet',
  preset: 'disco',
  motion: 'teleport',
  color: 'red',
  intensity: NaN,
  distance: -5,
  decay: 9,
  angle: 500,
  penumbra: 7,
  followSpeed: 0,
  effectSpeed: Infinity,
  lightCount: 99,
  motionRadius: -1,
  motionSpeed: 0,
  glowSize: 5,
})
// Finite out-of-range values clamp to their bound; non-finite heal to default.
assert.deepEqual(healedLight, {
  ...DEFAULT_CURSOR_LIGHT,
  followSpeed: 1,
  distance: 0,
  decay: 4,
  angle: 90,
  penumbra: 1,
  lightCount: 6,
  motionRadius: 0,
  motionSpeed: 0.1,
  glowSize: 0.6,
})
const healedGlobal = normalizeGlobalLighting({
  ambientColor: 'white',
  ambientIntensity: -1,
  keyIntensity: 99,
  fillColor: '#00ff00',
})
assert.equal(healedGlobal.ambientColor, '#ffffff')
assert.equal(healedGlobal.ambientIntensity, 0)
assert.equal(healedGlobal.keyIntensity, 5)
assert.equal(healedGlobal.fillColor, '#00ff00')

// Unknown keys never survive; undefined heals to defaults.
assert.deepEqual(normalizeCursorLight(undefined), DEFAULT_CURSOR_LIGHT)
assert.deepEqual(normalizeGlobalLighting(undefined), DEFAULT_GLOBAL_LIGHTING)

// Fresh install: the cursor rig adds zero light — disabled, and no glow orb
// on any preset (orbs are opt-in via the size slider).
assert.equal(DEFAULT_CURSOR_LIGHT.enabled, false)
assert.equal(DEFAULT_CURSOR_LIGHT.glowSize, 0)
for (const id of Object.keys(CURSOR_LIGHT_PRESETS) as (keyof typeof CURSOR_LIGHT_PRESETS)[]) {
  const applied = applyCursorLightPreset(DEFAULT_CURSOR_LIGHT, id)
  assert.equal(applied.enabled, false, `${id} stays off`)
  assert.equal(applied.glowSize, 0, `${id} has no orb`)
}

// Fireflies preset is a ready-made wandering swarm.
const fireflies = applyCursorLightPreset(DEFAULT_CURSOR_LIGHT, 'fireflies')
assert.equal(fireflies.motion, 'fireflies')
assert.equal(fireflies.lightCount, 5)

// Motion offsets: still is exactly zero; every other mode moves and spreads
// rig lights apart (even phase offsets around the anchor).
for (const motion of ['bob', 'orbit', 'swirl', 'fireflies'] as const) {
  const offsets = [0, 1, 2].map(i => cursorLightOffset(motion, i, 3, 0.35, 1, 10))
  for (const [x, y, z] of offsets) {
    assert.ok([x, y, z].every(Number.isFinite), `${motion} offsets stay finite`)
    assert.ok(Math.abs(x) <= 0.35 && Math.abs(y) <= 0.35 && Math.abs(z) <= 0.35, `${motion} stays within radius`)
  }
  const distinct = new Set(offsets.map(o => o.map(v => v.toFixed(4)).join(',')))
  assert.ok(distinct.size > 1, `${motion} spreads lights apart`)
}
assert.deepEqual(cursorLightOffset('still', 1, 3, 0.35, 1, 10), [0, 0, 0])
// Orbit keeps every light on its radius ring in the XZ plane.
for (const i of [0, 1, 2, 3]) {
  const [x, , z] = cursorLightOffset('orbit', i, 4, 0.5, 1, 7)
  assert.ok(Math.abs(Math.hypot(x, z) - 0.5) < 1e-9, 'orbit holds the ring radius')
}
// Firefly blink stays in its 0.35–1 band and varies per light.
for (const i of [0, 1, 2]) {
  const b = fireflyBlink(10, 1, i)
  assert.ok(b >= 0.35 && b <= 1, 'blink stays in band')
}
assert.notEqual(fireflyBlink(10, 1, 0).toFixed(4), fireflyBlink(10, 1, 1).toFixed(4))

console.log('Lighting passed: defaults, presets, motions, and invalid-value healing.')
