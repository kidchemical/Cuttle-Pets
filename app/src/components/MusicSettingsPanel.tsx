import { useEffect, useState } from 'react'
import { petUrl } from '../config'
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
  const [status, setStatus] = useState('Connecting…')
  useEffect(() => () => onPreview(false), [onPreview])
  useEffect(() => {
    let active = true
    const poll = () => fetch(petUrl('/music')).then(r => r.json()).then(s => {
      if (active) setStatus(s.analysis?.status === 'listening' ? (s.analysis.bpm ? `Beat detected: ${Math.round(s.analysis.bpm)} BPM` : 'Listening for bass peaks… Using fallback tempo until locked.') : s.analysis?.message || 'Audio analysis unavailable; using fallback tempo.')
    }).catch(() => { if (active) setStatus('Pet server offline; using fallback tempo.') })
    void poll(); const timer = setInterval(poll, 1500)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const slider = (label: string, value: number, min: number, max: number, step: number, change: (v: number) => void, unit = '') => <label style={{ display: 'grid', gridTemplateColumns: '1fr 76px', gap: 6, fontSize: 12 }}>
    <span>{label}</span><span style={{ textAlign: 'right' }}>{Number(value.toFixed(2))}{unit}</span>
    <input style={{ gridColumn: '1 / -1', width: '100%' }} type="range" min={min} max={max} step={step} value={value} onChange={e => change(Number(e.target.value))} />
  </label>
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
    <label><input type="checkbox" checked={enabled} onChange={e => onEnabledChange(e.target.checked)} /> React to music</label>
    <strong>Headphone fit — current character</strong>
    <span>Saved separately for each model. Offsets are a percentage of character height.</span>
    <label><input type="checkbox" checked={preview} onChange={e => { setPreview(e.target.checked); onPreview(e.target.checked) }} /> Preview headphones and nodding without music</label>
    {(['x', 'y', 'z'] as const).map((key, i) => <div key={key}>{slider(['Left / right', 'Up / down', 'Forward / back'][i], fit[key], -40, 40, .25, v => onFitChange({ ...fit, [key]: v }), '%')}</div>)}
    {(['scale', 'width', 'height', 'depth'] as const).map(key => <div key={key}>{slider(key === 'scale' ? 'Overall scale' : key[0].toUpperCase() + key.slice(1), fit[key], .2, 4, .025, v => onFitChange({ ...fit, [key]: v }), '×')}</div>)}
    {(['rx', 'ry', 'rz'] as const).map((key, i) => <div key={key}>{slider(['Pitch', 'Yaw', 'Roll'][i], fit[key], -180, 180, 1, v => onFitChange({ ...fit, [key]: v }), '°')}</div>)}
    <button onClick={() => onFitChange({ ...DEFAULT_FIT })}>Reset this character’s headphone fit</button>
    <strong>Music motion</strong>
    {slider('Forward / back nod', music.nod, 0, 45, 1, v => onMusicChange({ ...music, nod: v }), '°')}
    {slider('Side sway', music.sway, 0, 15, .5, v => onMusicChange({ ...music, sway: v }), '°')}
    <label><input type="checkbox" checked={music.amplitudeReactive} onChange={e => onMusicChange({ ...music, amplitudeReactive: e.target.checked })} /> Nod more strongly with louder music</label>
    {slider('Amplitude response', music.amplitudeGain, .5, 12, .25, v => onMusicChange({ ...music, amplitudeGain: v }), '×')}
    <label><input type="checkbox" checked={music.reactOnEnd} onChange={e => onMusicChange({ ...music, reactOnEnd: e.target.checked })} /> Clap or cheer after a song goes quiet</label>
    <span style={{ opacity: .75 }}>End reactions wait for sustained quiet after at least 10 seconds of playback. Typing resumes after the gesture.</span>
    <label><input type="checkbox" checked={music.randomDance} onChange={e => onMusicChange({ ...music, randomDance: e.target.checked })} /> Occasionally dance while idle</label>
    <label><input type="checkbox" checked={music.beatSync} onChange={e => onMusicChange({ ...music, beatSync: e.target.checked })} /> Sync to bass beats in desktop playback audio</label>
    <span>Audio is analyzed locally in memory. No recordings are saved. Working takes priority.</span>
    <span role="status">{status}</span>
    {slider('Minimum detected BPM', music.minBpm, 40, music.maxBpm - 1, 1, v => onMusicChange({ ...music, minBpm: v }))}
    {slider('Maximum detected BPM', music.maxBpm, music.minBpm + 1, 240, 1, v => onMusicChange({ ...music, maxBpm: v }))}
    {slider('Bass band upper limit', music.cutoff, 40, 200, 5, v => onMusicChange({ ...music, cutoff: v }), ' Hz')}
    {slider('Peak threshold (lower = more sensitive)', music.sensitivity, 1.05, 4, .05, v => onMusicChange({ ...music, sensitivity: v }), '×')}
    {slider('Fallback tempo', music.manualBpm, 40, 240, 1, v => onMusicChange({ ...music, manualBpm: v }), ' BPM')}
    <button onClick={() => onMusicChange({ ...DEFAULT_MUSIC })}>Reset music motion</button>
  </div>
}
