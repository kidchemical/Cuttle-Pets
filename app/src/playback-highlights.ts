import type { PetStatusPayload } from './window-sync'

/** Primary rendered motions; ambient eyes/blinks are deliberately excluded. */
export function activeAnimationIds(status?: PetStatusPayload | null): Set<string> {
  const active = new Set<string>()
  if (!status) return active
  const clip = status.danceId || (status.actionId !== 'idle' ? status.actionId : null)
  if (clip) active.add(clip)
  else {
    if (status.working) active.add('typing')
    if (status.sipping) active.add('sip')
    if (status.musicMotion) active.add('music')
    if (!active.size && status.actionId === 'idle') active.add('idle')
  }
  return active
}
