import { DEFAULT_MUSIC, DEFAULT_FIT, normalizeMusic, normalizeFit, modelFitKey, type MusicSettings, type HeadphoneFit } from './music-settings'
import { loadSettings, saveSettings } from './settings'
import { petUrl } from './config'
import { useEffect, useRef, useState, useCallback } from 'react'
import { VRMScene } from './components/VRMScene'
import type { VRMSceneHandle, TouchRegion } from './components/VRMScene'
import { normalizeQuality, normalizeQualitySettings, presetSettings, type QualitySettings } from './render-quality'
import { DEFAULT_BUBBLE_SETTINGS, normalizeBubbleSettings, type BubbleSettings } from './bubble-settings'
import { TextBubble } from './components/TextBubble'
import type { OnVrmMessage } from './components/TextBubble'
import { ChatInput } from './components/ChatInput'
import { ResizeHandles } from './components/ResizeHandles'
import { openSettingsWindow, subscribeWindowEvent, replyScreenshot, publishStatus, type PetCommand } from './window-sync'
import { DEFAULT_ANIMATIONS, normalizeAnimations, type AnimationSettings } from './animation-settings'
import { normalizeBehaviorSettings, resolvePetState, playOnceById, applyBaseById, type BehaviorSettings, type BehaviorStateId } from './behavior'
import { useBehaviorEngine } from './hooks/useBehaviorEngine'
import { usePassThrough } from './hooks/usePassThrough'
import { dancePresets, actionPresets } from './motion-controller'
import { LipSync } from './lip-sync'
import { bindScene } from './api'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { HistoryPanel } from './components/HistoryPanel'
import { MoodIndicator } from './components/MoodIndicator'
import { Menu, Pin, Move, RotateCcw, Rotate3D, EyeOff, Settings, Music, RefreshCw } from 'lucide-react'

const DEFAULT_MODEL = '/model1.vrm'

// Module-level to survive any component remount
let lastTouchMemoTime = 0
const TOUCH_MEMO_COOLDOWN = 3_000
let lastTouchChatTime = 0
const TOUCH_CHAT_COOLDOWN = 60_000

// 情绪 → 动作映射 (action names from motion-controller presets)
const emotionActionMap: Record<string, string> = {
  think: 'scratchHead',
  question: 'point',
  curious: 'scratchHead',
  happy: 'happy',
  surprised: 'excited',
  angry: 'angry',
  awkward: 'playFingers',
  sad: 'shy',
  love: 'shy',
  flirty: 'shy',
  greeting: 'greeting',
  relaxed: 'salute',
  neutral: 'salute',
}


const btnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(125, 125, 125, 0.28)',
  backdropFilter: 'blur(6px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 16,
  cursor: 'pointer',
}

