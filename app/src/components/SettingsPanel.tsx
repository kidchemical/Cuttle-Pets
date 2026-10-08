import { useFileDrop, singleModelPath } from '../hooks/useFileDrop'
import { FileDropHint } from './FileDropHint'
import { labelStyle, sectionStyle, selectStyle } from './settings-styles'
import './settings.css'
import { normalizeCustomDances } from '../custom-dances'
import { AnimationSettingsPanel } from './AnimationSettingsPanel'
import type { AnimationSettings } from '../animation-settings'
import { MAX_GAZE_GAIN, normalizeGazeGain } from '../cursor-gaze'
import { MusicSettingsPanel } from './MusicSettingsPanel'
import type { MusicSettings, HeadphoneFit } from '../music-settings'
import { CuttleConnection } from './CuttleConnection'
import { petUrl } from '../config'
import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Play, Loader, Sparkles, Trash2, Upload, Music, Github } from 'lucide-react'
import { BehaviorPanel } from './BehaviorPanel'
import { PetsPanel } from './PetsPanel'
import { PropsPanel } from './PropsPanel'
import type { CompanionAction, PetSettings, PropSettings } from '../companions'
import { VersionChip, VersionFooter, openExternal } from './VersionFooter'
import { APP_REPO_URL } from '../version'
import { describeStatus, type BehaviorEntryLocation, type BehaviorSettings, type BehaviorStateId } from '../behavior'
import { getLastPetStatus, sendPetCommand, subscribeWindowEvent, type PetStatusPayload } from '../window-sync'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri, invoke } from '@tauri-apps/api/core'
import type { DancePreset } from '../motion-controller'
import { RENDER_QUALITIES, presetSettings, resolvePreset, type QualityDetails, type QualitySettings } from '../render-quality'
import { BUBBLE_PREVIEW_TEXT, DEFAULT_BUBBLE_SETTINGS, FONT_CHOICES, type BubbleSettings } from '../bubble-settings'
import { CURSOR_LIGHT_MOTIONS, CURSOR_LIGHT_PRESET_IDS, DEFAULT_CURSOR_LIGHT, DEFAULT_GLOBAL_LIGHTING, applyCursorLightPreset, normalizeCursorLight, normalizeGlobalLighting, type CursorLightMotion, type CursorLightPreset, type CursorLightSettings, type GlobalLightingSettings } from '../lighting'

interface DanceItem {
  id: string
  label: string
  vmdUrl: string
  bgmUrl?: string
  type: 'vmd' | 'vrma' | 'fbx'
  builtin?: boolean
}

interface SettingsPanelProps {
  standalone?: boolean
  animationSettings: AnimationSettings
  onAnimationSettingsChange: (value: AnimationSettings) => void
  onAnimationPreview?: (id: string, preset?: DancePreset, mode?: 'once' | 'loop', durationMs?: number, source?: BehaviorEntryLocation) => void
  onAnimationStop?: () => void
  onBubblePreview?: () => void
  musicSettings: MusicSettings
  headphoneFit: HeadphoneFit
  musicEnabled: boolean
  onMusicEnabledChange: (v: boolean) => void
  onMusicSettingsChange: (v: MusicSettings) => void
  onHeadphoneFitChange: (v: HeadphoneFit) => void
  onMusicPreview: (v: boolean) => void
  visible: boolean
  onClose: () => void
  currentModel: string
  onModelChange: (path: string) => void
  hideUI: boolean
  onHideUIChange: (v: boolean) => void
  showText: boolean
  onShowTextChange: (v: boolean) => void
  ttsEnabled: boolean
  onTtsEnabledChange: (v: boolean) => void
  tracking: 'mouse' | 'camera'
  onTrackingChange: (v: 'mouse' | 'camera') => void
  gazeGain: number
  onGazeGainChange: (v: number) => void
  qualitySettings: QualitySettings
  onQualitySettingsChange: (v: QualitySettings) => void
  volume: number
  onVolumeChange: (v: number) => void
  uiAlign: 'left' | 'right'
  onUiAlignChange: (v: 'left' | 'right') => void
  hideMood: boolean
  onHideMoodChange: (v: boolean) => void
  screenObserve: boolean
  onScreenObserveChange: (v: boolean) => void
  screenObserveInterval: number
  onScreenObserveIntervalChange: (v: number) => void
  /** Return a data URL screenshot of the current VRM canvas */
  captureVrmScreenshot?: () => string | null | Promise<string | null>
  language: 'zh' | 'en'
  onLanguageChange: (v: 'zh' | 'en') => void
  currentDance: string
  onDanceChange: (id: string, preset?: DancePreset) => void
  bubbleSettings: BubbleSettings
  onBubbleSettingsChange: (v: BubbleSettings) => void
  panelWidth: number
  onPanelWidthChange: (v: number) => void
  pinned: boolean
  onPinnedChange: (v: boolean) => void
  behaviorSettings: BehaviorSettings
  onBehaviorSettingsChange: (v: BehaviorSettings) => void
  petSettings: PetSettings
  onPetSettingsChange: (v: PetSettings) => void
  propSettings: PropSettings
  onPropSettingsChange: (v: PropSettings) => void
  lightingSettings: GlobalLightingSettings
  onLightingSettingsChange: (v: GlobalLightingSettings) => void
  cursorLightSettings: CursorLightSettings
  onCursorLightSettingsChange: (v: CursorLightSettings) => void
}

type Tab = 'animations' | 'behavior' | 'music' | 'cuttle' | 'general' | 'voice' | 'model' | 'persona' | 'quality' | 'display' | 'lighting' | 'pets' | 'props'

const BUILTIN_MODELS = ['/model1.vrm', '/model2.vrm', '/model3.vrm', '/model4.vrm', '/model5.vrm']

const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 (女)' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓依 (女)' },
  { id: 'zh-CN-YunxiNeural', label: '云希 (男)' },
  { id: 'zh-CN-YunjianNeural', label: '云健 (男)' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵 (女)' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨 (女)' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱 (女)' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 (男)' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 (女)' },
  { id: 'ja-JP-NanamiNeural', label: 'Nanami (女)' },
  { id: 'en-US-MichelleNeural', label: 'Michelle (F)' },
  { id: 'en-US-GuyNeural', label: 'Guy (M)' },
]

const QWEN_VOICES = [
  { id: 'Cherry', label: '芊悦 - 阳光亲切 (女)' },
  { id: 'Serena', label: '苏瑶 - 温柔 (女)' },
  { id: 'Ethan', label: '晨煦 - 阳光温暖 (男)' },
  { id: 'Chelsie', label: '千雪 - 二次元 (女)' },
  { id: 'Momo', label: '茉兔 - 撒娇搞怪 (女)' },
  { id: 'Vivian', label: '十三 - 可爱小暴躁 (女)' },
  { id: 'Moon', label: '月白 - 率性帅气 (男)' },
  { id: 'Maia', label: '四月 - 知性温柔 (女)' },
  { id: 'Kai', label: '凯 - 耳朵SPA (男)' },
  { id: 'Nofish', label: '不吃鱼 - 设计师 (男)' },
  { id: 'Bella', label: '萌宝 - 小萝莉 (女)' },
  { id: 'Mia', label: '乖小妹 - 温顺乖巧 (女)' },
  { id: 'Mochi', label: '沙小弥 - 童真小大人 (男)' },
  { id: 'Bunny', label: '萌小姬 - 萌属性 (女)' },
  { id: 'Nini', label: '邻家妹妹 - 软糯甜蜜 (女)' },
  { id: 'Stella', label: '少女阿月 - 迷糊少女 (女)' },
  { id: 'Pip', label: '顽屁小孩 - 调皮捣蛋 (男)' },
  { id: 'Neil', label: '阿闻 - 新闻主持 (男)' },
  { id: 'Eldric Sage', label: '沧明子 - 沉稳老者 (男)' },
  { id: 'Vincent', label: '田叔 - 沙哑烟嗓 (男)' },
  { id: 'Bellona', label: '燕铮莺 - 有声书 (女)' },
  { id: 'Seren', label: '小婉 - 温柔助眠 (女)' },
]

