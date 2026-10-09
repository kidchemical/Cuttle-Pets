import { alphaInputRegions } from '../input-regions'
import { createExitShutdown } from '../exit-shutdown'
import { cursorPayloadToClient, DEFAULT_GAZE_GAIN, type CursorPositionPayload } from '../cursor-gaze'
import { intersectAnimatedModel } from '../mesh-hit-test'
import { FramePacer } from '../frame-pacer'
import { DEFAULT_ANIMATIONS, proceduralSpeed, type AnimationSettings } from '../animation-settings'
import { MusicMotion } from '../music-motion'
import { prepareLaptop, cupPositions } from '../work-props'
import { CompanionLayer } from '../companion-runtime'
import { companionAssetUrl } from '../asset-import'
import type { CompanionAction, PetConfig, PropConfig } from '../companions'
import { DEFAULT_MUSIC, DEFAULT_FIT, type MusicSettings, type HeadphoneFit } from '../music-settings'
import { DEFAULT_CURSOR_LIGHT, DEFAULT_GLOBAL_LIGHTING, MAX_CURSOR_LIGHTS, cursorLightOffset, fireflyBlink, normalizeCursorLight, normalizeGlobalLighting, type CursorLightSettings, type GlobalLightingSettings } from '../lighting'
import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { splitVrmMaterialVariants } from '../material-variants'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation'
import type { VRM } from '@pixiv/three-vrm'
import { EmoteController } from '../emote'
import { LipSync } from '../lip-sync'
import { MotionController } from '../motion-controller'
import { buildTypingPoseCache, restoreTypingPose, applyTypingPose, applySipPose, applyMusicAngles, applyHeadTurn, faceDirection } from '../typing-pose'
import { DEFAULT_HEAD_TURN_GAIN, headTurnTarget, dampAngle } from '../head-turn'
import type { CursorFollow } from '../behavior'
import type { TypingPoseCache } from '../typing-pose'

export type TouchRegion = 'head' | 'arm' | 'leg' | 'chest' | 'belly' | 'buttocks'

interface VRMSceneProps {
  animationSettings?: AnimationSettings
  musicSettings?: MusicSettings
  headphoneFit?: HeadphoneFit
  modelPath: string
  qualitySettings?: QualitySettings
  idleAnimationPath?: string
  /**
   * Polled every frame: cursor-follow strengths of the playing behavior entry,
   * or null to follow automatically (only while nothing animates the head).
   */
  cursorFollow?: () => CursorFollow | null
  lightingSettings?: GlobalLightingSettings
  cursorLightSettings?: CursorLightSettings
  onTouch?: (region: TouchRegion) => void
  pets?: PetConfig[]
  props?: PropConfig[]
  onModelError?: (message: string) => void
  onModelLoaded?: () => void
}

export type TrackingMode = 'mouse' | 'camera'
const NO_PETS: PetConfig[] = []
const NO_PROPS: PropConfig[] = []

import type { RenderQuality, QualitySettings } from '../render-quality'
import { QUALITY_PRESETS, frameCap, normalizeQualitySettings, SETTINGS_RESIZE_RECOVERY_MS } from '../render-quality'
import { defaultViewFromBounds, isValidView, loadSavedCameraView, saveCameraView, type CameraView } from '../camera-framing'
import { collectEarMorphSlots, dampenEarMorphs, type EarMorphSlot } from '../ear-morph-dampen'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCachedSetting } from '../settings'
export type { RenderQuality, QualitySettings, QualityPresetOrCustom, QualityDetails } from '../render-quality'
export { RENDER_QUALITIES, QUALITY_PRESETS as QUALITY_CONFIGS, normalizeQuality, presetSettings, resolvePreset, normalizeQualitySettings } from '../render-quality'

export interface VRMSceneHandle {
  /** Reserve graphics headroom for 250 ms after a settings size change. */
  budgetSettingsResize: () => void
  setEmotion: (emotion: string, intensity?: number) => void
  setEmotionWithReset: (emotion: string, durationMs: number, intensity?: number) => void
  resetCamera: () => void
  setTrackingMode: (mode: TrackingMode) => void
  playAction: (name: string, hold?: boolean) => void
  playAnimationOnce: (name: string) => Promise<void>
  captureScreenshot: () => string | null
  panCamera: (dx: number, dy: number) => void
  rotateCamera: (dx: number, dy: number) => void
  playDance: (nameOrPreset: string | import('../motion-controller').DancePreset, preferenceKey?: string) => void
  /** Dance clip played once, then back to idle. */
  playDanceOnce: (nameOrPreset: string | import('../motion-controller').DancePreset, preferenceKey?: string) => Promise<void>
  /** Replay an action on every finish until stop. */
  playActionLoop: (name: string) => void
  /** Repeat the coffee sip until stop (implies working mode). */
  startSipLoop: () => void
  /** Briefly emphasize an always-on procedural layer (5s, or until stop when looped). */
  pulseProcedural: (id: string, loop: boolean) => void
  stopDance: () => void
  isDancing: () => boolean
  setBgmVolume: (v: number) => void
  /** Unified reset: camera + resetToIdle + expressions to zero */
  resetPose: () => void
  reset: () => void
  /** Live playback snapshot for the settings status banner + behavior engine. */
  /** Frames rendered per second (last full second; 0 while paused) and drawing-buffer size. */
  getRenderStats: () => { browserFps: number; maxBrowserGapMs: number; longBrowserGaps: number; frameMs: number; maxFrameMs: number; effectiveMaxFps: number; settingsResizing: boolean; fps: number; pixelRatio: number; width: number; height: number }
  getPlaybackStatus: () => { actionId: string | null; dancing: boolean; danceId: string | null; working: boolean; sipping: boolean; musicMotion: boolean }
  /** True while a one-shot action or dance owns the mixer. */
  isBusy: () => boolean
  isLooping: () => boolean
  /** Working mode: typing pose + laptop prop (eases in/out) */
  setMusicMode: (active: boolean) => void
  /** durationMs > 0 auto-disables the preview after the timeout. */
  setMusicPreview: (active: boolean, durationMs?: number) => void
  receiveMusicBeat: (beat: { bpm: number | null; confidence: number; timestamp: number }) => void
  receiveMusicAudio: (audio: { amplitude: number; available: boolean; timestamp: number }) => void
  requestCoffeeSip: () => void
  /** durationMs > 0 auto-disables working mode after the timeout (preview). */
  setWorking: (active: boolean, durationMs?: number) => void
  /**
   * Screensaver/lock suspend. Stops the render loop AND hides the window so
   * the compositor drops our surface: no WebGL presents fight the saver for
   * the GPU, and the always-on-top pet can't paint over the lock screen.
   * Resume restores the loop and re-shows only if we hid it (a manual
   * tray-hide during suspend stays hidden).
   */
  setSuspended: (suspended: boolean) => void
  /** Pet/prop instruction from a behavior, reaction, CLI or settings preview. */
  companion: (action: CompanionAction) => void
  /** Reactions restore pet/prop state they changed when they finish. */
  snapshotCompanions: () => import('../companion-runtime').CompanionSnapshot | null
  restoreCompanions: (snapshot: import('../companion-runtime').CompanionSnapshot) => void
}

// ── Blink state ───────────────────────────────────────────────────────────────
interface BlinkState {
  isBlinking: boolean
  blinkProgress: number
  timeSinceLastBlink: number
  nextBlinkTime: number
}

function createBlinkState(): BlinkState {
  return {
    isBlinking: false,
    blinkProgress: 0,
    timeSinceLastBlink: 0,
    nextBlinkTime: Math.random() * 4 + 1,
  }
}

function updateBlink(vrm: VRM, delta: number, state: BlinkState) {
  if (!vrm.expressionManager) return

  state.timeSinceLastBlink += delta

  if (!state.isBlinking && state.timeSinceLastBlink >= state.nextBlinkTime) {
    state.isBlinking = true
    state.blinkProgress = 0
  }

  if (state.isBlinking) {
    const BLINK_DURATION = 0.15
    state.blinkProgress += delta / BLINK_DURATION
    const blinkValue = Math.sin(Math.PI * state.blinkProgress)
    vrm.expressionManager.setValue('blink', blinkValue)

    if (state.blinkProgress >= 1) {
      state.isBlinking = false
      state.timeSinceLastBlink = 0
      vrm.expressionManager.setValue('blink', 0)
      state.nextBlinkTime = Math.random() * 5 + 1
    }
  }
}

// ── Relaxed hand pose ─────────────────────────────────────────────────────────
// The idle_loop.vrma often has no finger tracks, so fingers stay in the stiff
// T-pose. This must be applied EVERY FRAME after mixer.update() because the
// AnimationMixer resets bones that have no tracks back to their rest rotation.
//
// VRM normalized bones use Z-axis for finger curl (spread is Y-axis).
// Left hand curls positive Z, right hand curls negative Z.
// We also add slight spread (Y-axis) variation per finger for a natural look,
// and subtle per-frame micro-movement to avoid a "frozen" appearance.

interface HandPoseCache {
  bones: { bone: THREE.Object3D; z: number; y: number }[]
}

function buildHandPoseCache(vrm: VRM): HandPoseCache {
  const humanoid = vrm.humanoid
  const bones: HandPoseCache['bones'] = []
  if (!humanoid) return { bones }

  const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const
  const segments = ['Proximal', 'Intermediate', 'Distal'] as const
  const sides = ['left', 'right'] as const

  // Base curl values — outer fingers curl more for a natural resting hand
  const curlMap: Record<string, [number, number, number]> = {
    Thumb:  [0.25, 0.15, 0.10],
    Index:  [0.20, 0.30, 0.20],
    Middle: [0.25, 0.35, 0.25],
    Ring:   [0.30, 0.40, 0.30],
    Little: [0.35, 0.45, 0.30],
  }

  // Slight spread (Y-axis) to fan fingers apart naturally
  const spreadMap: Record<string, number> = {
    Thumb:  0.15,
    Index:  0.04,
    Middle: 0.0,
    Ring:   -0.04,
    Little: -0.08,
  }

  for (const side of sides) {
    const sign = side === 'left' ? 1 : -1

    for (const finger of fingers) {
      const curls = curlMap[finger]
      const spread = spreadMap[finger]

      for (let s = 0; s < segments.length; s++) {
        const boneName = `${side}${finger}${segments[s]}` as any
        const bone = humanoid.getNormalizedBoneNode(boneName)
        if (!bone) continue

        const z = sign * curls[s]
        // Only apply spread on the proximal segment
        const y = s === 0 ? sign * spread : 0

        bones.push({ bone, z, y })
      }
    }
  }

  return { bones }
}

