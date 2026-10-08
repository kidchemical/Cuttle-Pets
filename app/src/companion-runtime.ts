import * as THREE from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { intersectAnimatedModel } from './mesh-hit-test'
import { DEFAULT_GLOBAL_LIGHTING, type GlobalLightingSettings } from './lighting'
import {
  resolveExpressionParts,
  type CompanionAction, type CompanionKind, type PetAnchor, type PetConfig, type PetMove, type PropAnchor, type PropConfig,
} from './companions'

/** What the companion layer needs from the loaded character. */
export interface CharacterRig {
  /** Character root (props on 'root' attach here). */
  root: THREE.Object3D
  /** Bind-pose height in world units. */
  height: number
  /** Bind-pose floor height (bounding box min y). */
  floorY: number
  /** Bind-pose top of the head (bounding box max y). */
  topY: number
  /** Normalized humanoid bone by VRM name, or null. */
  bone: (name: string) => THREE.Object3D | null
}

export interface CompanionSnapshot {
  pets: Record<string, { shown: boolean; anchor: PetAnchor | null; expression: string | null; loop: string | null }>
  props: Record<string, { shown: boolean }>
}

type LoadModel = (url: string) => Promise<GLTF>

// Measured on the Chao rig: wing bones flap around their local Z axis and
// tails wag around Y. Imported rigs that differ still read as a gentle twitch.
const WING_AXIS = new THREE.Vector3(0, 0, 1)
const TAIL_AXIS = new THREE.Vector3(0, 1, 0)
const MOVE_SECONDS: Record<PetMove, number> = { hop: 0.6, spin: 0.8, flap: 1.5, wiggle: 0.8, bounce: 1.4 }
const APPEAR_SECONDS = 0.35

const easeOutBack = (k: number) => { const c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2) }
const _v = new THREE.Vector3()
const _q = new THREE.Quaternion()

/** Runtime (non-persisted) pet state; exists before the model finishes loading. */
interface PetState {
  shown: boolean
  appear: number
  anchor: PetAnchor | null
  expression: string | null
  temp: { id: string; until: number } | null
  loop: string | null
  move: { id: string; t0: number; duration: number } | null
  blink: { next: number; t0: number | null }
  occasionalAt: number
}

interface BoneRest { bone: THREE.Object3D; rest: THREE.Quaternion; sign: number }
interface LimbRest extends BoneRest {
  relaxed: THREE.Quaternion
  swingAxis: THREE.Vector3
  swayAxis: THREE.Vector3
  arm: boolean
}
type PetMaterial = THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; emissiveMap?: THREE.Texture | null; map?: THREE.Texture | null }

/** Companion GLBs arrive with whatever the exporter wrote, and two shapes
 * ignore scene lights entirely: unlit (basic) materials, and fully metallic
 * PBR (glTF defaults metallicFactor to 1 when absent) with no environment
 * map to reflect — diffuse drops to ~0, so stage and cursor lights can't
 * reach the pet. Normalize both to matte dielectric PBR; the albedo emissive
 * fill in PetInstance.configure then applies uniformly. Authored tints, maps
 * (including metalness maps), transparency, and facing carry over, and the
 * cached source is untouched. */
function normalizeCompanionMaterial(material: THREE.Material): THREE.Material {
  const basic = material as THREE.MeshBasicMaterial
  let lit: THREE.Material
  if (!basic.isMeshBasicMaterial) {
    lit = material.clone()
  } else {
    const converted = new THREE.MeshStandardMaterial()
    converted.name = basic.name
    converted.color.copy(basic.color)
    if (basic.map) converted.map = basic.map
    converted.transparent = basic.transparent
    converted.opacity = basic.opacity
    converted.alphaTest = basic.alphaTest
    converted.side = basic.side
    converted.vertexColors = basic.vertexColors
    converted.roughness = 1
    converted.metalness = 0
    lit = converted
  }
  const standard = lit as THREE.MeshStandardMaterial
  if (standard.isMeshStandardMaterial && !standard.metalnessMap && standard.metalness > 0.5) {
    standard.metalness = 0
  }
  return lit
}

