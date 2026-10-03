import { MusicMotion } from '../music-motion'
import { prepareLaptop, cupPositions } from '../work-props'
import { DEFAULT_MUSIC, DEFAULT_FIT, type MusicSettings, type HeadphoneFit } from '../music-settings'
import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation'
import type { VRM } from '@pixiv/three-vrm'
import { EmoteController } from '../emote'
import { LipSync } from '../lip-sync'
import { MotionController } from '../motion-controller'
import { buildTypingPoseCache, restoreTypingPose, applyTypingPose, applySipPose, applyMusicAngles } from '../typing-pose'
import type { TypingPoseCache } from '../typing-pose'
import { getCurrentWindow } from '@tauri-apps/api/window'

export type TouchRegion = 'head' | 'arm' | 'leg' | 'chest' | 'belly' | 'buttocks'

interface VRMSceneProps {
  musicSettings?: MusicSettings
  headphoneFit?: HeadphoneFit
  modelPath: string
  idleAnimationPath?: string
  onTouch?: (region: TouchRegion) => void
  onModelError?: (message: string) => void
  onModelLoaded?: () => void
}

export type TrackingMode = 'mouse' | 'camera'

export interface VRMSceneHandle {
  setEmotion: (emotion: string, intensity?: number) => void
  setEmotionWithReset: (emotion: string, durationMs: number, intensity?: number) => void
  resetCamera: () => void
  setTrackingMode: (mode: TrackingMode) => void
  playAction: (name: string, hold?: boolean) => void
  playAnimationOnce: (name: string) => void
  captureScreenshot: () => string | null
  panCamera: (dx: number, dy: number) => void
  rotateCamera: (dx: number, dy: number) => void
  playDance: (nameOrPreset: string | import('../motion-controller').DancePreset) => void
  stopDance: () => void
  isDancing: () => boolean
  setBgmVolume: (v: number) => void
  /** Unified reset: camera + resetToIdle + expressions to zero */
  resetPose: () => void
  reset: () => void
  /** Working mode: typing pose + laptop prop (eases in/out) */
  setMusicMode: (active: boolean) => void
  setMusicPreview: (active: boolean) => void
  receiveMusicBeat: (beat: { bpm: number | null; confidence: number; timestamp: number }) => void
  receiveMusicAudio: (audio: { amplitude: number; available: boolean; timestamp: number }) => void
  celebrateMusicEnd: () => void
  requestCoffeeSip: () => void
  setWorking: (active: boolean) => void
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
  musicSettings = DEFAULT_MUSIC,
  headphoneFit = DEFAULT_FIT,
  idleAnimationPath = '/idle_loop.vrma',
  onTouch,
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
  const cameraStateRef = useRef<{ pivot: [number, number, number]; radius: number; theta: number; phi: number } | null>(null)
  const trackingModeRef = useRef<TrackingMode>('mouse')
  const motionRef = useRef<MotionController | null>(null)
  const panCameraRef = useRef<((dx: number, dy: number) => void) | null>(null)
  const rotateCameraRef = useRef<((dx: number, dy: number) => void) | null>(null)
  const lipSyncRef = useRef<LipSync>(LipSync.getInstance())
  const musicModeRef = useRef(false)
  const musicPreviewRef = useRef(false)
  const musicDanceActiveRef = useRef(false)
  const musicSettingsRef = useRef(musicSettings)
  musicSettingsRef.current = musicSettings
  const headphoneFitRef = useRef(headphoneFit)
  headphoneFitRef.current = headphoneFit
  const musicMotionRef = useRef(new MusicMotion())
  const musicEndUntilRef = useRef(0)
  const sipRequestedRef = useRef(false)
  const workingTargetRef = useRef(false)
  const onTouchRef = useRef(onTouch)
  onTouchRef.current = onTouch
  const onModelErrorRef = useRef(onModelError)
  onModelErrorRef.current = onModelError
  const onModelLoadedRef = useRef(onModelLoaded)
  onModelLoadedRef.current = onModelLoaded

