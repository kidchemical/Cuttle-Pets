import {
  applyBaseById, applyCompanions, applyEmotion, behaviorTarget, motionKey, playOnceById, resolveMain,
  type BehaviorEntry, type BehaviorEntryLocation, type BehaviorProfile, type BehaviorScene, type BehaviorStateId,
} from './behavior'

export interface EngineClock {
  now(): number
  random(): number
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}
const clock: EngineClock = {
  now: Date.now, random: Math.random,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  // Browser timer functions require the Window receiver. Calling a stored
  // clearTimeout as this.time.clearTimeout throws during state changes.
  clearTimeout: timer => clearTimeout(timer),
}
export interface BehaviorPlayback { state: BehaviorStateId | null; owned: boolean; entries?: BehaviorEntryLocation[] }
interface Input {
  enabled: boolean
  paused: boolean
  state: BehaviorStateId
  profile: BehaviorProfile
  scene: BehaviorScene | null
}

/** Owns all automatic sequences and occasional timers. The renderer only plays
 * requested motions. A nested behavior runs once without starting its timers;
 * a Main behavior reference delegates to its sustaining loop and occasionals. */
export class BehaviorEngine {
  private input: Input | null = null
  private generation = 0
  private waits = new Map<ReturnType<typeof setTimeout>, () => void>()
  private mains = new Map<string, BehaviorEntry>()
  private playing = false
  private active: BehaviorStateId | null = null
  private entries: BehaviorEntryLocation[] = []
  private previewSource?: BehaviorEntryLocation
  private preview: { entry: BehaviorEntry; loop: boolean } | null = null
  isPreviewing() { return this.preview !== null }
  private sustainedStates: BehaviorStateId[] = []
  private fingerprint = ''

  constructor(private report: (playback: BehaviorPlayback) => void, private time = clock) {}

  private cancel() {
    this.generation++
    for (const [timer, resolve] of this.waits) { this.time.clearTimeout(timer); resolve() }
    this.waits.clear()
    this.playing = false
    this.entries = []
  }
  dispose() { this.cancel(); this.input = null; this.setActive(null, false) }
  private setActive(state: BehaviorStateId | null, owned = true) {
    this.active = state
    this.report({ state, owned, entries: owned ? [...this.entries] : [] })
  }
  private live(gen: number) { return gen === this.generation && !!this.input?.scene }
  private delay(ms: number) {
    return new Promise<void>(resolve => {
      const timer = this.time.setTimeout(() => { this.waits.delete(timer); resolve() }, ms)
      this.waits.set(timer, resolve)
    })
  }
  private main(state: BehaviorStateId, profile: BehaviorProfile) {
    const cached = this.mains.get(state)
    const configured = profile.states[state]
    // Resume the previous weighted pick while it remains in the edited profile.
    if (cached && (configured.mains.some(e => motionKey(e) === motionKey(cached))
      || (!configured.mains.length && motionKey(configured.base) === motionKey(cached)))) return cached
    const pick = resolveMain(configured, () => this.time.random())
    if (pick) this.mains.set(state, pick)
    else this.mains.delete(state)
    return pick
  }

  update(input: Input) {
    const before = this.input
    // Cursor-follow tuning is read live by the renderer; editing it must not restart motion.
    const fingerprint = motionKey(input.profile)
    if (before && before.enabled === input.enabled && before.paused === input.paused
      && before.state === input.state && before.scene === input.scene && fingerprint === this.fingerprint) { this.input = input; return }
    // A manual preview owns playback but tracks changing ambient state/profile
    // so completion resumes the latest state. Reactions and reloads can cancel it.
    if (this.preview && before?.scene === input.scene && input.scene && !input.paused) {
      this.input = input
      this.fingerprint = fingerprint
      return
    }
    const previousState = before?.state
    const previousChain = this.sustainedStates
    this.sustainedStates = []
    const stateChanged = previousState !== input.state
    if (stateChanged) this.mains.clear()
    this.cancel()
    this.preview = null
    this.previewSource = undefined
    this.input = input
    this.fingerprint = fingerprint
    if (!input.enabled || input.paused || !input.scene) {
      this.setActive(null, false)
      if (!input.enabled && before?.enabled && !input.paused) input.scene?.resetPose()
      return
    }
    this.setActive(input.state)
    const gen = this.generation
    const scene = input.scene
    this.playing = true
    void (async () => {
      scene.resetPose()
      if (stateChanged && previousState && before?.enabled && !before.paused) {
        for (const exiting of (previousChain.length ? previousChain : [previousState]).slice().reverse()) {
          await this.sequence(before.profile.states[exiting].end, gen, new Set([exiting]), before.profile, exiting, 'end')
          if (!this.live(gen)) return
        }
      }
      if (!this.live(gen)) return
      if (!before?.enabled || stateChanged) {
        await this.sequence(input.profile.states[input.state].start, gen, new Set([input.state]), input.profile, input.state, 'start')
      }
      if (!this.live(gen)) return
      this.playing = false
      this.sustain(input.state, gen, new Set(), input.profile, !before?.enabled || stateChanged || before.scene !== input.scene, new Set(previousChain))
    })().catch(error => this.fail(gen, error))
  }

