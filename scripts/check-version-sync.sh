#!/usr/bin/env bash
# Fail when the recorded versions disagree. Intended for CI and as a pre-push
# hook (see scripts/install-hooks.sh). This script never mutates anything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

want="$(tr -d '[:space:]' < "$ROOT/VERSION")"
check() {
  local label="$1" got="$2"
  if [ "$got" != "$want" ]; then
    echo "version mismatch: $label is $got, VERSION file is $want" >&2
    fail=1
  fi
}

check "app/package.json" "$(python3 -c "import json; print(json.load(open('$ROOT/app/package.json'))['version'])")"
check "app/src-tauri/tauri.conf.json" "$(python3 -c "import json; print(json.load(open('$ROOT/app/src-tauri/tauri.conf.json'))['version'])")"
check "app/src-tauri/Cargo.toml" "$(grep -m1 '^version = ' "$ROOT/app/src-tauri/Cargo.toml" | cut -d'"' -f2)"
check "app/src/version.ts" "$(grep -m1 "APP_VERSION = " "$ROOT/app/src/version.ts" | cut -d"'" -f2)"

if [ "$fail" -ne 0 ]; then
  echo "run scripts/bump-version.sh to sync versions" >&2
  exit 1
fi
echo "versions in sync ($want)"