class PetInstance {
  readonly holder = new THREE.Group()
  readonly pivot = new THREE.Group()
  model: THREE.Object3D | null = null
  mixer: THREE.AnimationMixer | null = null
  clips: THREE.AnimationClip[] = []
  idleAction: THREE.AnimationAction | null = null
  oneShot: THREE.AnimationAction | null = null
  parts = new Map<string, THREE.Object3D>()
  wings: BoneRest[] = []
  tail: BoneRest[] = []
  limbs: LimbRest[] = []
  idleTime = 0
  phase = 0
  materials = new Map<string, { material: PetMaterial; original: THREE.Color; emissive?: THREE.Color; intensity: number; emissiveMap?: THREE.Texture | null }[]>()
  /** Bind-pose model height (model units) and the origin shift to bottom-center. */
  modelHeight = 1
  placed = false
  file: string
  private stageFill = new THREE.Color(1, 1, 1)

  constructor(public cfg: PetConfig, public state: PetState) {
    this.file = cfg.file
    this.holder.add(this.pivot)
    this.holder.name = `pet:${cfg.id}`
    this.holder.visible = false
    // Stable, independent phases so multiple pets don't move in lockstep.
    for (const c of cfg.id) this.phase = (this.phase * 31 + c.charCodeAt(0)) % 997
    this.phase = this.phase / 997 * Math.PI * 2
  }

