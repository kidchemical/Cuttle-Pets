import type { MusicSettings } from './music-settings'
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v))
const wrap = (cycles: number) => cycles - Math.floor(cycles + .5)
const smooth = (current: number, target: number, dt: number, seconds: number) => current + (target - current) * (1 - Math.exp(-dt / seconds))

/** Continuous oscillator: beat arrivals steer tempo/phase instead of restarting the pose. */
export class MusicMotion {
  phase = 0
  bpm = 120
  private lockedBpm = 120
  private lastLock = -Infinity
  private phaseError = 0
  private audioAt = -Infinity
  private audioLevel = 0
  private audioAvailable = false
  private intensity = 0
  private pitch = 0
  private roll = 0
  receiveBeat(beat: { bpm: number | null; confidence: number; timestamp: number }, now: number, age: number) {
    if (!beat.bpm || !Number.isFinite(beat.bpm) || !Number.isFinite(beat.confidence) || !Number.isFinite(age) || beat.confidence < .35 || age > 2) return
    this.lockedBpm = clamp(beat.bpm, 40, 240)
    this.lastLock = now
    this.phaseError = wrap(age * this.lockedBpm / 60 - this.phase)
  }
  receiveAudio(amplitude: number, available: boolean, now: number) {
    this.audioLevel = Number.isFinite(amplitude) ? clamp(amplitude, 0, 1) : 0
    this.audioAvailable = available
    this.audioAt = now
  }
  step(delta: number, now: number, options: MusicSettings, listening: boolean, preview: boolean, working: boolean, sip: number) {
    const dt = clamp(delta, 0, .05)
    const locked = options.beatSync && now - this.lastLock < 10
    this.bpm = smooth(this.bpm, locked ? this.lockedBpm : options.manualBpm, dt, 1.5)
    const correction = locked ? clamp(this.phaseError * 1.5, -.18, .18) * dt : 0
    this.phaseError -= correction
    this.phase = (this.phase + this.bpm / 60 * dt + correction) % 2
    const freshAudio = now - this.audioAt < 2
    const amplitude = freshAudio ? this.audioLevel : 0
    const reactive = options.amplitudeReactive && this.audioAvailable
    const strength = preview || !reactive ? 1 : Math.min(1, Math.sqrt(amplitude * options.amplitudeGain))
    const target = listening ? strength * (working ? .65 : 1) * (1 - sip) : 0
    this.intensity = smooth(this.intensity, target, dt, target > this.intensity ? .15 : .45)
    const requestedPitch = Math.cos(this.phase * Math.PI * 2) * options.nod * Math.PI / 180 * this.intensity
    const pitch = working ? clamp(requestedPitch, -.12, .25) : requestedPitch
    const roll = Math.sin(this.phase * Math.PI) * options.sway * Math.PI / 180 * this.intensity
    this.pitch = smooth(this.pitch, pitch, dt, .05)
    this.roll = smooth(this.roll, roll, dt, .08)
    return { pitch: this.pitch, roll: this.roll, intensity: this.intensity, phase: this.phase, bpm: this.bpm }
  }
}
