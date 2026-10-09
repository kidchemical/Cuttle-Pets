# Portable Settings Profiles — implementation plan

## Goal

Let someone save a named Cuttle Pets setup locally, load it later, and share it
as one portable bundle that another installation can import and use. A shared
profile must include the custom assets its settings depend on and must not rely
on paths, URLs, or IDs from the sender's computer. The user should not need to
assemble or compress the bundle manually.

This replaces the separate Behavior-only Save / Export / Import controls with
one profile model for the whole Settings window. Ordinary setting edits still
apply live and save automatically; profile Save is an intentional snapshot.

## Product decisions

- Put a compact **Profiles** control in the Settings window header, visible on
  every tab. Profiles affect the whole app, so their controls should not look
  like a feature owned by General or Behavior.
- Use one vocabulary everywhere: **Save** creates or updates a named local
  snapshot; **Load** applies a selected local snapshot; **Export** creates a
  portable bundle; **Import** adds a bundle to the local profile list.
- Import installs and validates assets, then adds the profile to the list. It
  does not silently replace the current setup. The user selects it and presses
  **Load**. Show the installed profile and a clear next Load action when import
  finishes.
- Local Save stores settings plus stable references to the existing local
  assets. Export packages those referenced assets. Do not duplicate binary
  assets for every local Save.
- Export only assets needed by the selected profile; do not bundle unrelated
  content from the sender's entire asset library.
- Loading a profile replaces the profile-managed settings as one operation.
  Fields intentionally excluded from profiles remain as they were.

Suggested header layout:

```text
Profiles  [Current setup                     ▾]  [Load] [Save]  [⋯]
                                                               Import bundle
                                                               Export bundle
```

The profile menu also provides Rename and Delete. Save prompts for a profile
name, prefilled from the active profile when updating one. Saving under an
existing name asks whether to replace it. Load is disabled until a profile is
selected. Delete only removes the local snapshot; it never deletes assets.

## Profile contents

Capture the settings that define the pet's visible setup across General,
Music, Voice preferences, Model, Animations, Behavior, Pets, Props, Quality,
Display, and Lighting. The implementation should use an explicit allowlist and
the existing normalizers/defaults rather than serializing arbitrary app state.

Include the selected custom model, presentation and bubble settings, music and
headphone fitting, animation preferences, the complete current Behavior
configuration (including engine enabled state and custom reactions), pet and
prop configurations, rendering quality, display preferences, stage lighting,
and cursor lighting. Include custom dance definitions and all other asset
references needed by those settings.

Exclude Cuttle login/session data, API keys and voice-provider credentials,
workspace persona files, screen-observation/capture preferences, operating
system window geometry, and the saved profile library itself. Do not package
built-in application assets; the receiving app supplies those. Respect native
permissions on the receiving device even if a profile enables a feature that
needs them.

Pets and props are both configuration and content: include each configured
entry's settings and its GLB. Include a custom VRM when selected. Include custom
motion files and associated music when referenced by the selected dance,
Behavior entries, or custom reactions. Include referenced custom assets from
the Behavior profiles retained in the snapshot if those profiles remain
available after migration. Avoid copying unreferenced models, dances, or audio.

## Portable bundle format

Recommended first container: a standard ZIP with a small manifest, a settings
snapshot, and an assets directory. Export builds it and Import reads it; the
user only handles one file. ZIP preserves directory structure, is supported by
standard libraries, and can be inspected or recovered with common archive
tools. The container is an implementation choice, not a product requirement.
Keep the manifest and settings schema independent of ZIP so another container
could be adopted later without changing profile semantics.

Give the bundle an app-specific `.cuttleprofile` suffix while keeping its
contents a standard ZIP archive. If interoperability with generic archive
tools is more important than an app-specific file type, use `.zip` instead;
either choice has the same profile contents and import flow.

Example:

```text
my-setup.cuttleprofile
  manifest.json
  profile.json
  assets/<stable-asset-id>/<original-filename>
```

The manifest declares a fixed format identifier, format version, profile name,
minimum compatible app version, and an inventory of assets. Each inventory
entry has a stable bundle-local ID, asset kind, archive-relative path, original
filename, byte size, and SHA-256 digest. `profile.json` contains the complete
allowlisted settings snapshot and references bundle assets by those IDs; it
contains no sender-local absolute paths or control-server URLs.

The asset collector walks the snapshot's known reference fields: selected
model; configured pet/prop files; custom dance motion and music references;
and asset references nested in Behavior entries and reactions. It resolves
those references against the existing model, dance, audio, pet, and prop
libraries. If a required file is missing or a reference cannot be resolved,
Export stops with the names of the missing assets rather than producing a
bundle that appears portable but is incomplete.

On import, map each bundle asset ID to the installed local filename/URL, then
rewrite the snapshot's model, dance, pet, prop, and nested Behavior references
before saving the profile. Keep the manifest mapping explicit; do not perform
global string replacement on arbitrary setting text.

## Storage and implementation boundaries

- Keep live settings in the existing `settings.json` merge-patch flow. A
  profile load normalizes a complete snapshot, then publishes and persists one
  patch for all profile-managed keys so the pet and Settings window stay in
  sync.
- Store local profile definitions separately under the app's user data
  directory, for example `profiles/<profile-id>.json`. These files contain the
  snapshot and references into the shared local asset library, not another
  copy of every asset. Keep this user data outside the app bundle.
- Use a stable local profile ID; display names are editable and need not be
  unique. On name conflicts during import, offer a rename or an explicit
  replace. Replacing a profile definition must not remove its old assets.
- Keep imported assets in the existing typed libraries (`models`, `dances`,
  `audio`, `pets`, `props`) so current runtime loaders continue to work. Bundle
  references are translated to these local records during import.