  attach(gltf: GLTF) {
    const model = gltf.scene
    model.traverse(object => { object.frustumCulled = false })
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    this.modelHeight = Math.max(size.y, 1e-4)
    // Origin at the bottom-center so every anchor positions the pet's feet.
    model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z))
    this.pivot.add(model)
    this.model = model
    this.clips = gltf.animations ?? []
    if (this.clips.length) this.mixer = new THREE.AnimationMixer(model)
    const boneNames = new Set([...this.cfg.wings, ...this.cfg.tail])
    model.traverse(object => {
      if (object.name && !(object as THREE.Bone).isBone && !this.parts.has(object.name)) this.parts.set(object.name, object)
      if ((object as THREE.Bone).isBone && boneNames.has(object.name)) {
        const entry = { bone: object, rest: object.quaternion.clone(), sign: /(^|[_.\s-])r($|[_.\s-])|right/i.test(object.name) ? -1 : 1 }
        if (this.cfg.wings.includes(object.name)) this.wings.push(entry)
        else this.tail.push(entry)
      }
      // Detect proximal arms and feet conservatively. Derive axes from the
      // actual rest rig: imported skeletons need not use humanoid local axes.
      const arm = /upper.?arm|^(?:arm[_. -]?[lr]|[lr](?:eft|ight)?[_. -]?arm)$/i.test(object.name)
      const foot = /foot|ankle/i.test(object.name)
      if ((object as THREE.Bone).isBone && (arm || foot)) {
        const rest = object.quaternion.clone()
        const world = object.getWorldQuaternion(new THREE.Quaternion())
        const inverse = world.clone().invert()
        const relaxed = rest.clone()
        if (arm) {
          const child = object.children.find(o => (o as THREE.Bone).isBone && o.position.lengthSq() > 1e-8)
          if (child && object.parent) {
            const direction = child.getWorldPosition(new THREE.Vector3()).sub(object.getWorldPosition(new THREE.Vector3())).normalize()
            // Lower a horizontal bind arm, retaining a little outward spread.
            const target = new THREE.Vector3(Math.sign(direction.x) * 0.45, -0.89, 0.06).normalize()
            const correction = new THREE.Quaternion().setFromUnitVectors(direction, target)
            relaxed.copy(object.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).multiply(correction).multiply(world)
          }
        }
        this.limbs.push({ bone: object, rest, relaxed, arm,
          sign: /(^|[_.\s-])r($|[_.\s-])|right/i.test(object.name) ? -1 : 1,
          swingAxis: new THREE.Vector3(1, 0, 0).applyQuaternion(inverse),
          swayAxis: new THREE.Vector3(0, 0, 1).applyQuaternion(inverse),
        })
      }
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) {
        // Clone so per-pet tints never leak into other instances or the cache.
        // Unlit source materials are upgraded so lights can reach the pet.
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        const cloned = list.map(normalizeCompanionMaterial)
        mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]
        for (const material of cloned as PetMaterial[]) {
          if (!material.color) continue
          const entries = this.materials.get(material.name) ?? []
          entries.push({ material, original: material.color.clone(), emissive: material.emissive?.clone(), intensity: material.emissiveIntensity ?? 1, emissiveMap: material.emissiveMap })
          this.materials.set(material.name, entries)
        }
      }
    })
    this.configure(this.cfg)
  }

  configure(cfg: PetConfig) {
    this.cfg = cfg
    for (const [name, entries] of this.materials) {
      const hex = cfg.colors[name]
      for (const { material, original } of entries) {
        // Pets attached before the metalness normalization existed keep
        // their materials across hot reloads (the scene effect doesn't
        // re-run), so heal in place here too: without this, lights can't
        // reach them until the model reloads.
        const standard = material as THREE.MeshStandardMaterial
        if (standard.isMeshStandardMaterial && !standard.metalnessMap && standard.metalness > 0.5) {
          standard.metalness = 0
        }
        material.color?.copy(hex ? new THREE.Color(hex) : original)
      }
    }
    this.applyLighting()
    if (this.mixer) {
      const clip = cfg.clip ? this.clips.find(c => c.name === cfg.clip) : undefined
      if (this.idleAction?.getClip() !== clip) {
        this.idleAction?.stop()
        this.resetProceduralPose()
        this.idleAction = clip ? this.mixer.clipAction(clip).play() : null
      }
    }
  }

  setStageFill(fill: THREE.Color) {
    if (this.stageFill.equals(fill)) return
    this.stageFill.copy(fill)
    this.applyLighting()
  }

  private applyLighting() {
    for (const entries of this.materials.values()) {
      for (const { material, emissive, intensity, emissiveMap } of entries) {
        if (!material.emissive || !emissive) continue
        const hasEmission = emissive.getHex() !== 0 || !!emissiveMap
        // The optional shadow lift follows stage illumination. A constant
        // emissive albedo makes companions look unlit when the stage is dark
        // and washes out colored cursor lights. Authored emission stays intact.
        material.emissive.copy(hasEmission ? emissive : material.color!)
        if (!hasEmission) material.emissive.multiply(this.stageFill)
        material.emissiveIntensity = hasEmission ? intensity : this.cfg.lighting
        const map = hasEmission ? emissiveMap : material.map
        if (material.emissiveMap !== map) { material.emissiveMap = map; material.needsUpdate = true }
      }
    }
  }

  resetProceduralPose() {
    for (const entry of this.wings) entry.bone.quaternion.copy(entry.rest)
    for (const entry of this.tail) entry.bone.quaternion.copy(entry.rest)
    for (const entry of this.limbs) entry.bone.quaternion.copy(entry.rest)
  }

  applyParts(expressionId: string | null, blinkFrame: string | null) {
    const selected = resolveExpressionParts(this.cfg, expressionId)
    if (blinkFrame && this.cfg.blink) selected[this.cfg.blink.group] = blinkFrame
    for (const group of this.cfg.groups) {
      for (const part of group.parts) {
        const object = this.parts.get(part)
        if (object) object.visible = selected[group.id] === part
      }
    }
  }

  dispose() {
    this.mixer?.stopAllAction()
    this.holder.removeFromParent()
    this.holder.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry?.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose()
        material.dispose()
      }
    })
  }
}

class PropInstance {
  readonly holder = new THREE.Group()
  model: THREE.Object3D | null = null
  maxDimension = 1
  materials = new Map<string, { material: THREE.Material & { color?: THREE.Color }; original: THREE.Color }[]>()
  appear = 0
  file: string
  anchor: PropAnchor | null = null
  colorsKey = ''

  constructor(public cfg: PropConfig, public shown: boolean) {
    this.file = cfg.file
    this.holder.name = `prop:${cfg.id}`
    this.holder.visible = false
  }

