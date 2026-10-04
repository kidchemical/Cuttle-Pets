import { petUrl } from './config'
export type CustomMotionType = 'vmd' | 'vrma' | 'fbx'
export interface CustomDance { id: string; label: string; vmdUrl: string; bgmUrl?: string; type: CustomMotionType }
/** Motion type from a file path or served URL (extension-based). */
export function motionTypeFor(path: string): CustomMotionType {
  const lower = path.toLowerCase()
  if (lower.endsWith('.vrma')) return 'vrma'
  if (lower.endsWith('.fbx')) return 'fbx'
  return 'vmd'
}
/** Accept the control server's name/url records and older id/vmdUrl records. */
export function normalizeCustomDances(data: unknown): CustomDance[] {
  if (!Array.isArray(data)) return []
  const url = (value: string) => /^https?:\/\//.test(value) ? value : petUrl(value)
  return data.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const id = entry.id ?? entry.name
    const path = entry.vmdUrl ?? entry.url
    if (typeof id !== 'string' || typeof path !== 'string') return []
    const type = typeof entry.type === 'string' && (entry.type === 'vrma' || entry.type === 'fbx' || entry.type === 'vmd')
      ? entry.type
      : motionTypeFor(path)
    return [{ id, label: entry.label ?? id.replace(/\.(vmd|vrma|fbx)$/i, ''), vmdUrl: url(path), bgmUrl: typeof entry.bgmUrl === 'string' ? url(entry.bgmUrl) : undefined, type }]
  })
}
