import assert from 'node:assert/strict'
import { DEFAULT_MAX_FPS, QUALITY_PRESETS, RENDER_QUALITIES, normalizeQuality, normalizeQualitySettings, presetSettings, resolvePreset } from '../app/src/render-quality'

async function main() {
  assert.deepEqual([...RENDER_QUALITIES], ['low', 'mid', 'high', 'ultra'])
  assert.equal(DEFAULT_MAX_FPS, 30, 'renderer runs at a fixed 30fps')
  const order: Array<'low' | 'mid' | 'high' | 'ultra'> = ['low', 'mid', 'high', 'ultra']
  for (let i = 1; i < order.length; i++) {
    const prev = QUALITY_PRESETS[order[i - 1]]
    const next = QUALITY_PRESETS[order[i]]
    assert.ok(next.pixelRatioCap >= prev.pixelRatioCap, `${order[i]} must render at least as sharply as ${order[i - 1]}`)
  }
  for (const name of RENDER_QUALITIES) {
    // Spring bones default on in every preset: secondary motion (ear twitches)
    // must stay springy no matter the preset.
    assert.equal(QUALITY_PRESETS[name].springBones, true, `${name} preset keeps spring bones on`)
    assert.equal(resolvePreset(QUALITY_PRESETS[name]), name, `${name} preset resolves to itself`)
    assert.ok(!('maxFps' in QUALITY_PRESETS[name]), `${name} preset must not carry a frame-rate cap`)
  }
  assert.equal(normalizeQuality('mid'), 'mid')
  assert.equal(normalizeQuality('potato'), 'high', 'unknown quality falls back to high')
  // Granular edits diverge to custom …
  assert.equal(resolvePreset({ pixelRatioCap: 0.5, springBones: true }), 'custom', 'off-preset scale is custom')
  assert.equal(resolvePreset({ pixelRatioCap: 2, springBones: true }), 'high', 'high values resolve back to high')
  // … but persist and reload intact.
  const custom = normalizeQualitySettings({ pixelRatioCap: 1, springBones: false, preset: 'low' })
  assert.equal(custom.preset, 'custom')
  assert.equal(custom.pixelRatioCap, 1)
  assert.equal(custom.springBones, false)
  // Legacy saved settings may carry maxFps; it is ignored, never applied.
  const legacy = normalizeQualitySettings({ pixelRatioCap: 2, maxFps: 120, springBones: true })
  assert.equal(legacy.preset, 'high')
  assert.ok(!('maxFps' in legacy), 'legacy maxFps is dropped')
  // v1 stored a bare preset string.
  assert.deepEqual(normalizeQualitySettings('ultra'), { ...QUALITY_PRESETS.ultra, preset: 'ultra' })
  assert.equal(normalizeQualitySettings(undefined).preset, 'high')
  console.log('Render quality passed: fixed 30fps, ordered presets, springs on everywhere, custom divergence, v1 + maxFps migration.')
}
main().catch(e => { console.error(e); process.exit(1) })
