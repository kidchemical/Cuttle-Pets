# Behavior editor and callable behavior library

Status: proposed; implementation has not started.

## Product direction

Build a visual behavior authoring system backed by versioned, validated JSON definitions. Execute scene operations in TypeScript, keep the Flask server responsible for persistence, catalog discovery, argument validation, and invocation routing. Do not add Lua or Python execution to behavior files in the initial release.

Distinguish persistent **states** (idle, working, custom focus mode) from finite **reactions** (celebrate a push, put on a hat and dance). Both use the same phase and action vocabulary. Profiles select and configure behaviors and event bindings; definitions have stable IDs independent of display names. Built-ins can be duplicated and customized.

## Existing implementation

- `app/src/behavior.ts`: fixed idle/working/music/dancing state union, profile normalization, animation catalog, playback mapping.
- `app/src/components/BehaviorPanel.tsx`: all four states expanded, entry/base/occasional/exit animation lists, per-animation preview, profile import/export.
- `app/src/hooks/useBehaviorEngine.ts`: state transitions and occasional scheduling; sequences poll global mixer busy state with a timeout.
- `app/src/components/VRMScene.tsx`: feature-specific prop and animation controls, no general prop authoring interface.
- `server/server.py`: persisted settings, SSE distribution, fixed activity mapping and verbs.
- `cli/cuttle_pet.py`: fixed commands and a `verbs` discovery command.
- `bridge/bridge.py`: polls Cuttle activity; it does not currently provide a successful-git-push event.

## Editor experience

Use a searchable behavior library on the left and a selected behavior editor on the right; adapt to a stacked view in narrow settings windows. Offer New behavior, Duplicate, Enable/disable, Import, and Export.

Selected behavior has four sections:

1. Overview: name, stable call ID, description, state/reaction kind, tags, enabled and agent-exposed flags.
2. Sequence: reorderable phase cards with actions that run together; phases run in order. States additionally have enter, sustain, occasional, and exit sections.
3. Parameters: typed inputs with defaults, constraints, descriptions, and optional presets. Each compatible action field has a Literal / Parameter picker.
4. Calls and triggers: generated CLI/HTTP examples, catalog preview, event bindings, cooldown and interruption policy.

Test opens a parameter form and executes the entire draft through the same runtime as external calls. Show the current phase, errors and missing assets, plus Stop. Preview temporarily owns playback and restores the latest underlying state when it finishes. Draft edits autosave; explicit Apply publishes a valid revision to the callable library. Invalid drafts never replace working definitions.

## Definition and binding model

Use a schemaVersion, ID, revision, kind, metadata, exposure flags, parameter definitions, lifecycle/phase definitions, execution policy, and asset references. Use discriminated action types instead of arbitrary code.

Initial action vocabulary: play/loop animation, set expression, show/hide prop, attach prop, change supported material color, wait. Add prop/pet-group transforms and tweening to support launch sequences. A phase ends after a specified duration or named animation completion; parallel actions have explicit completion rules and bounded waits. Do not infer completion solely from global isBusy().

Parameter values are typed references, for example `{"param":"duration"}` or `{"param":"color"}`. Initially support string, number, boolean, enum, and color, with units and ranges. Allow only compatible bindings; seconds cannot bind to color. No interpolated executable expressions. Validate defaults, supplied arguments and asset capabilities before playback.

Example hat dance: color defaults to #ff6600; duration defaults to 8 seconds with range 1–60. Phase one shows a head-attached hat and binds its color to color. Phase two loops a selected dance for duration seconds. Cleanup removes the behavior-owned hat and returns control to the current state.

Example rocket launch: show rocket; position/attach pet in rocket; play boarding animation; animate the rocket/pet group upward with optional effects; hide the group; cleanup and restore pet. This requires actual rocket and boarding assets, generic scene grouping and transform support. The editor alone cannot supply those capabilities. Initial motion remains inside the pet window; travel across desktop windows is a separate feature.

## Prop system

Introduce an asset registry with stable IDs, source references, supported attachment anchors, fit offsets, editable material slots, transform capabilities and optional clips. Separate reusable asset metadata from each behavior's prop instance settings. Color editing affects declared compatible material slots rather than every material indiscriminately.

