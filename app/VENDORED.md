# Vendored from claw-sama

`app/` is a copy of https://github.com/luckybugqqq/claw-sama `app/` directory
(MIT, (c) claw-sama contributors). See UPSTREAM-LICENSE.txt.

## What we changed

1. **Added `src/config.ts`** — `petUrl()` + `PET_SERVER` (default
   `http://127.0.0.1:8790`, override with `VITE_PET_SERVER`). Upstream hardcoded
   `OPENCLAW_URL = 'http://127.0.0.1:18789'` in five components.
2. **Repointed every call site** from `${OPENCLAW_URL}/plugins/claw-sama/*` to
   `petUrl('/*')`. No other OpenClaw references remain — the renderer never
   imported OpenClaw, it only spoke to that gateway's URL + route shapes.
3. **Nothing else.** Rendering, VRM loading, lip-sync, expressions, motion
   loading, gaze tracking, and the transparent/always-on-top window are all
   upstream.

## Route renames

`/plugins/claw-sama/<x>` -> `/<x>`, e.g. `events`, `settings`, `model/list`,
`model/import`, `model/serve/<name>`, `dance/*`, `history`, `persona`,
`voice`, `preview`. Implemented by `server/server.py`.

## Upstream test

`npx tsc --noEmit` and `npx vite build` both pass clean against these changes.
