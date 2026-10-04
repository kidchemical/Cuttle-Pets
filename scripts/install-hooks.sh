#!/usr/bin/env bash
# Install local git hooks (gitignored .git/hooks is not versioned).
# Currently: pre-push runs scripts/check-version-sync.sh (check only, never mutates).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-push"
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
ROOT="$(git rev-parse --show-toplevel)"
bash "$ROOT/scripts/check-version-sync.sh"
EOF
chmod +x "$HOOK"
echo "installed .git/hooks/pre-push"
