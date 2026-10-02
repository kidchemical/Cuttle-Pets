# cuttle-pet

A transparent, always-on-top 3D desktop pet driven by Cuttle — CLI, chat
activity, or direct HTTP.

Vendored from [claw-sama](https://github.com/luckybugqqq/claw-sama) (MIT). The
Tauri + three.js + `@pixiv/three-vrm` renderer is upstream's, unmodified in its
rendering path; the OpenClaw gateway it used to talk to has been replaced by a
local control server.

```
cuttle-pet/
  app/       Tauri + React + three.js renderer (vendored, MIT)
  server/    Flask control server — the only thing the app talks to
  cli/       cuttle-pet — emote / action / say / event / click-through
  bridge/    polls Cuttle live-status and drives the pet
  models/    your .vrm files (gitignored)
```

## Quick start

```bash
# 1. control server
python server/server.py            # http://127.0.0.1:8790

# 2. the pet window
cd app && npm install && npm run tauri dev

# 3. drive it
python cli/cuttle_pet.py emote happy --intensity 0.8
python cli/cuttle_pet.py event thinking
python cli/cuttle_pet.py watch      # stream events
```

## Model format

Use **VRM** (`.vrm`), not VRChat's `.unity3d` — a Unity bundle cannot be read by
any browser or Tauri runtime.

- Free authoring: [VRoid Studio](https://vroid.studio) → export `.vrm`, no Unity needed.
- From Unity: [UniVRM](https://github.com/vrm-c/UniVRM) (MIT) exports VRM 1.0 / 0.x.
- Import: `cuttle-pet models --import ~/pets/reef.vrm`

VRChat avatar *redistribution* is off-limits under VRChat's terms; author your
own character. The bundled `app/public/model1.vrm` is upstream's sample and is
covered by their asset terms, not the MIT code license — swap it before sharing.

## Control API

| Verb | Body | Effect |
|---|---|---|
| `GET /events` | — | **SSE**. The only inbound channel to the pet. |
| `POST /emote` | `emotion`, `emotionIntensity`, `emotionDuration`, `vrchat`, `value` | set expression |
| `POST /action` | `action`, `hold` | play a named animation |
| `POST /say` | `text`, `emotion`, `audioUrl`, `appendText`, `clearText` | text bubble + lip-sync |
| `POST /pet/event` | `state`, `detail`, `emotion`, `action` | chat-activity → reaction |
| `POST /clear` | — | clear the bubble |
| `POST /click-through` | `enabled` | toggle mouse pass-through |
| `GET/POST /settings` | — | renderer settings store |
| `GET /model/list`, `POST /model/import`, `GET /model/serve/<name>` | | models |

`state` is one of `thinking`, `streaming`, `done`, `error`, `idle`.

Presets — emotions: `happy sad angry surprised think awkward question curious
neutral love flirty greeting relaxed`. Actions: `akimbo playFingers
scratchHead stretch happy angry greeting excited shy point salute angryPump`.

`vrchat` passes a raw VRChat expression name + value for models outside the
preset vocabulary (upstream's presets are a hardcoded blend of `aa`/`ee`/`happy`
etc., so an unusual rig may need this).

## Cuttle bridge

```bash
export CUTTLE_SESSION_TOKEN=<your session token>
python bridge/bridge.py --session 868 --verbose
```

`/api/chat-live-status-batch` needs explicit session ids and an authenticated
session (cookie, `Authorization: Bearer …`, or `X-Cuttle-Session-Token`). Without
a token the bridge logs the 401 and treats the pet as idle rather than failing.

Reactions: `thinking` → think + scratchHead · `streaming` → curious ·
`done` → happy + happy (with the agent's status text as speech) · `error` →
surprised + point.

## Notes and gaps

- **Window**: `transparent`, `alwaysOnTop`, `decorations: false`,
  `skipTaskbar`. Drag inside the window, resize handles, pin toggle (Tab folds
  the menu, F4 settings, F5 reload). **Click-through** and **clickable** are the
  same toggle — clickable captures input on the pet so you can drag and poke it;
  click-through lets clicks reach the desktop behind.
- **Gaze tracking** works (mouse and camera modes); it queries native window
  bounds, which on Windows may jitter.
- **Not wired**: TTS/`audioUrl` (plumbing exists, no engine — plug one in at
  `/preview`), persona generation, screen observation, Cuttle chat input
  (upstream's `ChatInput` posts to `/chat`, which only displays text; Cuttle owns
  the conversation). Those are deliberately Cuttle's job.
- Upstream `mixamo-loader.ts` is a port of lobe-vidol's `loadMixamoAnimation` —
  check provenance if that matters to you.
- The pet is a **separate app**, not a Cuttle Electron window. It has no
  dependency on the Cuttle daemon and keeps running if Cuttle restarts.

## Building

Needs Rust + Node 20+, plus Tauri system deps:

```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
                 librsvg2-dev patchelf build-essential curl wget file libssl-dev
```

`npm run tauri build` in `app/`. Upstream CI targets win32-x64 and darwin;
add a linux target via `[build] target` in `src-tauri/tauri.conf.json`.

## License

Renderer and assets are upstream claw-sama's work under MIT — keep
`app/`'s notices intact when redistributing. Your own models and animations are
yours. Check each model's own terms before shipping it.