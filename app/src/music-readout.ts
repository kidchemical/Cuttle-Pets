export interface MusicAnalysis {
  status?: string
  message?: string
  bpm?: number | null
  candidate_bpm?: number | null
  locked?: boolean
  confidence?: number
  playing?: boolean
  timestamp?: number
}
export interface MusicReadout {
  bpm: number | null
  state: 'connecting' | 'locked' | 'calculating' | 'quiet' | 'disabled' | 'unavailable'
  label: string
  detail: string
  confidence: number
  current: boolean
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** A tentative estimate can be displayed without using it to drive animation. */
export function musicReadout(analysis: MusicAnalysis, previous: number | null, enabled: boolean, now = Date.now() / 1000): MusicReadout {
  const confidence = typeof analysis.confidence === 'number' && Number.isFinite(analysis.confidence)
    ? Math.max(0, Math.min(1, analysis.confidence)) : 0
  const stale = typeof analysis.timestamp === 'number' && (!Number.isFinite(analysis.timestamp) || Math.abs(now - analysis.timestamp) > 3)
  const listening = enabled && analysis.status === 'listening' && !stale
  const estimate = positive(analysis.bpm) ? analysis.bpm : positive(analysis.candidate_bpm) ? analysis.candidate_bpm : null
  const current = listening && analysis.playing !== false && estimate !== null
  const bpm = current ? estimate : positive(previous) ? previous : null
  const base = { bpm, confidence: listening ? confidence : 0, current }
  if (!enabled || analysis.status === 'disabled') return { ...base, state: 'disabled', label: 'Analysis off', detail: 'Enable music reactions to analyze desktop playback.' }
  if (stale || analysis.status === 'unavailable') return { ...base, state: 'unavailable', label: 'Audio unavailable', detail: stale ? 'Waiting for fresh audio analysis.' : analysis.message || 'Using fallback tempo until playback capture reconnects.' }
  if (!analysis.status || analysis.status === 'starting') return { ...base, state: 'connecting', label: 'Connecting', detail: 'Waiting for desktop audio analysis.' }
  if (analysis.playing === false) return { ...base, state: 'quiet', label: 'Waiting for audio', detail: 'Play music through your desktop output to start analysis.' }
  const locked = positive(analysis.bpm) && confidence >= .35 && analysis.locked !== false
  if (listening && locked) return { ...base, state: 'locked', label: 'Locked', detail: 'The detected beat grid is ready for synchronization.' }
  return { ...base, state: 'calculating', label: 'Calculating', detail: current ? 'Live estimate · still checking the rhythm.' : bpm ? 'Last estimate · still checking the rhythm.' : 'Collecting rhythm evidence · using fallback tempo.' }
}
