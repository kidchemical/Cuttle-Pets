# Versioning (Cuttle Pets)

Single source of truth: the repo-root `VERSION` file. It is mirrored into
`app/package.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`,
and `app/src/version.ts`.

- Bump only via `scripts/bump-version.sh [patch|minor|major|x.y.z]`. Never
  hand-edit just one of the mirrored files.
- Bump as part of finishing work, not per edit: when a task changes
  user-facing behavior, run `scripts/bump-version.sh` once at completion —
  patch for fixes and tweaks, minor for new features and behavior changes.
  No bump for internal refactors, tests-only, docs-only, or tooling changes.
  Never bump mid-task. Verify with `scripts/check-version-sync.sh` and leave
  the result uncommitted for UI review like any other change.
- Major (breaking) bumps always ask first. Note a bumped Cargo.toml forces a
  full native recompile on next build — expected, not a reason to skip the bump.
- `scripts/check-version-sync.sh` verifies they agree (CI + pre-push hook via
  `scripts/install-hooks.sh`). The hook is check-only: it never mutates the
  tree, and no flow auto-increments the version on push or commit.
- Tag releases as `vX.Y.Z`. The in-app update check reads GitHub releases for
  this repo and compares against the running build; without a published
  release it stays quiet.
- User data is sacred: everything under `DATA_DIR` (`~/.cuttle-pet` —
  `settings.json`, models, dances, audio) is user-owned. Updates replace the
  app bundle only. Never delete, overwrite, or migrate user data on update
  except through an explicit, documented migration for a named setting key
  (see `tests/test_version.py`). Settings saves are merge-patches, never
  full replacements.
