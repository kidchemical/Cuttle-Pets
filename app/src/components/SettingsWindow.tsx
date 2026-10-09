import { useEffect, useMemo, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@tauri-apps/api/core'
import { SettingsPanel } from './SettingsPanel'
import { loadSettings, saveSettings } from '../settings'
import { normalizeAnimations } from '../animation-settings'
import { normalizeBehaviorSettings } from '../behavior'
import { normalizePetSettings, normalizePropSettings } from '../companions'
import { DEFAULT_MUSIC, DEFAULT_FIT, normalizeMusic, normalizeFit, modelFitKey } from '../music-settings'
import { normalizeQualitySettings } from '../render-quality'
import { normalizeCursorLight, normalizeGlobalLighting } from '../lighting'
import { normalizeBubbleSettings } from '../bubble-settings'
import { petUrl } from '../config'
import { requestScreenshot, sendPetCommand, subscribeWindowEvent } from '../window-sync'

const previewMusic = (active: boolean) => sendPetCommand({ type: 'music-preview', active })
const previewBubble = () => sendPetCommand({ type: 'bubble-preview' })

function completeProfile(settings: Record<string, any>) {
  const modelPath = settings.modelPath || '/model1.vrm'
  const musicSettings = normalizeMusic(settings.musicSettings || DEFAULT_MUSIC)
  const headphoneFits = settings.headphoneFits && typeof settings.headphoneFits === 'object'
    ? Object.fromEntries(Object.entries(settings.headphoneFits).map(([key, fit]) => [modelFitKey(key), normalizeFit(fit as any)]))
    : { [modelFitKey(modelPath)]: normalizeFit(DEFAULT_FIT) }
  return {
    modelPath, ttsEnabled: settings.ttsEnabled ?? true, musicEnabled: settings.musicEnabled ?? true,
    musicSettings, headphoneFits, showText: settings.showText ?? true, hideUI: settings.hideUI ?? false,
    tracking: settings.tracking || 'mouse', gazeGain: settings.gazeGain ?? 2, volume: settings.volume ?? .5,
    uiAlign: settings.uiAlign || 'right', hideMood: settings.hideMood ?? false,
    currentDance: settings.currentDance || 'jile', customDancePreset: settings.customDancePreset ?? null,
    language: settings.language || (navigator.language.startsWith('zh') ? 'zh' : 'en'),
    pinned: settings.pinned ?? true, collapsed: settings.collapsed ?? false, panelWidth: settings.panelWidth ?? 400,
    quality: normalizeQualitySettings(settings.quality), bubbleSettings: normalizeBubbleSettings(settings.bubbleSettings),
    animationSettings: normalizeAnimations(settings.animationSettings),
    behaviorSettings: normalizeBehaviorSettings(settings.behaviorSettings, settings.musicSettings),
    petSettings: normalizePetSettings(settings.petSettings), propSettings: normalizePropSettings(settings.propSettings),
    lighting: normalizeGlobalLighting(settings.lighting), cursorLight: normalizeCursorLight(settings.cursorLight),
  }
}

/** Settings has its own webview; only the main window owns the pet and its effects. */
export function SettingsWindow() {
  useEffect(() => {
    const resizing = () => sendPetCommand({ type: 'settings-resizing' })
    window.addEventListener('resize', resizing)
    return () => window.removeEventListener('resize', resizing)
  }, [])
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    const changed: Record<string, any> = {}
    const stop = subscribeWindowEvent<Record<string, any>>('pet-preferences', patch => {
      Object.assign(changed, patch)
      setSettings(previous => ({ ...previous, ...patch }))
    })
    void loadSettings().then(async saved => {
      if (!active) return
      let next = { ...saved, ...changed }
      const behavior = normalizeBehaviorSettings(next.behaviorSettings, next.musicSettings)
      if (behavior.profiles.length) {
        try {
          const response = await fetch(petUrl('/settings-profiles'))
          if (!response.ok) throw new Error('Profile list unavailable')
          const existing = (await response.json()).profiles as { name: string; source?: string }[]
          for (const legacy of behavior.profiles) {
            const baseName = `Behavior — ${legacy.name}`
            if (existing.some(profile => profile.name === baseName && profile.source === 'behavior-migration')) continue
            let name = baseName
            let suffix = 2
            while (existing.some(profile => profile.name === name)) name = `${baseName} (${suffix++})`
            const snapshot = completeProfile({ ...next, behaviorSettings: { ...behavior, current: legacy, profiles: [] } })
            const result = await fetch(petUrl('/settings-profiles'), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, settings: snapshot, source: 'behavior-migration' }),
            })
            if (!result.ok) throw new Error('Behavior profile migration failed')
            existing.push({ name, source: 'behavior-migration' })
          }
          const migrated = { ...behavior, profiles: [] }
          next = { ...next, behaviorSettings: migrated }
          saveSettings({ behaviorSettings: migrated })
        } catch (error) {
          console.warn('Saved Behavior profiles will migrate when profile storage is available', error)
        }
      }
      next = { ...next, ...changed }
      if (active) { setSettings(next); setReady(true) }
    })
    const stopPreview = () => sendPetCommand({ type: 'music-preview', active: false })
    window.addEventListener('beforeunload', stopPreview)
    return () => { active = false; stop(); stopPreview(); window.removeEventListener('beforeunload', stopPreview) }
  }, [])
  const patch = (value: Record<string, any>) => {
    setSettings(previous => ({ ...previous, ...value }))
    saveSettings(value)
  }
  const loadProfile = (profile: Record<string, any>) => {
    const localUrls = (value: any): any => {
      if (typeof value === 'string' && /^\/(model|dance|audio|assets)\//.test(value)) return petUrl(value)
      if (Array.isArray(value)) return value.map(localUrls)
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key,
        key === 'headphoneFits' && child && typeof child === 'object'
          ? Object.fromEntries(Object.entries(child).map(([model, fit]) => [modelFitKey(model), fit]))
          : localUrls(child),
      ]))
    }
    const restored = localUrls(profile)
    if (restored.musicSettings) restored.musicSettings = normalizeMusic(restored.musicSettings)
    if (restored.headphoneFits && typeof restored.headphoneFits === 'object') {
      restored.headphoneFits = Object.fromEntries(Object.entries(restored.headphoneFits).map(([key, fit]) => [key, normalizeFit(fit as any)]))
    }
    if (restored.quality) restored.quality = normalizeQualitySettings(restored.quality)
    if (restored.bubbleSettings) restored.bubbleSettings = normalizeBubbleSettings(restored.bubbleSettings)
    if (restored.animationSettings) restored.animationSettings = normalizeAnimations(restored.animationSettings)
    if (restored.behaviorSettings) restored.behaviorSettings = normalizeBehaviorSettings(restored.behaviorSettings, restored.musicSettings)
    if (restored.petSettings !== undefined) restored.petSettings = normalizePetSettings(restored.petSettings)
    if (restored.propSettings !== undefined) restored.propSettings = normalizePropSettings(restored.propSettings)
    if (restored.lighting !== undefined) restored.lighting = normalizeGlobalLighting(restored.lighting)
    if (restored.cursorLight !== undefined) restored.cursorLight = normalizeCursorLight(restored.cursorLight)
    setSettings(previous => ({ ...previous, ...restored }))
    saveSettings(restored)
  }
  const modelPath = settings.modelPath || '/model1.vrm'
  // Preserve unrelated config identities while dragging a setting slider.
  const musicSettings = useMemo(() => normalizeMusic(settings.musicSettings || DEFAULT_MUSIC), [settings.musicSettings])
  const modelFit = settings.headphoneFits?.[modelFitKey(modelPath)]
  const headphoneFit = useMemo(() => normalizeFit(modelFit || DEFAULT_FIT), [modelFit])
  const qualitySettings = useMemo(() => normalizeQualitySettings(settings.quality), [settings.quality])
  const bubbleSettings = useMemo(() => normalizeBubbleSettings(settings.bubbleSettings), [settings.bubbleSettings])
  const animationSettings = useMemo(() => normalizeAnimations(settings.animationSettings), [settings.animationSettings])
  const behaviorSettings = useMemo(() => normalizeBehaviorSettings(settings.behaviorSettings, settings.musicSettings), [settings.behaviorSettings, settings.musicSettings])
  const petSettings = useMemo(() => normalizePetSettings(settings.petSettings), [settings.petSettings])
  const propSettings = useMemo(() => normalizePropSettings(settings.propSettings), [settings.propSettings])
  const lightingSettings = useMemo(() => normalizeGlobalLighting(settings.lighting), [settings.lighting])
  const cursorLightSettings = useMemo(() => normalizeCursorLight(settings.cursorLight), [settings.cursorLight])
  const profileSettings = completeProfile(settings)
  if (!ready) return <div style={{ background: '#1b1d25', color: 'white', height: '100vh', padding: 24 }}>Loading settings…</div>
  return <SettingsPanel
    standalone visible onClose={() => { sendPetCommand({ type: 'music-preview', active: false }); if (isTauri()) void getCurrentWindow().close(); else window.close() }}
    profileSettings={profileSettings} onLoadProfile={loadProfile}
    musicSettings={musicSettings}
    headphoneFit={headphoneFit}
    musicEnabled={settings.musicEnabled ?? true}
    onMusicEnabledChange={musicEnabled => patch({ musicEnabled })}
    onMusicSettingsChange={musicSettings => patch({ musicSettings: normalizeMusic(musicSettings) })}
    onHeadphoneFitChange={fit => patch({ headphoneFits: { ...settings.headphoneFits, [modelFitKey(modelPath)]: normalizeFit(fit) } })}
    onMusicPreview={previewMusic}
    currentModel={modelPath} onModelChange={modelPath => patch({ modelPath })}
    hideUI={settings.hideUI ?? false} onHideUIChange={hideUI => patch({ hideUI })}
    showText={settings.showText ?? true} onShowTextChange={showText => patch({ showText })}
    ttsEnabled={settings.ttsEnabled ?? true} onTtsEnabledChange={ttsEnabled => patch({ ttsEnabled })}
    tracking={settings.tracking || 'mouse'} onTrackingChange={tracking => patch({ tracking })}
    qualitySettings={qualitySettings} onQualitySettingsChange={quality => patch({ quality })}
    volume={settings.volume ?? .5} onVolumeChange={volume => patch({ volume })}
    uiAlign={settings.uiAlign || 'right'} onUiAlignChange={uiAlign => patch({ uiAlign })}
    hideMood={settings.hideMood ?? false} onHideMoodChange={hideMood => patch({ hideMood })}
    screenObserve={settings.screenObserve ?? false} onScreenObserveChange={screenObserve => patch({ screenObserve })}
    screenObserveInterval={settings.screenObserveInterval ?? 60} onScreenObserveIntervalChange={screenObserveInterval => patch({ screenObserveInterval })}
    captureVrmScreenshot={requestScreenshot} onBubblePreview={previewBubble}
    language={settings.language || (navigator.language.startsWith('zh') ? 'zh' : 'en')} onLanguageChange={language => patch({ language })}
    currentDance={settings.currentDance || 'jile'} onDanceChange={(currentDance, customDancePreset) => patch({ currentDance, customDancePreset })}
    bubbleSettings={bubbleSettings} onBubbleSettingsChange={bubbleSettings => patch({ bubbleSettings })}
    panelWidth={settings.panelWidth ?? 400} onPanelWidthChange={panelWidth => patch({ panelWidth })}
    pinned={settings.pinned ?? true} onPinnedChange={pinned => patch({ pinned })}
    animationSettings={animationSettings} onAnimationSettingsChange={animationSettings => patch({ animationSettings })}
    onAnimationPreview={(id, preset, mode, durationMs, source) => sendPetCommand({ type: 'animation', id, preset, mode, durationMs, source })}
    onAnimationStop={() => sendPetCommand({ type: 'stop' })}
    behaviorSettings={behaviorSettings} onBehaviorSettingsChange={behaviorSettings => patch({ behaviorSettings })}
    petSettings={petSettings} onPetSettingsChange={petSettings => patch({ petSettings })}
    propSettings={propSettings} onPropSettingsChange={propSettings => patch({ propSettings })}
    lightingSettings={lightingSettings} onLightingSettingsChange={lighting => patch({ lighting })}
    cursorLightSettings={cursorLightSettings} onCursorLightSettingsChange={cursorLight => patch({ cursorLight })}
  />
}
