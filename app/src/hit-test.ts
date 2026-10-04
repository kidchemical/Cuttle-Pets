/**
 * Hit-test with a fail-open timeout for window click-through.
 *
 * The 3D hit-test promise resolves after the next rendered frame. If the
 * render loop is paused (hidden page, screensaver suspend, low fps cap) or
 * the scene remounts mid-flight, the promise may never resolve — and the
 * caller (usePassThrough) drops every later cursor event while waiting,
 * freezing click-through in whatever state it was in. A window frozen with
 * cursor events ignored is completely dead: no drag, no zoom, no clicks.
 *
 * Failing OPEN (over-model) is the safe direction: the window stays
 * interactive instead of permanently deaf. Mirrors the existing
 * "model not loaded → don't pass through" precedent in VRMScene.
 */
export const HIT_TEST_TIMEOUT_MS = 500

export function hitTestWithTimeout(
  hitTest: (x: number, y: number) => Promise<boolean>,
  x: number,
  y: number,
  timeoutMs: number = HIT_TEST_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(true)
      }
    }, timeoutMs)
    hitTest(x, y).then(
      (hit) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(hit)
        }
      },
      () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(true)
        }
      },
    )
  })
}
