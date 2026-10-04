export interface HeadphoneFit { x: number; y: number; z: number; scale: number; width: number; height: number; depth: number; rx: number; ry: number; rz: number }
export interface MusicSettings { beatSync: boolean; minBpm: number; maxBpm: number; manualBpm: number; cutoff: number; sensitivity: number; nod: number; sway: number; randomDance: boolean; amplitudeReactive: boolean; amplitudeGain: number; reactOnEnd: boolean }
export const DEFAULT_FIT: HeadphoneFit = { x: 0, y: 4, z: 0, scale: 1, width: 1, height: 1, depth: 1, rx: 0, ry: 0, rz: 0 }
export const DEFAULT_MUSIC: MusicSettings = { beatSync: true, minBpm: 60, maxBpm: 200, manualBpm: 120, cutoff: 200, sensitivity: 1.5, nod: 24, sway: 4, randomDance: true, amplitudeReactive: true, amplitudeGain: 4, reactOnEnd: true }
const clamp = (v: unknown, fallback: number, low: number, high: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(high, Math.max(low, v)) : Math.min(high, Math.max(low, fallback))
export function normalizeMusic(value: Partial<MusicSettings> = {}): MusicSettings {
  const minBpm = clamp(value.minBpm, 60, 40, 239)
  return { beatSync: value.beatSync !== false, minBpm, maxBpm: clamp(value.maxBpm, 200, minBpm + 1, 240), manualBpm: clamp(value.manualBpm, 120, 40, 240), cutoff: clamp(value.cutoff, 200, 40, 200), sensitivity: clamp(value.sensitivity, 1.5, 1.05, 4), nod: clamp(value.nod, 24, 0, 45), sway: clamp(value.sway, 4, 0, 15), randomDance: value.randomDance !== false, amplitudeReactive: value.amplitudeReactive !== false, amplitudeGain: clamp(value.amplitudeGain, 4, .5, 12), reactOnEnd: value.reactOnEnd !== false }
}
export function normalizeFit(value: Partial<HeadphoneFit> = {}): HeadphoneFit {
  const fit = { ...DEFAULT_FIT }
  for (const key of ['x', 'y', 'z'] as const) fit[key] = clamp(value[key], fit[key], -40, 40)
  for (const key of ['scale', 'width', 'height', 'depth'] as const) fit[key] = clamp(value[key], 1, .2, 4)
  for (const key of ['rx', 'ry', 'rz'] as const) fit[key] = clamp(value[key], 0, -180, 180)
  return fit
}
// Relative model URLs and their localhost server URLs represent the same model.
export function modelFitKey(model: string): string {
  try { const url = new URL(model); if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.pathname } catch { /* Relative asset URL. */ }
  return model
}
