/** Display-clock frame pacing. Retain fractional intervals so a 90 FPS cap on
 * a 144 Hz screen averages 90 rather than falling to 72. */
export class FramePacer {
  private nextAt = 0
  private cap = -1
  reset() { this.cap = -1; this.nextAt = 0 }
  shouldRender(now: number, maxFps: number): boolean {
    if (maxFps !== this.cap) { this.cap = maxFps; this.nextAt = now }
    if (maxFps === 0) return true
    if (now + .5 < this.nextAt) return false
    const interval = 1000 / maxFps
    this.nextAt += Math.max(1, Math.floor((now - this.nextAt + .5) / interval) + 1) * interval
    return true
  }
}
