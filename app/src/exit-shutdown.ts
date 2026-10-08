// Page-exit shutdown for the WebGL renderer.
//
// Quitting with a live WebGL context presenting frames makes
// WebKitWebProcess crash on Linux ("stopped unexpectedly" dialog).
// beforeunload/pagehide handlers run before WebKit tears down the page, so
// exit cleanup must be fully synchronous: no awaits, no promise callbacks.
// This helper builds such a shutdown: it stops frame production, releases
// GPU resources, and drops the GL context, exactly once.

export interface ExitShutdownResources {
  /** Stop producing frames (e.g. cancelAnimationFrame, resolve pendings). */
  stopFrames: () => void
  /** Release GPU resources (render targets, geometries, renderer). */
  dispose: () => void
  /** Drop the underlying GL context so nothing is in flight on teardown. */
  loseContext: () => void
}

/** Idempotent synchronous shutdown: later calls are no-ops. Best-effort:
 * a throwing phase still lets the later phases run (the first error
 * propagates), so a half-released resource can't skip GL context loss. */
export function createExitShutdown(resources: ExitShutdownResources): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      resources.stopFrames()
    } finally {
      try {
        resources.dispose()
      } finally {
        resources.loseContext()
      }
    }
  }
}
