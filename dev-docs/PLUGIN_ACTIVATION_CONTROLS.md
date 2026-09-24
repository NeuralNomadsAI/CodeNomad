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

WSL paths are resolved and mutated through the workspace's selected distro;
configuration permissions never come from synthetic UNC metadata. No path is
derived from the CodeNomad process environment, CLI debug output, or
`OPENCODE_CONFIG_CONTENT`. Reads return the canonical service directory; the UI
aliases an initial Windows/UNC request to that identity so native plugin events,
later session locations, and the original host path share one cache record.

If the location is the global configuration root, or Global and Project resolve
through symlinks/junctions to the same physical document, Project is unavailable.
Its switch remains visible but disabled, and the server rejects a direct Project
mutation rather than writing the Global document under the wrong scope.

Global rules can be overridden by later project rules. The UI presents one
compact row per user/configured plugin with separate **Global** and **Project**
switches; each gesture therefore names its write scope directly. Built-in
OpenCode entries remain in the authoritative snapshot but are not presented as
user activation controls. An exact disabled ID remains available even when it
is absent from `plugin.list`, so it can be re-enabled. A plugin hidden only by a
broad wildcard cannot be named safely unless the runtime or an exact configured
rule reveals its ID. OpenCode's reserved `opencode.*` identity is retained on
disabled synthesized controls so builtins do not become visible merely because
`plugin.list` omits inactive entries.

A scope without an explicit matching rule inherits predictably in the compact
switch UI: Global uses OpenCode's enabled baseline, while Project inherits the
resolved Global state. A Project override therefore never changes the displayed
Global switch, even though it controls the plugin's final effective state.
Object-form sources remain source records, but are also replayed as ordered add
operations when they re-enable an already resolved plugin, matching OpenCode's
native supervisor. Relative and `file://` local declarations are correlated with
the resolved runtime entrypoint before that ordered replay.

Display snapshots are keyed by workspace instance and worktree directory, not
by session workspace identifiers. Changing sessions inside one worktree reuses
the same snapshot. The UI requests the first snapshot only while the Plugins
surface is visible and expanded. Location-scoped plugin events mark only their
worktree stale; an event for an unknown directory matches nothing immediately,
while a canonical event arriving before its WSL alias is learned is retained
and fences only the snapshot that later adopts that canonical identity.
Configuration events mark the instance's worktrees stale
because the event does not identify whether the global document changed.
Hidden surfaces retain their last snapshot without starting background
OpenCode reads, then refresh on the next visible demand. A successful Global
mutation likewise marks sibling worktree snapshots stale without refreshing
them in the background. Generic instance metadata hydration does not fetch
`plugin.list`; only a visible activation surface requests plugin inventory.
`plugin.updated` refreshes agents, providers, and commands without forcing a
generic metadata round-trip.

## Mutation guarantees

`packages/server/src/opencode/plugin-control-document.ts` owns the file
operation:

1. Read at most 4 MiB and require valid UTF-8 JSON/JSONC with one array-valued
   `plugins` key.
2. Resolve physical file destinations, including symlinked parent directories,
   and fail closed on malformed content, invalid plugin entries, circular links,
   or filesystem errors.
3. Append only the requested exact `id` or `-id` entry with `jsonc-parser`.
   Comments, source objects, options, unknown keys, ordering, indentation, line
   endings, and a UTF-8 BOM are retained.
4. Serialize in-process mutations and hold a per-target interprocess lock across
   the final source verification and atomic rename. The lock carries an owner
   nonce verified immediately before the rename, so a stalled owner fails with
   `conflict` instead of overwriting a successor. A stalled file/symlink lock
   is reaped like a stale directory. A same-directory temporary file is synced
   first with the source mode explicitly restored after creation (host `umask`
   cannot tighten it); an external mode-only change is a conflict. Crash
   leftovers (`*.tmp` with per-process random names) are never read and remain
   inert; locks self-heal after 30 s.

WSL performs bounded inspect/read/create/chmod/sync/rename operations inside the
selected distro. Existing native modes such as `0600` are retained rather than
being inferred from the Windows UNC projection. Shell helpers prefer portable
fallbacks (`realpath`, `sync`, `sha256sum`/`shasum`) and Ubuntu remains the
tested distro for minimal busybox images. A WSL toggle costs four `wsl.exe`
spawns on the happy path (`inspectMany`, `load`, `prepare`, `commit`; cleanup
runs only when the commit fails), each paying full process cold-start since
there is no pooling — expect roughly 2–8 s of filesystem time before daemon
RPCs on slow hosts.

The server keeps no display cache by design: every read and mutation reissues
`config.get` + `plugin.list` (plus one `location.get` for session-scoped
locations) and re-resolves targets, so snapshots can never serve stale daemon
state. Expensive work is bounded instead: one snapshot base per mutation with
positional overlays (no triple rebuild), per-write-target mutation queues, and
UI-side coalesced trailing refreshes.

UI cache records live until `workspace.stopped` clears the instance
(`clearInstance` also aborts in-flight reads). Records are keyed by worktree
directory plus one canonical alias at most, so retention is bounded in practice
by the worktree count; only unknown-directory invalidations use a bounded
(200-entry) pending set.

Daemon-normalized `ConfigEntry` values remain authoritative for inventory and
activation semantics, including environment substitutions. The raw JSONC is
used for editing and conflict detection only. During a serialized write burst,
concrete authorized rules already durable on disk but not yet reflected by the
daemon are paired positionally and replayed after its normalized document. Raw
`{env:...}`/`{file:...}` placeholders never consume a later concrete rule or
enable the no-op shortcut.

The connection generation is rechecked after discovery, before file preparation,
and again immediately before the atomic rename. Mutations also enter the active
worktree's deletion fence, so
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
- native WSL path operations and permission retention:
  `plugin-control-document-wsl.test.ts` (set
  `CODENOMAD_TEST_WSL_PLUGIN_CONTROLS` to a distro for the native fixture)
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
