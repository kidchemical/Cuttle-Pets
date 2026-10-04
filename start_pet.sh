#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
# Desktop login does not necessarily inherit the terminal's Node installation.
export PATH="$HOME/.local/opt/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
mkdir -p temp
if command -v flock >/dev/null; then
    exec 9>"$ROOT/temp/pet-launcher.lock"
    flock -n 9 || { echo 'Cuttle Pets is already running.'; exit 0; }
fi
# Wayland does not allow clients to restore absolute window coordinates.
# Use Xwayland when available so the saved placement can be restored.
if [[ "${XDG_SESSION_TYPE:-}" == wayland && -n "${DISPLAY:-}" ]]; then
    export GDK_BACKEND="${CUTTLE_PET_BACKEND:-x11}"
fi
PYTHON="${CUTTLE_PET_PYTHON:-$ROOT/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
    PYTHON="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON" ]] || ! "$PYTHON" -c 'import flask, numpy' 2>/dev/null; then
    echo "Python 3 with Flask and NumPy is required. Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo 'Rust/cargo is required for Tauri.' >&2; exit 1; }
mkdir -p temp
children=()
cleanup() {
    for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done
    for pid in "${children[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! "$PYTHON" cli/cuttle_pet.py status >/dev/null 2>&1; then
    "$PYTHON" server/server.py >temp/pet-server.log 2>&1 &
    server_pid=$!
    children+=("$server_pid")
    ready=false
    for _ in {1..50}; do
        if "$PYTHON" cli/cuttle_pet.py status >/dev/null 2>&1; then ready=true; break; fi
        kill -0 "$server_pid" 2>/dev/null || break
        sleep 0.1
    done
    if [[ "$ready" != true ]]; then
        cat temp/pet-server.log >&2
        exit 1
    fi
fi
if [[ "${CUTTLE_PET_BRIDGE:-1}" != 0 ]]; then
    "$PYTHON" bridge/bridge.py --verbose --parent-pid "$$" &
    children+=("$!")
fi
# Populate the accessibility bus address when available (Wayland/GTK).
if [[ -z "${AT_SPI_BUS_ADDRESS:-}" ]] && command -v gdbus >/dev/null; then
    bus_address="$(gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress 2>/dev/null || true)"
    if [[ "$bus_address" =~ \'([^\']+)\' ]]; then
        export AT_SPI_BUS_ADDRESS="${BASH_REMATCH[1]}"
    fi
fi
cd "$ROOT/app"
npm run tauri dev