  attach(gltf: GLTF) {
    const model = gltf.scene
    model.traverse(object => { object.frustumCulled = false })
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    this.maxDimension = Math.max(size.x, size.y, size.z, 1e-4)
    model.position.sub(box.getCenter(new THREE.Vector3()))
    model.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const cloned = list.map(normalizeCompanionMaterial)
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]
      for (const material of cloned as (THREE.Material & { color?: THREE.Color })[]) {
        if (!material.color) continue
        const entries = this.materials.get(material.name) ?? []
        entries.push({ material, original: material.color.clone() })
        this.materials.set(material.name, entries)
      }
    })
    this.holder.add(model)
    this.model = model
    this.applyColors()
  }

  applyColors() {
    this.colorsKey = JSON.stringify(this.cfg.colors)
    for (const [name, entries] of this.materials) {
      const hex = this.cfg.colors[name]
      for (const { material, original } of entries) material.color?.copy(hex ? new THREE.Color(hex) : original)
    }
  }

  dispose() {
    this.holder.removeFromParent()
    this.holder.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry?.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose()
    })
  }
}

/**
 * Owns every pet and prop in one scene. The renderer calls update() each
 * frame after the character pose is final; behaviors, reactions, the CLI and
 * settings previews all go through apply().
 */
export class CompanionLayer {
  readonly root = new THREE.Group()
  private rig: CharacterRig | null = null
  private pets = new Map<string, PetInstance>()
  private props = new Map<string, PropInstance>()
  private petStates = new Map<string, PetState>()
  private propShown = new Map<string, boolean>()
  private disposed = false
  private time = 0
  private stageFill = new THREE.Color(1, 1, 1)
  private lightColor = new THREE.Color()
  private nextStageFill = new THREE.Color()
  /** Bind-pose head bone → top of head. */
  private headTop = 0

  constructor(scene: THREE.Scene, private load: LoadModel, private urlFor: (kind: CompanionKind, file: string) => string) {
    this.root.name = 'companions'
    scene.add(this.root)
  }

  /** Shadow lift tracks the stage, while cursor lights shade surfaces normally. */
  setStageLighting(settings: GlobalLightingSettings) {
    const defaults = DEFAULT_GLOBAL_LIGHTING
    const total = defaults.ambientIntensity + defaults.keyIntensity + defaults.fillIntensity
    const fill = this.nextStageFill.setRGB(0, 0, 0)
    for (const key of ['ambient', 'key', 'fill'] as const) {
      this.lightColor.set(settings[`${key}Color`]).multiplyScalar(settings[`${key}Intensity`] / total)
      fill.add(this.lightColor)
    }
    if (this.stageFill.equals(fill)) return
    this.stageFill.copy(fill)
    for (const pet of this.pets.values()) pet.setStageFill(fill)
  }

  setCharacter(rig: CharacterRig | null) {
    this.rig = rig
    const head = rig?.bone('head')
    this.headTop = rig ? head ? rig.topY - head.getWorldPosition(new THREE.Vector3()).y : rig.height * 0.08 : 0
    for (const prop of this.props.values()) { prop.anchor = null }
    for (const pet of this.pets.values()) pet.placed = false
  }

