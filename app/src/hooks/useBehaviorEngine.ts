import { useEffect, useRef } from 'react'
import {
  applyBaseById, applyEmotion, playOnceById,
  type BehaviorEntry, type BehaviorProfile, type BehaviorScene, type BehaviorStateId,
  type OccasionalEntry,
} from '../behavior'

interface EngineInput {
  enabled: boolean
  profile: BehaviorProfile
  state: BehaviorStateId
  /** A custom reaction owns the pet: stop scheduling, then re-apply the base on resume. */
  paused?: boolean
  getScene: () => BehaviorScene | null
}

const SEQ_TIMEOUT_MS = 20000
const SEQ_POLL_MS = 400

function waitForSettled(scene: BehaviorScene, timeoutMs: number, pollMs: number): Promise<void> {
  const start = Date.now()
  return new Promise(resolve => {
    const tick = () => {
      if (!scene.isBusy() || Date.now() - start >= timeoutMs) resolve()
      else setTimeout(tick, pollMs)
    }
    tick()
  })
}

/**
 * Drives the pet from a behavior profile: on every state change it plays the
 * previous state's end sequence, then the new state's start sequence and base
 * loop, and schedules that state's occasional one-shots (frequency + chance).
 * Manual previews and interactions win: sequences wait for a free mixer and
 * occasionals skip busy rounds. While paused (a reaction is playing) nothing
 * is scheduled; resuming re-applies the current state's base without
 * replaying its start/end sequences.
 */
export function useBehaviorEngine({ enabled, profile, state, paused = false, getScene }: EngineInput) {
  const genRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const handledStateRef = useRef<BehaviorStateId | null>(null)
  const prevStateRef = useRef<BehaviorStateId | null>(null)
  const resumingRef = useRef(false)
  const sceneRef = useRef(getScene)
  sceneRef.current = getScene

  const clearTimers = () => {
    for (const timer of timersRef.current) clearTimeout(timer)
    timersRef.current = []
  }
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timersRef.current = timersRef.current.filter(t => t !== timer)
      fn()
    }, ms)
    timersRef.current.push(timer)
  }

  // State transitions: end sequence → start sequence → base loop.
  useEffect(() => {
    if (!enabled) {
      handledStateRef.current = null
      prevStateRef.current = null
      genRef.current++
      clearTimers()
      return
    }
    if (paused) {
      genRef.current++
      clearTimers()
      if (handledStateRef.current !== null) resumingRef.current = true
      handledStateRef.current = null
      return
    }
    if (resumingRef.current) {
      resumingRef.current = false
      handledStateRef.current = state
      prevStateRef.current = state
      // A resumed user dance already owns the mixer (see the dancing note below).
      const scene = sceneRef.current()
      if (scene && state !== 'dancing') {
        const base = profile.states[state].base
        applyBaseById(scene, base.animation, base.preset)
      }
      return
    }
    // Profile-only edit: occasionals reschedule below; don't replay sequences.
    if (handledStateRef.current === state) return
    const gen = ++genRef.current
    clearTimers()
    const prev = prevStateRef.current
    prevStateRef.current = state
    handledStateRef.current = state
    const scene = sceneRef.current()
    if (!scene) return
    const live = profile
    const runSequence = async (entries: BehaviorEntry[]) => {
      for (const entry of entries.slice(0, 5)) {
        if (gen !== genRef.current) return
        applyEmotion(scene, entry.emotion)
        playOnceById(scene, entry.animation, entry.preset)
        await waitForSettled(scene, SEQ_TIMEOUT_MS, SEQ_POLL_MS)
      }
    }
    void (async () => {
      if (prev && prev !== state) {
        scene.resetPose()
        await runSequence(live.states[prev].end)
        if (gen !== genRef.current) return
      }
      // A dance already owns the mixer when entering dancing: never reset it
      // away, just layer the (usually empty) start sequence on top.
      if (state !== 'dancing') {
        scene.resetPose()
        await runSequence(live.states[state].start)
        if (gen !== genRef.current) return
        const base = live.states[state].base
        applyBaseById(scene, base.animation, base.preset)
      } else {
        await runSequence(live.states[state].start)
      }
    })()
    return () => { genRef.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, paused, state, profile])

  // Occasional one-shots always follow the latest profile edit.
  useEffect(() => {
    if (!enabled || paused || handledStateRef.current !== state) return
    const gen = genRef.current
    clearTimers()
    const schedule = (entry: OccasionalEntry) => {
      const span = Math.max(0, entry.everyMax - entry.everyMin)
      later(() => {
        if (gen !== genRef.current) return
        const scene = sceneRef.current()
        if (!scene) return
        if (scene.isBusy()) { schedule(entry); return }
        if (Math.random() < entry.chance) {
          applyEmotion(scene, entry.emotion)
          playOnceById(scene, entry.animation, entry.preset)
        }
        schedule(entry)
      }, (entry.everyMin + Math.random() * span) * 1000)
    }
    for (const entry of profile.states[state].occasionals) schedule(entry)
    return () => { genRef.current++ }
  }, [enabled, paused, state, profile])
}