  private fail(gen: number, error: unknown) {
    if (!this.live(gen)) return
    console.warn('Behavior playback failed', error)
    this.playing = false
    this.preview = null
    this.previewSource = undefined
    this.input?.scene?.resetPose()
    if (this.input) this.restore(this.input.state, gen, new Set(), this.input.profile)
  }

  private async sequence(entries: BehaviorEntry[], gen: number, path: Set<BehaviorStateId>, profile: BehaviorProfile, state: BehaviorStateId, phase: 'start' | 'end') {
    for (const [index, entry] of entries.entries()) {
      if (!this.live(gen)) return
      await this.once(entry, gen, path, profile, { state, phase, index })
    }
  }

  private async once(entry: BehaviorEntry, gen: number, path: Set<BehaviorStateId>, profile: BehaviorProfile, source?: BehaviorEntryLocation) {
    if (!this.live(gen)) return
    const previous = this.entries
    if (source) this.entries = [...previous, source]
    this.setActive(this.active)
    try {
      const scene = this.input!.scene!
      const target = behaviorTarget(entry.animation)
      if (target) {
        // Refuse self-reference and indirect cycles. No nested timers are started.
        if (path.has(target)) return
        const nested = new Set(path).add(target)
        const parent = this.active
        this.setActive(target)
        scene.resetPose()
        applyEmotion(scene, entry.emotion, () => this.time.random())
        applyCompanions(scene, entry.companions)
        const cfg = profile.states[target]
        await this.sequence(cfg.start, gen, nested, profile, target, 'start')
        if (!this.live(gen)) return
        const main = resolveMain(cfg, () => this.time.random())
        if (main) await this.once({ ...main, emotion: main.emotion ?? entry.emotion, durationMs: entry.durationMs ?? main.durationMs }, gen, nested, profile, this.mainSource(target, main, profile))
        if (!this.live(gen)) return
        await this.sequence(cfg.end, gen, nested, profile, target, 'end')
        if (this.live(gen)) { scene.resetPose(); this.setActive(parent) }
        return
      }
      if (!entry.animation) {
        // Pet/prop-only entry: leave the character's motion alone.
        applyEmotion(scene, entry.emotion, () => this.time.random())
        applyCompanions(scene, entry.companions)
        if (entry.durationMs) await this.delay(entry.durationMs)
        return
      }
      scene.resetPose()
      applyEmotion(scene, entry.emotion, () => this.time.random())
      applyCompanions(scene, entry.companions)
      await playOnceById(scene, entry.animation, entry.preset, entry.durationMs ?? 5000)
      if (!this.live(gen)) return
      // Procedural motions have no clip-finished event; their one-shot hold is
      // explicit. Real clips wait for completion at their configured speed.
      if (entry.animation !== 'sip' && !entry.animation.startsWith('action:') && !entry.animation.startsWith('dance:') && entry.animation !== 'random:action') {
        await this.delay(entry.durationMs ?? 5000)
      } else {
        const started = this.time.now()
        while (this.live(gen) && scene.isBusy() && this.time.now() - started < 600000) await this.delay(100)
      }

    } finally {
      if (this.live(gen)) { this.entries = previous; this.setActive(this.active) }
    }
  }

  private mainSource(state: BehaviorStateId, main: BehaviorEntry, profile: BehaviorProfile): BehaviorEntryLocation | undefined {
    const index = profile.states[state].mains.findIndex(entry => motionKey(entry) === motionKey(main))
    return index < 0 ? undefined : { state, phase: 'mains', index }
  }