  configure(pets: PetConfig[], props: PropConfig[]) {
    if (this.disposed) return
    const petIds = new Set(pets.filter(p => p.enabled).map(p => p.id))
    for (const [id, pet] of this.pets) {
      if (!petIds.has(id)) { pet.dispose(); this.pets.delete(id) }
    }
    for (const cfg of pets) {
      if (!cfg.enabled) continue
      let state = this.petStates.get(cfg.id)
      if (!state) {
        state = { shown: cfg.visible, appear: 0, anchor: null, expression: null, temp: null, loop: null, move: null, blink: { next: this.time + 2 + Math.random() * 3, t0: null }, occasionalAt: this.nextOccasional(cfg) }
        this.petStates.set(cfg.id, state)
      }
      const existing = this.pets.get(cfg.id)
      if (existing && existing.file === cfg.file) { existing.configure(cfg); continue }
      existing?.dispose()
      const pet = new PetInstance(cfg, state)
      pet.setStageFill(this.stageFill)
      this.pets.set(cfg.id, pet)
      this.root.add(pet.holder)
      void this.load(this.urlFor('pet', cfg.file)).then(gltf => {
        if (this.disposed || this.pets.get(cfg.id) !== pet) return
        pet.attach(gltf)
      }).catch(error => console.warn(`Failed to load pet ${cfg.id}:`, error))
    }

    const propIds = new Set(props.filter(p => p.enabled).map(p => p.id))
    for (const [id, prop] of this.props) {
      if (!propIds.has(id)) { prop.dispose(); this.props.delete(id) }
    }
    for (const cfg of props) {
      if (!cfg.enabled) continue
      if (!this.propShown.has(cfg.id)) this.propShown.set(cfg.id, cfg.visible)
      const existing = this.props.get(cfg.id)
      // Wearing toggled in settings applies right away.
      if (existing && existing.cfg.visible !== cfg.visible) this.propShown.set(cfg.id, cfg.visible)
      if (existing && existing.file === cfg.file) { existing.cfg = cfg; continue }
      existing?.dispose()
      const prop = new PropInstance(cfg, this.propShown.get(cfg.id)!)
      this.props.set(cfg.id, prop)
      void this.load(this.urlFor('prop', cfg.file)).then(gltf => {
        if (this.disposed || this.props.get(cfg.id) !== prop) return
        prop.attach(gltf)
      }).catch(error => console.warn(`Failed to load prop ${cfg.id}:`, error))
    }
  }

  private nextOccasional(cfg: PetConfig) {
    const { everyMin, everyMax } = cfg.occasional
    return this.time + everyMin + Math.random() * Math.max(0, everyMax - everyMin)
  }

  /** Execute one behavior/reaction/CLI action. Unknown ids are ignored. */
  apply(action: CompanionAction) {
    if (action.kind === 'prop') {
      const shown = this.propShown.get(action.id)
      if (shown === undefined) return
      this.propShown.set(action.id, action.action === 'toggle' ? !shown : action.action === 'show')
      return
    }
    const state = this.petStates.get(action.id)
    const pet = this.pets.get(action.id)
    if (!state || !pet) return
    switch (action.action) {
      case 'show': state.shown = true; break
      case 'hide': state.shown = false; state.loop = null; break
      case 'toggle': state.shown = !state.shown; break
      case 'expression':
        if (action.durationMs) state.temp = { id: action.value!, until: this.time + action.durationMs / 1000 }
        else { state.expression = action.value === 'neutral' ? null : action.value!; state.temp = null }
        break
      case 'play':
        state.shown = true
        state.loop = action.loop ? action.value! : null
        this.startMove(pet, action.value!)
        break
      case 'stop':
        state.loop = null
        state.move = null
        state.anchor = null
        state.temp = null
        pet.oneShot?.stop()
        break
      case 'move':
        state.anchor = action.value === 'home' ? null : action.value as PetAnchor
        break
    }
  }

  private startMove(pet: PetInstance, id: string) {
    const state = pet.state
    if (id.startsWith('clip:')) {
      const clip = pet.clips.find(c => c.name === id.slice(5))
      if (!clip || !pet.mixer) { state.move = null; return }
      pet.oneShot?.stop()
      pet.resetProceduralPose()
      pet.oneShot = pet.mixer.clipAction(clip)
      pet.oneShot.reset().setLoop(THREE.LoopOnce, 1).play()
      pet.oneShot.clampWhenFinished = false
      state.move = { id, t0: this.time, duration: clip.duration }
      return
    }
    state.move = { id, t0: this.time, duration: MOVE_SECONDS[id as PetMove] ?? 1 }
  }

  /** Character emotion → configured pet expression, briefly. */
  emotion(emotion: string, durationMs = 4000) {
    for (const pet of this.pets.values()) {
      const expression = pet.cfg.mood[emotion]
      if (expression) pet.state.temp = { id: expression, until: this.time + durationMs / 1000 }
    }
  }

  /** Nearest visible pet under the ray. */
  hitPet(raycaster: THREE.Raycaster): { id: string; distance: number } | null {
    let best: { id: string; distance: number } | null = null
    for (const [id, pet] of this.pets) {
      if (!pet.holder.visible || !pet.model) continue
      const hit = intersectAnimatedModel(raycaster, pet.holder)[0]
      if (hit && (!best || hit.distance < best.distance)) best = { id, distance: hit.distance }
    }
    return best
  }

