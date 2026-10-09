import { SettingsHelp } from './SettingsHelp'
import { useEffect, useState } from 'react'
import { petUrl } from '../config'
import { musicReadout, type MusicAnalysis } from '../music-readout'
import './music-settings.css'
import { DEFAULT_FIT, DEFAULT_MUSIC, type HeadphoneFit, type MusicSettings } from '../music-settings'

interface Props {
  fit: HeadphoneFit; music: MusicSettings; enabled: boolean
  onFitChange: (fit: HeadphoneFit) => void
  onMusicChange: (music: MusicSettings) => void
  onEnabledChange: (enabled: boolean) => void
  onPreview: (active: boolean) => void
}
export function MusicSettingsPanel({ fit, music, enabled, onFitChange, onMusicChange, onEnabledChange, onPreview }: Props) {
  const [preview, setPreview] = useState(false)
  useEffect(() => () => onPreview(false), [onPreview])
  const slider = (label: string, value: number, min: number, max: number, step: number, change: (v: number) => void, unit = '') => <label style={{ display: 'grid', gridTemplateColumns: '1fr 76px', gap: 6, fontSize: 12 }}>
    <span>{label}</span><span style={{ textAlign: 'right' }}>{Number(value.toFixed(2))}{unit}</span>
    <input style={{ gridColumn: '1 / -1', width: '100%' }} type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={e => change(Number(e.target.value))} />
  </label>
  return <div className="music-settings">
    <label><input type="checkbox" checked={enabled} onChange={e => onEnabledChange(e.target.checked)} /> React to music</label>
    <section aria-label="BPM analysis">
      <MusicAnalysisReadout enabled={enabled} />
      <label><input type="checkbox" checked={music.beatSync} onChange={e => onMusicChange({ ...music, beatSync: e.target.checked })} /> Sync to beats in desktop playback audio</label>
      {slider('Minimum detected BPM', music.minBpm, 40, music.maxBpm - 1, 1, v => onMusicChange({ ...music, minBpm: v }))}
      {slider('Maximum detected BPM', music.maxBpm, music.minBpm + 1, 240, 1, v => onMusicChange({ ...music, maxBpm: v }))}
      {slider('Bass analysis band upper limit', music.cutoff, 40, 200, 5, v => onMusicChange({ ...music, cutoff: v }), ' Hz')}
      {slider('Peak threshold (lower = more sensitive)', music.sensitivity, 1.05, 4, .05, v => onMusicChange({ ...music, sensitivity: v }), '×')}
      {slider('Fallback tempo', music.manualBpm, 40, 240, 1, v => onMusicChange({ ...music, manualBpm: v }), ' BPM')}

    </section>
    <section aria-label="Music motion"><h3>Music motion<SettingsHelp label="Music motion help">Automatic dances and end reactions are configured in Behavior → Music.</SettingsHelp></h3>
      {slider('Forward / back nod', music.nod, 0, 45, 1, v => onMusicChange({ ...music, nod: v }), '°')}
      {slider('Side sway', music.sway, 0, 15, .5, v => onMusicChange({ ...music, sway: v }), '°')}
      <label><input type="checkbox" checked={music.amplitudeReactive} onChange={e => onMusicChange({ ...music, amplitudeReactive: e.target.checked })} /> Nod more strongly with louder music</label>
      {slider('Amplitude response', music.amplitudeGain, .5, 12, .25, v => onMusicChange({ ...music, amplitudeGain: v }), '×')}
      <button onClick={() => onMusicChange({ ...DEFAULT_MUSIC })}>Reset music settings</button>
    </section>
    <section className="music-headphone-fit" aria-label="Headphone fit">
      <h3>Headphone fit — current model<SettingsHelp label="Headphone fit help">Saved separately for each model. Offsets are a percentage of character height.</SettingsHelp></h3>
      <label><input type="checkbox" checked={preview} onChange={e => { setPreview(e.target.checked); onPreview(e.target.checked) }} /> Preview headphones and nodding without music</label>
      {(['x', 'y', 'z'] as const).map((key, i) => <div key={key}>{slider(['Left / right', 'Up / down', 'Forward / back'][i], fit[key], -40, 40, .25, v => onFitChange({ ...fit, [key]: v }), '%')}</div>)}
      {(['scale', 'width', 'height', 'depth'] as const).map(key => <div key={key}>{slider(key === 'scale' ? 'Overall scale' : key[0].toUpperCase() + key.slice(1), fit[key], .2, 4, .025, v => onFitChange({ ...fit, [key]: v }), '×')}</div>)}
      {(['rx', 'ry', 'rz'] as const).map((key, i) => <div key={key}>{slider(['Pitch', 'Yaw', 'Roll'][i], fit[key], -180, 180, 1, v => onFitChange({ ...fit, [key]: v }), '°')}</div>)}
      <button onClick={() => onFitChange({ ...DEFAULT_FIT })}>Reset this character’s headphone fit</button>
    </section>
  </div>
}

/** Polling updates only the live readout, leaving the fitting controls alone. */
function MusicAnalysisReadout({ enabled }: { enabled: boolean }) {
  const [analysis, setAnalysis] = useState<MusicAnalysis>({})
  const [lastBpm, setLastBpm] = useState<number | null>(null)
  const readout = musicReadout(analysis, lastBpm, enabled)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let controller: AbortController | null = null
    const poll = async () => {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 2000)
      try {
        const response = await fetch(petUrl('/music'), { signal: controller.signal })
        if (!response.ok) throw new Error('Music status unavailable')
        const result = await response.json()
        if (active) {
          const next: MusicAnalysis = result.analysis || {}
          setAnalysis(next)
          const value = musicReadout(next, null, true)
          if (value.current) setLastBpm(value.bpm)
        }
      } catch {
        if (active) setAnalysis({ status: 'unavailable', message: 'Pet server offline; using fallback tempo.' })
      } finally {
        clearTimeout(timeout)
        if (active) timer = setTimeout(() => { void poll() }, 500)
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer); controller?.abort() }
  }, [])
  return (
    <div className="music-bpm-card" data-state={readout.state}>
      <div className="music-bpm-heading"><h3>Desktop playback BPM<SettingsHelp label="BPM analysis help">Yellow: calculating. Green: locked. The estimate stays visible while analysis settles. Motion uses fallback tempo until a beat grid is available. Audio is analyzed locally in memory; no recordings are saved.</SettingsHelp></h3><span className="music-bpm-state" role="status">{readout.label}</span></div>
      <div className="music-bpm-value" aria-label={readout.bpm === null ? 'BPM estimate pending' : `${Math.round(readout.bpm)} BPM ${readout.current ? 'current' : 'last'} estimate`}>
        <strong>{readout.bpm === null ? '—' : Math.round(readout.bpm)}</strong><span>BPM</span>
      </div>
      <p className="music-note">{readout.detail}</p>
      {!readout.current && readout.bpm !== null && readout.state !== 'calculating' && <p className="music-note">Last estimate</p>}
      <div className="music-bpm-confidence"><span>Rhythm confidence</span><meter aria-label="Rhythm confidence" min={0} max={1} value={readout.confidence} /></div>
    </div>
  )
}
