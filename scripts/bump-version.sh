#!/usr/bin/env bash
# Bump the project version everywhere it is recorded.
# Usage: scripts/bump-version.sh [patch|minor|major|x.y.z]
# The repo-root VERSION file is the source of truth; this script mirrors it into
# app/package.json, app/src-tauri/Cargo.toml, app/src-tauri/tauri.conf.json,
# and app/src/version.ts. Never hand-edit only one of those files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="$ROOT/VERSION"

current="$(tr -d '[:space:]' < "$VERSION_FILE")"
arg="${1:-patch}"

semver="$arg"
case "$arg" in
  patch|minor|major)
    IFS='.' read -r major minor patch <<< "$current"
    case "$arg" in
      patch) patch=$((patch + 1)) ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      major) major=$((major + 1)); minor=0; patch=0 ;;
    esac
    semver="$major.$minor.$patch"
    ;;
  [0-9]*.[0-9]*.[0-9]*)
    ;;
  *)
    echo "usage: $0 [patch|minor|major|x.y.z]" >&2
    exit 1
    ;;
esac

printf '%s\n' "$semver" > "$VERSION_FILE"

ROOT_PY="$ROOT" python3 - "$semver" <<'EOF'
import json, os, re, sys
semver = sys.argv[1]
root = __import__('pathlib').Path(os.environ['ROOT_PY'])

def patch(path, pattern, repl):
    p = root / path
    text = p.read_text()
    updated, n = re.subn(pattern, repl.format(v=semver), text, count=1)
    assert n == 1, f'pattern not found once in {path}'
    p.write_text(updated)

# npm / tauri configs (JSON: first top-level "version" key)
for path in ('app/package.json', 'app/src-tauri/tauri.conf.json'):
    p = root / path
    data = json.loads(p.read_text())
    data['version'] = semver
    p.write_text(json.dumps(data, indent=2) + '\n')

patch('app/src-tauri/Cargo.toml', r'(?m)^version = "[^"]+"', 'version = "{v}"')
patch('app/src/version.ts', r"(?m)^export const APP_VERSION = '[^']+'", "export const APP_VERSION = '{v}'")
print(f'version -> {semver}')
EOF
