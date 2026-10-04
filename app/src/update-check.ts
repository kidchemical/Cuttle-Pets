import { APP_RELEASES_URL, APP_REPO, APP_VERSION } from './version'

export interface UpdateInfo {
  current: string
  latest: string
  url: string
  notes: string
  publishedAt: string
}

export type UpdateStatus =
  | { state: 'latest'; latest: string }
  | { state: 'available'; info: UpdateInfo }
  | { state: 'checking' }
  | { state: 'unknown' }

const CACHE_KEY = 'cuttle-pet-update-check-v1'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

interface CachedCheck {
  checkedAt: number
  latest: string
  url: string
  notes: string
  publishedAt: string
}

function readCache(): CachedCheck | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (typeof data?.latest !== 'string') return null
    return data as CachedCheck
  } catch {
    return null
  }
}

function writeCache(entry: CachedCheck) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    /* Storage unavailable — the check just runs again next time. */
  }
}

/** Numeric semver comparison. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('+')[0]
      .split('-')[0]
      .split('.')
      .map(n => {
        const parsed = parseInt(n, 10)
        return Number.isNaN(parsed) ? 0 : parsed
      })
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

async function fetchLatestRelease(): Promise<CachedCheck | 'none' | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
    // No releases published yet: distinct from a network failure. There is
    // nothing newer than the running build, so this resolves to 'latest'.
    if (response.status === 404) return 'none'
    if (!response.ok) throw new Error(`GitHub releases: HTTP ${response.status}`)
    const data = await response.json()
    const tag = String(data.tag_name || '').replace(/^v/i, '')
    if (!tag) return 'none'
    return {
      checkedAt: Date.now(),
      latest: tag,
      url: String(data.html_url || APP_RELEASES_URL),
      notes: String(data.body || ''),
      publishedAt: String(data.published_at || ''),
    }
  } finally {
    clearTimeout(timer)
  }
}

function toStatus(current: string, cached: CachedCheck | null): UpdateStatus {
  if (!cached) return { state: 'unknown' }
  if (compareVersions(current, cached.latest) < 0) {
    return {
      state: 'available',
      info: {
        current,
        latest: cached.latest,
        url: cached.url,
        notes: cached.notes,
        publishedAt: cached.publishedAt,
      },
    }
  }
  return { state: 'latest', latest: cached.latest }
}

/**
 * Check GitHub for a newer release. Uses the cached result when it is fresh
 * unless `force` is set. Never throws: network failures resolve to the cached
 * state (or 'unknown' when nothing was ever cached).
 */
export async function checkForUpdates(current = APP_VERSION, force = false): Promise<UpdateStatus> {
  const cached = readCache()
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
    return toStatus(current, cached)
  }
  try {
    const fresh = await fetchLatestRelease()
    if (fresh === 'none') return { state: 'latest', latest: current }
    if (!fresh) return toStatus(current, cached)
    writeCache(fresh)
    return toStatus(current, fresh)
  } catch {
    return toStatus(current, cached)
  }
}

/** Last cached check without hitting the network. */
export function cachedUpdateStatus(current = APP_VERSION): UpdateStatus {
  return toStatus(current, readCache())
}