const QWEN_MODELS = [
  { id: 'qwen3-tts-flash', label: 'Qwen3 TTS Flash' },
]

export function SettingsPanel({
  standalone = false, animationSettings, onAnimationSettingsChange, onAnimationPreview, onAnimationStop, onBubblePreview,
  musicSettings, headphoneFit, musicEnabled, onMusicEnabledChange, onMusicSettingsChange, onHeadphoneFitChange, onMusicPreview,
  visible, onClose, currentModel, onModelChange,
  hideUI, onHideUIChange,
  showText, onShowTextChange,
  ttsEnabled, onTtsEnabledChange,
  tracking, onTrackingChange,
  gazeGain, onGazeGainChange,
  qualitySettings, onQualitySettingsChange,
  volume, onVolumeChange,
  uiAlign, onUiAlignChange,
  hideMood, onHideMoodChange,
  screenObserve, onScreenObserveChange,
  screenObserveInterval, onScreenObserveIntervalChange,
  captureVrmScreenshot,
  language, onLanguageChange,
  currentDance, onDanceChange,
  bubbleSettings, onBubbleSettingsChange,
  panelWidth, onPanelWidthChange,
  pinned, onPinnedChange,
  behaviorSettings, onBehaviorSettingsChange,
  petSettings, onPetSettingsChange,
  propSettings, onPropSettingsChange,
  lightingSettings, onLightingSettingsChange,
  cursorLightSettings, onCursorLightSettingsChange,
}: SettingsPanelProps) {
  const testCompanion = (action: CompanionAction) => sendPetCommand({ type: 'companion', action })
  const t = (zh: string, en: string) => language === 'en' ? en : zh

  const [tab, setTab] = useState<Tab>('general')
  const [musicPreview, setMusicPreview] = useState(false)
  const handlePreview = useCallback((v: boolean) => { setMusicPreview(v); onMusicPreview(v) }, [onMusicPreview])
  const updateQualityDetails = useCallback((patch: Partial<QualityDetails>) => {
    const details: QualityDetails = {
      pixelRatioCap: qualitySettings.pixelRatioCap,
      maxFps: qualitySettings.maxFps,
      springBones: qualitySettings.springBones,
      ...patch,
    }
    onQualitySettingsChange({ ...details, preset: resolvePreset(details) })
  }, [qualitySettings, onQualitySettingsChange])
  const presetLabel = (q: string) => q === 'mid' ? t('中', 'Mid') : q === 'low' ? t('低', 'Low') : q === 'high' ? t('高', 'High') : q === 'ultra' ? t('超高', 'Ultra') : t('自定义', 'Custom')
  const cursorPresetLabel = (p: CursorLightPreset) => p === 'white' ? t('白光', 'White') : p === 'soft' ? t('柔光', 'Soft') : p === 'colored' ? t('彩色', 'Colored') : p === 'rgb' ? 'RGB' : p === 'flame' ? t('火焰', 'Flame') : p === 'lightning' ? t('闪电', 'Lightning') : t('萤火虫', 'Fireflies')
  const cursorMotionLabel = (m: CursorLightMotion) => m === 'still' ? t('静止', 'Still') : m === 'bob' ? t('浮动', 'Bob') : m === 'orbit' ? t('环绕', 'Orbit') : m === 'swirl' ? t('旋转', 'Swirl') : t('萤火虫', 'Fireflies')
  const setCursorLight = useCallback((patch: Partial<CursorLightSettings>) => {
    onCursorLightSettingsChange(normalizeCursorLight({ ...cursorLightSettings, ...patch }))
  }, [cursorLightSettings, onCursorLightSettingsChange])
  const setGlobalLighting = useCallback((patch: Partial<GlobalLightingSettings>) => {
    onLightingSettingsChange(normalizeGlobalLighting({ ...lightingSettings, ...patch }))
  }, [lightingSettings, onLightingSettingsChange])
  const [modelImportError, setModelImportError] = useState('')
  const [models, setModels] = useState<{ name: string; url: string }[]>([])
  const [soulContent, setSoulContent] = useState('')
  const [identityContent, setIdentityContent] = useState('')
  const [personaDirty, setPersonaDirty] = useState(false)
  const [personaSaving, setPersonaSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [currentVoice, setCurrentVoice] = useState('')
  const [currentProvider, setCurrentProvider] = useState<string>('edge')
  const [qwenKey, setQwenKey] = useState('')
  const [qwenModel, setQwenModel] = useState('qwen3-tts-flash')
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [customDances, setCustomDances] = useState<DanceItem[]>([])
  const [importingDance, setImportingDance] = useState(false)
  const [danceImportError, setDanceImportError] = useState('')
  const [importingModel, setImportingModel] = useState(false)
  const importBusy = useRef(false)
  const [petStatus, setPetStatus] = useState<PetStatusPayload | null>(getLastPetStatus)
  useEffect(() => {
    if (!visible) return
    return subscribeWindowEvent<PetStatusPayload>('pet-status', payload => {
      setPetStatus(previous => JSON.stringify(previous) === JSON.stringify(payload) ? previous : payload)
    }, () => sendPetCommand({ type: 'status' }))
  }, [visible])
  const petStatusText = petStatus
    ? describeStatus({
      state: (['idle', 'working', 'music', 'dancing'] as string[]).includes(petStatus.state) ? petStatus.state as BehaviorStateId : 'idle',
      actionId: petStatus.actionId, danceId: petStatus.danceId, working: petStatus.working, sipping: petStatus.sipping,
    }, customDances, language)
    : 'Connecting to pet…'


  // Drag state
  const [panelPos, setPanelPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; origX: number; origY: number }>({
    dragging: false, startX: 0, startY: 0, origX: 0, origY: 0,
  })

  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: panelPos.x, origY: panelPos.y }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current.dragging) return
      setPanelPos({
        x: dragRef.current.origX + ev.clientX - dragRef.current.startX,
        y: dragRef.current.origY + ev.clientY - dragRef.current.startY,
      })
    }
    const onUp = () => {
      dragRef.current.dragging = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [panelPos])

  // Reset position when panel opens
  useEffect(() => {
    if (visible) setPanelPos({ x: 0, y: 0 })
  }, [visible])

  // Force disable pass-through when the embedded overlay panel is visible.
  // The standalone settings window is a separate ordinary window: it has no
  // click-through to fight, so skip the 5Hz native IPC loop entirely.
  useEffect(() => {
    if (!visible || standalone || !isTauri()) return
    const win = getCurrentWindow()
    win.setIgnoreCursorEvents(false)
    // Keep forcing it in case of race conditions with cursor monitor
    const interval = setInterval(() => win.setIgnoreCursorEvents(false), 200)
    return () => clearInterval(interval)
  }, [visible, standalone])

  useEffect(() => {
    if (!visible) return
    fetch(petUrl("/model/list"))
      .then((r) => r.json())
      .then((data) => { if (data.models) setModels(data.models.map((m: { name: string; url: string }) => ({ ...m, url: petUrl(m.url) }))) })
      .catch(() => setModels([]))
    // Fetch current voice + provider
    fetch(petUrl("/voice"))
      .then((r) => r.json())
      .then((data) => {
        setCurrentVoice(data.voice || '')
        setCurrentProvider(data.provider || 'edge')
        if (data.qwenKey) setQwenKey(data.qwenKey)
        if (data.qwenModel) setQwenModel(data.qwenModel)
      })
      .catch(() => {})
  }, [visible])

  // Fetch persona files when model tab / persona sub-tab is active
  useEffect(() => {
    if (!visible || tab !== 'persona') return
    fetch(petUrl("/persona"))
      .then((r) => r.json())
      .then((data) => {
        setSoulContent(data.soul || '')
        setIdentityContent(data.identity || '')
        setPersonaDirty(false)
      })
      .catch(() => {})
  }, [visible, tab])

  const fetchCustomDances = useCallback(() => {
    fetch(petUrl("/dance/list"))
      .then((r) => r.json())
      .then((data) => { if (data.dances) setCustomDances(normalizeCustomDances(data.dances)) })
      .catch(() => setCustomDances([]))
  }, [])

  useEffect(() => {
    if (!visible || tab !== 'animations') return
    fetchCustomDances()
  }, [visible, tab, fetchCustomDances])

  const importModel = async (path: string) => {
    if (importBusy.current) return
    importBusy.current = true
    setImportingModel(true)
    setModelImportError('')
    try {
      singleModelPath([path], ['vrm'])
      const res = await fetch(petUrl('/model/import'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Model import failed')
      const list = await fetch(petUrl('/model/list')).then(r => r.json())
      if (list.models) setModels(list.models.map((m: { name: string; url: string }) => ({ ...m, url: petUrl(m.url) })))
      if (data.url) onModelChange(petUrl(data.url))
    } catch (error) {
      setModelImportError(error instanceof Error ? error.message : String(error))
    } finally {
      importBusy.current = false
      setImportingModel(false)
    }
  }

  const importMotion = async (paths: string[], pickMusic = false) => {
    if (importBusy.current) return
    importBusy.current = true
    setImportingDance(true)
    setDanceImportError('')
    try {
      if (!paths.length || paths.some(path => !/\.(vmd|vrma|fbx|mp3)$/i.test(path))) {
        throw new Error('Supported files: .vmd, .vrma, .fbx, .mp3')
      }
      for (const path of paths) {
        const res = await fetch(petUrl('/dance/import'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || 'Motion import failed')
      }
      if (pickMusic) {
        const path = await invoke<string | null>('pick_music_file')
        if (path) {
          const res = await fetch(petUrl('/dance/import'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || 'Music import failed')
        }
      }
    } catch (error) {
      setDanceImportError(error instanceof Error ? error.message : String(error))
    } finally {
      fetchCustomDances()
      importBusy.current = false
      setImportingDance(false)
    }
  }

  const fileDragging = useFileDrop(visible && (tab === 'model' || tab === 'animations'), async paths => {
    if (tab === 'model') await importModel(singleModelPath(paths, ['vrm']))
    else await importMotion(paths)
  }, message => tab === 'model' ? setModelImportError(message) : setDanceImportError(message))

  const savePersona = useCallback(() => {
    setPersonaSaving(true)
    fetch(petUrl("/persona"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soul: soulContent, identity: identityContent }),
    })
      .then(() => { setPersonaDirty(false) })
      .catch(() => {})
      .finally(() => setPersonaSaving(false))
  }, [soulContent, identityContent])

  const generatePersona = useCallback(async () => {
    if (!captureVrmScreenshot) return
    const dataUrl = await captureVrmScreenshot()
    if (!dataUrl) return
    setGenerating(true)
    try {
      // Save screenshot to server first
      const saveRes = await fetch(petUrl("/persona/screenshot"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      })
      const saveData = await saveRes.json()
      if (!saveData.ok) throw new Error(saveData.error || 'save screenshot failed')
      // Generate persona from saved screenshot
      const genRes = await fetch(petUrl("/persona/generate"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const genData = await genRes.json()
      if (genData.soul || genData.identity) {
        if (genData.soul) setSoulContent(genData.soul)
        if (genData.identity) setIdentityContent(genData.identity)
        setPersonaDirty(true)
      }
    } catch { /* ignore */ }
    setGenerating(false)
  }, [captureVrmScreenshot])

  const postVoiceSettings = (body: Record<string, string | undefined>) => {
    return fetch(petUrl("/voice"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }


  const setVoice = (voice: string) => {
    postVoiceSettings({ voice }).then(() => setCurrentVoice(voice)).catch(() => {})
  }

  const setProvider = (provider: string) => {
    postVoiceSettings({ provider }).then(() => setCurrentProvider(provider)).catch(() => {})
  }

  const saveQwenKey = (key: string) => {
    postVoiceSettings({ qwenKey: key }).catch(() => {})
  }

  const saveQwenModel = (model: string) => {
    postVoiceSettings({ qwenModel: model }).then(() => setQwenModel(model)).catch(() => {})
  }

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current = null
    }
    setPreviewingId(null)
  }, [])

  const preview = (voiceId: string) => {
    // Stop any current preview first
    stopPreview()
    setPreviewingId(voiceId)
    fetch(petUrl("/preview"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voiceId, provider: currentProvider }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.audioUrl) {
          const audio = new Audio(data.audioUrl)
          audioRef.current = audio
          audio.onended = () => stopPreview()
          audio.onerror = () => stopPreview()
          audio.play().catch(() => stopPreview())
        } else {
          if (data.error) console.warn('TTS preview error:', data.error)
          stopPreview()
        }
      })
      .catch(() => stopPreview())
  }

  const setBubble = useCallback((patch: Partial<BubbleSettings>) => {
    onBubbleSettingsChange({ ...bubbleSettings, ...patch })
  }, [bubbleSettings, onBubbleSettingsChange])

  const previewBubble = useCallback(() => {
    if (onBubblePreview) onBubblePreview()
    else (window as any).__clawPreviewBubble?.(BUBBLE_PREVIEW_TEXT)
  }, [onBubblePreview])

  // Live preview: show sample text shortly after any display change (or tab open)
  useEffect(() => {
    if (!visible || tab !== 'display') return
    const id = setTimeout(previewBubble, 400)
    return () => clearTimeout(id)
  }, [visible, tab, bubbleSettings, previewBubble])

  if (!visible) return null

  const voices = currentProvider === 'qwen' ? QWEN_VOICES : EDGE_VOICES

  return (
    <div className={standalone ? "pet-settings-window" : "pet-settings-panel"} style={{ ...overlayStyle, ...(standalone ? { background: '#1b1d25', alignItems: 'stretch', padding: 0 } : {}), ...(!standalone && tab === 'music' && musicPreview ? { background: 'transparent', alignItems: 'flex-end' } : {}) }} data-no-passthrough onClick={onClose}>
      <div className="settings-shell" style={{ ...panelStyle, ...(standalone ? { width: '100%', height: '100%', borderRadius: 0, display: 'flex', flexDirection: 'column' } : { width: panelWidth, maxWidth: '90vw', transform: `translate(${panelPos.x}px, ${panelPos.y}px)` }) }} data-no-passthrough onClick={(e) => e.stopPropagation()}>
        <div className="settings-header" style={headerStyle} onMouseDown={standalone ? undefined : onDragStart}>
          <div><h1 style={{ fontSize: 20, margin: 0 }}>{t('设置', 'Settings')}<VersionChip language={language} /></h1><p className="settings-caption">{t('个性化你的桌面伙伴', 'Make your desktop companion your own')}</p></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button aria-label={t('打开 GitHub 仓库', 'Open GitHub repository')} title={t('GitHub 仓库', 'GitHub repository')} onClick={() => void openExternal(APP_REPO_URL)} style={closeBtnStyle}>
              <Github size={16} />
            </button>
            {!standalone && <button aria-label="Close settings" onClick={onClose} style={closeBtnStyle}>
              <X size={16} />
            </button>}
          </div>
        </div>

        {/* Tabs */}
        <nav className="settings-tabs" aria-label="Settings sections" style={tabBarStyle}>
          {(['general', 'music', 'cuttle', 'voice', 'model', 'persona', 'animations', 'behavior', 'pets', 'props', 'quality', 'display', 'lighting'] as const).map((tb) => (
            <button
              key={tb}
              className="settings-tab" aria-current={tab === tb ? "page" : undefined}
              onClick={() => setTab(tb)}
              style={{ ...tabStyle, ...(tab === tb ? activeTabStyle : {}) }}
            >
              {{ animations: t('动画', 'Animations'), behavior: t('行为', 'Behavior'), music: 'Music', cuttle: 'Cuttle', general: t('常规', 'General'), voice: t('语音', 'Voice'), model: t('形象', 'Model'), persona: t('人设', 'Persona'), quality: t('画质', 'Quality'), display: t('显示', 'Display'), lighting: t('灯光', 'Lighting'), pets: t('宠物', 'Pets'), props: t('道具', 'Props') }[tb]}
            </button>
          ))}
        </nav>

        {/* Tab content */}
        <div className="settings-content" style={{ ...contentStyle, maxHeight: standalone ? undefined : tab === 'music' && musicPreview ? '32vh' : '60vh', ...(standalone ? { flex: 1, minHeight: 0 } : {}), overflowY: 'auto', paddingRight: 4 }}>
          {standalone && <div className="settings-section-heading"><h2>{{ general: t('常规', 'General'), music: 'Music', cuttle: 'Cuttle connection', voice: t('语音', 'Voice'), model: t('形象', 'Model'), persona: t('人设', 'Persona'), animations: t('动画', 'Animations'), behavior: t('行为', 'Behavior'), pets: t('宠物', 'Pets'), props: t('道具', 'Props'), quality: t('画质', 'Quality'), display: t('显示', 'Display'), lighting: t('灯光', 'Lighting') }[tab]}</h2><p>{t('更改会自动保存并实时应用。', 'Changes save automatically and apply live.')}</p></div>}
          {tab === 'music'  && <MusicSettingsPanel fit={headphoneFit} music={musicSettings} enabled={musicEnabled} onFitChange={onHeadphoneFitChange} onMusicChange={onMusicSettingsChange} onEnabledChange={onMusicEnabledChange} onPreview={handlePreview} />}
          {tab === 'animations' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {petStatusText && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#22303f', border: '1px solid #39465c', borderRadius: 8, padding: '9px 12px' }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: '#7fe08a', display: 'inline-block' }} />
                <span>Now: <strong>{petStatusText}</strong></span>
              </div>}
              <div style={sectionStyle}>
                  <div style={labelStyle}>{t('导入的动作', 'Imported Motion')}</div>
                  <div style={{ fontSize: 12, color: '#aebbd0', marginBottom: 8 }}>
                    {t('内置舞蹈见下方动画列表（含预览）。这里只管理你导入的动作文件。', 'Built-in dances live in the animation list below (with previews). This section is only for your imported motion files.')}
                  </div>
                  {customDances.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={labelStyle}>{t('自定义舞蹈', 'Custom Dances')}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {customDances.map((dance) => (
                          <div
                            key={dance.id}
                            onClick={() => {
                              const preset = {
                                label: dance.label,
                                type: dance.type,
                                url: dance.vmdUrl,
                                bgm: dance.bgmUrl,
                              }
                              onDanceChange(`custom:${dance.id}`, preset)
                              onAnimationPreview?.(`dance:custom:${dance.id}`, preset, 'loop')
                            }}
                            title={t('点击播放', 'Click to play')}
                            style={{
                              ...modelBtnStyle,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 10px',
                              fontSize: 13,
                              background: currentDance === `custom:${dance.id}` ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                              borderColor: currentDance === `custom:${dance.id}` ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <Music size={14} style={{ opacity: 0.6 }} />
                              <div>
                                <div>{dance.label}</div>
                                {dance.bgmUrl && (
                                  <div style={{ fontSize: 11, color: '#aebbd0', marginTop: 1 }}>{t('含BGM', 'w/ BGM')}</div>
                                )}
                              </div>
                            </div>
                            <div
                              onClick={(e) => {
                                e.stopPropagation()
                                fetch(petUrl("/dance/delete"), {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ name: dance.id }),
                                })
                                  .then(() => {
                                    fetchCustomDances()
                                    if (currentDance === `custom:${dance.id}`) onDanceChange('love')
                                  })
                                  .catch(() => {})
                              }}
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: 6,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'rgba(255, 255, 255, 0.08)',
                                cursor: 'pointer',
                                flexShrink: 0,
                                opacity: 0.5,
                              }}
                              title={t('删除', 'Delete')}
                            >
                              <Trash2 size={13} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: 12 }}>
                    <div style={labelStyle}>{t('导入自定义动作', 'Import Custom Motion')}</div>
                    <FileDropHint dragging={fileDragging}>{t('拖放动作文件和配套 .mp3 到此页面导入', 'Drop motion files and matching .mp3 music anywhere on this page to import.')}</FileDropHint>
                    {danceImportError && <div role="alert" style={{ color: '#ffaaaa' }}>{danceImportError}</div>}
                    <button
                      disabled={importingDance}
                      onClick={async () => {
                        try {
                          const path = await invoke<string | null>('pick_dance_file')
                          if (path) await importMotion([path], true)
                        } catch (error) {
                          setDanceImportError(error instanceof Error ? error.message : String(error))
                        }
                      }}
                      style={{ ...applyBtnStyle, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    >
                      {importingDance
                        ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                        : <Upload size={14} />}
                      {importingDance ? t('导入中…', 'Importing…') : t('选择动作文件… (.vmd/.vrma/.fbx)', 'Select motion file… (.vmd/.vrma/.fbx)')}
                    </button>
                    <div style={{ fontSize: 11, color: '#aebbd0', marginTop: 4 }}>
                      {t('选择动作文件后，可选择配套 .mp3 音乐文件', 'Select a motion file, then optionally pick a matching .mp3')}
                    </div>
                  </div>
              </div>
              <AnimationSettingsPanel status={petStatus} settings={animationSettings} onChange={onAnimationSettingsChange} customDances={customDances} onPreview={onAnimationPreview} onStop={onAnimationStop} language={language} />
            </div>
          )}
          {tab === 'behavior' && <BehaviorPanel status={petStatus} settings={behaviorSettings} onChange={onBehaviorSettingsChange} customDances={customDances} statusText={petStatusText} onPreview={onAnimationPreview} onStop={onAnimationStop} language={language} pets={petSettings.pets} props={propSettings.props} onCompanionTest={testCompanion} />}
          {tab === 'pets' && <PetsPanel pets={petSettings.pets} onChange={pets => onPetSettingsChange({ ...petSettings, pets })} language={language} onTest={testCompanion} status={petStatus} statusText={petStatusText} />}
          {tab === 'props' && <PropsPanel props={propSettings.props} onChange={props => onPropSettingsChange({ ...propSettings, props })} language={language} onTest={testCompanion} />}
          {tab === 'cuttle' && <CuttleConnection />}
          {tab === 'general' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('语言', 'Language')}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['zh', 'en'] as const).map((l) => (
                    <button
                      key={l}
                      onClick={() => onLanguageChange(l)}
                      style={{
                        ...smallBtnStyle,
                        background: language === l ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: language === l ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      {l === 'zh' ? '中文' : 'English'}
                    </button>
                  ))}
                </div>
              </div>
              <ToggleRow label={t('显示字幕', 'Subtitles')} value={showText} onChange={onShowTextChange} />
              <ToggleRow label={t('语音播报', 'TTS')} value={ttsEnabled} onChange={onTtsEnabledChange} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('音量', 'Volume')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(volume * 100)}
                    onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
                    style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                  />
                  <span style={{ fontSize: 12, color: '#aebbd0', width: 28, textAlign: 'right' }}>{Math.round(volume * 100)}</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('视线跟随', 'Eye Tracking')}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['mouse', 'camera'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => onTrackingChange(m)}
                      style={{
                        ...smallBtnStyle,
                        background: tracking === m ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: tracking === m ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      {m === 'mouse' ? t('鼠标', 'Mouse') : t('镜头', 'Camera')}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('视线幅度', 'Gaze strength')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={0}
                    max={MAX_GAZE_GAIN}
                    step={0.1}
                    value={gazeGain}
                    onChange={(e) => onGazeGainChange(normalizeGazeGain(Number(e.target.value)))}
                    style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                  />
                  <span style={{ fontSize: 12, color: '#aebbd0', width: 28, textAlign: 'right' }}>{gazeGain.toFixed(1)}</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('UI位置', 'UI Position')}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['left', 'right'] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => onUiAlignChange(a)}
                      style={{
                        ...smallBtnStyle,
                        background: uiAlign === a ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: uiAlign === a ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      {a === 'left' ? t('靠左', 'Left') : t('靠右', 'Right')}
                    </button>
                  ))}
                </div>
              </div>
              {!standalone && (<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('设置面板宽度', 'Panel width')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={300}
                    max={640}
                    step={10}
                    value={panelWidth}
                    onChange={(e) => onPanelWidthChange(Number(e.target.value))}
                    style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                  />
                  <span style={{ fontSize: 12, color: '#aebbd0', width: 44, textAlign: 'right' }}>{panelWidth}px</span>
                </div>
              </div>)}
              <ToggleRow label={t('窗口置顶', 'Stay on top')} value={pinned} onChange={onPinnedChange} />
              <ToggleRow label={t('隐藏UI', 'Hide UI')} value={hideUI} onChange={onHideUIChange} />
              <ToggleRow label={t('隐藏心情条', 'Hide Mood Bar')} value={hideMood} onChange={onHideMoodChange} />
              <ToggleRow label={t('屏幕观察', 'Screen Observe')} value={screenObserve} onChange={onScreenObserveChange} />
              {screenObserve && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: -8 }}>
                    <span style={{ fontSize: 14 }}>{t('观察间隔', 'Interval')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min={15}
                        max={300}
                        step={15}
                        value={screenObserveInterval}
                        onChange={(e) => onScreenObserveIntervalChange(Number(e.target.value))}
                        style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                      />
                      <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{screenObserveInterval}s</span>
                    </div>
                  </div>

                </>
              )}
            </div>
          )}

          {tab === 'voice' && (
            <div style={sectionStyle}>
              <div style={labelStyle}>{t('TTS 服务', 'TTS Provider')}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['edge', 'qwen'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setProvider(p)}
                    style={{
                      ...modelBtnStyle,
                      flex: 1,
                      textAlign: 'center',
                      padding: '6px 10px',
                      fontSize: 13,
                      background: p === currentProvider ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                      borderColor: p === currentProvider ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                    }}
                  >
                    {{ edge: 'Edge', qwen: t('千问 TTS', 'Qwen TTS') }[p]}
                  </button>
                ))}
              </div>

              {currentProvider === 'qwen' && (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <div style={labelStyle}>{t('阿里云 API Key', 'Alibaba Cloud API Key')}</div>
                    <input
                      type="text"
                      value={qwenKey}
                      onChange={(e) => setQwenKey(e.target.value)}
                      onBlur={() => saveQwenKey(qwenKey)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveQwenKey(qwenKey) }}
                      placeholder="sk-..."
                      style={{ ...inputStyle, width: '100%' }}
                    />
                    <div style={{ fontSize: 11, color: '#aebbd0', marginTop: 4 }}>
                      {t('从阿里云百炼控制台获取 API Key', 'Get API Key from Alibaba Cloud console')}
                    </div>
                  </div>
                  <div>
                    <div style={labelStyle}>{t('语音模型', 'Voice Model')}</div>
                    <select
                      value={qwenModel}
                      onChange={(e) => { setQwenModel(e.target.value); saveQwenModel(e.target.value) }}
                      style={selectStyle}
                    >
                      {QWEN_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 8 }}>
                <div style={labelStyle}>{currentProvider === 'qwen' ? t('千问语音', 'Qwen Voice') : t('Edge TTS 语音', 'Edge TTS Voice')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                  {voices.map((v) => (
                    <div
                      key={v.id}
                      onClick={() => setVoice(v.id)}
                      style={{
                        ...modelBtnStyle,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 6px 6px 10px',
                        fontSize: 13,
                        background: v.id === currentVoice ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: v.id === currentVoice ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      <div>
                        <div>{v.label}</div>
                        <div style={{ fontSize: 11, color: '#aebbd0', marginTop: 1 }}>{v.id}</div>
                      </div>
                      <div
                        onClick={(e) => { e.stopPropagation(); preview(v.id) }}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: previewingId === v.id ? 'rgba(100, 160, 255, 0.3)' : 'rgba(255, 255, 255, 0.08)',
                          cursor: previewingId !== null ? 'default' : 'pointer',
                          flexShrink: 0,
                          opacity: previewingId !== null && previewingId !== v.id ? 0.3 : 0.7,
                          transition: 'background 0.15s',
                        }}
                        title={t('试听', 'Preview')}
                      >
                        {previewingId === v.id ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'model' && (
            <div style={sectionStyle}>
              <div style={labelStyle}>{t('内置VRM模型', 'Built-in VRM Models')}</div>
              <select
                aria-label="Built-in VRM models"
                value={BUILTIN_MODELS.includes(currentModel) ? currentModel : ''}
                onChange={(e) => { onModelChange(e.target.value) }}
                style={selectStyle}
              >
                {!BUILTIN_MODELS.includes(currentModel) && <option value="" disabled>{t('未选择', 'Not selected')}</option>}
                {BUILTIN_MODELS.map((m) => (
                  <option key={m} value={m}>{m.replace(/^\//, '')}</option>
                ))}
              </select>

              {models.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={labelStyle}>{t('自定义VRM模型', 'Custom VRM Models')}</div>
                  <select
                    aria-label="Custom VRM models"
                    value={!BUILTIN_MODELS.includes(currentModel) ? currentModel : ''}
                    onChange={(e) => { onModelChange(e.target.value) }}
                    style={selectStyle}
                  >
                    {BUILTIN_MODELS.includes(currentModel) && <option value="" disabled>{t('未选择', 'Not selected')}</option>}
                    {models.map((m) => (
                      <option key={m.url} value={m.url}>{m.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {modelImportError && <div role="alert" style={{ color: '#ffaaaa' }}>{modelImportError}</div>}
              <div style={{ marginTop: 12 }}>
                <div style={labelStyle}>{t('导入自定义模型', 'Import Custom Model')}</div>
                <FileDropHint dragging={fileDragging}>{t('拖放 .vrm 到此页面导入', 'Drop a .vrm anywhere on this page to import.')}</FileDropHint>
                <button
                  disabled={importingModel}
                  onClick={async () => {
                    try {
                      const path = await invoke<string | null>('pick_vrm_file')
                      if (path) await importModel(path)
                    } catch (error) {
                      setModelImportError(error instanceof Error ? error.message : String(error))
                    }
                  }}
                  style={{ ...applyBtnStyle, width: '100%' }}
                >
                  {t('浏览本地文件…', 'Browse local files…')}
                </button>
                <div style={{ fontSize: 11, color: '#aebbd0', marginTop: 4 }}>
                  {t('选择 .vrm 文件导入宠物模型库', 'Choose a .vrm file to import into your pet model library. Files in this project’s models folder also appear above.')}
                </div>
              </div>
            </div>
          )}

          {tab === 'persona' && (
            <div style={sectionStyle}>
              <div style={labelStyle}>IDENTITY.md</div>
              <textarea
                value={identityContent}
                onChange={(e) => { setIdentityContent(e.target.value); setPersonaDirty(true) }}
                placeholder={t('角色身份信息（名字、种族、性格、emoji 等）…', 'Character identity (name, race, personality, emoji, etc.)…')}
                style={textareaStyle}
                rows={4}
              />

              <div style={{ ...labelStyle, marginTop: 4 }}>SOUL.md</div>
              <textarea
                value={soulContent}
                onChange={(e) => { setSoulContent(e.target.value); setPersonaDirty(true) }}
                placeholder={t('角色灵魂设定（说话风格、行为准则、背景故事等）…', 'Character soul (speaking style, behavior, backstory, etc.)…')}
                style={textareaStyle}
                rows={6}
              />

              <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                <button
                  onClick={generatePersona}
                  disabled={generating || !captureVrmScreenshot}
                  style={{
                    ...applyBtnStyle,
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    background: generating ? 'rgba(100, 160, 255, 0.3)' : 'rgba(160, 120, 255, 0.5)',
                  }}
                  title={t('根据当前模型截图自动生成人设', 'Auto-generate persona from model screenshot')}
                >
                  {generating
                    ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    : <Sparkles size={14} />}
                  {generating ? t('生成中…', 'Generating…') : t('一键生成人设', 'Auto Generate')}
                </button>
                <button
                  onClick={savePersona}
                  disabled={!personaDirty || personaSaving}
                  style={{
                    ...applyBtnStyle,
                    opacity: personaDirty ? 1 : 0.4,
                  }}
                >
                  {personaSaving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 4 }}>
                {t('关联工作区根目录的 IDENTITY.md 和 SOUL.md', 'Linked to IDENTITY.md and SOUL.md in workspace root')}
              </div>
            </div>
          )}

          {tab === 'quality' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('预设', 'Preset')}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {RENDER_QUALITIES.map((q) => (
                    <button
                      key={q}
                      onClick={() => onQualitySettingsChange({ ...presetSettings(q), maxFps: qualitySettings.maxFps })}
                      style={{
                        ...smallBtnStyle,
                        background: qualitySettings.preset === q ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: qualitySettings.preset === q ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      {presetLabel(q)}
                    </button>
                  ))}
                  {qualitySettings.preset === 'custom' && (
                    <span style={{ ...smallBtnStyle, background: 'rgba(100, 160, 255, 0.4)', borderColor: 'rgba(100, 160, 255, 0.6)', cursor: 'default' }}>
                      {presetLabel('custom')}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('渲染精度', 'Render scale')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={0.5}
                    max={4}
                    step={0.25}
                    value={qualitySettings.pixelRatioCap}
                    onChange={(e) => updateQualityDetails({ pixelRatioCap: Number(e.target.value) })}
                    style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                  />
                  <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{parseFloat(qualitySettings.pixelRatioCap.toFixed(2))}x</span>
                </div>
              </div>
              <label className="settings-control-row"><span>{t('帧率限制', 'Frame rate limit')}</span>
                <select aria-label="Frame rate limit" value={qualitySettings.maxFps} onChange={e => updateQualityDetails({ maxFps: Number(e.target.value) })} style={{ ...selectStyle, width: 170 }}>
                  {![0, 15, 24, 30, 60, 90, 120, 144, 165, 240].includes(qualitySettings.maxFps) && <option value={qualitySettings.maxFps}>{qualitySettings.maxFps} FPS</option>}
                  {[15, 24, 30, 60, 90, 120, 144, 165, 240].map(fps => <option key={fps} value={fps}>{fps} FPS</option>)}
                  <option value={0}>{t('无限制', 'Uncapped')}</option>
                </select>
              </label>
              <p className="settings-help">{t('较低的帧率降低资源使用。此限制独立于画质预设。', 'Lower caps use fewer resources. Frame rate is independent of the visual preset.')}</p>
              <ToggleRow label={t('弹簧骨骼（耳朵/头发）', 'Spring bones (ears/hair)')} value={qualitySettings.springBones} onChange={(v) => updateQualityDetails({ springBones: v })} />
            </div>
          )}
          {tab === 'lighting' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={sectionStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={labelStyle}>{t('跟随鼠标的灯', 'Cursor light')}</div>
                  <button
                    onClick={() => onCursorLightSettingsChange({ ...DEFAULT_CURSOR_LIGHT, enabled: cursorLightSettings.enabled })}
                    style={{ ...smallBtnStyle }}
                  >
                    {t('重置', 'Reset')}
                  </button>
                </div>
                <ToggleRow label={t('启用', 'Enabled')} value={cursorLightSettings.enabled} onChange={(v) => setCursorLight({ enabled: v })} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('预设', 'Preset')}</span>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {CURSOR_LIGHT_PRESET_IDS.map((p) => (
                      <button
                        key={p}
                        onClick={() => onCursorLightSettingsChange(applyCursorLightPreset({ ...cursorLightSettings, enabled: true }, p))}
                        style={{
                          ...smallBtnStyle,
                          background: cursorLightSettings.preset === p ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                          borderColor: cursorLightSettings.preset === p ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                        }}
                      >
                        {cursorPresetLabel(p)}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('类型', 'Type')}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['point', 'spot'] as const).map((k) => (
                      <button
                        key={k}
                        onClick={() => setCursorLight({ kind: k, preset: cursorLightSettings.preset })}
                        style={{
                          ...smallBtnStyle,
                          background: cursorLightSettings.kind === k ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                          borderColor: cursorLightSettings.kind === k ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                        }}
                      >
                        {k === 'point' ? t('点光', 'Point') : t('聚光', 'Spot')}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('跟随方式', 'Follow')}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['hard', 'soft'] as const).map((a) => (
                      <button
                        key={a}
                        onClick={() => setCursorLight({ anchor: a })}
                        style={{
                          ...smallBtnStyle,
                          background: cursorLightSettings.anchor === a ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                          borderColor: cursorLightSettings.anchor === a ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                        }}
                      >
                        {a === 'hard' ? t('硬跟随', 'Hard') : t('柔跟随', 'Soft')}
                      </button>
                    ))}
                  </div>
                </div>
                {cursorLightSettings.anchor === 'soft' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t('跟随速度', 'Follow speed')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min={1}
                        max={30}
                        step={1}
                        value={cursorLightSettings.followSpeed}
                        onChange={(e) => setCursorLight({ followSpeed: Number(e.target.value) })}
                        style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                      />
                      <span style={{ fontSize: 12, color: '#aebbd0', width: 28, textAlign: 'right' }}>{cursorLightSettings.followSpeed}</span>
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('颜色', 'Color')}</span>
                  <input
                    type="color"
                    aria-label="Cursor light color"
                    value={cursorLightSettings.color}
                    onChange={(e) => setCursorLight({ color: e.target.value })}
                    style={{ width: 44, height: 28, padding: 0, border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'transparent' }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('亮度', 'Intensity')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="range"
                      min={0}
                      max={20}
                      step={0.1}
                      value={cursorLightSettings.intensity}
                      onChange={(e) => setCursorLight({ intensity: Number(e.target.value) })}
                      style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                    />
                    <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{cursorLightSettings.intensity.toFixed(1)}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('大小（0=无限）', 'Size (0=infinite)')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="range"
                      min={0}
                      max={20}
                      step={0.1}
                      value={cursorLightSettings.distance}
                      onChange={(e) => setCursorLight({ distance: Number(e.target.value) })}
                      style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                    />
                    <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{cursorLightSettings.distance.toFixed(1)}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('边缘（越高越聚）', 'Edge (higher=tighter)')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="range"
                      min={0}
                      max={4}
                      step={0.1}
                      value={cursorLightSettings.decay}
                      onChange={(e) => setCursorLight({ decay: Number(e.target.value) })}
                      style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                    />
                    <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{cursorLightSettings.decay.toFixed(1)}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('光晕大小（0=无）', 'Glow size (0=off)')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="range"
                      min={0}
                      max={0.6}
                      step={0.01}
                      value={cursorLightSettings.glowSize}
                      onChange={(e) => setCursorLight({ glowSize: Number(e.target.value) })}
                      style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                    />
                    <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{cursorLightSettings.glowSize.toFixed(2)}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('动态', 'Motion')}</span>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {CURSOR_LIGHT_MOTIONS.map((m) => (
                      <button
                        key={m}
                        onClick={() => setCursorLight({ motion: m })}
                        style={{
                          ...smallBtnStyle,
                          background: cursorLightSettings.motion === m ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                          borderColor: cursorLightSettings.motion === m ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                        }}
                      >
                        {cursorMotionLabel(m)}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14 }}>{t('灯数量', 'Lights')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="range"
                      min={1}
                      max={6}
                      step={1}
                      value={cursorLightSettings.lightCount}
                      onChange={(e) => setCursorLight({ lightCount: Number(e.target.value) })}
                      style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                    />
                    <span style={{ fontSize: 12, color: '#aebbd0', width: 28, textAlign: 'right' }}>{cursorLightSettings.lightCount}</span>
                  </div>
                </div>
                {cursorLightSettings.motion !== 'still' && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14 }}>{t('活动范围', 'Motion radius')}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="range"
                          min={0}
                          max={1.5}
                          step={0.05}
                          value={cursorLightSettings.motionRadius}
                          onChange={(e) => setCursorLight({ motionRadius: Number(e.target.value) })}
                          style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                        />
                        <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{cursorLightSettings.motionRadius.toFixed(2)}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14 }}>{t('活动速度', 'Motion speed')}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="range"
                          min={0.1}
                          max={5}
                          step={0.1}
                          value={cursorLightSettings.motionSpeed}
                          onChange={(e) => setCursorLight({ motionSpeed: Number(e.target.value) })}
                          style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                        />
                        <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{cursorLightSettings.motionSpeed.toFixed(1)}</span>
                      </div>
                    </div>
                  </>
                )}
                {cursorLightSettings.kind === 'spot' && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14 }}>{t('锥角', 'Cone angle')}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="range"
                          min={5}
                          max={90}
                          step={1}
                          value={cursorLightSettings.angle}
                          onChange={(e) => setCursorLight({ angle: Number(e.target.value) })}
                          style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                        />
                        <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{Math.round(cursorLightSettings.angle)}°</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14 }}>{t('边缘柔化', 'Edge softness')}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={cursorLightSettings.penumbra}
                          onChange={(e) => setCursorLight({ penumbra: Number(e.target.value) })}
                          style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                        />
                        <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{Math.round(cursorLightSettings.penumbra * 100)}%</span>
                      </div>
                    </div>
                  </>
                )}
                {['rgb', 'flame', 'lightning'].includes(cursorLightSettings.preset) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t('特效速度', 'Effect speed')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min={0.1}
                        max={5}
                        step={0.1}
                        value={cursorLightSettings.effectSpeed}
                        onChange={(e) => setCursorLight({ effectSpeed: Number(e.target.value) })}
                        style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                      />
                      <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{cursorLightSettings.effectSpeed.toFixed(1)}</span>
                    </div>
                  </div>
                )}
              </div>
              <div style={sectionStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={labelStyle}>{t('全局灯光', 'Stage lighting')}</div>
                  <button onClick={() => onLightingSettingsChange({ ...DEFAULT_GLOBAL_LIGHTING })} style={{ ...smallBtnStyle }}>
                    {t('重置', 'Reset')}
                  </button>
                </div>
                {([
                  { key: 'ambient', zh: '环境光', en: 'Ambient' },
                  { key: 'key', zh: '主光', en: 'Key' },
                  { key: 'fill', zh: '补光', en: 'Fill' },
                ] as const).map(({ key, zh, en }) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t(zh, en)}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="color"
                        aria-label={`${en} color`}
                        value={lightingSettings[`${key}Color` as const]}
                        onChange={(e) => setGlobalLighting({ [`${key}Color`]: e.target.value } as Partial<GlobalLightingSettings>)}
                        style={{ width: 44, height: 28, padding: 0, border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'transparent' }}
                      />
                      <input
                        type="range"
                        min={0}
                        max={key === 'ambient' ? 3 : 5}
                        step={0.05}
                        value={lightingSettings[`${key}Intensity` as const]}
                        onChange={(e) => setGlobalLighting({ [`${key}Intensity`]: Number(e.target.value) } as Partial<GlobalLightingSettings>)}
                        style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                      />
                      <span style={{ fontSize: 12, color: '#aebbd0', width: 36, textAlign: 'right' }}>{(lightingSettings[`${key}Intensity` as const] as number).toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab === 'display' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={previewBubble} style={{ ...applyBtnStyle, flex: 1 }}>
                  {t('预览字幕', 'Preview Subtitle')}
                </button>
                <button onClick={() => setBubble({ ...DEFAULT_BUBBLE_SETTINGS })} style={{ ...applyBtnStyle, background: 'rgba(255, 255, 255, 0.12)' }}>
                  {t('重置', 'Reset')}
                </button>
              </div>
              {!showText && (
                <div style={{ fontSize: 11, color: 'rgba(255,200,100,0.8)' }}>
                  {t('字幕已关闭（常规选项卡），预览不可见', 'Subtitles are off (General tab), so the preview is hidden')}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('缩放', 'Scale')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.05}
                    value={bubbleSettings.scale}
                    onChange={(e) => setBubble({ scale: Number(e.target.value) })}
                    style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                  />
                  <span style={{ fontSize: 12, color: '#aebbd0', width: 40, textAlign: 'right' }}>{Math.round(bubbleSettings.scale * 100)}%</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('水平位置', 'Position')}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['left', 'center', 'right'] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => setBubble({ align: a })}
                      style={{
                        ...smallBtnStyle,
                        background: bubbleSettings.align === a ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: bubbleSettings.align === a ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      {a === 'left' ? t('靠左', 'Left') : a === 'right' ? t('靠右', 'Right') : t('居中', 'Center')}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('底部距离', 'Bottom offset')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={0}
                    max={400}
                    step={4}
                    value={bubbleSettings.bottom}
                    onChange={(e) => setBubble({ bottom: Number(e.target.value) })}
                    style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                  />
                  <span style={{ fontSize: 12, color: '#aebbd0', width: 40, textAlign: 'right' }}>{bubbleSettings.bottom}px</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('字体', 'Font')}</span>
                <select
                  value={FONT_CHOICES.some((f) => f.id === bubbleSettings.fontFamily) ? bubbleSettings.fontFamily : FONT_CHOICES[0].id}
                  onChange={(e) => setBubble({ fontFamily: e.target.value })}
                  style={{ ...selectStyle, width: 160 }}
                >
                  {FONT_CHOICES.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('字号', 'Font size')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={8}
                    max={28}
                    step={1}
                    value={bubbleSettings.fontSize}
                    onChange={(e) => setBubble({ fontSize: Number(e.target.value) })}
                    style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                  />
                  <span style={{ fontSize: 12, color: '#aebbd0', width: 40, textAlign: 'right' }}>{bubbleSettings.fontSize}px</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>{t('文字颜色', 'Text color')}</span>
                <input
                  type="color"
                  value={bubbleSettings.textColor}
                  onChange={(e) => setBubble({ textColor: e.target.value })}
                  style={{ width: 44, height: 26, padding: 0, border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                />
              </div>
              <ToggleRow label={t('文字阴影', 'Text shadow')} value={bubbleSettings.textShadow} onChange={(v) => setBubble({ textShadow: v })} />
              {bubbleSettings.textShadow && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t('阴影颜色', 'Shadow color')}</span>
                    <input
                      type="color"
                      value={bubbleSettings.textShadowColor}
                      onChange={(e) => setBubble({ textShadowColor: e.target.value })}
                      style={{ width: 44, height: 26, padding: 0, border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t('阴影强度', 'Shadow intensity')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={bubbleSettings.textShadowIntensity}
                        onChange={(e) => setBubble({ textShadowIntensity: Number(e.target.value) })}
                        style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                      />
                      <span style={{ fontSize: 12, color: '#aebbd0', width: 40, textAlign: 'right' }}>{Math.round(bubbleSettings.textShadowIntensity * 100)}%</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t('阴影模糊', 'Shadow blur')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min={0}
                        max={30}
                        step={1}
                        value={bubbleSettings.textShadowBlur}
                        onChange={(e) => setBubble({ textShadowBlur: Number(e.target.value) })}
                        style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                      />
                      <span style={{ fontSize: 12, color: '#aebbd0', width: 40, textAlign: 'right' }}>{bubbleSettings.textShadowBlur}px</span>
                    </div>
                  </div>
                </>
              )}
              <ToggleRow label={t('气泡背景', 'Bubble background')} value={bubbleSettings.bubbleEnabled} onChange={(v) => setBubble({ bubbleEnabled: v })} />
              {bubbleSettings.bubbleEnabled && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t('背景颜色', 'Bubble color')}</span>
                    <input
                      type="color"
                      value={bubbleSettings.bubbleColor}
                      onChange={(e) => setBubble({ bubbleColor: e.target.value })}
                      style={{ width: 44, height: 26, padding: 0, border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t('不透明度', 'Opacity')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={bubbleSettings.bubbleAlpha}
                        onChange={(e) => setBubble({ bubbleAlpha: Number(e.target.value) })}
                        style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                      />
                      <span style={{ fontSize: 12, color: '#aebbd0', width: 40, textAlign: 'right' }}>{Math.round(bubbleSettings.bubbleAlpha * 100)}%</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14 }}>{t('圆角', 'Corner radius')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min={0}
                        max={24}
                        step={1}
                        value={bubbleSettings.borderRadius}
                        onChange={(e) => setBubble({ borderRadius: Number(e.target.value) })}
                        style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                      />
                      <span style={{ fontSize: 12, color: '#aebbd0', width: 40, textAlign: 'right' }}>{bubbleSettings.borderRadius}px</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <VersionFooter language={language} />
      </div>
    </div>
  )
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        style={{
          ...toggleStyle,
          background: value ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
        }}
      >
        <div style={{
          ...toggleKnobStyle,
          transform: value ? 'translateX(18px)' : 'translateX(2px)',
        }} />
      </button>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  zIndex: 500,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
}

const panelStyle: React.CSSProperties = {
  width: 400,
  background: 'rgba(30, 30, 40, 0.95)',
  backdropFilter: 'blur(12px)',
  borderRadius: 12,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
  padding: 16,
  color: '#fff',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
  cursor: 'grab',
  userSelect: 'none',
}

const closeBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(255, 255, 255, 0.1)',
  color: 'rgba(255, 255, 255, 0.7)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 2,
  marginBottom: 16,
  background: 'rgba(255, 255, 255, 0.06)',
  borderRadius: 8,
  padding: 2,
}

const tabStyle: React.CSSProperties = {
  flex: '1 0 22%',
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: '#aebbd0',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
}

const activeTabStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.12)',
  color: '#fff',
}

const contentStyle: React.CSSProperties = {
  minHeight: 120,
}

const toggleStyle: React.CSSProperties = {
  width: 40,
  height: 22,
  borderRadius: 11,
  border: 'none',
  cursor: 'pointer',
  position: 'relative',
  transition: 'background 0.2s',
  padding: 0,
}

const toggleKnobStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 9,
  background: '#fff',
  transition: 'transform 0.2s',
  position: 'absolute',
  top: 2,
}

const smallBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
}

const modelBtnStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid',
  borderRadius: 8,
  color: '#fff',
  fontSize: 14,
  cursor: 'pointer',
  textAlign: 'left',
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  height: 32,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.3)',
  color: '#fff',
  fontSize: 13,
  padding: '0 8px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.3)',
  color: '#fff',
  fontSize: 12,
  lineHeight: '1.5',
  padding: '6px 8px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
  resize: 'vertical',
}

const applyBtnStyle: React.CSSProperties = {
  height: 32,
  padding: '0 12px',
  border: 'none',
  borderRadius: 6,
  background: 'rgba(100, 160, 255, 0.5)',
  color: '#fff',
  fontSize: 13,
  cursor: 'pointer',
}
