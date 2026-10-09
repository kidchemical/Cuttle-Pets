import { useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

/** Help stays out of the layout; shown only on hover, keyboard focus or tap. */
export function SettingsHelp({ children, label = 'More information' }: { children: ReactNode; label?: string }) {
  const id = useId()
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const show = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), top: rect.bottom + 8, above: rect.bottom > window.innerHeight / 2 })
  }
  return <>
    <button type="button" className="settings-info" aria-label={label} aria-describedby={position ? id : undefined}
      onMouseEnter={e => show(e.currentTarget)} onMouseLeave={() => setPosition(null)}
      onFocus={e => show(e.currentTarget)} onBlur={() => setPosition(null)}
      onClick={e => { e.preventDefault(); e.stopPropagation(); show(e.currentTarget) }}
      onKeyDown={e => { if (e.key === 'Escape') setPosition(null) }}><Info size={14} aria-hidden="true" /></button>
    {position && createPortal(<div id={id} role="tooltip" className="settings-tooltip" style={{ left: position.left, ...(position.above ? { bottom: window.innerHeight - position.top + 30 } : { top: position.top }) }}>{children}</div>, document.body)}
  </>
}
