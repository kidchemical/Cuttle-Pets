import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js'
import { petUrl } from './config'
import type { AssetInfo, CompanionKind } from './companions'

const folder = (kind: CompanionKind) => kind === 'pet' ? 'pets' : 'props'

/** Named nodes owning meshes, bones, clips and materials of a loaded asset. */
export function analyzeAsset(root: THREE.Object3D, clips: THREE.AnimationClip[] = []): AssetInfo {
  const parts = new Set<string>()
  const bones = new Set<string>()
  const materials = new Set<string>()
  root.traverse(object => {
    if ((object as THREE.Bone).isBone) { if (object.name) bones.add(object.name); return }
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    // A swap mesh is toggled through its nearest named non-bone ancestor.
    let owner: THREE.Object3D | null = mesh
    while (owner && (!owner.name || (owner as THREE.Bone).isBone)) owner = owner.parent
    if (owner && owner !== root) parts.add(owner.name)
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material.name) materials.add(material.name)
    }
  })
  return { parts: [...parts], bones: [...bones], clips: clips.map(c => c.name).filter(Boolean), materials: [...materials] }
}

async function loadSource(url: string, format: string): Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  // FBX/Collada return before their textures finish; the manager settles
  // once every request (model + textures, failed or not) is done.
  const manager = new THREE.LoadingManager()
  const settled = new Promise<void>(resolve => { manager.onLoad = () => resolve(); manager.onError = () => {} })
  const done = <T,>(value: T) => Promise.race([settled, new Promise(resolve => setTimeout(resolve, 20000))]).then(() => value)
  if (format === 'glb' || format === 'gltf') {
    const gltf = await new GLTFLoader(manager).loadAsync(url)
    return done({ scene: gltf.scene, clips: gltf.animations ?? [] })
  }
  if (format === 'fbx') {
    const group = await new FBXLoader(manager).loadAsync(url)
    return done({ scene: group, clips: group.animations ?? [] })
  }
  if (format === 'dae') {
    const collada = await new ColladaLoader(manager).loadAsync(url)
    if (!collada) throw new Error('Could not read the Collada file.')
    // Collada carries clips on the scene; the root up-axis rotation is kept
    // and baked into the exported node transform.
    return done({ scene: collada.scene, clips: collada.scene.animations ?? [] })
  }
  throw new Error(`Unsupported format .${format}`)
}

/** Unnamed materials get stable names so per-material colors can address them. */
function nameMaterials(root: THREE.Object3D) {
  let n = 0
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material.name) material.name = `material-${++n}`
    }
  })
}

/** Textures that failed to load would make the exporter throw; drop them. */
function dropBrokenTextures(root: THREE.Object3D) {
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const [key, value] of Object.entries(material)) {
        if (value instanceof THREE.Texture && !(value.image as { width?: number } | undefined)?.width) {
          (material as unknown as Record<string, unknown>)[key] = null
        }
      }
    }
  })
}

async function post(path: string, body: BodyInit, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
  const response = await fetch(petUrl(path), { method: 'POST', headers, body })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

export interface ImportedAsset { file: string; name: string; asset: AssetInfo }

/** A GLB already stored in the companion library (server `asset_list`). */
export interface LibraryAsset { name: string; size: number; url: string }

/** Files stored under DATA_DIR/pets or DATA_DIR/props. */
export async function listCompanionAssets(kind: CompanionKind): Promise<LibraryAsset[]> {
  const response = await fetch(petUrl(`/assets/${folder(kind)}/list`))
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error || `Library request failed (${response.status})`)
  return Array.isArray(data.assets) ? data.assets as LibraryAsset[] : []
}

/** Library files with no pet/prop config pointing at them yet. */
export function unconfiguredAssets(library: LibraryAsset[], configuredFiles: string[]): LibraryAsset[] {
  const used = new Set(configuredFiles)
  return library.filter(asset => !used.has(asset.name))
}

/** Analyze an already-imported GLB so it can be added as a pet/prop config
 * without re-converting: same GLTFLoader + analyzeAsset as the import path. */
export async function analyzeStoredAsset(kind: CompanionKind, file: string): Promise<AssetInfo> {
  const gltf = await new GLTFLoader().loadAsync(companionAssetUrl(kind, file))
  return analyzeAsset(gltf.scene, gltf.animations ?? [])
}

/**
 * Import a local model file as a pet or prop GLB. GLB files are stored as-is;
 * glTF/FBX/DAE are loaded with three.js (textures from the same folder) and
 * re-exported as a single GLB so the renderer only ever loads one format.
 */
export async function importCompanionAsset(kind: CompanionKind, path: string, onStatus: (text: string) => void = () => {}): Promise<ImportedAsset> {
  onStatus('Copying model and textures…')
  const staged = await post(`/assets/${folder(kind)}/stage`, JSON.stringify({ path }))
  onStatus('Reading model…')
  const { scene, clips } = await loadSource(petUrl(staged.url), staged.format)
  if (staged.format === 'glb') {
    const asset = analyzeAsset(scene, clips)
    const stored = await post(`/assets/${folder(kind)}/commit`, JSON.stringify({ token: staged.token, name: staged.name }))
    return { file: stored.name, name: staged.name, asset }
  }
  onStatus('Converting to GLB…')
  nameMaterials(scene)
  dropBrokenTextures(scene)
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false, animations: clips, maxTextureSize: 2048 }) as ArrayBuffer
  onStatus('Saving…')
  const stored = await post(`/assets/${folder(kind)}/upload?token=${encodeURIComponent(staged.token)}&name=${encodeURIComponent(staged.name)}`, glb, { 'Content-Type': 'model/gltf-binary' })
  // Analyze the stored GLB, not the source: names are what the renderer will see.
  const roundTrip = await new GLTFLoader().loadAsync(petUrl(stored.url))
  return { file: stored.name, name: staged.name, asset: analyzeAsset(roundTrip.scene, roundTrip.animations) }
}

export async function deleteCompanionAsset(kind: CompanionKind, file: string) {
  await post(`/assets/${folder(kind)}/delete`, JSON.stringify({ name: file }))
}

export function companionAssetUrl(kind: CompanionKind, file: string) {
  return petUrl(`/assets/${folder(kind)}/serve/${encodeURIComponent(file)}`)
}