  /** Props attached to the character are hit through the character; pets live in our root. */
  intersects(raycaster: THREE.Raycaster): boolean {
    return this.hitPet(raycaster) !== null
  }

  click(id: string) {
    const pet = this.pets.get(id)
    if (!pet) return
    if (pet.cfg.click.move) this.startMove(pet, pet.cfg.click.move)
    if (pet.cfg.click.expression) pet.state.temp = { id: pet.cfg.click.expression, until: this.time + 2.5 }
  }

  snapshot(): CompanionSnapshot {
    const pets: CompanionSnapshot['pets'] = {}
    for (const [id, s] of this.petStates) pets[id] = { shown: s.shown, anchor: s.anchor, expression: s.expression, loop: s.loop }
    const props: CompanionSnapshot['props'] = {}
    for (const [id, shown] of this.propShown) props[id] = { shown }
    return { pets, props }
  }

  restore(snapshot: CompanionSnapshot) {
    for (const [id, saved] of Object.entries(snapshot.pets)) {
      const state = this.petStates.get(id)
      if (!state) continue
      Object.assign(state, saved)
      state.temp = null
      if (!saved.loop) state.move = null
    }
    for (const [id, saved] of Object.entries(snapshot.props)) if (this.propShown.has(id)) this.propShown.set(id, saved.shown)
  }

  update(delta: number) {
    this.time += delta
    const rig = this.rig
    for (const pet of this.pets.values()) this.updatePet(pet, delta, rig)
    for (const prop of this.props.values()) this.updateProp(prop, delta, rig)
  }

  private anchorTarget(pet: PetInstance, anchor: PetAnchor, rig: CharacterRig, out: THREE.Vector3) {
    const H = rig.height
    const side = pet.cfg.side === 'right' ? 1 : -1
    // The default camera looks down -Z at a character facing +Z, so the
    // viewer's right (+X) is the character's left.
    const world = (name: string, fallback: THREE.Vector3) => {
      const bone = rig.bone(name)
      return bone ? bone.getWorldPosition(new THREE.Vector3()) : fallback
    }
    const rootPos = rig.root.getWorldPosition(new THREE.Vector3())
    const hips = world('hips', rootPos.clone().setY(rig.floorY + H * 0.5))
    switch (anchor) {
      case 'shoulder': {
        const arm = world(side > 0 ? 'leftUpperArm' : 'rightUpperArm', hips.clone().setY(rig.floorY + H * 0.82))
        out.set(arm.x + side * H * 0.17, arm.y - H * 0.1, arm.z + H * 0.03)
        break
      }
      case 'head': {
        const head = world('head', hips.clone().setY(rig.floorY + H * 0.9))
        out.set(head.x, head.y + this.headTop - H * 0.015, head.z)
        break
      }
      case 'beside':
        out.set(hips.x + side * H * 0.3, rig.floorY, hips.z + H * 0.06)
        break
      case 'hands': {
        const left = world('leftHand', hips)
        const right = world('rightHand', hips)
        out.copy(left).add(right).multiplyScalar(0.5)
        out.z += H * 0.08
        out.y -= H * 0.04
        break
      }
      case 'orbit': {
        const chest = world('chest', hips.clone().setY(rig.floorY + H * 0.7))
        const angle = this.time * 0.8 * pet.cfg.idle.speed
        out.set(chest.x + Math.sin(angle) * H * 0.36, chest.y - H * 0.12, chest.z + Math.cos(angle) * H * 0.36)
        break
      }
    }
    const unit = H / 100
    out.x += pet.cfg.offset.x * unit
    out.y += pet.cfg.offset.y * unit
    out.z += pet.cfg.offset.z * unit
  }

