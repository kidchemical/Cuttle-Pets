import type { CSSProperties } from 'react'

/** Section primitives shared by the SettingsPanel tabs and the Pets page,
 * so the Pets model picker matches the Models page instead of drifting. */
export const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

export const labelStyle: CSSProperties = {
  fontSize: 13,
  color: '#aebbd0',
  marginBottom: 2,
}

export const selectStyle: CSSProperties = {
  width: '100%',
  height: 32,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.3)',
  color: '#fff',
  fontSize: 13,
  padding: '0 8px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}
