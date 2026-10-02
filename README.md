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
python3 server/server.py            # http://127.0.0.1:8790

# 2. the pet window
cd app && npm install && npm run tauri dev

# 3. drive it
python3 cli/cuttle_pet.py emote happy --intensity 0.8
python3 cli/cuttle_pet.py event thinking
python3 cli/cuttle_pet.py watch      # stream events
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
The laptop prop (`app/public/laptop.glb`) is Kenney's CC0 model via
[Poly Pizza](https://poly.pizza/m/GnbwSUiVty) — public domain, no attribution
required. It appears automatically while Cuttle is working, with a
procedural typing pose (see `app/src/typing-pose.ts`).

Bundled animation packs in `app/public/`:

- `mixamo_*.fbx` — 10 Mixamo clips (waving, cheering, clapping, victory,
  praying, defeated, joyful jump, looking, pointing, breakdance). Same bytes
  as a [mixamo.com](https://www.mixamo.com) download (free Adobe account),
  mirrored via GitHub. More Mixamo FBX work directly: download, drop the file
  in `app/public/`, add a preset in `motion-controller.ts`.
- `ual1.fbx` — [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html)
  (CC0, no attribution required). Multi-take pack; presets select takes by
  name (`take: 'Armature|Sitting_Idle_Loop'`): sitting idle / sitting talking
  / talking idle actions plus a `ualDance` dance. The loader
  (`app/src/mixamo-loader.ts`) detects the Quaternius rig and retargets it
  with the same math as Mixamo.
- `ual2.fbx` — [Universal Animation Library 2](https://quaternius.com/packs/universalanimationlibrary2.html)
  (CC0): provides the `phoneCall` action (`Armature|Idle_TalkingPhone_Loop`).
  The pet holds up a cellphone prop while it plays.

Try them: `cuttle-pet action waving`, `cuttle-pet action sittingIdle`,
`cuttle-pet action phoneCall`, or pick the `ualDance` dance from the pet menu.

Hand props (`app/public/phone.glb`, `app/public/cup.glb`) are CC0 via
[Poly Pizza](https://poly.pizza) (phone by Quaternius, cup by Kenney) —
public domain. The phone appears during the `phoneCall` action; the coffee
cup appears in the right hand every 40–90s of sustained working for a ~4s
sip (`applySipPose` in `app/src/typing-pose.ts`).

Extra character models (`models/model2.vrm` … `model5.vrm`) are the remaining
defaults from upstream [claw-sama](https://github.com/luckybugqqq/claw-sama)
(MIT) — pick them in Settings → Model. Note: simple models without VRM
expressions or detailed eyes degrade gracefully (unknown expression names
are silently ignored), so animations, props, and lip-sync keep working.

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

## Launch on Linux

Set up the pet's Python environment once:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
bash start_pet.sh
```

The launcher starts the control server, Cuttle bridge, and Tauri development
window. It reuses an existing control server and stops only the Python processes
it started when you exit. Server logs are in `temp/pet-server.log`.
`CUTTLE_PET_PYTHON` overrides the interpreter; otherwise it uses `.venv/bin/python`,
then `python3`. The fallback must have Flask installed.

## Window placement and desktop login

Window position and size are saved on normal exit and restored on the next
launch using Tauri's window-state plugin. Quit from the pet tray menu to save.
On Wayland desktops the launcher uses Xwayland when available, since native
Wayland restricts apps from restoring absolute window positions. Set
`CUTTLE_PET_BACKEND=wayland` to use native Wayland instead (position restoration
then depends on your compositor).

Enable or disable automatic launch at Linux desktop login:

```bash
.venv/bin/python scripts/autostart.py enable
.venv/bin/python scripts/autostart.py status
.venv/bin/python scripts/autostart.py disable
```

Login startup runs `start_pet.sh` without opening a terminal. Logs are in
`temp/autostart.log`. It uses the same development launch as your manual command;
Node, Rust, and the project directory must remain installed. A launcher lock
prevents duplicate launches. Your saved Cuttle connection is reused automatically
and retries if Cuttle starts later. Passwords are never stored.

## Cuttle bridge

The bridge watches **all chats belonging to your Cuttle account** by default,
including newly created chats. It queries them in batches of 12 every three
seconds. Busy chats take priority over idle or cancelled chats. When all observed
work finishes, the pet reacts with `done`, then returns to idle on the next poll.
Very short turns between polls may be missed. This is an activity indicator;
it does not read or speak full assistant replies or distinguish successful
completion from every error/cancellation outcome.

Launch normally:

```bash
bash start_pet.sh
```

Open the pet's **Settings → Cuttle** tab and select **Connect to Cuttle**.
Sign in with your normal Cuttle username and password once. The pet saves a
separate login session locally and automatically reconnects after launches,
Cuttle restarts, or machine reboots. No browser developer tools or pasted tokens
are needed. Your password is never saved, and the saved session never reaches
the renderer. **Disconnect** removes it and revokes that pet login in Cuttle
when Cuttle is reachable.

The equivalent terminal setup (also works before launching the pet):

```bash
.venv/bin/python cli/cuttle_pet.py connect
bash start_pet.sh
```

The CLI prompts for your username and password; password entry is hidden.
Check or remove the saved connection with:

```bash
.venv/bin/python cli/cuttle_pet.py connection
.venv/bin/python cli/cuttle_pet.py connection --disconnect
```

Cuttle must be running (default `https://127.0.0.1:8080`). The panel supports
other local HTTPS ports. Local Cuttle's self-signed certificate is accepted;
remote destinations and credential redirects are rejected. Saved credentials
live in `~/.cuttle-pet/cuttle-connection.json` (or `CUTTLE_PET_DATA`) with owner-only
file permissions (0600), and are stored as a login token, not encrypted. Do not
share that file. Cuttle currently expires login sessions after 30 days; the
panel shows **Sign-in expired** when you need to reconnect. When Cuttle is merely
offline, it preserves the connection and retries automatically.

Run the bridge separately, or restrict it to selected chats:

```bash
.venv/bin/python bridge/bridge.py --all-chats --verbose
.venv/bin/python bridge/bridge.py --session 868 --session 869 --verbose
.venv/bin/python bridge/bridge.py --all-chats --once --verbose
```

`CUTTLE_PET_SESSIONS=868,869` also restricts the launcher bridge. Set
`CUTTLE_PET_BRIDGE=0` to launch without the bridge, useful for direct CLI tests.

## Terminal tests

With the pet running, these commands drive it directly without Cuttle:

```bash
.venv/bin/python cli/cuttle_pet.py status
.venv/bin/python cli/cuttle_pet.py say "Hello from the terminal!" --emotion happy
.venv/bin/python cli/cuttle_pet.py emote surprised --intensity 0.8
.venv/bin/python cli/cuttle_pet.py action greeting
.venv/bin/python cli/cuttle_pet.py event thinking --detail "Testing the bridge reaction"
.venv/bin/python cli/cuttle_pet.py event done --detail "Test complete!"
.venv/bin/python cli/cuttle_pet.py clear
```

Use `.venv/bin/python cli/cuttle_pet.py watch` in another terminal to inspect the
SSE events sent to the renderer. A running bridge may replace a manual reaction
when chat activity changes; disable it for isolated tests.

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