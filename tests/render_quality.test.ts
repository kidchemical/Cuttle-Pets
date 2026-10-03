import assert from 'node:assert/strict'
import { FramePacer } from '../app/src/frame-pacer'
import { DEFAULT_MAX_FPS, QUALITY_PRESETS, RENDER_QUALITIES, normalizeQuality, normalizeQualitySettings, presetSettings, resolvePreset } from '../app/src/render-quality'

async function main() {
  assert.deepEqual([...RENDER_QUALITIES], ['low', 'mid', 'high', 'ultra'])
  assert.equal(DEFAULT_MAX_FPS, 30, 'default cap remains 30fps')
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
    assert.equal(QUALITY_PRESETS[name].maxFps, 30, 'Visual presets keep the default frame rate')
  }
  assert.equal(normalizeQuality('mid'), 'mid')
  assert.equal(normalizeQuality('potato'), 'high', 'unknown quality falls back to high')
  // Granular edits diverge to custom …
  assert.equal(resolvePreset({ pixelRatioCap: 0.5, maxFps: 60, springBones: true }), 'custom', 'off-preset scale is custom')
  assert.equal(resolvePreset({ pixelRatioCap: 2, maxFps: 60, springBones: true }), 'high', 'high values resolve back to high')
  // … but persist and reload intact.
  const custom = normalizeQualitySettings({ pixelRatioCap: 1, springBones: false, preset: 'low' })
  assert.equal(custom.preset, 'custom')
  assert.equal(custom.pixelRatioCap, 1)
  assert.equal(custom.springBones, false)
  // Legacy saved settings keep their frame-rate choice.
  const legacy = normalizeQualitySettings({ pixelRatioCap: 2, maxFps: 120, springBones: true })
  assert.equal(legacy.preset, 'high')
  assert.equal(legacy.maxFps, 120)
  assert.equal(normalizeQualitySettings({ maxFps: 0 }).maxFps, 0)
  assert.equal(normalizeQualitySettings({ maxFps: NaN }).maxFps, 30)
  assert.equal(normalizeQualitySettings({ maxFps: -5 }).maxFps, 30)
  // v1 stored a bare preset string.
  assert.deepEqual(normalizeQualitySettings('ultra'), { ...QUALITY_PRESETS.ultra, preset: 'ultra' })
  assert.equal(normalizeQualitySettings(undefined).preset, 'high')
  const pacer = new FramePacer()
  let frames = 0
  for (let i = 0; i < 1440; i++) if (pacer.shouldRender(i * 1000 / 144, 90)) frames++
  assert.ok(Math.abs(frames - 900) <= 1, '90 FPS on a 144 Hz display does not collapse to 72 FPS')
  assert.equal(pacer.shouldRender(10001, 0), true, 'Uncapped immediately renders')
  assert.equal(pacer.shouldRender(10002, 30), true, 'Changing caps resets pacing immediately')
  assert.equal(pacer.shouldRender(10003, 30), false)
  console.log('Render quality passed: independent FPS, ordered presets, springs on everywhere, custom divergence, v1 + maxFps migration.')
}
main().catch(e => { console.error(e); process.exit(1) })
