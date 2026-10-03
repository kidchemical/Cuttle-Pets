import assert from 'node:assert/strict'
import { QUALITY_PRESETS, RENDER_QUALITIES, normalizeQuality, normalizeQualitySettings, presetSettings, resolvePreset } from '../app/src/render-quality'

async function main() {
  assert.deepEqual([...RENDER_QUALITIES], ['low', 'mid', 'high', 'ultra'])
  const order: Array<'low' | 'mid' | 'high' | 'ultra'> = ['low', 'mid', 'high', 'ultra']
  for (let i = 1; i < order.length; i++) {
    const prev = QUALITY_PRESETS[order[i - 1]]
    const next = QUALITY_PRESETS[order[i]]
    assert.ok(next.pixelRatioCap >= prev.pixelRatioCap, `${order[i]} must render at least as sharply as ${order[i - 1]}`)
    // maxFps 0 means uncapped, which is >= any cap.
    const prevFps = prev.maxFps === 0 ? Infinity : prev.maxFps
    const nextFps = next.maxFps === 0 ? Infinity : next.maxFps
    assert.ok(nextFps >= prevFps, `${order[i]} must allow at least as many fps as ${order[i - 1]}`)
  }
  for (const name of RENDER_QUALITIES) {
    // Spring bones default on in every preset: secondary motion (ear twitches)
    // must stay springy no matter the preset.
    assert.equal(QUALITY_PRESETS[name].springBones, true, `${name} preset keeps spring bones on`)
    assert.equal(resolvePreset(QUALITY_PRESETS[name]), name, `${name} preset resolves to itself`)
  }
  assert.equal(QUALITY_PRESETS.high.maxFps, 60)
  assert.equal(normalizeQuality('mid'), 'mid')
  assert.equal(normalizeQuality('potato'), 'high', 'unknown quality falls back to high')
  // Granular edits diverge to custom …
  assert.equal(resolvePreset({ ...QUALITY_PRESETS.low, maxFps: 120 }), 'custom', 'low + 120fps is custom')
  assert.equal(resolvePreset({ pixelRatioCap: 2, maxFps: 60, springBones: true }), 'high', 'high values resolve back to high')
  // … but persist and reload intact.
  const custom = normalizeQualitySettings({ pixelRatioCap: 1, maxFps: 120, springBones: true, preset: 'low' })
  assert.equal(custom.preset, 'custom')
  assert.equal(custom.maxFps, 120)
  // v1 stored a bare preset string.
  assert.deepEqual(normalizeQualitySettings('ultra'), { ...QUALITY_PRESETS.ultra, preset: 'ultra' })
  assert.equal(normalizeQualitySettings(undefined).preset, 'high')
  assert.equal(normalizeQualitySettings({ maxFps: -5 }).maxFps, QUALITY_PRESETS.high.maxFps, 'negative fps heals to default')
  console.log('Render quality passed: ordered presets, springs on everywhere, custom divergence, v1 migration.')
}
main().catch(e => { console.error(e); process.exit(1) })
