import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@tauri-apps/api/core'
import { SettingsPanel } from './SettingsPanel'
import { loadSettings, saveSettings } from '../settings'
import { normalizeAnimations } from '../animation-settings'
import { normalizeGazeGain } from '../cursor-gaze'
import { normalizeBehaviorSettings } from '../behavior'
import { normalizePetSettings, normalizePropSettings } from '../companions'
import { DEFAULT_MUSIC, DEFAULT_FIT, normalizeMusic, normalizeFit, modelFitKey } from '../music-settings'
import { normalizeQualitySettings } from '../render-quality'
import { normalizeBubbleSettings } from '../bubble-settings'
import { requestScreenshot, sendPetCommand, subscribeWindowEvent } from '../window-sync'

const previewMusic = (active: boolean) => sendPetCommand({ type: 'music-preview', active })
const previewBubble = () => sendPetCommand({ type: 'bubble-preview' })

/** Settings has its own webview; only the main window owns the pet and its effects. */
export function SettingsWindow() {
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    const changed: Record<string, any> = {}
    const stop = subscribeWindowEvent<Record<string, any>>('pet-preferences', patch => {
      Object.assign(changed, patch)
      setSettings(previous => ({ ...previous, ...patch }))
    })
    void loadSettings().then(saved => { if (active) { setSettings({ ...saved, ...changed }); setReady(true) } })
    const stopPreview = () => sendPetCommand({ type: 'music-preview', active: false })
    window.addEventListener('beforeunload', stopPreview)
    return () => { active = false; stop(); stopPreview(); window.removeEventListener('beforeunload', stopPreview) }
  }, [])
  const patch = (value: Record<string, any>) => {
    setSettings(previous => ({ ...previous, ...value }))
    saveSettings(value)
  }
  const modelPath = settings.modelPath || '/model1.vrm'
  if (!ready) return <div style={{ background: '#1b1d25', color: 'white', height: '100vh', padding: 24 }}>Loading settings…</div>
  return <SettingsPanel
    standalone visible onClose={() => { sendPetCommand({ type: 'music-preview', active: false }); if (isTauri()) void getCurrentWindow().close(); else window.close() }}
    musicSettings={normalizeMusic(settings.musicSettings || DEFAULT_MUSIC)}
    headphoneFit={normalizeFit(settings.headphoneFits?.[modelFitKey(modelPath)] || DEFAULT_FIT)}
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
    gazeGain={normalizeGazeGain(settings.gazeGain)} onGazeGainChange={gazeGain => patch({ gazeGain })}
    qualitySettings={normalizeQualitySettings(settings.quality)} onQualitySettingsChange={quality => patch({ quality })}
    volume={settings.volume ?? .5} onVolumeChange={volume => patch({ volume })}
    uiAlign={settings.uiAlign || 'right'} onUiAlignChange={uiAlign => patch({ uiAlign })}
    hideMood={settings.hideMood ?? false} onHideMoodChange={hideMood => patch({ hideMood })}
    screenObserve={settings.screenObserve ?? false} onScreenObserveChange={screenObserve => patch({ screenObserve })}
    screenObserveInterval={settings.screenObserveInterval ?? 60} onScreenObserveIntervalChange={screenObserveInterval => patch({ screenObserveInterval })}
    captureVrmScreenshot={requestScreenshot} onBubblePreview={previewBubble}
    language={settings.language || (navigator.language.startsWith('zh') ? 'zh' : 'en')} onLanguageChange={language => patch({ language })}
    currentDance={settings.currentDance || 'jile'} onDanceChange={(currentDance, customDancePreset) => patch({ currentDance, customDancePreset })}
    bubbleSettings={normalizeBubbleSettings(settings.bubbleSettings)} onBubbleSettingsChange={bubbleSettings => patch({ bubbleSettings })}
    panelWidth={settings.panelWidth ?? 400} onPanelWidthChange={panelWidth => patch({ panelWidth })}
    pinned={settings.pinned ?? true} onPinnedChange={pinned => patch({ pinned })}
    animationSettings={normalizeAnimations(settings.animationSettings)} onAnimationSettingsChange={animationSettings => patch({ animationSettings })}
    onAnimationPreview={(id, preset, mode, durationMs, source) => sendPetCommand({ type: 'animation', id, preset, mode, durationMs, source })}
    onAnimationStop={() => sendPetCommand({ type: 'stop' })}
    behaviorSettings={normalizeBehaviorSettings(settings.behaviorSettings, settings.musicSettings)} onBehaviorSettingsChange={behaviorSettings => patch({ behaviorSettings })}
    petSettings={normalizePetSettings(settings.petSettings)} onPetSettingsChange={petSettings => patch({ petSettings })}
    propSettings={normalizePropSettings(settings.propSettings)} onPropSettingsChange={propSettings => patch({ propSettings })}
  />
}