Adapt existing laptop, cup and headphone features incrementally; preserve specialized typing/sipping logic while sharing prop ownership infrastructure. Provide a simple accessory asset to validate attachment, color and parameter binding end to end.

## Runtime contract

Give every invocation a run ID and pin its definition revision. A single authoritative pet renderer executes runs; settings previews must route to it rather than execute independently in every SSE subscriber. Handle renderer registration, readiness and disconnection explicitly. Return accepted separately from started/completed; fail clearly when no execution renderer is available.

Run-scoped resources include timers, animations, expressions and prop instances. Completion, cancellation, failure and model changes all perform cleanup. Restore the latest desired underlying state, not a snapshot that can become stale while a reaction plays. Define replace, bounded queue and ignore-if-busy policies, plus cooldown and request deduplication for event retries. Keep one foreground behavior in the first release; ambient layers remain governed by explicit ownership rules.

Custom states support enter/exit calls and optional expiration so disconnected integrations cannot leave the pet stuck. Built-in state resolution remains a fallback. Definition edits do not mutate active runs.

## Agent API and integrations

Proposed CLI:

```sh
cuttle-pet behaviors list --json
cuttle-pet behaviors describe hat-dance --json
cuttle-pet behaviors run hat-dance --args '{"color":"#ff6600","duration":8}'
cuttle-pet behaviors status RUN_ID
cuttle-pet behaviors stop RUN_ID
```

Provide matching HTTP catalog, detail, run, status and cancellation endpoints. Persistent states additionally need an explicit leave operation. Catalog entries include ID, description, parameter schema, examples, kind, dependencies, enabled/available status and revision. Only published, exposed definitions are discoverable and callable externally. Generate CLI help and HTTP examples from this same registry; keep legacy verbs compatible.

The editor configures a callable ID and generates commands; it does not require users to implement shell handlers. External agent CLIs can discover and invoke the same local interface through their existing tool or hook mechanisms. Provide integration instructions and examples without promising every CLI has identical hooks.

Event bindings are separate from behavior definitions: source + event + optional filters -> behavior + argument mappings. A successful git push must be reported by Cuttle's completed push action or an explicit integration hook; activity polling cannot reliably infer success. Example normalized event: source=cuttle, event=git.push.succeeded. Preserve an explicit direct-call route for all integrations. Changes to Cuttle itself require a separate project scope.

## Delivery plan and verification

1. Foundation: schema/validation, definition registry, migrations from current profiles, stable asset references, preservation of original data. Verify all existing default behavior semantics and import/export round trips; unsupported newer versions produce actionable errors rather than silently dropping content.
2. Runtime and catalog: cancellable phase engine, renderer authority, argument validation, generated discovery and CLI/HTTP calls. Verify invocation lifecycle, cancellation cleanup, disconnects, duplicate requests, and state changes during a reaction.
3. Editor: behavior list/detail, state/reaction creation, phase cards, typed bindings, draft/Apply workflow, full preview and live phase display. Verify keyboard operation, narrow layouts, validation feedback and draft/published separation.
4. Props: registry and ownership, accessory import/fit, attachment/color controls, transform tweening. Demonstrate hat-dance with multiple colors/durations and interrupted cleanup; then rocket launch with suitable assets.
5. Integrations: event-to-behavior bindings and documentation for Cuttle and direct agent CLI invocation. Verify successful-push triggering exactly once and no trigger on failed push. Implement the Cuttle producer only under a separately authorized Cuttle task.

First reviewable milestone: create a named reaction, sequence existing animations, bind a duration parameter, preview it, discover its description/schema through the CLI, and invoke it externally. Build props on that working contract.

## Scripting decision

JSON is the editable document format; TypeScript is the runtime. This keeps visual edits and stored definitions equivalent and enables validation, sharing and agent discovery. Lua becomes worth evaluating only when concrete behaviors require control flow that reusable phases, bindings and a small declarative action vocabulary cannot express. If later introduced, scripts should be optional advanced action nodes with bounded execution and a narrow scene API, rather than replacing the editor's underlying format.