function applyRelaxedHandPose(cache: HandPoseCache, time: number) {
  for (const { bone, z, y } of cache.bones) {
    // Subtle micro-movement: ±0.02 rad oscillation at slightly different
    // frequencies per bone (seeded by the base z value) to avoid uniformity
    const freq = 0.3 + Math.abs(z) * 2
    const micro = Math.sin(time * freq + z * 50) * 0.02
    bone.rotation.z = z + micro
    if (y !== 0) bone.rotation.y = y
  }
}


export const VRMScene = forwardRef<VRMSceneHandle, VRMSceneProps>(function VRMScene({
  modelPath,
  animationSettings = DEFAULT_ANIMATIONS,
  musicSettings = DEFAULT_MUSIC,
  headphoneFit = DEFAULT_FIT,
  qualitySettings,
  idleAnimationPath = '/idle_loop.vrma',
  cursorFollow,
  lightingSettings = DEFAULT_GLOBAL_LIGHTING,
  cursorLightSettings = DEFAULT_CURSOR_LIGHT,
  onTouch,
  pets = NO_PETS,
  props = NO_PROPS,
  onModelLoaded,
  onModelError,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number; confirmed: boolean }[]>([])
  const rippleIdRef = useRef(0)

  const spawnRipple = useCallback((x: number, y: number, confirmed: boolean) => {
    const id = ++rippleIdRef.current
    setRipples(prev => [...prev, { id, x, y, confirmed }])
    setTimeout(() => setRipples(prev => prev.filter(r => r.id !== id)), confirmed ? 700 : 500)
  }, [])

  const emoteRef = useRef<EmoteController | null>(null)
  const resetCameraRef = useRef<(() => void) | null>(null)
  // Exact camera view, persisted across model reloads so switching
  // characters never moves the user's camera.
  const cameraStateRef = useRef<CameraView | null>(null)
  const trackingModeRef = useRef<TrackingMode>('mouse')
  const cursorFollowRef = useRef(cursorFollow)
  cursorFollowRef.current = cursorFollow
  const lightingRef = useRef(normalizeGlobalLighting(lightingSettings))
  lightingRef.current = normalizeGlobalLighting(lightingSettings)
  const cursorLightRef = useRef(normalizeCursorLight(cursorLightSettings))
  cursorLightRef.current = normalizeCursorLight(cursorLightSettings)
  const motionRef = useRef<MotionController | null>(null)
  const panCameraRef = useRef<((dx: number, dy: number) => void) | null>(null)
  const rotateCameraRef = useRef<((dx: number, dy: number) => void) | null>(null)
  const lipSyncRef = useRef<LipSync>(LipSync.getInstance())
  const musicModeRef = useRef(false)
  const musicPreviewRef = useRef(false)
  const animationSettingsRef = useRef(animationSettings)
  animationSettingsRef.current = animationSettings
  useEffect(() => { motionRef.current?.setAnimationSettings(animationSettings) }, [animationSettings])
  const musicSettingsRef = useRef(musicSettings)
  musicSettingsRef.current = musicSettings
  const qualityDetailsRef = useRef(normalizeQualitySettings(qualitySettings))
  qualityDetailsRef.current = normalizeQualitySettings(qualitySettings)
  const headphoneFitRef = useRef(headphoneFit)
  headphoneFitRef.current = headphoneFit
  const musicMotionRef = useRef(new MusicMotion())
  const sipRequestedRef = useRef(false)
  const workingTargetRef = useRef(false)
  const sipBlendMirrorRef = useRef(0)
  const sipActiveMirrorRef = useRef(false)
  const sipResetRef = useRef(0)
  // Preview/loop state owned by the settings animations list transport.
  const actionLoopRef = useRef<string | null>(null)
  const sipLoopRef = useRef(false)
  const danceLoopRef = useRef(false)
  const pulseRef = useRef<{ id: string; until: number } | null>(null)
  const workingGenRef = useRef(0)
  const musicGenRef = useRef(0)
  const previewTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const previewGenReset = () => {
    workingGenRef.current++
    musicGenRef.current++
    for (const timer of previewTimersRef.current) clearTimeout(timer)
    previewTimersRef.current = []
  }
  /** Clear every loop/preview/pulse; a new playback command always starts clean. */
  const stopLoops = () => {
    previewGenReset()
    actionLoopRef.current = null
    sipLoopRef.current = false
    danceLoopRef.current = false
    pulseRef.current = null
    musicPreviewRef.current = false
  }
  // Set inside the render effect (it owns the rAF id); called via setSuspended.
  const suspendFnRef = useRef<(suspended: boolean) => void>(() => {})
  // Suspend state outlives scene re-inits (model change, hot reload) so a
  // lock that hid the window still shows it again on unlock.
  const suspendActiveRef = useRef(false)
  const fpsRef = useRef(0)
  const settingsResizeUntilRef = useRef(0)
  const effectiveMaxFpsRef = useRef(0)
  const frameStatsRef = useRef({ browserFps: 0, maxBrowserGapMs: 0, longBrowserGaps: 0, frameMs: 0, maxFrameMs: 0 })
  const renderPixelRatioRef = useRef(1)
  const captureScreenshotRef = useRef<() => string | null>(() => null)
  const companionsRef = useRef<CompanionLayer | null>(null)
  const companionConfigRef = useRef({ pets, props })
  companionConfigRef.current = { pets, props }
  useEffect(() => { companionsRef.current?.configure(pets, props) }, [pets, props])
  const onTouchRef = useRef(onTouch)
  onTouchRef.current = onTouch
  const onModelErrorRef = useRef(onModelError)
  onModelErrorRef.current = onModelError
  const onModelLoadedRef = useRef(onModelLoaded)
  onModelLoadedRef.current = onModelLoaded

  useImperativeHandle(ref, () => ({
    setEmotion(emotion: string, intensity?: number) {
      emoteRef.current?.setEmotion(emotion, intensity)
      companionsRef.current?.emotion(emotion)
    },
    setEmotionWithReset(emotion: string, durationMs: number, intensity?: number) {
      emoteRef.current?.setEmotionWithReset(emotion, durationMs, intensity)
      companionsRef.current?.emotion(emotion, Math.min(durationMs, 6000))
    },
    resetCamera() {
      resetCameraRef.current?.()
    },
    setTrackingMode(mode: TrackingMode) {
      trackingModeRef.current = mode
    },
    playAction(name: string, hold?: boolean) {
      stopLoops()
      motionRef.current?.playAction(name, hold)
    },
    playActionLoop(name: string) {
      stopLoops()
      motionRef.current?.resetToIdle()
      actionLoopRef.current = name
      void motionRef.current?.playAction(name, false)
    },
    captureScreenshot() {
      return captureScreenshotRef.current()
    },
    budgetSettingsResize() { settingsResizeUntilRef.current = performance.now() + SETTINGS_RESIZE_RECOVERY_MS },
    panCamera(dx: number, dy: number) {
      panCameraRef.current?.(dx, dy)
    },
    rotateCamera(dx: number, dy: number) {
      rotateCameraRef.current?.(dx, dy)
    },
    playDance(nameOrPreset: string | import('../motion-controller').DancePreset, preferenceKey?: string) {
      stopLoops()
      danceLoopRef.current = true
      void motionRef.current?.playDance(nameOrPreset, preferenceKey)
    },
    async playDanceOnce(nameOrPreset: string | import('../motion-controller').DancePreset, preferenceKey?: string) {
      stopLoops()
      await motionRef.current?.playDanceOnce(nameOrPreset, preferenceKey)
    },
    startSipLoop() {
      stopLoops()
      if (!workingTargetRef.current) motionRef.current?.resetToIdle()
      workingTargetRef.current = true
      sipRequestedRef.current = true
      sipLoopRef.current = true
    },
    pulseProcedural(id: string, loop: boolean) {
      pulseRef.current = { id, until: loop ? Infinity : performance.now() / 1000 + 5 }
    },
    stopDance() {
      stopLoops()
      motionRef.current?.resetToIdle()
    },
    isDancing() {
      return motionRef.current?.isDancing ?? false
    },
    setBgmVolume(v: number) {
      motionRef.current?.setVolume(v)
    },
    resetPose() {
      stopLoops()
      workingTargetRef.current = false
      sipRequestedRef.current = false
      sipResetRef.current++
      sipActiveMirrorRef.current = false
      sipBlendMirrorRef.current = 0
      motionRef.current?.resetToIdle()
      emoteRef.current?.resetAll()
    },
    reset() {
      // Deliberately no camera reset: state transitions (dance stop, work
      // done, etc.) must preserve the user's position/zoom. Explicit
      // reframe stays available via resetCamera (tray → camera).
      stopLoops()
      workingTargetRef.current = false
      sipRequestedRef.current = false
      sipResetRef.current++
      sipActiveMirrorRef.current = false
      sipBlendMirrorRef.current = 0
      motionRef.current?.resetToIdle()
      emoteRef.current?.resetAll()
    },
    async playAnimationOnce(name: string) {
      stopLoops()
      motionRef.current?.resetToIdle()
      await motionRef.current?.playAction(name, false)
    },
    setMusicMode(active: boolean) { musicModeRef.current = active },
    setMusicPreview(active: boolean, durationMs = 0) {
      musicPreviewRef.current = active
      if (active && durationMs > 0) {
        const gen = ++musicGenRef.current
        previewTimersRef.current.push(setTimeout(() => {
          if (musicGenRef.current === gen) musicPreviewRef.current = false
        }, durationMs))
      }
    },
    receiveMusicBeat(beat) {
      const age = Math.max(0, Date.now() / 1000 - beat.timestamp)
      musicMotionRef.current.receiveBeat(beat, performance.now() / 1000, age)
    },
    receiveMusicAudio(audio) {
      if (Math.abs(Date.now() / 1000 - audio.timestamp) > 2) return
      musicMotionRef.current.receiveAudio(audio.amplitude, audio.available, performance.now() / 1000)
    },
    requestCoffeeSip() { sipRequestedRef.current = true },
    isLooping() { return !!actionLoopRef.current || danceLoopRef.current || sipLoopRef.current },
    isBusy() {
      const motion = motionRef.current
      return sipRequestedRef.current || sipActiveMirrorRef.current || sipBlendMirrorRef.current > 0.05 || (!!motion && (motion.actionPlaying || motion.isDancing))
    },
    getRenderStats() {
      const canvas = canvasRef.current
      return { ...frameStatsRef.current, effectiveMaxFps: effectiveMaxFpsRef.current, settingsResizing: performance.now() < settingsResizeUntilRef.current,
        fps: fpsRef.current, pixelRatio: renderPixelRatioRef.current, width: canvas?.width ?? 0, height: canvas?.height ?? 0 }
    },
    getPlaybackStatus() {
      const motion = motionRef.current
      return {
        actionId: motion?.currentAnimationId() ?? null,
        dancing: motion?.isDancing ?? false,
        danceId: motion?.danceId ?? null,
        working: workingTargetRef.current,
        sipping: sipBlendMirrorRef.current > 0.05,
        musicMotion: (musicModeRef.current || musicPreviewRef.current) && !motion?.actionPlaying && !motion?.isDancing,
      }
    },
    setWorking(active: boolean, durationMs = 0) {
      // Never cut a one-shot action: a working frame arriving mid-preview
      // would reset the mixer and kill the clip (the render loop already
      // yields the typing layer while an action plays).
      if (active && !workingTargetRef.current && !motionRef.current?.actionPlaying) motionRef.current?.resetToIdle()
      workingTargetRef.current = active
      if (active && durationMs > 0) {
        const gen = ++workingGenRef.current
        previewTimersRef.current.push(setTimeout(() => {
          if (workingGenRef.current === gen) workingTargetRef.current = false
        }, durationMs))
      }
    },
    setSuspended(suspended: boolean) {
      suspendFnRef.current(suspended)
    },
    companion(action: CompanionAction) {
      companionsRef.current?.apply(action)
    },
    snapshotCompanions() {
      return companionsRef.current?.snapshot() ?? null
    },
    restoreCompanions(snapshot) {
      companionsRef.current?.restore(snapshot)
    },
  }), [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: false,
    })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x000000, 0)

    // Capture immediately after an explicit render. Keeping every drawing buffer
    // alive just for occasional screenshots adds work to every normal frame.
    captureScreenshotRef.current = () => {
      if (disposed) return null
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      return canvas.toDataURL('image/png')
    }

    // ── Scene ─────────────────────────────────────────────────────────────────
    const scene = new THREE.Scene()

    // ── Camera ────────────────────────────────────────────────────────────────
    const FOV = 40
    const camera = new THREE.PerspectiveCamera(
      FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    )
    // Orbit state: camera orbits around the pivot point
    // Will be recalculated after model loads (like airi)
    const pivot = new THREE.Vector3(0, 0, 0)
    let orbitRadius = 2.0
    let orbitTheta = 0       // horizontal angle (radians)
    let orbitPhi = Math.PI / 2 // vertical angle (radians), PI/2 = eye level
    // Set once a model finishes loading and the camera is framed on it.
    // The unmount snapshot below must only run when this is true: saving the
    // pre-framing defaults (pivot at feet, radius 2m) poisons the next load,
    // which would restore them and show legs-only with the head cut off.
    let framingApplied = false

    function updateCameraOrbit() {
      camera.position.set(
        pivot.x + orbitRadius * Math.sin(orbitPhi) * Math.sin(orbitTheta),
        pivot.y + orbitRadius * Math.cos(orbitPhi),
        pivot.z + orbitRadius * Math.sin(orbitPhi) * Math.cos(orbitTheta),
      )
      camera.lookAt(pivot)
    }

    // Snapshot the view to the session ref + localStorage (survives restarts).
    // Called on user-driven moves only — never on model-fit framing.
    function saveCameraViewNow() {
      const view = {
        pivot: [pivot.x, pivot.y, pivot.z] as [number, number, number],
        radius: orbitRadius,
        theta: orbitTheta,
        phi: orbitPhi,
      }
      cameraStateRef.current = view
      saveCameraView(view)
    }
    updateCameraOrbit()

    // ── Lights ────────────────────────────────────────────────────────────────
    // Global rig (ambient wash + key + fill) with the same defaults as
    // before; colors/intensities are driven per-frame from lightingRef so
    // the settings panel can customize them live.
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambientLight)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(1, 2, 3)
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-2, 1, -1)
    scene.add(fillLight)
    // Cursor light rig: up to MAX_CURSOR_LIGHTS point lights plus the same
    // number of spotlights following the mouse (point = glow around the
    // cursor, spot = beams from the cursor onto the pet). Only the active
    // kind's first `lightCount` entries are visible. No shadows: keeps the
    // extra lights cheap.
    const cursorPoints: THREE.PointLight[] = []
    const cursorSpots: THREE.SpotLight[] = []
    for (let i = 0; i < MAX_CURSOR_LIGHTS; i++) {
      const point = new THREE.PointLight(0xffffff, 2, 0, 2)
      point.visible = false
      scene.add(point)
      cursorPoints.push(point)
      const spot = new THREE.SpotLight(0xffffff, 6, 0, THREE.MathUtils.degToRad(30), 0.5, 2)
      spot.visible = false
      scene.add(spot)
      scene.add(spot.target)
      cursorSpots.push(spot)
    }
    // Soft additive glow orbs marking each rig light (size from settings).
    const glowTexture = (() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 128
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
        gradient.addColorStop(0, 'rgba(255,255,255,1)')
        gradient.addColorStop(0.35, 'rgba(255,255,255,0.5)')
        gradient.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 128, 128)
      }
      return new THREE.CanvasTexture(canvas)
    })()
    const cursorGlows: THREE.Sprite[] = []
    for (let i = 0; i < MAX_CURSOR_LIGHTS; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }))
      sprite.visible = false
      scene.add(sprite)
      cursorGlows.push(sprite)
    }
    const applyGlobalLighting = () => {
      const g = lightingRef.current
      ambientLight.color.set(g.ambientColor)
      ambientLight.intensity = g.ambientIntensity
      dirLight.color.set(g.keyColor)
      dirLight.intensity = g.keyIntensity
      fillLight.color.set(g.fillColor)
      fillLight.intensity = g.fillIntensity
      companionsRef.current?.setStageLighting(g)
    }
    applyGlobalLighting()
    // Cursor anchor state: world target on a plane through the model focus,
    // plus the focus point itself (model center once loaded, origin fallback).
    // cursorLightBase is the eased anchor; rig lights add motion offsets to it.
    const cursorLightTarget = new THREE.Vector3(0, 1, 1)
    const cursorLightBase = new THREE.Vector3(0, 1, 1)
    const lightFocus = new THREE.Vector3(0, 1, 0)
    let lightningUntil = 0

    // ── Loader ───────────────────────────────────────────────────────────────
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    // Pets and props: plain GLB assets from the user's library.
    const companionLoader = new GLTFLoader()
    const companions = new CompanionLayer(scene, url => companionLoader.loadAsync(url), companionAssetUrl)
    companionsRef.current = companions
    companions.setStageLighting(lightingRef.current)
    companions.setEnvironment(() => {
      const pmrem = new THREE.PMREMGenerator(renderer)
      const room = new RoomEnvironment()
      const texture = pmrem.fromScene(room, 0.04).texture
      room.dispose()
      pmrem.dispose()
      return texture
    })
    companions.configure(companionConfigRef.current.pets, companionConfigRef.current.props)

    // ── State ─────────────────────────────────────────────────────────────────
    let vrm: VRM | null = null
    let disposed = false
    let motion: MotionController | null = null
    let emote: EmoteController | null = null
    let earMorphSlots: EarMorphSlot[] = []
    let handPose: HandPoseCache | null = null
    let typingCache: TypingPoseCache | null = null
    let laptop: THREE.Object3D | null = null
    let phone: THREE.Object3D | null = null
    let cup: THREE.Object3D | null = null
    let headphones: THREE.Group | null = null
    let workingBlend = 0
    // Coffee-sip state: sipActive while raising/lowering, sipBlend eases 0→1→0
    let sipActive = false
    let sipBlend = 0
    let sipT0 = 0
    let nextSipAt = Infinity
    let lastSipReset = sipResetRef.current
    // Head-center → face-surface distance, raycast once per model so the
    // sip target sits outside the skull on any head shape. Null = unmeasured.
    let faceOffset: number | null = null
    const blinkState = createBlinkState()
    const saccades = new EyeSaccadeController()
    const lookAtTarget = { x: 0, y: 0, z: -100 }

    // ── Load VRM model, then load idle animation ─────────────────────────────
    loader.load(
      modelPath,
      async (gltf) => {
        if (disposed) { VRMUtils.deepDispose(gltf.scene); return }
        const loadedVrm = gltf.userData.vrm as VRM
        if (!loadedVrm) {
          console.error('No VRM data found in GLTF')
          onModelErrorRef.current?.('This file does not contain a supported VRM character.')
          return
        }

        VRMUtils.removeUnnecessaryVertices(loadedVrm.scene)
        VRMUtils.combineSkeletons(loadedVrm.scene)
        // Shared materials across shader variants make three.js switch
        // programs on every draw; give each variant its own material.
        splitVrmMaterialVariants(loadedVrm)
        loadedVrm.scene.traverse((obj) => {
          obj.frustumCulled = false
        })

        // Add lookAt quaternion proxy (from airi — needed for lookAt to work)
        if (loadedVrm.lookAt) {
          const lookAtQuatProxy = new VRMLookAtQuaternionProxy(loadedVrm.lookAt)
          lookAtQuatProxy.name = 'lookAtQuaternionProxy'
          loadedVrm.scene.add(lookAtQuatProxy)
        }

        // Normalize VRM 0.x to match 1.0 convention, then face camera
        VRMUtils.rotateVRM0(loadedVrm)

        scene.add(loadedVrm.scene)
        vrm = loadedVrm

        // ── Compute camera from model bounds (airi style) ───────────────────
        const box = new THREE.Box3().setFromObject(loadedVrm.scene)
        const modelSize = new THREE.Vector3()
        const modelCenter = new THREE.Vector3()
        box.getSize(modelSize)
        box.getCenter(modelCenter)
        // Cursor spotlight aims here; the cursor-light anchor plane passes
        // through it so the light sits at the pet's depth on any model.
        lightFocus.copy(modelCenter)

        const framing = defaultViewFromBounds(modelSize, modelCenter, FOV)
        pivot.set(framing.pivot[0], framing.pivot[1], framing.pivot[2])
        orbitRadius = framing.radius
        orbitTheta = framing.theta
        orbitPhi = framing.phi
        updateCameraOrbit()
        framingApplied = true

        // Restore the exact pre-switch view when changing characters.
        // First load (no saved view) keeps the model-fitted defaults above.
        // The snapshot is validated: a view saved before any model finished
        // loading (e.g. StrictMode double-mount) holds the pre-framing orbit
        // defaults (pivot at feet, radius 2m) and must never be restored —
        // that parks the camera at foot level (legs-only, head cut off).
        const savedView = cameraStateRef.current ?? loadSavedCameraView()
        if (savedView && isValidView(savedView)) {
          pivot.set(savedView.pivot[0], savedView.pivot[1], savedView.pivot[2])
          orbitRadius = savedView.radius
          orbitTheta = savedView.theta
          orbitPhi = savedView.phi
          updateCameraOrbit()
        }

        // Store initial state for reset
        const initPivot = pivot.clone()
        const initRadius = orbitRadius
        const initTheta = orbitTheta
        const initPhi = orbitPhi
        resetCameraRef.current = () => {
          pivot.copy(initPivot)
          orbitRadius = initRadius
          orbitTheta = initTheta
          orbitPhi = initPhi
          updateCameraOrbit()
          saveCameraViewNow()
        }

        panCameraRef.current = (dx: number, dy: number) => {
          const right = new THREE.Vector3()
          const up = new THREE.Vector3()
          camera.getWorldDirection(new THREE.Vector3())
          right.setFromMatrixColumn(camera.matrixWorld, 0) // camera right
          up.setFromMatrixColumn(camera.matrixWorld, 1)    // camera up
          pivot.addScaledVector(right, -dx * 0.003)
          pivot.addScaledVector(up, dy * 0.003)
          updateCameraOrbit()
          saveCameraViewNow()
        }

        rotateCameraRef.current = (dx: number, dy: number) => {
          orbitTheta -= dx * 0.005
          orbitPhi = THREE.MathUtils.clamp(
            orbitPhi - dy * 0.005,
            0.1,
            Math.PI - 0.1,
          )
          updateCameraOrbit()
          saveCameraViewNow()
        }

        companions.setCharacter({
          root: loadedVrm.scene,
          height: modelSize.y,
          floorY: box.min.y,
          topY: box.max.y,
          bone: name => loadedVrm.humanoid?.getNormalizedBoneNode(name as any) ?? null,
        })

        // Build hand pose cache (applied every frame in animate loop)
        handPose = buildHandPoseCache(loadedVrm)
        typingCache = buildTypingPoseCache(loadedVrm)

        // Lightweight native prop, scaled with the avatar and attached to its head.
        const headBone = loadedVrm.humanoid?.getNormalizedBoneNode('head')
        if (headBone) {
          headphones = new THREE.Group()
          const radius = modelSize.y * 0.075
          const plastic = new THREE.MeshStandardMaterial({ color: 0x252533, roughness: 0.6 })
          const accent = new THREE.MeshStandardMaterial({ color: 0x66bbff, roughness: 0.4 })
          const band = new THREE.Mesh(new THREE.TorusGeometry(radius, radius * 0.09, 8, 32, Math.PI), plastic)
          headphones.add(band)
          for (const side of [-1, 1]) {
            const pad = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.3, radius * 0.3, radius * 0.25, 16), accent)
            pad.rotation.z = Math.PI / 2
            pad.position.x = side * radius
            headphones.add(pad)
          }
          headphones.userData.modelHeight = modelSize.y
          headphones.visible = false
          headBone.add(headphones)
        }

        // Laptop prop for working mode (CC0 model by Kenney). Positioned in
        // front of the pet at waist height; hidden unless working.
        // Keep the keyboard and screen facing the pet, not the viewer.
        new GLTFLoader().load(
          '/laptop.glb',
          (laptopGltf) => {
            if (disposed) { VRMUtils.deepDispose(laptopGltf.scene); return }
            const left = typingCache?.upperL?.getWorldPosition(new THREE.Vector3())
            const right = typingCache?.upperR?.getWorldPosition(new THREE.Vector3())
            const shoulderSpan = left && right ? Math.abs(left.x - right.x) : 0
            laptop = prepareLaptop(laptopGltf.scene, Math.max(modelSize.y * .28, shoulderSpan * 1.3) * .6)
            laptop.position.set(modelCenter.x, box.min.y + modelSize.y * .38, modelCenter.z + .15)
            laptop.visible = false
            scene.add(laptop)
          },
          undefined,
          (laptopErr) => console.warn('Failed to load laptop prop:', laptopErr),
        )

        // Hand props: cellphone (shown during phoneCall action) and coffee
        // cup (shown during working coffee sips). Both ride on the right
        // hand bone; scale is normalized by bounding box since sources vary.
        const propLoader = new GLTFLoader()
        function attachHandProp(url: string, targetHeight: number, offset: [number, number, number], set: (o: THREE.Object3D) => void) {
          propLoader.load(
            url,
            (gltf) => {
              if (disposed) { VRMUtils.deepDispose(gltf.scene); return }
              const asset = gltf.scene
              const obj = new THREE.Group()
              obj.add(asset)
              const bbox = new THREE.Box3().setFromObject(obj)
              const size = new THREE.Vector3()
              bbox.getSize(size)
              const center = bbox.getCenter(new THREE.Vector3())
              if (url === '/cup.glb') asset.position.sub(center)
              else asset.position.set(0, 0, 0)
              if (size.y > 0) obj.scale.multiplyScalar(targetHeight / size.y)
              obj.position.set(...offset)
              obj.visible = false
              if (typingCache?.handR) {
                typingCache.handR.add(obj)
                set(obj)
              } else {
                console.warn(`No right-hand bone for prop ${url}`)
                VRMUtils.deepDispose(obj)
              }
            },
            undefined,
            (err) => console.warn(`Failed to load prop ${url}:`, err),
          )
        }
        attachHandProp('/phone.glb', 0.16, [0.02, 0.05, 0.04], (o) => { phone = o })
        attachHandProp('/cup.glb', modelSize.y * .065, [0, 0, 0], (o) => { cup = o; scene.attach(cup); cup.userData.height = modelSize.y * .065; cup.rotation.set(0, Math.PI / 2 + Math.PI, 0) })

        // Initialize emote controller
        emote = new EmoteController(loadedVrm)
        emoteRef.current = emote

        // Collect ear-mesh morph slots (blink expressions yank ear verts).
        earMorphSlots = collectEarMorphSlots(loadedVrm.expressionManager?.expressions)

        // ── Initialize MotionController ──────────────────────────────────────
        motion = new MotionController(loadedVrm)
        motion.setAnimationSettings(animationSettingsRef.current)
        motionRef.current = motion
        // Show the cellphone prop while the phoneCall action is playing
        motion.onActionChange = (actionName) => {
          if (phone) phone.visible = actionName === 'phoneCall'
          // Looped action preview: replay on every finish until stopped.
          // (stopLoops clears the ref before resetToIdle, so the stop path
          // never replays.)
          if (!actionName && actionLoopRef.current && motionRef.current
            && !motionRef.current.isDancing) {
            void motionRef.current.playAction(actionLoopRef.current, false)
          }
        }

        // Animation state changes leave the user’s camera framing untouched.

        // Load idle animation (non-blocking for fast startup)
        motion.loadIdle(idleAnimationPath).catch((err) =>
          console.warn('Failed to load idle animation:', err),
        )

        // Reset spring bones after everything is set up
        loadedVrm.springBoneManager?.reset()

        // Notify parent that model is ready (for auto-screenshot etc.)
        // Delay slightly so the first frame is rendered
        setTimeout(() => onModelLoadedRef.current?.(), 500)
      },
      () => {},
      (err) => {
        console.error('Failed to load VRM:', err)
        onModelErrorRef.current?.('Could not load the model. Check that the pet server is running and choose a valid .vrm file.')
      },
    )

    // ── Mouse tracking ────────────────────────────────────────────────────────
    const mouse = new THREE.Vector2(0, 0)
    // Last cursor position and the last time anything moved the pet (idle frame cap).
    const lastCursor = { x: NaN, y: NaN }
    let lastActivity = performance.now()
    // Damped idle head-turn angles (radians); eased back to neutral whenever
    // the pet isn't idle so dances and actions own the head.
    let headTurnYaw = 0
    let headTurnPitch = 0
    // Eye gain the gaze target was last aimed with (0 = not following).
    let aimedEyes = 0

    /** Effective eye/head follow this frame (mouse tracking only). */
    function currentFollow(): CursorFollow {
      if (trackingModeRef.current !== 'mouse') return { eyes: 0, head: 0 }
      const entry = cursorFollowRef.current?.()
      if (entry) return entry
      // No behavior entry playing: follow only while nothing else drives the
      // head, fading the head glance out as the typing pose blends in.
      if (motion?.isDancing || motion?.actionPlaying) return { eyes: 0, head: 0 }
      return { eyes: workingBlend > 0.5 ? 0 : DEFAULT_GAZE_GAIN, head: DEFAULT_HEAD_TURN_GAIN * (1 - workingBlend) }
    }

    const _raycaster = new THREE.Raycaster()
    const _mouseVec = new THREE.Vector2()
    const gazeCameraDirection = new THREE.Vector3()
    const gazePlaneCenter = new THREE.Vector3()
    const gazeIntersection = new THREE.Vector3()
    const gazePlane = new THREE.Plane()

    // Shared gaze path: point the eyes at a window client-pixel position.
    // DOM mousemove only reaches us over the silhouette (click-through /
    // input regions starve it elsewhere), so the Rust cursor-position feed
    // below drives the same path with the global cursor position.
    function updateGazeFromClient(clientX: number, clientY: number) {
      if (clientX !== lastCursor.x || clientY !== lastCursor.y) {
        lastCursor.x = clientX
        lastCursor.y = clientY
        lastActivity = performance.now()
      }
      mouse.x = (clientX / window.innerWidth) * 2 - 1
      mouse.y = -(clientY / window.innerHeight) * 2 + 1

      _mouseVec.set(mouse.x, mouse.y)
      _raycaster.setFromCamera(_mouseVec, camera)
      const camDir = camera.getWorldDirection(gazeCameraDirection)
      // Cursor light anchor runs in every tracking mode: intersect the cursor
      // ray with a plane through the model focus so the light sits at the
      // pet's depth, nudged toward the camera so it lights the front instead
      // of the interior.
      {
        const focusPlane = gazePlane
        focusPlane.setFromNormalAndCoplanarPoint(camDir, lightFocus)
        const hit = gazeIntersection
        if (_raycaster.ray.intersectPlane(focusPlane, hit)) {
          cursorLightTarget.copy(hit).addScaledVector(camDir, -0.6)
        }
      }

      const eyes = currentFollow().eyes
      if (eyes > 0) aimEyesAtCursor(eyes)
    }
    // Point the eyes at the last cursor position, like airi's lookAtMouse,
    // amplified so small cursor moves read clearly (VRM eye limits still cap
    // the extremes).
    function aimEyesAtCursor(gain: number) {
      aimedEyes = gain
      _mouseVec.set(mouse.x, mouse.y)
      _raycaster.setFromCamera(_mouseVec, camera)
      const camDir = camera.getWorldDirection(gazeCameraDirection)
      const planeCenter = gazePlaneCenter.copy(camera.position).add(camDir)
      const plane = gazePlane
      plane.setFromNormalAndCoplanarPoint(camDir, planeCenter)
      const intersection = gazeIntersection
      if (_raycaster.ray.intersectPlane(plane, intersection)) {
        lookAtTarget.x = planeCenter.x + (intersection.x - planeCenter.x) * gain
        lookAtTarget.y = planeCenter.y + (intersection.y - planeCenter.y) * gain
        lookAtTarget.z = planeCenter.z + (intersection.z - planeCenter.z) * gain
        if (vrm) {
          saccades.instantUpdate(vrm, lookAtTarget)
        }
      }
    }
    function onMouseMove(e: MouseEvent) {
      updateGazeFromClient(e.clientX, e.clientY)
    }
    // Listen on both window and document to handle transparent window cases
    window.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mousemove', onMouseMove)
    // Global cursor feed from the Rust monitor: keeps the eyes following the
    // cursor even where the OS delivers no DOM mouse events (click-through /
    // silhouette input regions). Pass-through ignores these events (its gate
    // is the input region), so this only moves the gaze.
    const unlistenGaze = listen<CursorPositionPayload>('cursor-position', (event) => {
      const { clientX, clientY } = cursorPayloadToClient(
        event.payload,
        window.innerWidth,
        window.innerHeight,
      )
      updateGazeFromClient(clientX, clientY)
    })

    // ── Cursor light ─────────────────────────────────────────────────────────
    // Eases the shared anchor toward the cursor target, then positions each
    // rig light around it (motion offset) and animates the preset's effect.
    // Runs even with no model loaded so the light still responds while a
    // character downloads.
    const scratchColor = new THREE.Color()
    const flameHot = new THREE.Color('#ff2a00')
    const strikeColor = new THREE.Color('#e8f2ff')
    function stepCursorLight(delta: number, elapsed: number) {
      const cl = cursorLightRef.current
      const count = cl.enabled ? Math.min(cl.lightCount, MAX_CURSOR_LIGHTS) : 0
      const isSpot = cl.kind === 'spot'
      // Anchor: hard snaps, soft eases toward the target each frame.
      if (cl.anchor === 'hard') cursorLightBase.copy(cursorLightTarget)
      else cursorLightBase.lerp(cursorLightTarget, 1 - Math.exp(-delta * cl.followSpeed))
      // Lightning strikes are rig-wide: every light flashes together.
      let striking = elapsed < lightningUntil
      if (cl.enabled && cl.preset === 'lightning' && !striking
        && Math.random() < delta * (0.4 + cl.effectSpeed * 0.6)) {
        lightningUntil = elapsed + 0.08 + Math.random() * 0.12
        striking = true
      }
      for (let i = 0; i < MAX_CURSOR_LIGHTS; i++) {
        const on = i < count
        const light = isSpot ? cursorSpots[i] : cursorPoints[i]
        const other = isSpot ? cursorPoints[i] : cursorSpots[i]
        other.visible = false
        light.visible = on
        const glow = cursorGlows[i]
        if (!on) { glow.visible = false; continue }
        const [ox, oy, oz] = cursorLightOffset(cl.motion, i, count, cl.motionRadius, cl.motionSpeed, elapsed)
        light.position.set(
          cursorLightBase.x + ox,
          cursorLightBase.y + oy,
          cursorLightBase.z + oz,
        )
        light.distance = cl.distance
        light.decay = cl.decay
        // Base color/intensity; effects below modulate them per light.
        let intensity = cl.intensity
        scratchColor.set(cl.color)
        if (cl.preset === 'rgb') {
          // Extras spread evenly around the hue wheel from light 0's phase.
          scratchColor.setHSL((elapsed * 0.12 * cl.effectSpeed + i / count) % 1, 0.85, 0.6)
        } else if (cl.preset === 'flame') {
          const t = elapsed * (4 + cl.effectSpeed * 4) + i * 1.7
          const flicker = 0.78
            + 0.12 * Math.sin(t * 1.0)
            + 0.07 * Math.sin(t * 2.7 + 1.3)
            + 0.05 * Math.sin(t * 6.1 + 4.1)
          intensity *= flicker
          scratchColor.lerp(flameHot, 0.25 + 0.2 * Math.sin(t * 0.7))
        } else if (cl.preset === 'lightning') {
          // Mostly a dim charge glow, broken by brief full-power strikes.
          if (striking) {
            scratchColor.copy(strikeColor)
            intensity *= 1.6
          } else {
            intensity *= 0.12
          }
        }
        if (cl.motion === 'fireflies') intensity *= fireflyBlink(elapsed, cl.motionSpeed, i)
        light.color.copy(scratchColor)
        light.intensity = intensity
        if (isSpot) {
          const spot = light as THREE.SpotLight
          spot.angle = THREE.MathUtils.degToRad(cl.angle)
          spot.penumbra = cl.penumbra
          spot.target.position.copy(lightFocus)
          spot.target.updateMatrixWorld()
        }
        glow.visible = cl.glowSize > 0.001
        if (glow.visible) {
          glow.position.copy(light.position)
          glow.scale.set(cl.glowSize, cl.glowSize, 1)
          ;(glow.material as THREE.SpriteMaterial).color.copy(scratchColor)
        }
      }
    }

    // ── Scroll zoom ──────────────────────────────────────────────────────────
    const MIN_RADIUS = 0.8
    const MAX_RADIUS = 5.0
    const ZOOM_SPEED = 0.002

    // True when the cursor is over an actual mesh (not transparent space).
    // All viewport interactions (zoom, drag, window-move) are gated on this
    // so empty pixels never steal clicks/scrolls from windows behind the pet.
    function pointerOverModel(clientX: number, clientY: number): boolean {
      if (!vrm) return false
      touchMouseVec.set(
        (clientX / window.innerWidth) * 2 - 1,
        -(clientY / window.innerHeight) * 2 + 1,
      )
      touchRaycaster.setFromCamera(touchMouseVec, camera)
      return intersectAnimatedModel(touchRaycaster, vrm.scene).length > 0 || companions.intersects(touchRaycaster)
    }

    /** Pet under the cursor when it is in front of the character. */
    function petUnderPointer(clientX: number, clientY: number): string | null {
      if (!vrm) return null
      touchMouseVec.set(
        (clientX / window.innerWidth) * 2 - 1,
        -(clientY / window.innerHeight) * 2 + 1,
      )
      touchRaycaster.setFromCamera(touchMouseVec, camera)
      const pet = companions.hitPet(touchRaycaster)
      if (!pet) return null
      const character = intersectAnimatedModel(touchRaycaster, vrm.scene)[0]
      return !character || pet.distance <= character.distance ? pet.id : null
    }

    function onWheel(e: WheelEvent) {
      lastActivity = performance.now()
      if (!pointerOverModel(e.clientX, e.clientY)) return
      e.preventDefault()
      orbitRadius = THREE.MathUtils.clamp(
        orbitRadius + e.deltaY * ZOOM_SPEED,
        MIN_RADIUS,
        MAX_RADIUS,
      )
      updateCameraOrbit()
      saveCameraViewNow()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // ── Drag controls ──────────────────────────────────────────────────────
    // Left drag: move window (startDragging)
    // Middle drag: dolly (zoom)
    // Right drag: rotate around model
    let dragMode: 'rotate' | 'dolly' | 'pan' | null = null
    let prevX = 0
    let prevY = 0
    const ROTATE_SPEED = 0.005
    const PAN_SPEED = 0.003
    const DOLLY_SPEED = 0.01

    // ── Touch interaction: detect body region from raycast hit ────────────
    const touchRaycaster = new THREE.Raycaster()
    const touchMouseVec = new THREE.Vector2()
    const faceRaycaster = new THREE.Raycaster()

    // Cast from outside the face back toward the head: first hit is the face
    // surface (an inside-out ray would hit culled backfaces and miss).
    // Result is the head-bone → face distance, used to park the sip target
    // outside the skull. Falls back to 12cm on any degenerate measurement.
    function measureFaceOffset(): number {
      const head = typingCache?.head
      if (!head || !vrm || !typingCache) return 0.12
      // Eye-located forward (world space) — see faceDirection: root- and
      // head-axis-derived signs both lie on some imports.
      const fwd = faceDirection(typingCache)
      const c = head.getWorldPosition(new THREE.Vector3())
      const origin = c.clone().addScaledVector(fwd, 0.5)
      origin.y -= 0.02
      faceRaycaster.set(origin, fwd.negate())
      const hits = faceRaycaster.intersectObject(vrm.scene, true)
      if (!hits.length) return 0.12
      const surf = 0.5 - origin.distanceTo(hits[0].point)
      return surf >= 0.06 && surf <= 0.30 ? surf : 0.12
    }
    let lastTapTime = 0
    let lastTapRegion: TouchRegion | null = null
    let lastTouchFireTime = 0
    const DOUBLE_TAP_WINDOW = 500 // ms
    const TOUCH_COOLDOWN = 5_000 // ms

    // Bone-to-region mapping for proximity-based touch detection
    const boneRegionMap: [string, TouchRegion][] = [
      // Head
      ['head', 'head'], ['neck', 'head'],
      ['leftEye', 'head'], ['rightEye', 'head'], ['jaw', 'head'],
      // Arms
      ['leftShoulder', 'arm'], ['leftUpperArm', 'arm'], ['leftLowerArm', 'arm'], ['leftHand', 'arm'],
      ['rightShoulder', 'arm'], ['rightUpperArm', 'arm'], ['rightLowerArm', 'arm'], ['rightHand', 'arm'],
      // Legs
      ['leftUpperLeg', 'leg'], ['leftLowerLeg', 'leg'], ['leftFoot', 'leg'], ['leftToes', 'leg'],
      ['rightUpperLeg', 'leg'], ['rightLowerLeg', 'leg'], ['rightFoot', 'leg'], ['rightToes', 'leg'],
      // Torso
      ['chest', 'chest'], ['upperChest', 'chest'],
      ['spine', 'belly'],
      ['hips', 'buttocks'],
    ]
    const _bonePos = new THREE.Vector3()

    function detectTouchRegion(e: PointerEvent): TouchRegion | null {
      if (!vrm?.humanoid) return null

      touchMouseVec.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      )
      touchRaycaster.setFromCamera(touchMouseVec, camera)

      const intersects = intersectAnimatedModel(touchRaycaster, vrm.scene)
      if (intersects.length === 0) return null

      const hitPoint = intersects[0].point

      // Find closest bone to hit point
      let closestRegion: TouchRegion = 'belly'
      let closestDist = Infinity

      for (const [boneName, region] of boneRegionMap) {
        const bone = vrm.humanoid.getNormalizedBoneNode(boneName as any)
        if (!bone) continue
        bone.getWorldPosition(_bonePos)
        const dist = hitPoint.distanceToSquared(_bonePos)
        if (dist < closestDist) {
          closestDist = dist
          closestRegion = region
        }
      }

      return closestRegion
    }

    // ── Left-click: distinguish click (touch) vs drag (move window) ────
    let leftDownPos: { x: number; y: number; time: number; region: TouchRegion | null; pet?: string } | null = null
    const CLICK_MOVE_THRESHOLD = 5  // px
    const CLICK_TIME_THRESHOLD = 300 // ms

    function startWindowDrag() {
      // Native dragging can consume pointerup; always release our input hold.
      void getCurrentWindow().startDragging().catch(console.error).finally(() => {
        ;(window as any).__clawDragging = false
      })
    }

    function onPointerDown(e: PointerEvent) {
      lastActivity = performance.now()
      // Transparent space is click-through: ignore presses that don't start
      // on a mesh so the pet never steals clicks from windows behind it.
      // (When pass-through is engaged the OS won't deliver these at all;
      // this gate covers the transition and pass-through-off states.)
      if (e.button > 2 || !pointerOverModel(e.clientX, e.clientY)) return
      // A gesture is starting on the model: hold click-through off so the
      // cursor monitor can't enable ignore-cursor-events mid-drag (e.g. the
      // model rotating out from under the cursor) and deafen the canvas.
      ;(window as any).__clawDragging = true
      if (e.button === 0) {
        const pet = petUnderPointer(e.clientX, e.clientY)
        if (pet) {
          leftDownPos = { x: e.clientX, y: e.clientY, time: Date.now(), region: null, pet }
          return
        }
        const region = detectTouchRegion(e)
        if (region) {
          // Might be a touch — wait for pointerup to confirm it's not a drag
          leftDownPos = { x: e.clientX, y: e.clientY, time: Date.now(), region }
          return
        }
        // On model but no region (shouldn't happen) — move window
        startWindowDrag()
        return
      } else if (e.button === 1) {
        dragMode = e.shiftKey ? 'pan' : 'dolly'
        e.preventDefault()
      } else if (e.button === 2) {
        dragMode = 'rotate'
      } else {
        return
      }
      prevX = e.clientX
      prevY = e.clientY
      canvas!.setPointerCapture(e.pointerId)
    }

    function onPointerMove(e: PointerEvent) {
      lastActivity = performance.now()
      // If left button held on model and moved beyond threshold → it's a drag, not a touch
      if (leftDownPos && e.buttons & 1) {
        const dx = Math.abs(e.clientX - leftDownPos.x)
        const dy = Math.abs(e.clientY - leftDownPos.y)
        if (dx > CLICK_MOVE_THRESHOLD || dy > CLICK_MOVE_THRESHOLD) {
          leftDownPos = null
          startWindowDrag()
          return
        }
      }
      if (!dragMode) return
      const dx = e.clientX - prevX
      const dy = e.clientY - prevY
      prevX = e.clientX
      prevY = e.clientY

      if (dragMode === 'rotate') {
        orbitTheta -= dx * ROTATE_SPEED
        orbitPhi = THREE.MathUtils.clamp(
          orbitPhi - dy * ROTATE_SPEED,
          0.1,
          Math.PI - 0.1,
        )
      } else if (dragMode === 'dolly') {
        orbitRadius = THREE.MathUtils.clamp(
          orbitRadius + dy * DOLLY_SPEED,
          MIN_RADIUS,
          MAX_RADIUS,
        )
      } else if (dragMode === 'pan') {
        panCameraRef.current?.(dx, dy)
      }
      updateCameraOrbit()
      saveCameraViewNow()
    }

    function onPointerUp(e: PointerEvent) {
      ;(window as any).__clawDragging = false
      // Confirm touch: short press with no movement on model
      if (leftDownPos && e.button === 0) {
        ;(window as any).__clawDragging = false
        const elapsed = Date.now() - leftDownPos.time
        const dx = Math.abs(e.clientX - leftDownPos.x)
        const dy = Math.abs(e.clientY - leftDownPos.y)
        if (leftDownPos.pet && elapsed < CLICK_TIME_THRESHOLD && dx <= CLICK_MOVE_THRESHOLD && dy <= CLICK_MOVE_THRESHOLD) {
          spawnRipple(e.clientX, e.clientY, true)
          companions.click(leftDownPos.pet)
        } else if (elapsed < CLICK_TIME_THRESHOLD && dx <= CLICK_MOVE_THRESHOLD && dy <= CLICK_MOVE_THRESHOLD) {
          const now = Date.now()
          const region = leftDownPos.region!
          if (now - lastTapTime < DOUBLE_TAP_WINDOW && lastTapRegion === region && now - lastTouchFireTime > TOUCH_COOLDOWN) {
            // Double-tap confirmed
            lastTouchFireTime = now
            spawnRipple(e.clientX, e.clientY, true)
            onTouchRef.current?.(region)
            lastTapTime = 0
            lastTapRegion = null
          } else {
            // First tap — wait for second
            spawnRipple(e.clientX, e.clientY, false)
            lastTapTime = now
            lastTapRegion = region
          }
        }
        leftDownPos = null
        return
      }
      if (dragMode) {
        dragMode = null
        ;(window as any).__clawDragging = false
        try { canvas!.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      }
    }

    function onPointerCancel(e: PointerEvent) {
      leftDownPos = null
      dragMode = null
      ;(window as any).__clawDragging = false
      try { canvas!.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    }

    function onContextMenu(e: Event) {
      e.preventDefault()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('contextmenu', onContextMenu)

    // ── Resize ────────────────────────────────────────────────────────────────
    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onResize)

    // ── Hit-test for window pass-through ──────────────────────────────────────
    // Keep the full viewport for screen-space material effects, but scissor the
    // cursor pass to one pixel. Async readback avoids waiting for the GPU here.
    const hitTarget = new THREE.WebGLRenderTarget(1, 1)
    let pendingHitTest: { x: number; y: number; resolve: (hit: boolean) => void } | null = null
    const hitPixel = new Uint8Array(4)
    const inputTarget = new THREE.WebGLRenderTarget(1, 1)
    let lastInputMaskTime = 0
    let inputPixels = new Uint8Array(4)
    let inputReadback: Promise<void> | null = null
    let hitReadback: Promise<void> | null = null
    let activeHitResolve: ((hit: boolean) => void) | null = null
    let readbackErrorReported = false
    const reportReadbackError = (error: unknown) => {
      if (!disposed && !readbackErrorReported) {
        readbackErrorReported = true
        console.warn('Input pixel readback failed; keeping the window receptive.', error)
      }
    }

    // Async hit-test: queues a request, resolved after next frame render
    ;(window as any).__clawHitTest = (clientX: number, clientY: number): Promise<boolean> => {
      return new Promise((resolve) => {
        pendingHitTest?.resolve(true)
        pendingHitTest = { x: clientX, y: clientY, resolve }
      })
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    // Pauses when the page is hidden (minimized / locked / screensaver) so the
    // pet deactivates instead of burning CPU/GPU underneath the screensaver.
    // Quality controls pixel ratio and the independently selected frame-rate cap.
    // Delta is clamped so capped frames and resume-from-pause never cause
    // animation jumps.
    const clock = new THREE.Clock()
    let animFrameId: number
    let renderingPaused = document.hidden || suspendActiveRef.current
    const framePacer = new FramePacer()
    const IDLE_AFTER_MS = 2000
    let fpsFrames = 0
    let browserFrames = 0, frameMs = 0, maxFrameMs = 0
    let fpsWindowStart = performance.now()
    let previousCallback = fpsWindowStart, maxBrowserGapMs = 0, longBrowserGaps = 0
    const animationTimes = { hands: 0, typing: 0, sip: 0 }

    function animate() {
      animFrameId = requestAnimationFrame(animate)
      const frameStarted = performance.now()
      const gap = frameStarted - previousCallback
      previousCallback = frameStarted
      maxBrowserGapMs = Math.max(maxBrowserGapMs, gap)
      if (gap > 100) longBrowserGaps++
      browserFrames++
      const elapsed = frameStarted - fpsWindowStart
      if (elapsed >= 1000) {
        fpsRef.current = fpsFrames * 1000 / elapsed
        frameStatsRef.current = { browserFps: Math.round(browserFrames * 1000 / elapsed * 10) / 10,
          maxBrowserGapMs: Math.round(maxBrowserGapMs * 10) / 10, longBrowserGaps,
          frameMs: Math.round(frameMs / Math.max(1, fpsFrames) * 100) / 100, maxFrameMs: Math.round(maxFrameMs * 100) / 100 }
        browserFrames = 0; fpsFrames = 0; frameMs = 0; maxFrameMs = 0
        maxBrowserGapMs = 0
        fpsWindowStart = frameStarted
      }
      const cfg = qualityDetailsRef.current
      const targetRatio = Math.min(window.devicePixelRatio || 1, cfg.pixelRatioCap)
      if (renderer.getPixelRatio() !== targetRatio) renderer.setPixelRatio(targetRatio)
      renderPixelRatioRef.current = targetRatio
      {
        const now = performance.now()
        // Idle = nothing has moved the pet for a moment: no cursor, gesture,
        // speech, dance, action, music motion, or typing. Only then may the
        // optional idle cap lower the frame rate.
        const motion = motionRef.current
        if ((motion && (motion.actionPlaying || motion.isDancing)) || musicModeRef.current || musicPreviewRef.current
          || workingTargetRef.current || lipSyncRef.current.speaking || (window as any).__clawDragging) lastActivity = now
        const cap = frameCap(cfg, now - lastActivity > IDLE_AFTER_MS, now < settingsResizeUntilRef.current)
        effectiveMaxFpsRef.current = cap
        if (!framePacer.shouldRender(now, cap)) return
        fpsFrames++
      }
      const delta = Math.min(clock.getDelta(), 0.1)

      if (vrm) {
        const prefs = animationSettingsRef.current
        // Procedural layers use only their own individual speed; the global
        // multiplier applies to base clips (mixer) only. A pulsed layer
        // (settings-list preview) runs 3x until its preview ends.
        const pulse = pulseRef.current
        const pulsed = pulse && performance.now() / 1000 < pulse.until ? pulse.id : null
        if (pulse && !pulsed) pulseRef.current = null
        const effSpeed = (id: string) => proceduralSpeed(prefs, id) * (pulsed === id ? 3 : 1)
        for (const key of ['hands', 'typing', 'sip'] as const) animationTimes[key] += delta * effSpeed(key)
        // Remove last frame’s procedural layer, including bones absent from the idle clip.
        if (typingCache) restoreTypingPose(typingCache)
        // 1. Animation mixer
        motion?.update(delta)

        // 1.5. Relaxed hand pose — skip during dance (VMD has own hand anim)
        if (handPose && !motion?.isDancing) applyRelaxedHandPose(handPose, animationTimes.hands)

        // 1.6. Working mode: ease toward target, layer typing pose on top
        const workingTarget = workingTargetRef.current && !motion?.actionPlaying && !motion?.isDancing ? 1 : 0
        workingBlend += (workingTarget - workingBlend) * Math.min(1, delta * 4)
        if (Math.abs(workingBlend) < 0.001) workingBlend = workingTarget
        if (typingCache && workingBlend > 0) {
          applyTypingPose(typingCache, animationTimes.typing, workingBlend)
        }
        if (laptop) {
          laptop.visible = workingBlend > .02
          if (typingCache?.keyboardL && typingCache.keyboardR && workingBlend > .02) {
            const keyboard = typingCache.keyboardL.getWorldPosition(new THREE.Vector3()).add(typingCache.keyboardR.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5)
            keyboard.y -= laptop.userData.width * .14
            keyboard.z += laptop.userData.width * .02
            laptop.position.lerp(keyboard, 1 - Math.exp(-delta * 10))
          }
        }

        // 1.7. Play a requested coffee sip (~4.5s), or repeat an explicit
        // loop preview. Automatic sip frequency belongs to the behavior engine.
        if (lastSipReset !== sipResetRef.current) {
          lastSipReset = sipResetRef.current
          sipActive = false
          sipBlend = 0
          nextSipAt = Infinity
        }
        const now = animationTimes.sip
        if (workingBlend > 0.8) {
          if (sipRequestedRef.current) {
            nextSipAt = now
            sipRequestedRef.current = false
          }
          if (!sipActive && now >= nextSipAt) {
            sipActive = true
            sipT0 = now
          }
          if (sipActive) {
            const SIP_DUR = 4.5
            const st = now - sipT0
            if (st >= SIP_DUR) {
              sipActive = false
              sipBlend = 0
              // Looped sip preview: short pause, then drink again.
              nextSipAt = sipLoopRef.current ? now + 2.5 : Infinity
            } else {
              const k = st / SIP_DUR
              sipBlend = k < 0.25 ? k / 0.25 : k > 0.75 ? (1 - k) / 0.25 : 1
            }
          }
        } else {
          sipActive = false
          sipBlend = 0
          nextSipAt = Infinity
        }
        sipActiveMirrorRef.current = sipActive
        sipBlendMirrorRef.current = sipBlend
        if (faceOffset == null && typingCache?.head) faceOffset = measureFaceOffset()
        if (typingCache && sipBlend > 0) {
          applySipPose(typingCache, now, sipBlend * workingBlend, faceOffset ?? 0.12)
        }
        if (cup) {
          cup.visible = workingBlend > .02
          if (laptop && typingCache?.handR) {
            cup.position.copy(cupPositions(laptop.position, typingCache.handR.getWorldPosition(new THREE.Vector3()), laptop.userData.width, cup.userData.height, laptop.userData.keyboardToBase, sipBlend))
          }
        }

        const listening = musicModeRef.current || musicPreviewRef.current
        const musicOptions = musicSettingsRef.current
        if (headphones) {
          const fit = headphoneFitRef.current
          const unit = headphones.userData.modelHeight / 100
          headphones.position.set(fit.x * unit, fit.y * unit, fit.z * unit)
          headphones.scale.set(fit.scale * fit.width, fit.scale * fit.height, fit.scale * fit.depth)
          headphones.rotation.set(THREE.MathUtils.degToRad(fit.rx), THREE.MathUtils.degToRad(fit.ry), THREE.MathUtils.degToRad(fit.rz))
          headphones.visible = listening
        }
        const musicPose = musicMotionRef.current.step(delta, performance.now() / 1000, musicOptions, listening, musicPreviewRef.current, workingTargetRef.current, sipBlend, effSpeed('music'))
        if (typingCache && !motion?.actionPlaying && !motion?.isDancing) applyMusicAngles(typingCache, musicPose.pitch, musicPose.roll)
        // 1.8. Cursor follow, per the playing behavior entry. The head glance
        // is damped every frame so it eases in, follows, and settles to
        // neutral when the strength drops to 0.
        const follow = currentFollow()
        if (typingCache) {
          const target = headTurnTarget(mouse.x, mouse.y, follow.head)
          headTurnYaw = dampAngle(headTurnYaw, target.yaw, delta)
          headTurnPitch = dampAngle(headTurnPitch, target.pitch, delta)
          applyHeadTurn(typingCache, headTurnYaw, headTurnPitch)
        }
        // 1.9. Eyes: re-aim when following starts or its strength changes
        // (mouse moves re-aim on their own). When not following, ease the
        // eye target back to straight ahead of the head so the gaze settles
        // instead of freezing on the last cursor point.
        if (follow.eyes > 0) {
          if (follow.eyes !== aimedEyes) aimEyesAtCursor(follow.eyes)
        } else {
          aimedEyes = 0
          if (trackingModeRef.current === 'mouse' && vrm && typingCache?.head) {
            const headPos = typingCache.head.getWorldPosition(new THREE.Vector3())
            const fwd = faceDirection(typingCache)
            const k = 1 - Math.exp(-delta * 6)
            lookAtTarget.x += (headPos.x + fwd.x * 4 - lookAtTarget.x) * k
            lookAtTarget.y += (headPos.y + fwd.y * 4 - lookAtTarget.y) * k
            lookAtTarget.z += (headPos.z + fwd.z * 4 - lookAtTarget.z) * k
          }
        }
        // 2. Humanoid update
        vrm.humanoid?.update()
        // 2.5. Pets follow the final pose; props ride their bones.
        companions.update(delta)

        // 3. Camera tracking mode: look at camera position
        if (trackingModeRef.current === 'camera') {
          lookAtTarget.x = camera.position.x
          lookAtTarget.y = camera.position.y
          lookAtTarget.z = camera.position.z
          saccades.instantUpdate(vrm, lookAtTarget)
        }

        // 4. LookAt update
        vrm.lookAt?.update(delta * effSpeed('eyes'))

        // 5. Eye saccades (airi style)
        saccades.update(vrm, lookAtTarget, delta * effSpeed('eyes'))

        // 5. Blinking
        updateBlink(vrm, delta * effSpeed('blink'), blinkState)

        // 6. Emote transitions
        emote?.update(delta * effSpeed('expressions'))

        // 7. Lip sync
        lipSyncRef.current.update(vrm, delta)

        // 8. Expression manager (apply blink etc.)
        vrm.expressionManager?.update()
        // 8b. Soften blink-driven ear yanks; springs own ear motion.
        if (earMorphSlots.length) dampenEarMorphs(earMorphSlots)

        // 8. Spring bone physics (ears, hair, clothes). Always on unless the
        // user explicitly disables it in Quality settings — secondary motion
        // is what keeps fast twitches from looking like they snap.
        if (qualityDetailsRef.current.springBones) {
          vrm.springBoneManager?.update(delta)
        }
      }

      // 9. Lights: global rig follows settings; cursor light tracks the mouse.
      applyGlobalLighting()
      stepCursorLight(delta, performance.now() / 1000)

      renderer.render(scene, camera)

      // Linux uses a persistent silhouette input shape, never cursor polling.
      if (canvas && !inputReadback && (window as any).__clawInputRegionsEnabled && performance.now() - lastInputMaskTime >= 100) {
        lastInputMaskTime = performance.now()
        if (!vrm) {
          delete (window as any).__clawInputRegions
        } else {
          const cssWidth = canvas.clientWidth, cssHeight = canvas.clientHeight
          const width = 128
          const height = Math.max(1, Math.round(width * cssHeight / Math.max(1, cssWidth)))
          if (inputTarget.width !== width || inputTarget.height !== height) {
            inputTarget.setSize(width, height)
            inputPixels = new Uint8Array(width * height * 4)
          }
          try {
            renderer.setRenderTarget(inputTarget)
            renderer.clear()
            renderer.render(scene, camera)
            inputReadback = renderer.readRenderTargetPixelsAsync(inputTarget, 0, 0, width, height, inputPixels)
              .then(() => {
                // Never publish an old-sized mask after a resize or scene teardown.
                if (disposed || renderingPaused || !(window as any).__clawInputRegionsEnabled
                  || canvas.clientWidth !== cssWidth || canvas.clientHeight !== cssHeight) return
                ;(window as any).__clawInputRegions = alphaInputRegions(inputPixels, width, height, cssWidth, cssHeight)
              })
              .catch(error => {
                if (!disposed) delete (window as any).__clawInputRegions
                reportReadbackError(error)
              })
              .finally(() => { inputReadback = null })
          } finally {
            renderer.setRenderTarget(null)
          }
        }
      }

      // Only one cursor readback may own the pixel buffer at a time.
      if (pendingHitTest && !hitReadback && canvas) {
        const { x, y, resolve } = pendingHitTest
        pendingHitTest = null
        if (!vrm) {
          resolve(true) // Model not loaded — keep the window receptive.
        } else {
          const dpr = renderer.getPixelRatio()
          const bufW = canvas.width, bufH = canvas.height
          const px = Math.floor(x * dpr)
          const py = bufH - 1 - Math.floor(y * dpr)
          if (px < 0 || py < 0 || px >= bufW || py >= bufH) {
            resolve(false)
          } else {
            if (hitTarget.width !== bufW || hitTarget.height !== bufH) hitTarget.setSize(bufW, bufH)
            hitTarget.scissor.set(px, py, 1, 1)
            hitTarget.scissorTest = true
            activeHitResolve = resolve
            try {
              renderer.setRenderTarget(hitTarget)
              renderer.clear()
              renderer.render(scene, camera)
              hitReadback = renderer.readRenderTargetPixelsAsync(hitTarget, px, py, 1, 1, hitPixel)
                .then(() => { activeHitResolve?.(hitPixel[3] > 10) })
                .catch(error => { activeHitResolve?.(true); reportReadbackError(error) })
                .finally(() => { activeHitResolve = null; hitReadback = null })
            } finally {
              renderer.setRenderTarget(null)
            }
          }
        }
      }
      const workMs = performance.now() - frameStarted
      frameMs += workMs
      maxFrameMs = Math.max(maxFrameMs, workMs)
    }

    // Pause the loop while hidden; resume on visible. rAF stops firing on its
    // own in background tabs, but explicit cancel guarantees no work (and no
    // GPU presents) while hidden.
    //
    // NOTE: this alone does NOT cover the screensaver: a fullscreen saver
    // over an always-on-top window never hides the page, so rAF keeps
    // presenting WebGL frames and fights the saver for the GPU (~0.5fps).
    // The server therefore polls the OS saver/lock state and drives
    // setSuspended below, which pauses via the same helpers AND hides the
    // window so the compositor drops our surface entirely.
    function pauseRendering() {
      if (renderingPaused) return
      renderingPaused = true
      fpsRef.current = 0
      frameStatsRef.current = { browserFps: 0, maxBrowserGapMs: 0, longBrowserGaps, frameMs: 0, maxFrameMs: 0 }
      cancelAnimationFrame(animFrameId)
      pendingHitTest?.resolve(true)
      pendingHitTest = null
      activeHitResolve?.(true)
      activeHitResolve = null
    }
    function resumeRendering() {
      if (!renderingPaused) return
      renderingPaused = false
      clock.getDelta()
      framePacer.reset()
      fpsFrames = 0
      browserFrames = 0; frameMs = 0; maxFrameMs = 0
      fpsWindowStart = performance.now()
      previousCallback = fpsWindowStart; maxBrowserGapMs = 0
      animFrameId = requestAnimationFrame(animate)
    }
    // Set while a screensaver/lock suspend is in force; only setSuspended
    // clears it. Tracks whether *we* hid the window so resume doesn't undo
    // a manual tray-hide made mid-suspend.
    // The hidden-by-suspend flag lives in sessionStorage so it also survives
    // a full page reload while locked.
    const HIDDEN_BY_SUSPEND = 'cuttle-pet-hidden-by-suspend'
    const hiddenBySuspend = () => sessionStorage.getItem(HIDDEN_BY_SUSPEND) === '1'
    const setHiddenBySuspend = (value: boolean) => {
      if (value) sessionStorage.setItem(HIDDEN_BY_SUSPEND, '1')
      else sessionStorage.removeItem(HIDDEN_BY_SUSPEND)
    }
    suspendFnRef.current = (suspended: boolean) => {
      if (suspended) {
        if (suspendActiveRef.current) return
        suspendActiveRef.current = true
        pauseRendering()
        getCurrentWindow().isVisible()
          .then((visible) => {
            // Resumed while the check was in flight — leave the window alone.
            if (!suspendActiveRef.current) return
            if (visible) {
              setHiddenBySuspend(true)
              return getCurrentWindow().hide()
            }
            // Already hidden: keep a flag set before a reload; otherwise the
            // user hid it, and resume leaves it hidden.
          })
          .catch(() => { /* not running under Tauri (browser dev) */ })
      } else {
        suspendActiveRef.current = false
        if (hiddenBySuspend()) {
          setHiddenBySuspend(false)
          // Re-assert always-on-top: some WMs drop the topmost hint across hide/show.
          getCurrentWindow().show()
            .then(() => { if (getCachedSetting('pinned', true) !== false) return getCurrentWindow().setAlwaysOnTop(true) })
            .catch(() => {})
        }
        // Stay paused if the page itself is hidden (e.g. minimized).
        if (!document.hidden) resumeRendering()
      }
    }
    function onVisibilityChange() {
      if (document.hidden) {
        pauseRendering()
      } else if (!suspendActiveRef.current) {
        resumeRendering()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    // Synchronous teardown for app exit. Quitting with a live WebGL context
    // presenting frames makes WebKitWebProcess crash on Linux ("stopped
    // unexpectedly" dialog). beforeunload/pagehide run before WebKit tears
    // down the page: stop presenting and release the GL context here, while
    // the context is still current. Async disposal (see effect cleanup below)
    // never runs on an abrupt exit, so this path must be fully synchronous.
    // Idempotent: the effect cleanup sets the same disposed flag.
    const shutdownForExit = createExitShutdown({
      stopFrames: () => {
        if (disposed) return
        disposed = true
        captureScreenshotRef.current = () => null
        cancelAnimationFrame(animFrameId)
        pendingHitTest?.resolve(true)
        pendingHitTest = null
        activeHitResolve?.(true)
        activeHitResolve = null
      },
      dispose: () => {
        hitTarget.dispose()
        inputTarget.dispose()
        renderer.dispose()
      },
      // Drop the underlying GL context so the web process has nothing in
      // flight while the native window is destroyed.
      loseContext: () => renderer.forceContextLoss(),
    })
    window.addEventListener('beforeunload', shutdownForExit)
    window.addEventListener('pagehide', shutdownForExit)
    if (!renderingPaused) {
      animFrameId = requestAnimationFrame(animate)
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      disposed = true
      captureScreenshotRef.current = () => null
      // Canvas gestures die with the effect; never leave the cursor monitor
      // suppressed (or a stale in-flight gesture) behind.
      ;(window as any).__clawDragging = false
      suspendFnRef.current = () => {}
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('beforeunload', shutdownForExit)
      window.removeEventListener('pagehide', shutdownForExit)
      // Snapshot the view so a model reload restores it verbatim — but only
      // when this run actually framed a model. An unmount before the load
      // finishes (StrictMode double-mount, fast model switches) must not
      // overwrite a good snapshot with the pre-framing defaults.
      if (framingApplied) {
        cameraStateRef.current = {
          pivot: [pivot.x, pivot.y, pivot.z],
          radius: orbitRadius,
          theta: orbitTheta,
          phi: orbitPhi,
        }
        saveCameraView(cameraStateRef.current)
      }
      cancelAnimationFrame(animFrameId)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mousemove', onMouseMove)
      unlistenGaze.then((fn) => fn())
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('resize', onResize)
      companions.dispose()
      if (companionsRef.current === companions) companionsRef.current = null
      emote?.dispose()
      emoteRef.current = null
      motion?.dispose()
      motionRef.current = null
      // renderer.dispose() alone does not release loaded mesh geometries,
      // materials, or textures. Release them on model changes and hot reloads.
      VRMUtils.deepDispose(scene)
      if (laptop) {
        scene.remove(laptop)
        laptop = null
      }
      if (headphones) {
        headphones.removeFromParent()
      }
      phone?.removeFromParent()
      phone = null
      cup?.removeFromParent()
      cup = null
      typingCache = null
      // Readbacks own GL resources until their fences complete. Release the
      // renderer afterwards, even on rapid model reloads / StrictMode teardown.
      activeHitResolve?.(true)
      activeHitResolve = null
      void Promise.allSettled([inputReadback, hitReadback]).then(() => {
        hitTarget.dispose()
        inputTarget.dispose()
        renderer.dispose()
      })
      delete (window as any).__clawInputRegions
      // Fail open: a cursor hit-test still awaiting its frame must resolve
      // instead of hanging usePassThrough's pending gate forever.
      if (pendingHitTest) {
        pendingHitTest.resolve(true)
        pendingHitTest = null
      }
      delete (window as any).__clawHitTest
      for (const timer of previewTimersRef.current) clearTimeout(timer)
      previewTimersRef.current = []
    }
  }, [modelPath, idleAnimationPath])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          background: 'transparent',
          cursor: 'grab',
        }}
      />
      {ripples.map(r => (
        <span
          key={r.id}
          className={r.confirmed ? 'touch-ripple confirmed' : 'touch-ripple'}
          style={{ left: r.x, top: r.y }}
        />
      ))}
    </div>
  )
})