export default function App() {
  const sceneRef = useRef<VRMSceneHandle>(null)
  const [musicEnabled, setMusicEnabled] = useState(true)
  const [musicSettings, setMusicSettings] = useState<MusicSettings>(DEFAULT_MUSIC)
  const [headphoneFits, setHeadphoneFits] = useState<Record<string, HeadphoneFit>>({})
  const musicEnabledRef = useRef(musicEnabled)
  musicEnabledRef.current = musicEnabled
  const [musicPlaying, setMusicPlaying] = useState(false)
  const musicPlayingRef = useRef(false)
  const workingRef = useRef(false)
  const [working, setWorkingState] = useState(false)
  const [behaviorSettings, setBehaviorSettings] = useState<BehaviorSettings>(() => normalizeBehaviorSettings(undefined))
  const behaviorEnabledRef = useRef(true)
  behaviorEnabledRef.current = behaviorSettings.enabled
  const [petState, setPetState] = useState<BehaviorStateId>('idle')
  const lastPublishedRef = useRef('')
  const [pinned, setPinned] = useState(true)
  const [tracking, setTracking] = useState<'mouse' | 'camera'>('mouse')
  const [qualitySettings, setQualitySettings] = useState<QualitySettings>(() => presetSettings('high'))
  const qualitySettingsRef = useRef(qualitySettings)
  qualitySettingsRef.current = qualitySettings
  const qualityPreset = qualitySettings.preset
  const [showText, setShowText] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [modelError, setModelError] = useState('')
  const [modelPath, setModelPath] = useState(DEFAULT_MODEL)
  const [animationSettings, setAnimationSettings] = useState<AnimationSettings>(DEFAULT_ANIMATIONS)
  const openSettings = useCallback(() => { void openSettingsWindow().catch(error => setModelError(String(error))) }, [])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [hideUI, setHideUI] = useState(false)
  const [volume, setVolume] = useState(0.5)
  const [uiAlign, setUiAlign] = useState<'left' | 'right'>('right')
  const [dancing, setDancing] = useState(false)
  const [currentDance, setCurrentDance] = useState('jile')
  const [customDancePreset, setCustomDancePreset] = useState<import('./motion-controller').DancePreset | undefined>(undefined)
  const [hideMood, setHideMood] = useState(false)
  const [screenObserve, setScreenObserve] = useState(false)
  const [screenObserveInterval, setScreenObserveInterval] = useState(60)
  const [language, setLanguage] = useState<'zh' | 'en'>(() => navigator.language.startsWith('zh') ? 'zh' : 'en')
  const [bubbleSettings, setBubbleSettings] = useState<BubbleSettings>({ ...DEFAULT_BUBBLE_SETTINGS })
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const [viewportHovered, setViewportHovered] = useState(false)
  // Hover is true only when the cursor is over the model or a button
  // (see usePassThrough), plus pointer enter/leave and window focus below.
  usePassThrough(!historyOpen, setViewportHovered)
  useEffect(() => {
    const onBlur = () => setViewportHovered(false)
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])
  const hoverControlsStyle = { visibility: viewportHovered ? 'visible' as const : 'hidden' as const }

  const applyPreferences = useCallback((s: Record<string, any>, initial = false) => {
    if (s.pinned !== undefined) { const pin = s.pinned; setPinned(pin); void getCurrentWindow().setAlwaysOnTop(pin); void invoke('set_pinned', { pinned: pin }).catch(() => {}) }
    if (s.collapsed !== undefined) setCollapsed(s.collapsed)
    if (s.modelPath) { setModelError(''); setModelPath(s.modelPath.startsWith('/model/') ? petUrl(s.modelPath) : s.modelPath); setDancing(false) }
    if (s.ttsEnabled !== undefined) setTtsEnabled(s.ttsEnabled)
    if (s.musicEnabled !== undefined) setMusicEnabled(s.musicEnabled)
    if (s.musicSettings) setMusicSettings(normalizeMusic(s.musicSettings))
    if (s.headphoneFits) setHeadphoneFits(s.headphoneFits)
    if (s.showText !== undefined) setShowText(s.showText)
    if (s.hideUI !== undefined) setHideUI(s.hideUI)
    if (s.tracking) { setTracking(s.tracking); sceneRef.current?.setTrackingMode(s.tracking) }
    if (s.quality !== undefined) setQualitySettings(normalizeQualitySettings(s.quality))
    if (s.volume !== undefined) { setVolume(s.volume); LipSync.getInstance().setVolume(s.volume); sceneRef.current?.setBgmVolume(s.volume) }
    if (s.uiAlign) setUiAlign(s.uiAlign)
    if (s.hideMood !== undefined) setHideMood(s.hideMood)
    if (s.screenObserve !== undefined) setScreenObserve(s.screenObserve)
    if (s.screenObserveInterval !== undefined) setScreenObserveInterval(s.screenObserveInterval)
    if (s.bubbleSettings) setBubbleSettings(normalizeBubbleSettings(s.bubbleSettings))
    if (s.currentDance) setCurrentDance(s.currentDance)
    if (s.customDancePreset !== undefined) setCustomDancePreset(s.customDancePreset || undefined)
    if (s.language) {
      setLanguage(s.language)
    } else if (initial) {
      // No saved language — persist the detected system language to backend
      const detected = navigator.language.startsWith('zh') ? 'zh' : 'en'
      saveSettings({ language: detected })
    }
    if (s.animationSettings) setAnimationSettings(normalizeAnimations(s.animationSettings))
    if (s.behaviorSettings) setBehaviorSettings(normalizeBehaviorSettings(s.behaviorSettings))
  }, [])
  useEffect(() => {
    let active = true
    const changed: Record<string, any> = {}
    const stop = subscribeWindowEvent<Record<string, any>>('pet-preferences', patch => { Object.assign(changed, patch); applyPreferences(patch) })
    void loadSettings().then(s => { if (active) applyPreferences({ ...s, ...changed }, true) })
    return () => { active = false; stop() }
  }, [applyPreferences])
  useEffect(() => subscribeWindowEvent<PetCommand>('pet-command', command => {
    if (command.type === 'animation') {
      const scene = sceneRef.current
      if (!scene) return
      scene.resetPose()
      if (command.id === 'idle') return
      if (command.mode === 'loop') applyBaseById(scene, command.id, command.preset)
      else playOnceById(scene, command.id, command.preset, 15000)
    }
    if (command.type === 'stop') { sceneRef.current?.resetPose(); setDancing(false) }
    if (command.type === 'music-preview') sceneRef.current?.setMusicPreview(command.active)
    if (command.type === 'bubble-preview') (window as any).__clawPreviewBubble?.('Hello! This is your text bubble preview.')
    if (command.type === 'screenshot') replyScreenshot(command.request, sceneRef.current?.captureScreenshot() ?? null)
  }), [])
  useEffect(() => {
    const unlisten = listen('open-settings', openSettings)
    return () => { void unlisten.then(f => f()) }
  }, [openSettings])

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const response = await fetch(petUrl('/model/list'))
        const data = await response.json()
        const models = [{ name: 'Default character', url: DEFAULT_MODEL }, ...(data.models || []).map((m: { name: string; url: string }) => ({ name: m.name, url: petUrl(m.url) }))]
        if (active) await invoke('update_tray_models', { models, selected: modelPath, musicEnabled, animations: Object.entries(actionPresets).map(([id, preset]) => ({ id, name: preset.label })), quality: qualityPreset })
      } catch (e) { console.warn('Tray model refresh failed', e) }
    }
    void refresh()
    const timer = window.setInterval(refresh, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [modelPath, musicEnabled, qualityPreset])

  useEffect(() => {
    const model = listen<string>('select-model', event => {
      setModelError(''); setModelPath(event.payload); setDancing(false)
      saveSettings({ modelPath: event.payload })
    })
    const animation = listen<string>('play-animation', event => {
      if (actionPresets[event.payload]) { setDancing(false); sceneRef.current?.playAnimationOnce(event.payload) }
    })
    const controls = listen<string>('tray-control', event => {
      if (event.payload === 'music') setMusicEnabled(value => { saveSettings({ musicEnabled: !value }); return !value })
      if (event.payload.startsWith('quality:')) {
        const qs = { ...presetSettings(normalizeQuality(event.payload.slice('quality:'.length))), maxFps: qualitySettingsRef.current.maxFps }
        setQualitySettings(qs)
        saveSettings({ quality: qs })
      }
      if (event.payload === 'text') setShowText(value => { saveSettings({ showText: !value }); return !value })
      if (event.payload === 'camera') sceneRef.current?.resetCamera()
      if (event.payload === 'pose') sceneRef.current?.resetPose()
    })
    return () => { model.then(f => f()); animation.then(f => f()); controls.then(f => f()) }
  }, [])

  useEffect(() => { musicPlayingRef.current = musicEnabled && musicPlaying; sceneRef.current?.setMusicMode(musicEnabled && musicPlaying) }, [musicEnabled, musicPlaying, modelPath])

  // Built-in sip scheduler runs only when the behavior engine is off; the
  // engine schedules sips itself from the working state's occasionals.
  useEffect(() => { sceneRef.current?.setAutoSip(!behaviorSettings.enabled) }, [behaviorSettings.enabled, modelPath])

  // Live status for the settings banner + behavior engine state, polled from
  // the scene so dances (any source) count as dancing.
  useEffect(() => {
    const timer = setInterval(() => {
      const playback = sceneRef.current?.getPlaybackStatus()
      if (!playback) return
      const state = resolvePetState({ dancing: playback.dancing, working, music: musicEnabled && musicPlaying })
      setPetState(previous => (previous === state ? previous : state))
      const key = JSON.stringify([state, playback.actionId, playback.danceId, playback.working, playback.sipping])
      if (key !== lastPublishedRef.current) {
        lastPublishedRef.current = key
        publishStatus({ state, actionId: playback.actionId, danceId: playback.danceId, working: playback.working, sipping: playback.sipping })
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [working, musicEnabled, musicPlaying])

  useBehaviorEngine({
    enabled: behaviorSettings.enabled,
    profile: behaviorSettings.current,
    state: petState,
    getScene: () => sceneRef.current,
  })

  useEffect(() => {
    bindScene(sceneRef.current)
    return () => bindScene(null)
  })

  const handleVrmMessage: OnVrmMessage = useCallback((msg) => {
    // Screensaver/lock suspend: full render suspend + window hide (see
    // VRMScene.setSuspended). document.hidden never fires under a fullscreen
    // saver, so this server-driven frame is the only reliable trigger.
    if (msg.suspended !== undefined) { sceneRef.current?.setSuspended(msg.suspended); return }
    if (msg.musicAudio) { sceneRef.current?.receiveMusicAudio(msg.musicAudio); return }
    if (msg.musicEnded) { if (musicEnabledRef.current) sceneRef.current?.celebrateMusicEnd(); return }
    if (msg.musicBeat) sceneRef.current?.receiveMusicBeat(msg.musicBeat)
    if (msg.musicPlaying !== undefined) {
      setMusicPlaying(msg.musicPlaying)
      return
    }
    if (msg.demoReset) sceneRef.current?.resetPose()
    if (msg.sipCoffee) sceneRef.current?.requestCoffeeSip()
    if (msg.working !== undefined) { workingRef.current = msg.working; setWorkingState(msg.working); sceneRef.current?.setWorking(msg.working) }
    if (msg.playAction) sceneRef.current?.playAction(msg.playAction, msg.hold ?? false)
    if (msg.emotion && sceneRef.current) {
      const action = emotionActionMap[msg.emotion]
      if (msg.text) {
        // 回复消息：表情和动作同时触发（文字出现1s后由TextBubble延迟调用）
        sceneRef.current.setEmotionWithReset(msg.emotion, msg.emotionDuration ?? 5000, msg.emotionIntensity)
        if (action && !msg.playAction && msg.working !== true) sceneRef.current.playAction(action)
      } else {
        // 思考阶段：hold 动作，10s 后自动 reset
        sceneRef.current.setEmotionWithReset(msg.emotion, msg.emotionDuration ?? 10000, msg.emotionIntensity)
        if (action && !msg.playAction && msg.working !== true) sceneRef.current.playAction(action, true)
      }
    }
  }, [])

  // ── Idle fidget: random emotion + action every ~60s when idle ──────────────
  const lastActivityRef = useRef(Date.now())
  // Reset idle timer whenever a VRM message arrives
  const originalHandleVrmMessage = handleVrmMessage
  const handleVrmMessageWithActivity: OnVrmMessage = useCallback((msg) => {
    if (!msg.activitySync && !msg.musicBeat && !msg.musicAudio && !msg.musicEnded && msg.musicPlaying === undefined && msg.suspended === undefined) lastActivityRef.current = Date.now()
    originalHandleVrmMessage(msg)
  }, [originalHandleVrmMessage])

  useEffect(() => {
    const allEmotions = [
      'happy', 'sad', 'angry', 'surprised', 'think', 'awkward',
      'question', 'curious', 'neutral', 'love', 'flirty', 'greeting', 'relaxed',
    ]
    const allActions = [
      'akimbo', 'playFingers', 'scratchHead', 'stretch',
      'happy', 'angry', 'greeting', 'excited', 'shy',
      'point', 'salute', 'angryPump',
      'waving', 'cheering', 'clapping', 'victory', 'praying',
      'defeated', 'joyfulJump', 'looking', 'pointing', 'breakdance',
      'sittingIdle', 'sittingTalk', 'talkingIdle', 'phoneCall',
    ]
    const IDLE_THRESHOLD_MS = 30_000
    const FIDGET_CHECK_MS = 15_000 // check every 15s, randomness inside

    const timer = setInterval(() => {
      // The behavior engine owns idle variety when enabled; this is the fallback.
      if (behaviorEnabledRef.current || workingRef.current || musicPlayingRef.current) return
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs < IDLE_THRESHOLD_MS) return
      // 50% chance each check to avoid being too predictable
      if (Math.random() > 0.5) return

      const emotion = allEmotions[Math.floor(Math.random() * allEmotions.length)]
      const action = allActions[Math.floor(Math.random() * allActions.length)]
      const intensity = 0.4 + Math.random() * 0.4 // 0.4–0.8
      sceneRef.current?.setEmotionWithReset(emotion, 3000 + Math.random() * 2000, intensity)
      sceneRef.current?.playAction(action)
      lastActivityRef.current = Date.now() // reset so we don't spam
    }, FIDGET_CHECK_MS)

    return () => clearInterval(timer)
  }, [])

  // ── Dancing mood boost: +1 every 30s ─────────
  useEffect(() => {
    if (!dancing) return
    const timer = setInterval(() => {
      fetch(petUrl("/mood/adjust"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: 1, max: 90 }),
      }).catch(() => {})
    }, 30_000)
    return () => clearInterval(timer)
  }, [dancing])

  // ── Screen observation: capture desktop & send to LLM periodically ─────────
  useEffect(() => {
    if (!screenObserve) return
    const intervalMs = screenObserveInterval * 1000

    const doObserve = () => {
      fetch(petUrl("/screen/observe"), { method: 'POST' })
        .catch(() => {})
    }

    const timer = setInterval(doObserve, intervalMs)
    // Also fire once immediately on enable
    doObserve()

    return () => clearInterval(timer)
  }, [screenObserve, screenObserveInterval])

  // Capture VRM screenshot and upload to server (debounced to avoid duplicates)
  const screenshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const uploadVrmScreenshot = useCallback(() => {
    if (screenshotTimer.current) clearTimeout(screenshotTimer.current)
    screenshotTimer.current = setTimeout(() => {
      screenshotTimer.current = null
      const dataUrl = sceneRef.current?.captureScreenshot()
      if (!dataUrl) return
      fetch(petUrl("/persona/screenshot"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      }).catch(() => {})
    }, 500)
  }, [])

  const clearContext = async () => {
    try {
      await fetch(petUrl("/context/clear"), { method: 'POST' })
    } catch { /* ignore */ }
  }

  // 全局快捷键: Tab 展开/折叠菜单
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Tab') {
        e.preventDefault()
        setCollapsed((v) => !v)
      }
      if (e.key === 'F4') {
        e.preventDefault()
        openSettings()
      }
      if (e.key === 'F5') {
        e.preventDefault()
        window.location.reload()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ── Touch interaction: immediate reaction + verbal response ──────────
  // Each region has multiple possible reactions, randomly selected (from lobe-vidol female defaults)
  const touchReactions: Record<TouchRegion, { emotion: string; action?: string }[]> = {
    head: [
      { emotion: 'relaxed', action: 'happy' },
      { emotion: 'relaxed', action: 'shy' },
      { emotion: 'relaxed', action: 'happy' },
      { emotion: 'relaxed', action: 'shy' },
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'relaxed', action: 'excited' },
    ],
    arm: [
      { emotion: 'surprised', action: 'excited' },
      { emotion: 'happy', action: 'happy' },
      { emotion: 'relaxed', action: 'greeting' },
      { emotion: 'relaxed', action: 'salute' },
      { emotion: 'relaxed', action: 'akimbo' },
    ],
    chest: [
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'angry', action: 'angry' },
      { emotion: 'angry', action: 'point' },
    ],
    belly: [
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'angry', action: 'angry' },
      { emotion: 'awkward', action: 'playFingers' },
      { emotion: 'angry', action: 'akimbo' },
    ],
    buttocks: [
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'angry', action: 'point' },
      { emotion: 'sad', action: 'shy' },
    ],
    leg: [
      { emotion: 'sad', action: 'shy' },
      { emotion: 'angry', action: 'angry' },
      { emotion: 'angry', action: 'point' },
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'awkward', action: 'playFingers' },
    ],
  }

  const regionLabels: Record<TouchRegion, string> = language === 'en'
    ? { head: 'head', arm: 'arm', chest: 'chest', belly: 'belly', buttocks: 'buttocks', leg: 'leg' }
    : { head: '头', arm: '手臂', chest: '胸', belly: '肚子', buttocks: '屁股', leg: '腿' }

  const handleTouch = useCallback((region: TouchRegion) => {
    const reactions = touchReactions[region]
    if (!reactions?.length) return
    const visual = reactions[Math.floor(Math.random() * reactions.length)]

    // Immediate visual feedback (always)
    lastActivityRef.current = Date.now()
    sceneRef.current?.setEmotionWithReset(visual.emotion, 3000, 0.8)
    if (visual.action) sceneRef.current?.playAction(visual.action)

    const now = Date.now()
    const prompt = language === 'en'
      ? `[The user touched your ${regionLabels[region]}]`
      : `[用户摸了摸你的${regionLabels[region]}]`

    // Always write to session history (3s cooldown)
    if (now - lastTouchMemoTime > TOUCH_MEMO_COOLDOWN) {
      lastTouchMemoTime = now
      fetch(petUrl("/session/memo"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prompt }),
      }).catch(() => {})
    }

    // Send to backend for verbal response (60s cooldown, 50% chance)
    if (now - lastTouchChatTime > TOUCH_CHAT_COOLDOWN && Math.random() < 0.5) {
      lastTouchChatTime = now
      fetch(petUrl("/touch"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, prompt }),
      }).catch(() => {})
    }
  }, [])

  const applyPinned = async (next: boolean) => {
    await getCurrentWindow().setAlwaysOnTop(next)
    setPinned(next)
    saveSettings({ pinned: next })
    void invoke('set_pinned', { pinned: next }).catch(() => {})
  }

  const togglePin = async () => {
    await applyPinned(!pinned)
  }

  return (
    <div
      onPointerEnter={() => { if (document.hasFocus()) setViewportHovered(true) }}
      onPointerLeave={() => setViewportHovered(false)}
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div style={hoverControlsStyle}><ResizeHandles /></div>
      {modelError && <div role="alert" data-no-passthrough style={{ position: 'absolute', top: 20, left: 16, right: 16, zIndex: 1000, background: '#402020', color: 'white', padding: 12, borderRadius: 8 }}>
        {modelError}<button onClick={() => { setModelError(''); setModelPath(DEFAULT_MODEL); saveSettings({ modelPath: DEFAULT_MODEL }) }}>Use default model</button>
      </div>}
      <VRMScene animationSettings={animationSettings} ref={sceneRef} musicSettings={musicSettings} headphoneFit={normalizeFit(headphoneFits[modelFitKey(modelPath)] || DEFAULT_FIT)} modelPath={modelPath} qualitySettings={qualitySettings} onTouch={handleTouch} onModelError={setModelError} onModelLoaded={() => { setModelError(''); sceneRef.current?.setTrackingMode(tracking); sceneRef.current?.setBgmVolume(volume); sceneRef.current?.setMusicMode(musicEnabled && musicPlaying); uploadVrmScreenshot() }} />
      <div style={hoverControlsStyle}>{!hideMood && <MoodIndicator uiAlign={uiAlign} />}</div>
      <TextBubble onMessage={handleVrmMessageWithActivity} enabled={showText} ttsEnabled={ttsEnabled} bubble={bubbleSettings} />
      <div style={hoverControlsStyle}>{!hideUI && <ChatInput uiAlign={uiAlign} onHistoryOpen={() => setHistoryOpen(true)} onNewSession={clearContext} language={language} />}</div>
      <HistoryPanel
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        language={language}
      />
      {!hideUI && <div
        style={{
          ...hoverControlsStyle,
          position: 'absolute',
          top: 8,
          ...(uiAlign === 'left' ? { left: 8 } : { right: 8 }),
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <button
          onClick={() => setCollapsed((v) => { saveSettings({ collapsed: !v }); return !v })}
          style={btnStyle}
          title={collapsed ? t('展开菜单 (Tab)', 'Expand Menu (Tab)') : t('折叠菜单 (Tab)', 'Collapse Menu (Tab)')}
        >
          <Menu size={16} />
        </button>
        {!collapsed && <>
          <button
            onClick={() => openSettings()}
            style={btnStyle}
            title={t('设置 (F4)', 'Settings (F4)')}
          >
            <Settings size={16} />
          </button>
          <button
            onClick={() => window.location.reload()}
            style={btnStyle}
            title={t('刷新 (F5)', 'Refresh (F5)')}
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => getCurrentWindow().hide()}
            style={btnStyle}
            title={t('隐藏窗口', 'Hide Window')}
          >
            <EyeOff size={16} />
          </button>
          <button
            onClick={togglePin}
            style={{ ...btnStyle, opacity: pinned ? 1 : 0.5 }}
            title={pinned ? t('取消置顶', 'Unpin') : t('置顶窗口', 'Pin to Top')}
          >
            <Pin size={16} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              ;(window as any).__clawDragging = true
              let lastX = e.clientX
              let lastY = e.clientY
              const onMove = (ev: MouseEvent) => {
                sceneRef.current?.panCamera(ev.clientX - lastX, ev.clientY - lastY)
                lastX = ev.clientX
                lastY = ev.clientY
              }
              const onUp = () => {
                ;(window as any).__clawDragging = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            style={{ ...btnStyle, cursor: 'grab' }}
            title={t('拖动移动人物位置', 'Drag to Move')}
          >
            <Move size={16} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              ;(window as any).__clawDragging = true
              let lastX = e.clientX
              let lastY = e.clientY
              const onMove = (ev: MouseEvent) => {
                sceneRef.current?.rotateCamera(ev.clientX - lastX, ev.clientY - lastY)
                lastX = ev.clientX
                lastY = ev.clientY
              }
              const onUp = () => {
                ;(window as any).__clawDragging = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            style={{ ...btnStyle, cursor: 'grab' }}
            title={t('拖动旋转视角', 'Drag to Rotate')}
          >
            <Rotate3D size={16} />
          </button>
          <button
            onClick={() => {
              if (dancing) {
                sceneRef.current?.reset()
                setDancing(false)
              } else {
                const label = currentDance.startsWith('custom:') && customDancePreset
                  ? customDancePreset.label
                  : dancePresets[currentDance]?.label ?? currentDance
                if (currentDance.startsWith('custom:') && customDancePreset) {
                  sceneRef.current?.playDance(customDancePreset, `dance:${currentDance}`)
                } else {
                  sceneRef.current?.playDance(currentDance)
                }
                setDancing(true)
                // Record dance event in session history (no LLM reply)
                fetch(petUrl("/session/memo"), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: `[用户邀请你跳了一支舞:${label}]` }),
                }).catch(() => {})
              }
            }}
            style={{
              ...btnStyle,
              ...(dancing ? { background: 'rgba(34, 197, 94, 0.6)' } : {}),
            }}
            title={dancing ? t('停止跳舞', 'Stop Dance') : t('跳舞', 'Dance')}
          >
            <Music size={16} />
          </button>
        </>}
      </div>}
    </div>
  )
}
