#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/temp"
exec bash "$ROOT/start_pet.sh" >>"$ROOT/temp/autostart.log" 2>&1
