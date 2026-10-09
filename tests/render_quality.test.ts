import assert from 'node:assert/strict'
import { FramePacer } from '../app/src/frame-pacer'
import { applyPreset, DEFAULT_IDLE_FPS, DEFAULT_MAX_FPS, QUALITY_PRESETS, frameCap, normalizeIdleFps, RENDER_QUALITIES, normalizeQuality, normalizeQualitySettings, presetSettings, resolvePreset } from '../app/src/render-quality'

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
  // Idle cap: off by default, healed, and never above the active cap.
  assert.equal(DEFAULT_IDLE_FPS, 0)
  assert.equal(normalizeQualitySettings({ maxFps: 30 }).idleFps, 0, 'Old settings keep full-rate idle')
  assert.equal(normalizeQualitySettings({ idleFps: 15 }).idleFps, 15)
  assert.equal(normalizeIdleFps(1), 5)
  assert.equal(normalizeIdleFps('15'), 0)
  assert.equal(resolvePreset({ pixelRatioCap: 2, maxFps: 30, idleFps: 15, springBones: true }), 'high', 'Idle cap does not change the visual preset')
  assert.equal(frameCap({ maxFps: 30, idleFps: 15 }, false), 30, 'Active frames use the limit')
  assert.equal(frameCap({ maxFps: 30, idleFps: 15 }, true), 15)
  assert.equal(frameCap({ maxFps: 30, idleFps: 0 }, true), 30, 'Idle cap off')
  assert.equal(frameCap({ maxFps: 10, idleFps: 15 }, true), 10, 'Idle never raises the limit')
  assert.equal(frameCap({ maxFps: 0, idleFps: 15 }, true), 15, 'Uncapped still idles down')
  assert.equal(frameCap({ maxFps: 120, idleFps: 0 }, false, true), 30, 'Resize reserves graphics headroom')
  assert.equal(frameCap({ maxFps: 0, idleFps: 0 }, false, true), 30, 'Resize also bounds uncapped rendering')
  assert.equal(frameCap({ maxFps: 24, idleFps: 0 }, false, true), 24, 'Resize never raises a lower cap')
  assert.equal(frameCap({ maxFps: 120, idleFps: 10 }, true, true), 10, 'Resize respects the idle cap')
  assert.equal(frameCap({ maxFps: 120, idleFps: 0 }, false, false), 120, 'Normal limit returns after resizing')
  // v1 stored a bare preset string.
  assert.deepEqual(normalizeQualitySettings('ultra'), { ...QUALITY_PRESETS.ultra, preset: 'ultra', showFps: false, fpsPosition: 'top-left' })
  // Switching presets keeps frame-rate and diagnostic choices.
  const tuned = { ...presetSettings('high'), maxFps: 120, idleFps: 15, showFps: true }
  assert.deepEqual(applyPreset(tuned, 'low'), { ...tuned, pixelRatioCap: 1, preset: 'low' })
  assert.equal(normalizeQualitySettings({ showFps: true }).showFps, true)
  assert.equal(normalizeQualitySettings({ showFps: 'yes' }).showFps, false)
  assert.equal(normalizeQualitySettings({ fpsPosition: 'bottom-right' }).fpsPosition, 'bottom-right')
  assert.equal(normalizeQualitySettings({ fpsPosition: 'middle' }).fpsPosition, 'top-left')
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