  private sustain(state: BehaviorStateId, gen: number, path: Set<BehaviorStateId>, profile: BehaviorProfile, enter = true, previous = new Set<BehaviorStateId>()) {
    if (!this.live(gen)) return
    const scene = this.input!.scene!
    if (path.has(state)) { scene.resetPose(); return }
    const nested = new Set(path).add(state)
    this.sustainedStates.push(state)
    if (!path.size) this.entries = this.previewSource ? [this.previewSource] : []
    const main = this.main(state, profile)
    const source = main && this.mainSource(state, main, profile)
    if (source) this.entries = [...this.entries, source]
    this.setActive(state)
    const target = main && behaviorTarget(main.animation)
    if (main) applyCompanions(scene, main.companions)
    if (target) {
      this.playing = true
      void (async () => {
        if ((enter || !previous.has(target)) && !nested.has(target)) await this.sequence(profile.states[target].start, gen, new Set(nested).add(target), profile, target, 'start')
        if (!this.live(gen)) return
        this.playing = false
        this.sustain(target, gen, nested, profile, enter, previous)
      })().catch(error => this.fail(gen, error))
    } else {
      scene.resetPose()
      if (main) { applyEmotion(scene, main.emotion); applyBaseById(scene, main.animation, main.preset) }
    }
    for (const [index, entry] of profile.states[state].occasionals.entries()) {
      void (async () => {
        while (this.live(gen)) {
          await this.delay((entry.everyMin + this.time.random() * Math.max(0, entry.everyMax - entry.everyMin)) * 1000)
          if (!this.live(gen)) return
          // The engine may interrupt its own sustained clip, but never another
          // occasional, manual preview, touch gesture, or custom reaction.
          if (this.playing || (scene.isBusy() && !scene.isLooping?.())) continue
          if (this.time.random() >= entry.chance) continue
          this.playing = true
          this.entries = []
          await this.once(entry, gen, nested, profile, { state, phase: 'occasionals', index })
          if (!this.live(gen)) return
          this.playing = false
          // A pet/prop-only occasional never interrupted the sustained motion.
          if (!entry.animation) { this.restoreEntries(state, profile); continue }
          scene.resetPose()
          this.restore(state, gen, new Set(), profile)
        }
      })().catch(error => this.fail(gen, error))
    }
  }
  /** Playback highlights for the sustained state, without touching the pose. */
  private restoreEntries(state: BehaviorStateId, profile: BehaviorProfile) {
    const main = this.mains.get(state)
    const source = main && this.mainSource(state, main, profile)
    this.entries = [...(this.previewSource ? [this.previewSource] : []), ...(source ? [source] : [])]
    this.setActive(state)
  }

  private restore(state: BehaviorStateId, gen: number, path: Set<BehaviorStateId>, profile: BehaviorProfile) {
    if (!this.live(gen) || path.has(state)) return
    if (!path.size) this.entries = this.previewSource ? [this.previewSource] : []
    const main = this.main(state, profile)
    const source = main && this.mainSource(state, main, profile)
    if (source) this.entries = [...this.entries, source]
    this.setActive(state)
    const target = main && behaviorTarget(main.animation)
    if (target) this.restore(target, gen, new Set(path).add(state), profile)
    else if (main) applyBaseById(this.input!.scene!, main.animation, main.preset)
  }

  /** Settings transports also use this dispatcher for behavior references. */
  previewEntry(entry: BehaviorEntry, loop: boolean, source?: BehaviorEntryLocation) {
    if (!this.input?.scene) return
    this.cancel()
    this.preview = { entry, loop }
    this.previewSource = source
    this.sustainedStates = []
    const gen = this.generation
    const profile = this.input.profile
    const target = behaviorTarget(entry.animation)
    this.setActive(target ?? (entry.animation.startsWith('dance:') ? 'dancing' : this.input.state))
    this.playing = true
    void (async () => {
      if (loop && target) {
        this.input!.scene!.resetPose()
        await this.sequence(profile.states[target].start, gen, new Set([target]), profile, target, 'start')
        if (!this.live(gen)) return
        this.playing = false
        this.sustain(target, gen, new Set(), profile)
      } else if (loop) {
        this.input!.scene!.resetPose()
        this.entries = source ? [source] : []
        this.setActive(this.active)
        applyCompanions(this.input!.scene!, entry.companions)
        applyBaseById(this.input!.scene!, entry.animation, entry.preset)
        this.playing = false
      } else {
        await this.once(entry, gen, new Set(), profile, source)
        if (!this.live(gen)) return
        this.preview = null
        const input = this.input!
        this.input = null
        input.scene?.resetPose()
        this.update(input)
      }
    })().catch(error => this.fail(gen, error))
  }
  stopPreview() {
    if (!this.preview || !this.input) return
    const input = this.input
    this.input = null
    input.scene?.resetPose()
    this.update(input)
  }
  /**
   * Re-apply the current state's sustained base after an external pose reset
   * (Stop preview button, tray pose reset) cleared it. Never interrupts an
   * in-flight sequence, occasional, preview, or paused/disabled engine.
   */
  resync() {
    const input = this.input
    if (!input || !input.enabled || input.paused || !input.scene || this.preview || this.playing) return
    this.restore(input.state, this.generation, new Set(), input.profile)
  }
}
