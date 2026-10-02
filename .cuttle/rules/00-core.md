# Cuttle Pets — always-on project rules

These files under `.cuttle/rules/` are compiled into every harness agent turn by the
**Context Compiler** (Cuttle Brain). Keep them short and agent-agnostic.

## Project layout

| Path | Role |
|---|---|
| `app/` | Tauri + React + TypeScript + three.js desktop renderer; Rust host in `app/src-tauri/` |
| `server/server.py` | Flask pet control server (port 8790); publishes SSE events |
| `cli/cuttle_pet.py` | Pet control CLI |
| `bridge/bridge.py` | Polls Cuttle activity and drives pet reactions |
| `models/` | Local VRM models (gitignored) |
| `start_pet.sh` | Linux pet launcher |
| `README.md` | Setup, control API, and model guidance |
| `temp/` | Agent scratch / redirected stdout (gitignored; global rule 14) |
| `.cuttle/personal/` | Install-local overlay (gitignored; supplements tracked `.cuttle/`) |
| `.cuttle/commands/` | Cuttle slash commands (`/name`) |
| `.cuttle/actions/` | Allowlisted side effects (forms / confirms) |
| `.cuttle/docs/` | Runbooks and design notes |

## Hard rules

1. Prefer this project's `.cuttle/commands`, `.cuttle/actions`, and `.cuttle/docs` over inventing parallel conventions.
2. Long OS jobs should use project commands with `execute: shell` + `watch:` when available.
3. Scratch / `_tmp_*` dumps go in `temp/` (or `scripts/temp/` if this project keeps agent scripts under `scripts/`) — never next to kept helpers or at the repo root. See global `.cuttle_global/rules/00-core.md` rule 14.
4. Machine-specific paths / LAN notes → `.cuttle/personal/` (never commit).