// ── Eye saccade interval (from airi) ─────────────────────────────────────────
const EYE_SACCADE_INT_STEP = 400
const EYE_SACCADE_INT_P: number[][] = [
  [0.075, 800], [0.110, 0], [0.125, 0], [0.140, 0], [0.125, 0],
  [0.050, 0],   [0.040, 0], [0.030, 0], [0.020, 0], [1.000, 0],
]
for (let i = 1; i < EYE_SACCADE_INT_P.length; i++) {
  EYE_SACCADE_INT_P[i][0] += EYE_SACCADE_INT_P[i - 1][0]
  EYE_SACCADE_INT_P[i][1] = EYE_SACCADE_INT_P[i - 1][1] + EYE_SACCADE_INT_STEP
}

function randomSaccadeInterval(): number {
  const r = Math.random()
  for (let i = 0; i < EYE_SACCADE_INT_P.length; i++) {
    if (r <= EYE_SACCADE_INT_P[i][0]) {
      return EYE_SACCADE_INT_P[i][1] + Math.random() * EYE_SACCADE_INT_STEP
    }
  }
  return EYE_SACCADE_INT_P[EYE_SACCADE_INT_P.length - 1][1] + Math.random() * EYE_SACCADE_INT_STEP
}

// ── Eye saccade controller (from airi) ───────────────────────────────────────
class EyeSaccadeController {
  private nextSaccadeAfter = -1
  private timeSinceLastSaccade = 0
  private fixationTarget = new THREE.Vector3()

