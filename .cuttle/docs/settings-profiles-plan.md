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
- Use one vocabulary everywhere: **Save** writes the current setup to a
  portable `.cuttleprofile` file; **Load** reads one and applies it. The app
  keeps no profile library of its own, so there is no second, server-side
  Save/Export pair to reconcile.
- Save always packages the assets the current setup depends on, so the file is
  self-contained and shareable. Loading installs any missing assets into the
  local libraries, remaps the profile's asset references to those local files,
  and applies the settings live as one operation.
- Loading a profile replaces the profile-managed settings as one operation.
  Fields intentionally excluded from profiles remain as they were.

Suggested header layout:

```text
Profiles  [Save] [Load]
```

Save prompts for a profile name, then asks where to store the bundle with the
OS save dialog (a browser download in the web build). Load opens a bundle,
shows a review summary (settings categories, asset counts and sizes, reused
versus newly installed files), and asks for confirmation before installing
anything.

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
system window geometry, and any retired in-app profile library. Do not package
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
- Do not store profile definitions in the app. The profile exists only as the
  portable bundle the user saves and loads. The server stages imports under the
  user data directory and installs referenced assets into the shared local
  libraries; it keeps no snapshot library and no second copy of every asset.
- Use stable bundle-local asset IDs inside the bundle; display names live only
  in the manifest and the downloaded filename. Loading never overwrites or
  deletes existing user assets, so a re-downloaded file cannot silently replace
  a user's content.
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
5. Commit installed assets only after validation passes. On failure, clean up
   staging and any files created by that import; leave settings, existing
   assets, and the current setup unchanged.

Show a review summary before an import commits: profile name, settings
categories, asset counts/sizes, reused files, and newly installed files. Clearly
state that required assets will be installed and the profile applied.
Set explicit compressed and expanded size limits in the API and surface a
readable error when either is exceeded.

## Legacy Behavior profiles

The old Behavior tab had its own local Save / Export / Import controls that
stored behavior-only snapshots. Those controls were removed when the unified
profile model landed. Because profiles are now ordinary files with no in-app
library, there is nothing to migrate into: the legacy `behaviorSettings.profiles`
list is simply no longer surfaced. Existing JSON behavior normalization stays in
place for imported and older settings, and the live setup is never altered by
this cleanup.

## Delivery phases

1. **Define profile schema and dependency inventory.** Audit every Settings
   preference and every asset reference in the current model, animation,
   Behavior/reaction, pet, and prop data. Write normalization and migration
   rules and decide archive size caps before implementing endpoints.
2. **Profile file save/load.** Add the header Save and Load controls, the
   versioned snapshot schema, and the export-from-current-settings path. Verify
   a complete snapshot exported and loaded back applies live and survives
   restart before adding asset bundling.
3. **Asset-aware export.** Implement dependency discovery, stable bundle-local
   references, manifest generation, hashing, missing-file reporting, and ZIP
   download. Export/import a setup containing a custom VRM, custom dance and
   music, a pet, a prop, nested Behavior references, and custom reactions.
4. **Validated load.** Add preview, staging, conflict mapping, atomic asset
   install, and applying the restored settings live. Test loading into a clean
   data directory without access to the sender's directories.
5. **Legacy cleanup.** Retire the old Behavior-only profile controls and the
   in-app profile library, and update user help/docs to describe Save and Load
   as file operations.

Keep each phase reviewable. Do not combine this feature with unrelated asset
library redesign or remote profile hosting.

## Acceptance criteria

- Save writes a self-contained bundle of the current setup; Load restores all
  included settings live without touching excluded settings.
- A profile can be saved once and loaded on a clean installation where no
  sender-local paths or source installation are available.
- Loading a profile installs its selected custom VRM, configured pets and props,
  custom dance/audio, and every nested Behavior/reaction reference.
- Loading the same bundle twice is safe and does not duplicate identical asset
  files. Filename conflicts never silently replace user data.
- Invalid, corrupt, unsupported, oversized, or hostile bundles fail before
  settings change; failed loads leave no partial asset changes.
- Secrets, Cuttle credentials, workspace persona content, screen-capture
  preferences, window position, and built-in assets are absent from saved
  profiles.
- The retired Behavior profile list is no longer surfaced, and removing it does
  not alter the live setup.
- Existing ordinary setting edits still auto-save and apply immediately.

## Verification plan

- Unit-test the profile allowlist, normalization, dependency walker, asset
  reference rewrite, hashes, and conflict naming.
- API-test bundle export from current settings, preview/commit load, staged
  failure, traversal and expansion-limit rejection, and no-partial-write
  behavior.
- UI-test header controls on multiple tabs, Save/Load clarity, load review,
  progress/error states, and that retired Behavior controls are gone.
- Run an end-to-end round trip with a source profile and a separate empty
  `CUTTLE_PET_DATA` directory. Stop the source server before loading the saved
  profile to prove it has no dependency on the sender's asset paths.
- Verify normal live editing, multi-window Settings synchronization, offline
  settings merge-patches, existing settings migrations, and user data outside
  the app bundle remain intact.

## Out of scope

- Cloud sync, profile links, a profile marketplace, or remote hosting.
- Copying the sender's entire asset library or OS-level window placement.
- Bundling secrets, login sessions, workspace files, or permission grants.