  useImperativeHandle(ref, () => ({
    setEmotion(emotion: string, intensity?: number) {
      emoteRef.current?.setEmotion(emotion, intensity)
    },
    setEmotionWithReset(emotion: string, durationMs: number, intensity?: number) {
      emoteRef.current?.setEmotionWithReset(emotion, durationMs, intensity)
    },
    resetCamera() {
      resetCameraRef.current?.()
    },
    setTrackingMode(mode: TrackingMode) {
      trackingModeRef.current = mode
    },
    playAction(name: string, hold?: boolean) {
      musicDanceActiveRef.current = false
      motionRef.current?.playAction(name, hold)
    },
    captureScreenshot() {
      return canvasRef.current?.toDataURL('image/png') ?? null
    },
    panCamera(dx: number, dy: number) {
      panCameraRef.current?.(dx, dy)
    },
    rotateCamera(dx: number, dy: number) {
      rotateCameraRef.current?.(dx, dy)
    },
    playDance(nameOrPreset: string | import('../motion-controller').DancePreset) {
      musicDanceActiveRef.current = false
      motionRef.current?.playDance(nameOrPreset)
    },
    stopDance() {
      motionRef.current?.resetToIdle()
    },
    isDancing() {
      return motionRef.current?.isDancing ?? false
    },
    setBgmVolume(v: number) {
      motionRef.current?.setVolume(v)
    },
    resetPose() {
      workingTargetRef.current = false
      sipRequestedRef.current = false
      motionRef.current?.resetToIdle()
      emoteRef.current?.resetAll()
    },
    reset() {
      // Deliberately no camera reset: state transitions (dance stop, work
      // done, etc.) must preserve the user's position/zoom. Explicit
      // reframe stays available via resetCamera (tray → camera).
      workingTargetRef.current = false
      sipRequestedRef.current = false
      motionRef.current?.resetToIdle()
      emoteRef.current?.resetAll()
    },
    playAnimationOnce(name: string) {
      musicDanceActiveRef.current = false
      motionRef.current?.resetToIdle()
      void motionRef.current?.playAction(name, false)
    },
    setMusicMode(active: boolean) { musicModeRef.current = active },
    setMusicPreview(active: boolean) { musicPreviewRef.current = active },
    receiveMusicBeat(beat) {
      const age = Math.max(0, Date.now() / 1000 - beat.timestamp)
      musicMotionRef.current.receiveBeat(beat, performance.now() / 1000, age)
    },
    receiveMusicAudio(audio) {
      if (Math.abs(Date.now() / 1000 - audio.timestamp) > 2) return
      musicMotionRef.current.receiveAudio(audio.amplitude, audio.available, performance.now() / 1000)
    },
    celebrateMusicEnd() { if (musicSettingsRef.current.reactOnEnd) musicEndUntilRef.current = performance.now() / 1000 + 15 },
    requestCoffeeSip() { sipRequestedRef.current = true },
    setWorking(active: boolean) {
      if (active) musicDanceActiveRef.current = false
      if (active && !workingTargetRef.current) motionRef.current?.resetToIdle()
      workingTargetRef.current = active
    },
  }))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x000000, 0)

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

    function updateCameraOrbit() {
      camera.position.set(
        pivot.x + orbitRadius * Math.sin(orbitPhi) * Math.sin(orbitTheta),
        pivot.y + orbitRadius * Math.cos(orbitPhi),
        pivot.z + orbitRadius * Math.sin(orbitPhi) * Math.cos(orbitTheta),
      )
      camera.lookAt(pivot)
    }
    updateCameraOrbit()

    // ── Lights ────────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(1, 2, 3)
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-2, 1, -1)
    scene.add(fillLight)

    // ── Loader ───────────────────────────────────────────────────────────────
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    // ── State ─────────────────────────────────────────────────────────────────
    let vrm: VRM | null = null
    let motion: MotionController | null = null
    let emote: EmoteController | null = null
    let handPose: HandPoseCache | null = null
    let typingCache: TypingPoseCache | null = null
    let laptop: THREE.Object3D | null = null
    let phone: THREE.Object3D | null = null
    let cup: THREE.Object3D | null = null
    let headphones: THREE.Group | null = null
    let nextMusicDance = 0
    let workingBlend = 0
    // Coffee-sip state: sipActive while raising/lowering, sipBlend eases 0→1→0
    let sipActive = false
    let sipBlend = 0
    let sipT0 = 0
    let nextSipAt = Infinity
    const blinkState = createBlinkState()
    const saccades = new EyeSaccadeController()
    const lookAtTarget = { x: 0, y: 0, z: -100 }

    // ── Load VRM model, then load idle animation ─────────────────────────────
    loader.load(
      modelPath,
      async (gltf) => {
        const loadedVrm = gltf.userData.vrm as VRM
        if (!loadedVrm) {
          console.error('No VRM data found in GLTF')
          onModelErrorRef.current?.('This file does not contain a supported VRM character.')
          return
        }

        VRMUtils.removeUnnecessaryVertices(loadedVrm.scene)
        VRMUtils.combineSkeletons(loadedVrm.scene)
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
        modelCenter.y += modelSize.y / 3.2 // pivot at neck height

        const radians = (FOV / 2 * Math.PI) / 180
        const offsetX = modelSize.x / 16
        const offsetY = modelSize.y / 10
        const offsetZ = (modelSize.y / 4.2) / Math.tan(radians)

        pivot.copy(modelCenter)
        orbitRadius = offsetZ
        orbitTheta = Math.atan2(offsetX, offsetZ)
        orbitPhi = Math.PI / 2 - Math.atan2(offsetY, offsetZ)
        updateCameraOrbit()

        // Restore the exact pre-switch view when changing characters.
        // First load (no saved view) keeps the model-fitted defaults above.
        const savedView = cameraStateRef.current
        if (savedView) {
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
        }

        rotateCameraRef.current = (dx: number, dy: number) => {
          orbitTheta -= dx * 0.005
          orbitPhi = THREE.MathUtils.clamp(
            orbitPhi - dy * 0.005,
            0.1,
            Math.PI - 0.1,
          )
          updateCameraOrbit()
        }

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

        // ── Initialize MotionController ──────────────────────────────────────
        motion = new MotionController(loadedVrm)
        motionRef.current = motion
        // Show the cellphone prop while the phoneCall action is playing
        motion.onActionChange = (actionName) => {
          if (!actionName) musicDanceActiveRef.current = false
          if (phone) phone.visible = actionName === 'phoneCall'
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

    const _raycaster = new THREE.Raycaster()
    const _mouseVec = new THREE.Vector2()

    function onMouseMove(e: MouseEvent) {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1

      if (trackingModeRef.current !== 'mouse') return

      // Compute lookAt target like airi's lookAtMouse
      _mouseVec.set(mouse.x, mouse.y)
      _raycaster.setFromCamera(_mouseVec, camera)
      const camDir = new THREE.Vector3()
      camera.getWorldDirection(camDir)
      const plane = new THREE.Plane()
      plane.setFromNormalAndCoplanarPoint(
        camDir,
        camera.position.clone().add(camDir.multiplyScalar(1)),
      )
      const intersection = new THREE.Vector3()
      if (_raycaster.ray.intersectPlane(plane, intersection)) {
        lookAtTarget.x = intersection.x
        lookAtTarget.y = intersection.y
        lookAtTarget.z = intersection.z
        if (vrm) {
          saccades.instantUpdate(vrm, lookAtTarget)
        }
      }
    }
    // Listen on both window and document to handle transparent window cases
    window.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mousemove', onMouseMove)

    // ── Scroll zoom ──────────────────────────────────────────────────────────
    const MIN_RADIUS = 0.8
    const MAX_RADIUS = 5.0
    const ZOOM_SPEED = 0.002

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      orbitRadius = THREE.MathUtils.clamp(
        orbitRadius + e.deltaY * ZOOM_SPEED,
        MIN_RADIUS,
        MAX_RADIUS,
      )
      updateCameraOrbit()
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

      const intersects = touchRaycaster.intersectObject(vrm.scene, true)
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
    let leftDownPos: { x: number; y: number; time: number; region: TouchRegion | null } | null = null
    const CLICK_MOVE_THRESHOLD = 5  // px
    const CLICK_TIME_THRESHOLD = 300 // ms

    function onPointerDown(e: PointerEvent) {
      if (e.button === 0) {
        const region = detectTouchRegion(e)
        if (region) {
          // Might be a touch — wait for pointerup to confirm it's not a drag
          leftDownPos = { x: e.clientX, y: e.clientY, time: Date.now(), region }
          return
        }
        // Not on model — move window immediately
        getCurrentWindow().startDragging()
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
      // If left button held on model and moved beyond threshold → it's a drag, not a touch
      if (leftDownPos && e.buttons & 1) {
        const dx = Math.abs(e.clientX - leftDownPos.x)
        const dy = Math.abs(e.clientY - leftDownPos.y)
        if (dx > CLICK_MOVE_THRESHOLD || dy > CLICK_MOVE_THRESHOLD) {
          leftDownPos = null
          getCurrentWindow().startDragging()
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
    }

    function onPointerUp(e: PointerEvent) {
      // Confirm touch: short press with no movement on model
      if (leftDownPos && e.button === 0) {
        const elapsed = Date.now() - leftDownPos.time
        const dx = Math.abs(e.clientX - leftDownPos.x)
        const dy = Math.abs(e.clientY - leftDownPos.y)
        if (elapsed < CLICK_TIME_THRESHOLD && dx <= CLICK_MOVE_THRESHOLD && dy <= CLICK_MOVE_THRESHOLD) {
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
        canvas!.releasePointerCapture(e.pointerId)
      }
    }

    function onContextMenu(e: Event) {
      e.preventDefault()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('contextmenu', onContextMenu)

    // ── Resize ────────────────────────────────────────────────────────────────
    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onResize)

    // ── Hit-test for window pass-through ──────────────────────────────────────
    // Offscreen render target: render scene, read 1 pixel alpha at cursor.
    // Updated in the render loop — no extra render pass, just piggybacks.
    const hitTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false })
    let pendingHitTest: { x: number; y: number; resolve: (hit: boolean) => void } | null = null
    const hitPixel = new Uint8Array(4)

    // Async hit-test: queues a request, resolved after next frame render
    ;(window as any).__clawHitTest = (clientX: number, clientY: number): Promise<boolean> => {
      return new Promise((resolve) => {
        pendingHitTest = { x: clientX, y: clientY, resolve }
      })
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    const clock = new THREE.Clock()
    let animFrameId: number

    function animate() {
      animFrameId = requestAnimationFrame(animate)
      const delta = clock.getDelta()

      if (vrm) {
        // Remove last frame’s procedural layer, including bones absent from the idle clip.
        if (typingCache) restoreTypingPose(typingCache)
        // 1. Animation mixer
        motion?.update(delta)

        // 1.5. Relaxed hand pose — skip during dance (VMD has own hand anim)
        if (handPose && !motion?.isDancing) applyRelaxedHandPose(handPose, clock.elapsedTime)

        // 1.6. Working mode: ease toward target, layer typing pose on top
        const workingTarget = workingTargetRef.current && !motion?.actionPlaying && !motion?.isDancing ? 1 : 0
        workingBlend += (workingTarget - workingBlend) * Math.min(1, delta * 4)
        if (Math.abs(workingBlend) < 0.001) workingBlend = workingTarget
        if (typingCache && workingBlend > 0) {
          applyTypingPose(typingCache, clock.elapsedTime, workingBlend)
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

        // 1.7. Coffee sip: every 40–90s of sustained working, raise the cup
        // for ~4.5s (blend ramps up/down over the first/last quarter)
        const now = clock.elapsedTime
        if (workingBlend > 0.8) {
          if (sipRequestedRef.current) {
            nextSipAt = now
            sipRequestedRef.current = false
          }
          if (nextSipAt === Infinity) nextSipAt = now + 25
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
              nextSipAt = now + 40 + Math.random() * 50
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
        if (typingCache && sipBlend > 0) {
          applySipPose(typingCache, now, sipBlend * workingBlend)
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
        const musicPose = musicMotionRef.current.step(delta, performance.now() / 1000, musicOptions, listening, musicPreviewRef.current, workingTargetRef.current, sipBlend)
        if (typingCache && !motion?.actionPlaying && !motion?.isDancing) applyMusicAngles(typingCache, musicPose.pitch, musicPose.roll)
        if (listening && !motion?.actionPlaying && !motion?.isDancing) {
          if (!nextMusicDance) nextMusicDance = now + 20 + Math.random() * 25
          if (musicOptions.randomDance && !musicPreviewRef.current && !workingTargetRef.current && workingBlend < .02 && now >= nextMusicDance) {
            const choices = ['breakdance', 'cheering', 'joyfulJump']
            musicDanceActiveRef.current = true
            void motion?.playAction(choices[Math.floor(Math.random() * choices.length)])
            nextMusicDance = now + 45 + Math.random() * 45
          }
        } else if (!listening) {
          if (musicDanceActiveRef.current) {
            musicDanceActiveRef.current = false
            motion?.resetToIdle()
          }
          nextMusicDance = 0
        }

        if (musicEndUntilRef.current && (!musicOptions.reactOnEnd || performance.now() / 1000 > musicEndUntilRef.current || listening)) musicEndUntilRef.current = 0
        if (musicEndUntilRef.current && sipBlend < .05 && !motion?.actionPlaying && !motion?.isDancing) {
          musicEndUntilRef.current = 0
          void motion?.playAction(Math.random() < .65 ? 'clapping' : 'cheering')
        }

        // 2. Humanoid update
        vrm.humanoid?.update()

        // 3. Camera tracking mode: look at camera position
        if (trackingModeRef.current === 'camera') {
          lookAtTarget.x = camera.position.x
          lookAtTarget.y = camera.position.y
          lookAtTarget.z = camera.position.z
          saccades.instantUpdate(vrm, lookAtTarget)
        }

        // 4. LookAt update
        vrm.lookAt?.update(delta)

        // 5. Eye saccades (airi style)
        saccades.update(vrm, lookAtTarget, delta)

        // 5. Blinking
        updateBlink(vrm, delta, blinkState)

        // 6. Emote transitions
        emote?.update(delta)

        // 7. Lip sync
        lipSyncRef.current.update(vrm, delta)

        // 8. Expression manager (apply blink etc.)
        vrm.expressionManager?.update()

        // 8. Spring bone physics
        vrm.springBoneManager?.update(delta)
      }

      renderer.render(scene, camera)

      // Process pending hit-test after render
      if (pendingHitTest && canvas) {
        const { x, y, resolve } = pendingHitTest
        pendingHitTest = null

        if (!vrm) {
          resolve(true) // Model not loaded — don't pass through
        } else {

        const dpr = renderer.getPixelRatio()
        const bufW = canvas.clientWidth * dpr
        const bufH = canvas.clientHeight * dpr

        if (hitTarget.width !== bufW || hitTarget.height !== bufH) {
          hitTarget.setSize(bufW, bufH)
        }

        // Render to offscreen target
        renderer.setRenderTarget(hitTarget)
        renderer.clear()
        renderer.render(scene, camera)
        // Read 1 pixel at cursor position
        const px = Math.floor(x * dpr)
        const py = Math.floor(bufH - y * dpr) // GL Y-flip
        renderer.readRenderTargetPixels(hitTarget, px, py, 1, 1, hitPixel)
        renderer.setRenderTarget(null)

        resolve(hitPixel[3] > 10)
        } // end else (vrm exists)
      }
    }

    animate()

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      // Snapshot the view so a model reload restores it verbatim.
      cameraStateRef.current = {
        pivot: [pivot.x, pivot.y, pivot.z],
        radius: orbitRadius,
        theta: orbitTheta,
        phi: orbitPhi,
      }
      cancelAnimationFrame(animFrameId)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('resize', onResize)
      emote?.dispose()
      emoteRef.current = null
      motion?.dispose()
      motionRef.current = null
      if (laptop) {
        scene.remove(laptop)
        laptop = null
      }
      if (headphones) {
        headphones.removeFromParent()
        headphones.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose() } })
      }
      phone?.removeFromParent()
      phone = null
      cup?.removeFromParent()
      cup = null
      typingCache = null
      hitTarget.dispose()
      delete (window as any).__clawHitTest
      renderer.dispose()
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
