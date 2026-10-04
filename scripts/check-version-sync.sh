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

# Tauri JS/Rust halves must share major.minor, or `tauri dev` errors out
# ("Found version mismatched Tauri packages"). Compare the npm ranges in
# package.json against the pinned crates in Cargo.lock.
mismatched="$(ROOT="$ROOT" python3 - <<'EOF'
import json, os, re
root = os.environ['ROOT']
pkg = json.load(open(f'{root}/app/package.json'))
deps = {**pkg.get('dependencies', {}), **pkg.get('devDependencies', {})}
lock = open(f'{root}/app/src-tauri/Cargo.lock').read()
bad = []
for name, npm_range in deps.items():
    if name == '@tauri-apps/api':
        crate = 'tauri'
    elif name.startswith('@tauri-apps/plugin-'):
        crate = 'tauri-' + name.split('@tauri-apps/')[1]
    else:
        continue
    m = re.search(r'name = "' + re.escape(crate) + r'"\nversion = "([^"]+)"', lock)
    if not m:
        continue
    npm_minor = '.'.join(re.search(r'(\d+)\.(\d+)', npm_range).groups())
    rust_minor = '.'.join(m.group(1).split('.')[:2])
    if npm_minor != rust_minor:
        bad.append(f'{name} (npm {npm_range} vs {crate} {m.group(1)})')
print(' '.join(bad))
EOF
)"
if [ -n "$mismatched" ]; then
  echo "tauri minor mismatch: $mismatched" >&2
  echo "align the npm range with the Cargo.lock minor (e.g. npm i <pkg>@<major>.<minor>)" >&2
  exit 1
fi
echo "tauri js/rust minors match"
