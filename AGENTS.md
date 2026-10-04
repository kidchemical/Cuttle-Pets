# Agent guide

This guide applies to the whole repository. Read [README.md](README.md) for setup,
control API usage, and platform requirements. Cuttle-specific commands and runbooks
live under [.cuttle/](.cuttle/README.md); when working through Cuttle, follow its
loaded project and global instructions too.

## Where to make changes

- `app/src/App.tsx`: main pet UI, server events, and settings-window entry point.
- `app/src/components/VRMScene.tsx`: three.js renderer, VRM animation, camera,
  model interactions, and screensaver suspension.
- `app/src/hooks/usePassThrough.ts`: mouse pass-through coordination.
- `app/src/input-regions.ts`: rendered alpha mask to native input rectangles.
- `app/src/mesh-hit-test.ts`: raycasting animated meshes with current pose bounds.
- `app/src-tauri/src/lib.rs`: native window operations, Linux input regions,
  cursor monitoring, tray, and settings-window creation.
- `app/src/settings.ts` and `app/src/window-sync.ts`: settings persistence and
  synchronization between the pet and separate settings window.
- `server/server.py`: Flask control API and SSE stream on port 8790.
- `cli/cuttle_pet.py`: Python CLI for the control API.
- `bridge/bridge.py`: Cuttle activity polling and pet reactions.
- `tests/`: Python and TypeScript regression tests; `tests/browser/` holds
  optional Playwright smoke tests.

The pet also works standalone. Keep Cuttle integration optional. Preserve the
upstream notices listed in `app/VENDORED.md` and asset provenance in
`docs/ASSET_LICENSES.md` when changing bundled code or assets.

## Development and checks

Run commands from the repository root unless a command changes directory.

```bash
# Linux: server, optional bridge, and Tauri development window
bash start_pet.sh

# Frontend typecheck and production build
(cd app && npm run build)

# Native Rust check
cargo check --manifest-path app/src-tauri/Cargo.toml

# Python tests (use the project's virtual environment if available)
python3 -m pytest tests/

# Input regression tests, after installing app dependencies
app/node_modules/.bin/tsx tests/hit_test.test.ts
app/node_modules/.bin/tsx tests/mesh_hit_test.test.ts
app/node_modules/.bin/tsx tests/input_regions.test.ts
```

Choose tests relevant to the changed behavior. Other TypeScript tests use the same
`tsx` invocation. Browser smoke-test setup is documented in the README. Browser
mocks verify UI behavior; they cannot establish that the native desktop window
receives mouse events correctly. Report native interaction checks separately.

Keep scratch files, logs, and screenshots in gitignored `temp/`. Put
machine-specific Cuttle notes in gitignored `.cuttle/personal/`. Avoid adding
absolute installation paths to tracked documentation.

## Mouse input: regression traps

Linux uses a persistent native input region derived from the rendered silhouette,
plus visible HTML controls. Other platforms use cursor monitoring and bounded
render-loop hit tests to toggle whole-window click-through.

On a Wayland desktop, the launcher uses Xwayland to support window positioning.
X11 cursor coordinates can stop updating when the cursor leaves Xwayland surfaces.
If the whole pet window ignores input, it may never learn that the cursor returned
over the mesh. A window behind the pet can make the problem appear to disappear.
Keep Linux silhouette input regions independent of global cursor polling.

Three.js caches skinned-mesh bounding spheres. Animation can move visible triangles
outside those bounds, causing ordinary raycasts to miss. Use
`intersectAnimatedModel` for interaction raycasts; it refreshes the current pose's
sphere and any existing bounding box. Disabling frustum culling alone does not
fix raycasting.

Native window dragging can consume `pointerup`. Release gesture holds when native
dragging completes or fails, and on cancellation and scene cleanup. An async
hit-test result must not enable click-through during an active gesture. Pending
render-loop hit tests must resolve on scene teardown or time out if rendering
pauses.

When changing input behavior, verify these cases in the actual Tauri window:

- Left-drag on the mesh moves the pet repeatedly, including after setting it down.
- Repeat over bare desktop, an Xwayland window, and a native Wayland window on Linux.
- Right-drag rotates; middle-drag zooms; wheel over the model zooms.
- Transparent space passes input through and visible controls remain clickable.
- Model animation/reload, settings open/close, and screen-lock resume preserve input.

## Window lifecycle

Settings opens in a separate ordinary window and is raised when explicitly opened.
Do not leave automatic settings-opening timers or other temporary verification
hooks in startup code. The pet is pinned by default; show/resume paths preserve
that preference. Screensaver/lock handling pauses rendering and hides the window;
resume respects a manual tray hide performed during suspension.
