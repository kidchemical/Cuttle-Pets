import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { InputRegion } from '../input-regions'
import { hitTestWithTimeout } from '../hit-test'

interface CursorPosition {
  x: number
  y: number
  window_x: number
  window_y: number
  window_w: number
  window_h: number
}

/**
 * Enables window click-through when cursor is NOT over the rendered 3D model.
 * Uses Rust-side global cursor monitoring + render-target alpha hit-test.
 */
export function usePassThrough(enabled: boolean, onHover?: (inside: boolean) => void) {
  const hoverCallback = useRef(onHover)
  hoverCallback.current = onHover
  const passingThrough = useRef(false)
  const pending = useRef(false)
  const active = useRef(false)

  useEffect(() => {
    const win = getCurrentWindow()

    if (!enabled) {
      active.current = false
      // Force disable pass-through immediately
      if (passingThrough.current) {
        passingThrough.current = false
        win.setIgnoreCursorEvents(false).catch(() => {})
      }
      return
    }

    let disposed = false
    let regionTimer: ReturnType<typeof setInterval> | undefined
    void invoke<boolean>('supports_input_regions').then((supported) => {
      if (!supported || disposed) return
      active.current = false
      clearTimeout(startDelay)
      void invoke('stop_cursor_monitor')
      void win.setIgnoreCursorEvents(false)
      ;(window as any).__clawInputRegionsEnabled = true
      const publish = () => {
        if (disposed) return
        const regions = (window as any).__clawInputRegions as InputRegion[] | undefined
        if ((window as any).__clawDragging || !regions) {
          void invoke('set_input_regions', { regions: null }).catch(console.error)
          return
        }
        const ui = [...document.querySelectorAll('button, input, textarea, [data-no-passthrough]')]
          .filter(el => getComputedStyle(el).visibility !== 'hidden')
          .map(el => el.getBoundingClientRect())
          .filter(r => r.width > 0 && r.height > 0)
          .map(r => ({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }))
        void invoke('set_input_regions', { regions: [...regions, ...ui] }).catch(console.error)
      }
      publish()
      regionTimer = setInterval(publish, 100)
    }).catch(console.error)
    const onRegionMove = () => {
      if ((window as any).__clawInputRegionsEnabled) hoverCallback.current?.(true)
    }
    const onRegionLeave = () => {
      if ((window as any).__clawInputRegionsEnabled) hoverCallback.current?.(false)
    }
    window.addEventListener('pointermove', onRegionMove)
    document.documentElement.addEventListener('pointerleave', onRegionLeave)

    // Delay enabling pass-through so the window is selectable on startup
    const startDelay = setTimeout(() => {
      active.current = true
      invoke('start_cursor_monitor').catch(console.error)
    }, 1000)

    const unlisten = listen<CursorPosition>('cursor-position', async (event) => {
      if (!active.current) return
      const { x, y, window_x, window_y, window_w, window_h } = event.payload

      const inside =
        x >= window_x &&
        x < window_x + window_w &&
        y >= window_y &&
        y < window_y + window_h

      // NOTE: hover state uses model/UI hit below, not this window-rect flag —
      // the window is fullscreen, so `inside` is nearly always true.
      if (!inside) hoverCallback.current?.(false)
      if (pending.current) return
      if (!inside) {
        if (!passingThrough.current) {
          passingThrough.current = true
          win.setIgnoreCursorEvents(true).catch(() => {})
        }
        return
      }

      // Normalize to 0..1 using same-unit values from Rust (works whether
      // coords are physical or CSS pixels), then convert to CSS pixels.
      const relX = (x - window_x) / window_w
      const relY = (y - window_y) / window_h
      const clientX = relX * window.innerWidth
      const clientY = relY * window.innerHeight

      // While a drag operation is in progress, keep pass-through disabled
      if ((window as any).__clawDragging) {
        if (passingThrough.current) {
          passingThrough.current = false
          win.setIgnoreCursorEvents(false).catch(() => {})
        }
        return
      }

      // Check if cursor is over an interactive HTML element (buttons, inputs, etc.)
      const el = document.elementFromPoint(clientX, clientY)
      const overUI = el instanceof HTMLButtonElement
        || el instanceof HTMLInputElement
        || el instanceof HTMLTextAreaElement
        || !!el?.closest('button, input, textarea, [data-no-passthrough]')

      if (overUI) {
        if (passingThrough.current) {
          passingThrough.current = false
          win.setIgnoreCursorEvents(false).catch(() => {})
        }
        hoverCallback.current?.(true)
        return
      }

      // Use render-loop hit-test for the 3D model
      const hitTest = (window as any).__clawHitTest as
        | ((x: number, y: number) => Promise<boolean>)
        | undefined
      if (!hitTest) return

      pending.current = true
      try {
        if (!active.current) return
        // Bounded wait: a hit-test that never resolves (paused render loop,
        // scene remount) must not freeze click-through state forever.
        const overModel = await hitTestWithTimeout(hitTest, clientX, clientY)
        if (!active.current || (window as any).__clawDragging) return
        if (overModel && passingThrough.current) {
          passingThrough.current = false
          win.setIgnoreCursorEvents(false).catch(() => {})
        } else if (!overModel && !passingThrough.current) {
          passingThrough.current = true
          win.setIgnoreCursorEvents(true).catch(() => {})
        }
        hoverCallback.current?.(overModel)
      } finally {
        pending.current = false
      }
    })

    return () => {
      disposed = true
      clearInterval(regionTimer)
      window.removeEventListener('pointermove', onRegionMove)
      document.documentElement.removeEventListener('pointerleave', onRegionLeave)
      ;(window as any).__clawInputRegionsEnabled = false
      void invoke('set_input_regions', { regions: null }).catch(() => {})
      clearTimeout(startDelay)
      active.current = false
      unlisten.then((fn) => fn())
      invoke('stop_cursor_monitor').catch(() => {})
      win.setIgnoreCursorEvents(false).catch(() => {})
      passingThrough.current = false
    }
  }, [enabled])
}
