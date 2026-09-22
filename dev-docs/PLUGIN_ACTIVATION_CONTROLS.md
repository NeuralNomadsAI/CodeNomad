# OpenCode V2 plugin activation controls

CodeNomad exposes **activation controls**, not a package manager. The surface
does not install, remove, update, or edit plugin options. Those operations stay
in OpenCode configuration and the OpenCode CLI.

## V2 contract

OpenCode applies plugin entries in configuration order. `-plugin.id` disables
an ID, `plugin.id` later re-enables it, `*` matches all plugins, and `prefix.*`
matches an ID prefix. Source declarations remain in place when an activation
rule is added.

The runtime exposes `plugin.list`, `plugin.check`, and `plugin.update`, but no
symmetric enable/disable operation. The pinned client's `config.update` only
supports its declared preference fields. CodeNomad therefore does not proxy an
upstream write. It performs one narrow, authenticated configuration mutation.

## Authority and precedence

Every read and mutation starts with the workspace's acquired, authenticated
OpenCode connection and an ownership check for the complete native location.
`config.get()` is the authority for the daemon's discovered paths:

- **Global** uses the daemon-reported global configuration directory. The
  highest existing `opencode.jsonc`/`opencode.json` document is selected;
  otherwise `opencode.jsonc` is created there.
- **Project** uses only the active location directory. The highest existing
  direct or `.opencode` document is selected; otherwise
  `.opencode/opencode.jsonc` is created.

WSL paths are translated through the workspace's selected distro. No path is
derived from the CodeNomad process environment, CLI debug output, or
`OPENCODE_CONFIG_CONTENT`.

Global rules can be overridden by later project rules. The UI presents one
compact row per user/configured plugin with separate **Global** and **Project**
switches; each gesture therefore names its write scope directly. Built-in
OpenCode entries remain in the authoritative snapshot but are not presented as
user activation controls. An exact disabled ID remains available even when it
is absent from `plugin.list`, so it can be re-enabled. A plugin hidden only by a
broad wildcard cannot be named safely unless the runtime or an exact configured
rule reveals its ID.

Display snapshots are keyed by workspace instance and worktree directory, not
by session workspace identifiers. Changing sessions inside one worktree reuses
the same snapshot. The UI requests the first snapshot only while the Plugins
surface is visible and expanded. Location-scoped plugin events mark only their
worktree stale. Configuration events mark the instance's worktrees stale
because the event does not identify whether the global document changed.
Hidden surfaces retain their last snapshot without starting background
OpenCode reads, then refresh on the next visible demand. A successful Global
mutation likewise marks sibling worktree snapshots stale without refreshing
them in the background.

## Mutation guarantees

`packages/server/src/opencode/plugin-control-document.ts` owns the file
operation:

1. Read at most 4 MiB and require valid UTF-8 JSON/JSONC with one array-valued
   `plugins` key.
2. Follow an existing file symlink explicitly and fail closed on malformed
   content, invalid plugin entries, circular links, or filesystem errors.
3. Append only the requested exact `id` or `-id` entry with `jsonc-parser`.
   Comments, source objects, options, unknown keys, ordering, indentation, line
   endings, and a UTF-8 BOM are retained.
4. Serialize CodeNomad mutations, write a same-directory temporary file,
   `fsync` it, verify the source has not changed, and atomically rename it.

The connection generation is rechecked after discovery and immediately before
persistence. Mutations also enter the active worktree's deletion fence, so
worktree removal drains an admitted write and a blocked write fails closed. The
route accepts no caller-provided config path and refuses foreign locations,
malformed runtime inventory, or IDs absent from the authorized
runtime/configured inventory.

OpenCode watches these configuration roots. CodeNomad does not restart the
daemon and does not claim that a successful file write means the plugin is
already active. The mutation response publishes the durable configured state;
`config.updated` and `plugin.updated` trigger fenced, coalesced refreshes until
runtime state catches up.

## Runtime qualification

The feature uses only `config.get` and `plugin.list`, which are already consumed
through CodeNomad's connection-scoped compatibility transport.

The server, UI, and bundled plugin currently pin `2.0.11` together. Its
declarations provide the location-scoped reads, ordered `ConfigEntry.plugins`,
and plugin source/state metadata used here. CodeNomad's demonstrated technical
minimum is `2.0.7`, while `2.0.11` is the separately recommended and tested
target. These activation controls add no higher version requirement. The
activation write remains a local JSONC rule; no runtime-specific mutation
endpoint is used.

Historical beta and stable contract-family results remain recorded in
`OPENCODE_V2_COMPATIBILITY.md` as compatibility-adapter evidence, not as a
separate support promise for this feature. Runtime admission follows
`opencode/runtime-support.ts` and the evidence policy in that document. There is
no release-number-only gate:
unknown runtimes must first pass the existing authenticated OpenAPI contract
recognition. Read or discovery failures leave controls unavailable and never
fall back to guessed paths.

## Validation

- JSONC preservation, malformed input, optimistic conflict, and atomic replace:
  `plugin-control-document.test.ts`
- ownership, WSL/host path authority, precedence, visibility of disabled IDs,
  serialization, and scope mutations: `plugin-controls.test.ts`
- strict CodeNomad route and error mapping: `plugin-controls.test.ts` beside
  the route
- worktree-scoped cache sharing, retained snapshots, demand-driven invalidation,
  generation fencing, and trailing refresh:
  `packages/ui/src/stores/plugin-controls.test.ts`
- real Solid UI, full stylesheet, dual explicit scope switches, lazy visibility,
  shared rounded geometry, mutation, and native event dispatcher:
  `packages/ui/tests/browser/plugin-controls.test.ts`
