import { useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'

/** Native drops carry absolute paths; HTML File objects do not. */
export function useFileDrop(active: boolean, onDrop: (paths: string[]) => Promise<void>, onError: (message: string) => void) {
  const [dragging, setDragging] = useState(false)
  const current = useRef({ onDrop, onError })
  current.current = { onDrop, onError }
  useEffect(() => {
    setDragging(false)
    if (!active || !isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview().onDragDropEvent(event => {
      if (disposed) return
      const payload = event.payload
      setDragging(payload.type === 'enter' || payload.type === 'over')
      if (payload.type === 'drop') {
        void current.current.onDrop(payload.paths).catch(error => {
          if (!disposed) current.current.onError(error instanceof Error ? error.message : String(error))
        })
      }
    }).then(stop => {
      if (disposed) stop()
      else unlisten = stop
    }).catch(error => { if (!disposed) current.current.onError(String(error)) })
    return () => { disposed = true; unlisten?.() }
  }, [active])
  return dragging
}

export function singleModelPath(paths: string[], extensions: string[]): string {
  if (paths.length !== 1) throw new Error('Drop one model at a time.')
  if (!extensions.some(ext => paths[0].toLowerCase().endsWith(`.${ext}`))) {
    throw new Error(`Supported files: ${extensions.map(ext => `.${ext}`).join(', ')}`)
  }
  return paths[0]
}
