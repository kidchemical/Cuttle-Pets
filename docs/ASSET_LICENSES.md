# Asset licenses

Code in this repo is MIT (see [`LICENSE.txt`](../LICENSE.txt)). The binary
assets below are **not all MIT** — each keeps its own terms. This file is the
complete provenance record; keep it accurate when adding assets.

## Renderer

`app/` source is vendored from [claw-sama](https://github.com/luckybugqqq/claw-sama)
(MIT, (c) claw-sama contributors). Keep `app/UPSTREAM-LICENSE.txt` intact.

## Default character

| File | Source | Terms |
| --- | --- | --- |
| `app/public/model1.vrm` | Upstream claw-sama sample character | Upstream asset terms (not MIT). Replace with your own `.vrm` (e.g. via [VRoid Studio](https://vroid.studio)) before redistributing screenshots, videos, or builds that feature it. |

Import your own models with `python3 cli/cuttle_pet.py models --import file.vrm`
— imported files live in `models/` (gitignored) and never ship with the repo.

## Motion clips

| Files | Source | Terms |
| --- | --- | --- |
| `mixamo_*.fbx` (10 clips) | [mixamo.com](https://www.mixamo.com) (free Adobe account), same bytes as a direct download | Free, royalty-free for use in projects per Adobe's Mixamo terms. Do not redistribute the raw files as standalone stock. |
| `ual1.fbx`, `ual2.fbx` | [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) | CC0 — public domain, no attribution required. |
| `angry.fbx`, `angryPump.fbx`, `excited.fbx`, `greeting.fbx`, `happy.fbx`, `point.fbx`, `salute.fbx`, `shy.fbx` | Upstream claw-sama bundle | Upstream asset terms. |
| `*.vrma`, `jile.vmd`, `love.vmd` | Upstream claw-sama bundle (VMD: MMD-format motion data) | Upstream asset terms. Check the original motion author's terms before reusing the `.vmd` files outside this project. |

## Props

| File | Source | Terms |
| --- | --- | --- |
| `app/public/laptop.glb` | Kenney via [Poly Pizza](https://poly.pizza/m/GnbwSUiVty) | CC0 — public domain. |
| `app/public/phone.glb` | Quaternius via Poly Pizza | CC0 — public domain. |
| `app/public/cup.glb` | Kenney via Poly Pizza | CC0 — public domain. |

## Libraries (code dependencies)

All MIT-compatible with an MIT release — no attribution UI required:

- MIT: `three`, `react`, `react-dom`, `express`, `cors`, `@pixiv/three-vrm*`, `mmd-parser`, `wlipsync`, `vite`, `typescript`, Tauri JS API, Flask (BSD-3-Clause)
- ISC: `lucide-react`
- MIT/Apache-2.0 dual: Tauri Rust crates, `serde`, `tokio`, `rfd`
