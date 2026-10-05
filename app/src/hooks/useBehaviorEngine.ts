import { useEffect, useRef } from 'react'
import { BehaviorEngine, type BehaviorPlayback } from '../behavior-engine'
import type { BehaviorProfile, BehaviorScene, BehaviorStateId } from '../behavior'

interface EngineInput {
  enabled: boolean
  profile: BehaviorProfile
  state: BehaviorStateId
  paused?: boolean
  ready?: boolean
  getScene: () => BehaviorScene | null
  onPlayback: (playback: BehaviorPlayback) => void
}

export function useBehaviorEngine({ enabled, profile, state, paused = false, ready = true, getScene, onPlayback }: EngineInput) {
  const report = useRef(onPlayback)
  report.current = onPlayback
  const ref = useRef<BehaviorEngine | null>(null)
  if (!ref.current) ref.current = new BehaviorEngine(playback => report.current(playback))
  const engine = ref.current
  useEffect(() => {
    engine.update({ enabled, profile, state, paused, scene: ready ? getScene() : null })
  }, [engine, enabled, profile, state, paused, ready, getScene])
  useEffect(() => () => engine.dispose(), [engine])
  return engine
}
