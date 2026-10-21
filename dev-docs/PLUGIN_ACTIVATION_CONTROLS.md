# OpenCode V2 plugin activation controls

CodeNomad exposes **activation controls** plus native package check/update
(`stores/plugin-package-actions.ts`), not a package manager: it does not install,
remove or edit plugin options, which stay in OpenCode configuration and the CLI.

## V2 contract

OpenCode applies plugin entries in configuration order. `-plugin.id` disables
an ID, `plugin.id` later re-enables it, `*` matches all plugins, and `prefix.*`
matches an ID prefix. Source declarations remain in place when an activation
rule is added.

The runtime's `plugin.list`/`plugin.check`/`plugin.update` have no enable/disable
counterpart and the pinned client's `config.update` accepts only its declared
preference fields, so activation is one narrow, authenticated configuration mutation.

## Authority and precedence

Every read and mutation starts with the workspace's acquired, authenticated
OpenCode connection and an ownership check for the complete native location.
`config.get()` is the authority for the daemon's discovered paths:

- **Global** uses the daemon-reported global configuration directory. The
  highest existing `opencode.jsonc`/`opencode.json` document is selected;
  otherwise `opencode.jsonc` is created there.
- **Project** uses only the active location directory. The highest existing
  direct or `.opencode` document is selected; otherwise
  `.opencode/opencode.jsonc` is created. When discovery reports an inherited
  `.opencode` document, every direct document ranks below it: Project therefore
  selects an existing active-location `.opencode` document or creates
  `.opencode/opencode.jsonc` there. It never selects the ancestor as its target.

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
The higher-precedence Project fallback is also unavailable if its physical
destination escapes the active location through a symlink/junction; it must not
edit an ancestor/shared file to implement a location-local override. Missing
fallback documents are created only by an explicit mutation, not display reads.

Global rules can be overridden by later project rules. Built-in OpenCode entries
remain in the authoritative snapshot but are not presented as user activation
controls. An exact disabled ID remains available even when it is absent from
`plugin.list`, so it can be re-enabled. A plugin hidden only by a
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

Display snapshots are never keyed by session workspace identifiers: changing
sessions inside one worktree reuses its snapshot, and the first read waits until
the Plugins surface is visible and expanded. Location-scoped plugin events mark
only their worktree stale; an unknown directory matches nothing, while a canonical
event arriving before its WSL alias is learned is retained and fences only the
snapshot that later adopts that identity. Merging separate host and canonical
in-flight records keeps the canonical invalidation generation and coalesced
demand; the older alias response cannot publish over the event, its read is
aborted and one reconciliation read supplies the shared snapshot. Configuration
events (which do not identify the changed document) and renderer-to-backend SSE
reconnection (even when the native subscription stayed connected) mark every
worktree of the instance stale, a successful Global mutation its siblings. Stale
and hidden snapshots are kept without background OpenCode reads; a queued
follow-up starts only while a visible consumer remains, and scoped demand handles
follow canonical aliases until deactivation/disposal. Generic metadata hydration
never fetches `plugin.list`; `plugin.updated` refreshes agents, providers and
commands without a generic metadata round-trip.

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
selected distro, retaining native modes such as `0600` rather than inferring them
from the UNC projection. Shell helpers prefer portable fallbacks (`realpath`,
`sync`, `sha256sum`/`shasum`); Ubuntu remains the tested distro for minimal busybox
images. A toggle costs four unpooled `wsl.exe` cold starts (`inspectMany`, `load`,
`prepare`, `commit`; cleanup only after a failed commit): roughly 2–8 s of
filesystem time before daemon RPCs on slow hosts.

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
enable the no-op shortcut. A no-op additionally requires the whole normalized
prefix to match the raw target, followed only by concrete rules included in the
projection. A raw deletion/replacement or an unprojected entry during watcher
lag instead appends the requested exact rule; stale daemon state cannot prove
that the requested state is already durable.

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

Activation adds no version requirement beyond `opencode/runtime-support.ts`; its
write is a local JSONC rule, not a runtime mutation endpoint. Read or discovery
failures leave controls unavailable and never fall back to guessed paths.

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

## Agent conventions

- Present Global and Project as separate per-plugin columns so every mutation has an explicit scope. Cache display snapshots by instance and worktree directory, and refresh them only while the plugin surface is visible.
- Keep the Plugins surface minimal: plugin names, a compact package check/update icon when applicable, and Global/Project switches. Activating the icon opens a menu that names the exact package operation (check or update with its native target) instead of firing blindly; put source/status/target details and the shared-cache effect of package updates in hover/focus tooltips. Do not add general descriptions, inline explanations, target footers or success commentary. The compact Refresh icon occupies the name-column header and spins during loading and refresh; automatic display updates follow native events, reconnects and visible demand. Package writes use native inventory-validated targets, never plugin IDs; styles live in `styles/components/plugin-package-action.css` and menu chrome is shared with `action-overflow-menu`.
- Plugin packages that fail before exporting an ID remain visible by their native target with check/update actions and failure details in the name tooltip. Do not fabricate plugin IDs or activation switches for these entries; reconcile them into ordinary rows once native loading succeeds.