  /** Called when lookAt target changes (e.g. mouse moved) */
  instantUpdate(vrm: VRM, target: { x: number; y: number; z: number }) {
    this.fixationTarget.set(target.x, target.y, target.z)
    if (!vrm.lookAt) return
    if (!vrm.lookAt.target) {
      vrm.lookAt.target = new THREE.Object3D()
    }
    vrm.lookAt.target.position.copy(this.fixationTarget)
    vrm.lookAt.update(0.016)
  }

  /** Called every frame */
  update(vrm: VRM, lookAtTarget: { x: number; y: number; z: number }, delta: number) {
    if (!vrm.expressionManager || !vrm.lookAt) return

    if (this.timeSinceLastSaccade >= this.nextSaccadeAfter) {
      // Add random offset to the current lookAt target
      this.fixationTarget.set(
        lookAtTarget.x + THREE.MathUtils.randFloat(-0.25, 0.25),
        lookAtTarget.y + THREE.MathUtils.randFloat(-0.25, 0.25),
        lookAtTarget.z,
      )
      this.timeSinceLastSaccade = 0
      this.nextSaccadeAfter = randomSaccadeInterval() / 1000
    }

    if (!vrm.lookAt.target) {
      vrm.lookAt.target = new THREE.Object3D()
    }
    vrm.lookAt.target.position.lerp(this.fixationTarget, 1)
    vrm.lookAt.update(delta)

    this.timeSinceLastSaccade += delta
  }
}