  private updatePet(pet: PetInstance, delta: number, rig: CharacterRig | null) {
    const { state, cfg } = pet
    state.appear = THREE.MathUtils.clamp(state.appear + (state.shown ? 1 : -1) * delta / APPEAR_SECONDS, 0, 1)
    pet.holder.visible = !!pet.model && !!rig && state.appear > 0
    if (!pet.model || !rig) return
    // Only reset while procedural: mixers cache constant track values and
    // won't reapply them if we overwrite the bones on every frame.
    if (!pet.idleAction && !state.move?.id.startsWith('clip:')) pet.resetProceduralPose()
    pet.mixer?.update(delta)
    if (state.appear <= 0) return

    // Placement: follow the anchor smoothly so the pet trails the character.
    const anchor = state.anchor ?? cfg.anchor
    this.anchorTarget(pet, anchor, rig, _v)
    if (!pet.placed) { pet.holder.position.copy(_v); pet.placed = true }
    else pet.holder.position.lerp(_v, 1 - Math.exp(-delta / cfg.followLag))

    const petHeight = cfg.size * rig.height
    const scale = petHeight / pet.modelHeight
    const pop = state.shown ? easeOutBack(state.appear) : state.appear
    pet.holder.scale.setScalar(scale * Math.max(pop, 0.0001))
    const facing = anchor === 'orbit' ? this.time * 0.8 * cfg.idle.speed + Math.PI / 2 : -(cfg.side === 'right' ? 1 : -1) * 0.25
    pet.holder.rotation.set(0, facing + THREE.MathUtils.degToRad(cfg.turn), 0)

    // Idle motion in model units (pivot is inside the scaled holder).
    const h = pet.modelHeight
    pet.idleTime += delta * cfg.idle.speed
    const t = pet.idleTime + pet.phase
    const amount = cfg.idle.amount
    let x = 0, y = 0, z = 0, rx = 0, rz = 0, ry = 0, sy = 1, flap = 0.25 * amount, flapHz = 6
    if (cfg.idle.style === 'float' && anchor !== 'beside') {
      x = Math.sin(t * 0.73) * 0.07 * h * amount
      y = (Math.sin(t * 1.6) * 0.11 + Math.sin(t * 0.63) * 0.025) * h * amount
      z = Math.sin(t * 1.07 + 1.2) * 0.04 * h * amount
      rx = Math.sin(t * 1.13 + 0.7) * 0.1 * amount
      ry = Math.sin(t * 0.67) * 0.16 * amount
      rz = Math.sin(t * 0.9) * 0.15 * amount
    } else if (cfg.idle.style === 'hop' || (cfg.idle.style === 'float' && anchor === 'beside')) {
      const phase = (t / 1.8) % 1
      if (phase < 0.3) y = Math.sin(phase / 0.3 * Math.PI) * 0.18 * h * amount
    }
    if (state.move) {
      const move = state.move
      const k = (this.time - move.t0) / move.duration
      if (k >= 1) {
        state.move = null
        if (state.loop) this.startMove(pet, state.loop)
      } else if (!move.id.startsWith('clip:')) {
        switch (move.id as PetMove) {
          case 'hop': y += Math.sin(k * Math.PI) * 0.5 * h; sy = k < 0.15 ? 1 - k * 1.5 : 1 + Math.sin(k * Math.PI) * 0.08; break
          case 'spin': ry += Math.PI * 2 * (1 - Math.pow(1 - k, 3)); break
          case 'flap': flap = 0.7; flapHz = 14; y += Math.sin(k * Math.PI) * 0.2 * h; break
          case 'wiggle': rz += Math.sin(k * Math.PI * 6) * 0.25 * (1 - k); break
          case 'bounce': y += Math.abs(Math.sin(k * Math.PI * 3)) * 0.22 * h; break
        }
      }
    }
    pet.pivot.position.set(x, y, z)
    pet.pivot.rotation.set(rx, ry, rz)
    pet.pivot.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy))
    const proceduralRig = !pet.idleAction && !state.move?.id.startsWith('clip:')
    for (const limb of proceduralRig ? pet.limbs : []) {
      const strength = cfg.limbMotion
      const moving = cfg.idle.style !== 'still' || (!!state.move && !state.move.id.startsWith('clip:'))
      const motion = moving ? amount * strength : 0
      const phase = t * 1.9 + (limb.sign < 0 ? Math.PI : 0)
      limb.bone.quaternion.copy(limb.rest).slerp(limb.relaxed, Math.min(strength, 1))
      _q.setFromAxisAngle(limb.swingAxis, Math.sin(phase) * (limb.arm ? 0.22 : 0.28) * motion)
      limb.bone.quaternion.multiply(_q)
      _q.setFromAxisAngle(limb.swayAxis, Math.sin(t * 1.17 + limb.sign) * 0.08 * motion)
      limb.bone.quaternion.multiply(_q)
    }
    for (const wing of proceduralRig ? pet.wings : []) {
      _q.setFromAxisAngle(WING_AXIS, Math.sin(this.time * flapHz) * flap * wing.sign)
      wing.bone.quaternion.copy(wing.rest).multiply(_q)
    }
    for (const tail of proceduralRig ? pet.tail : []) {
      _q.setFromAxisAngle(TAIL_AXIS, Math.sin(this.time * 3) * 0.3 * amount)
      tail.bone.quaternion.copy(tail.rest).multiply(_q)
    }

    // Expressions: temporary (mood, click) over persistent, plus blinking.
    if (state.temp && this.time >= state.temp.until) state.temp = null
    const expression = state.temp?.id ?? state.expression
    let blinkFrame: string | null = null
    const blink = cfg.blink
    if (blink) {
      const open = resolveExpressionParts(cfg, expression)[blink.group] === cfg.groups.find(g => g.id === blink.group)?.default
      if (state.blink.t0 === null && this.time >= state.blink.next && open) state.blink.t0 = this.time
      if (state.blink.t0 !== null) {
        const frames = [...blink.frames, ...blink.frames.slice(0, -1).reverse()]
        const index = Math.floor((this.time - state.blink.t0) / 0.05)
        if (index >= frames.length || !open) {
          state.blink.t0 = null
          state.blink.next = this.time + 2 + Math.random() * 4
        } else blinkFrame = frames[index]
      }
    }
    pet.applyParts(expression, blinkFrame)

    if (cfg.occasional.enabled && cfg.occasional.moves.length && this.time >= state.occasionalAt) {
      state.occasionalAt = this.nextOccasional(cfg)
      if (!state.move && !state.loop && state.shown) this.startMove(pet, cfg.occasional.moves[Math.floor(Math.random() * cfg.occasional.moves.length)])
    }
  }

  private updateProp(prop: PropInstance, delta: number, rig: CharacterRig | null) {
    const shown = this.propShown.get(prop.cfg.id) ?? false
    prop.appear = THREE.MathUtils.clamp(prop.appear + (shown ? 1 : -1) * delta / APPEAR_SECONDS, 0, 1)
    if (!prop.model || !rig) { prop.holder.visible = false; return }
    const cfg = prop.cfg
    if (prop.anchor !== cfg.anchor || !prop.holder.parent) {
      const parent = cfg.anchor === 'root' ? rig.root : rig.bone(cfg.anchor) ?? rig.root
      parent.add(prop.holder)
      prop.anchor = cfg.anchor
    }
    if (prop.colorsKey !== JSON.stringify(cfg.colors)) prop.applyColors()
    const unit = rig.height / 100
    prop.holder.position.set(cfg.offset.x * unit, cfg.offset.y * unit, cfg.offset.z * unit)
    prop.holder.rotation.set(THREE.MathUtils.degToRad(cfg.rotation.x), THREE.MathUtils.degToRad(cfg.rotation.y), THREE.MathUtils.degToRad(cfg.rotation.z))
    // Bone world scale is folded out so size stays relative to the character.
    const parentScale = prop.holder.parent ? prop.holder.parent.getWorldScale(_v).x || 1 : 1
    const scale = cfg.size * rig.height / prop.maxDimension / parentScale
    prop.holder.scale.setScalar(scale * Math.max(shown ? easeOutBack(prop.appear) : prop.appear, 0.0001))
    prop.holder.visible = prop.appear > 0
  }

  dispose() {
    this.disposed = true
    for (const pet of this.pets.values()) pet.dispose()
    for (const prop of this.props.values()) prop.dispose()
    this.pets.clear()
    this.props.clear()
    this.root.removeFromParent()
  }
}
