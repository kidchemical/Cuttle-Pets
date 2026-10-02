/**
 * Cuttle Pet — server configuration.
 *
 * Vendored from claw-sama (MIT), which hardcoded the OpenClaw gateway
 * (http://127.0.0.1:18789) in five components. We replace it with our own
 * control server. Nothing else in the renderer knew about OpenClaw.
 *
 * Override at build time with VITE_PET_SERVER.
 */

const DEFAULT_SERVER = 'http://127.0.0.1:8790'

// Read defensively: this is the only `import.meta.env` use in the app, so the
// vendored tsconfig has no `vite/client` types. Don't add them just for this.
const ENV: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

export const PET_SERVER: string = (ENV.VITE_PET_SERVER ?? DEFAULT_SERVER).replace(/\/$/, '')

/** Build a URL for a control-server endpoint. */
export function petUrl(path: string): string {
  return `${PET_SERVER}${path.startsWith('/') ? path : `/${path}`}`
}