import { petUrl } from './config'
export interface CustomDance { id: string; label: string; vmdUrl: string; bgmUrl?: string }
/** Accept the control server's name/url records and older id/vmdUrl records. */
export function normalizeCustomDances(data: unknown): CustomDance[] {
  if (!Array.isArray(data)) return []
  const url = (value: string) => /^https?:\/\//.test(value) ? value : petUrl(value)
  return data.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const id = entry.id ?? entry.name
    const path = entry.vmdUrl ?? entry.url
    if (typeof id !== 'string' || typeof path !== 'string') return []
    return [{ id, label: entry.label ?? id.replace(/\.vmd$/i, ''), vmdUrl: url(path), bgmUrl: typeof entry.bgmUrl === 'string' ? url(entry.bgmUrl) : undefined }]
  })
}