- Implement bundle creation and extraction in the existing Flask control
  server, where the asset libraries already live. The Settings UI selects a
  bundle and calls the local API; Export receives the bundle and triggers a
  download. This avoids teaching the WebView to write into user data paths.
- Add narrow profile-list, export, and import API routes. Do not add profile
  archives or binary content to the regular preference merge-patch endpoint.

## Import safety and conflict behavior

Treat an imported bundle as untrusted input. Before changing settings or installing
files:

1. Validate the format/version, manifest schema, required settings fields,
   asset kinds, file inventory, sizes, and hashes.
2. Reject absolute paths, `..` traversal, duplicate archive paths, symlinks,
   unexpected archive entries, unsupported file types, oversized bundles,
   and excessive expanded size. Extract only to a server-controlled staging
   directory under the user's data directory.
3. Verify the snapshot has no unresolved asset references and run the same
   normalizers used for normal settings before commit.
4. Reuse an installed file with the same digest. If a filename is already in
   use for different content, install under a unique safe filename and rewrite
   the profile reference. Never overwrite or delete existing user assets.
5. Commit installed assets and the local profile only after validation passes.
   On failure, clean up staging and any files created by that import; leave
   settings, existing profiles, and existing assets unchanged.

Show a review summary before import commits: profile name, settings categories,
asset counts/sizes, reused files, and newly installed files. Clearly state that
the profile will be added to the list and will not take effect until loaded.
Set explicit compressed and expanded size limits in the API and surface a
readable error when either is exceeded.

## Existing Behavior profile migration

The current Behavior profile format stores only behavior states. Its name is
clickable to load (which is why a separate Load control is hard to find),
Export writes only the current behavior profile, and Import replaces the
editor's current behavior profile without adding it to the saved list. Behavior
profiles also omit the engine-enabled flag and custom reaction library.

On first upgrade to unified profiles, preserve every existing named Behavior
profile by migrating it into the new local profile list. Build each migrated
full snapshot from the user's then-current settings, replacing only its
Behavior state definition with the saved Behavior profile. Give it a visible
name such as `Behavior — <old name>` and mark it as migrated in metadata. This
preserves the old behavior-only effect when loaded while giving the new profile
well-defined values for the other settings. Preserve the active Behavior
configuration and reactions. Make migration idempotent so interruption or
relaunch cannot create duplicates or lose the old profiles.

After migration, remove the redundant Behavior-specific profile controls and
legacy list once the new local profile records are safely written. Keep existing
JSON behavior normalization for imported/older settings. The one-time
migration must not alter the live setup or delete user assets.

## Delivery phases

1. **Define profile schema and dependency inventory.** Audit every Settings
   preference and every asset reference in the current model, animation,
   Behavior/reaction, pet, and prop data. Write normalization and migration
   rules and decide archive size caps before implementing endpoints.
2. **Local profile library.** Add versioned profile records and the header
   selector, Save, Load, Rename, and Delete. Verify a complete setting snapshot
   loads live and survives restart before adding ZIP support.
3. **Asset-aware export.** Implement dependency discovery, stable bundle-local
   references, manifest generation, hashing, missing-file reporting, and ZIP
   download. Export/import a setup containing a custom VRM, custom dance and
   music, a pet, a prop, nested Behavior references, and custom reactions.
4. **Validated import.** Add preview, staging, conflict mapping, atomic commit,
   and registration in the local profile library. Test importing into a clean
   data directory and loading the result without access to the sender's
   directories.
5. **Behavior migration and UX cleanup.** Migrate old Behavior profiles
   idempotently, replace their local-only controls with the unified profile
   flow, and update user help/docs with the distinction between Save, Load,
   Export ZIP, and Import ZIP.

Keep each phase reviewable. Do not combine this feature with unrelated asset
library redesign or remote profile hosting.

## Acceptance criteria

- Save creates a named local profile; Load is an explicit visible action and
  restores all included settings live without touching excluded settings.
- A profile can be exported once and imported on a clean installation where
  no sender-local paths or source installation are available.
- The imported setup loads its selected custom VRM, configured pets and props,
  custom dance/audio, and every nested Behavior/reaction reference.
- Re-importing the same ZIP is safe and does not duplicate identical asset
  files. Name and filename conflicts never silently replace user data.
- Invalid, corrupt, unsupported, oversized, or hostile ZIPs fail before
  settings change; failed imports leave no partial asset/profile changes.
- Secrets, Cuttle credentials, workspace persona content, screen-capture
  preferences, window position, and built-in assets are absent from exports.
- Existing Behavior profiles are preserved by a repeat-safe migration, and
  the live setup is unchanged by migration.
- Existing ordinary setting edits still auto-save and apply immediately.

## Verification plan

- Unit-test the profile allowlist, normalization, dependency walker, asset
  reference rewrite, migration idempotence, hashes, and conflict naming.
- API-test profile list/save/rename/delete, ZIP export/import, staged failure,
  traversal and expansion-limit rejection, and no-partial-write behavior.
- UI-test header controls on multiple tabs, Save/Load clarity, import review,
  conflict resolution, progress/error states, and legacy Behavior migration.
- Run an end-to-end round trip with a source profile and a separate empty
  `CUTTLE_PET_DATA` directory. Stop the source server before loading the
  imported profile to prove it has no dependency on the sender's asset paths.
- Verify normal live editing, multi-window Settings synchronization, offline
  settings merge-patches, existing settings migrations, and user data outside
  the app bundle remain intact.

## Out of scope

- Cloud sync, profile links, a profile marketplace, or remote hosting.
- Copying the sender's entire asset library or OS-level window placement.
- Bundling secrets, login sessions, workspace files, or permission grants.
