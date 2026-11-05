# OpenCode V2 plugin controls

The Plugins surface adds and removes plugin source declarations
(`opencode/plugin-sources.ts`, `stores/plugin-sources.ts`), toggles plugin
activation per scope, shows each plugin's version and update availability, and
runs native package check/update (`stores/plugin-package-actions.ts`). Plugin
options, local-path sources and package installation itself stay with OpenCode:
CodeNomad writes the declaration and OpenCode resolves, installs and loads it.

## Source declarations

`POST /api/workspaces/:id/plugin-sources` (`{ location, scope, spec }`) appends
one string entry at the end of the scope's `plugins`; `DELETE` (`{ location,
scope, target, entryIndex, expectedRevision }`) removes one entry. Both routes are strict, map
errors like the activation route and add a stable `code` (`invalid-spec`,
`local-path`, `plugin-id`, `duplicate`, `stale`, `timeout`, `global-only`).

- **Accepted specs** match OpenCode's own `plugin add`: registry versions, ranges,
  tags and `npm:` aliases, and remote Git specs, parsed with `npm-package-arg`.
  Local paths (relative, absolute, `~`, `file:`, `git+file:`), tarball URLs,
  `{env:`/`{file:` variables, control characters and activation selectors
  (`-id`, wildcards, `opencode.*`, or any known plugin ID or rule selector) are
  refused before any file is touched. Existing local entries stay displayable and
  removable.
- **Duplicates**: a package already declared in any effective scope (the
  daemon's documents, including inherited and inline ones, plus the raw target
  documents for writes not yet reloaded) is refused. Identity is the
  case-insensitive registry name, both sides of an alias, whatever the version,
  range or tag, object `{ package }` entries included, and the Git repository
  without committish (host and path for hosts other than GitHub, GitLab and
  Bitbucket). Specs are printable ASCII only. The check spans both scopes while
  the document lock covers one file, so adds share one server-wide queue (every
  workspace shares the Global document). Each turn has a
  `PLUGIN_SOURCE_ADD_TIMEOUT_MS` (20 s) deadline that aborts it: daemon reads
  receive the signal (`read`, `readConfigDocuments`, `editConfigDocument`) and the
  commit re-checks it under the lock, so the turn's own outcome is reported and
  `timeout` (503) means nothing was written. A client that ignores the signal
  releases the queue after a 5 s grace; the abandoned turn then fails its next
  signal check, before any write.
- **Removal** requires, under the document primitive, that `plugins[entryIndex]`
  still declares `target` (a string, or an object's `package`); otherwise `stale`
  (409). The result must parse to the original minus exactly that element.
  Activation rules (`id`/`-id`) are left in place, and OpenCode's package cache is
  never touched.
  Every ordinary plugin uses the ordinary source removal, independently of catalog, family or binding count.
  The trusted Cancel-first confirmation names the plugin and exact scope, warns of interrupted availability
  and connections (including other projects for Global), and enables its scoped removal action after 600 ms.
  Unsent consent expires after 120 s and is revoked by navigation, invalidation or disconnection.
  Cancellation and expiry perform no mutation. The captured request is sent once; uncertain responses
  reconcile actual configuration through the existing invalidation/read path before any fresh user action.
   The integration's own Status section offers application install/update when a fresh active native integration reports
   `host.action`. It uses the shared Cancel-first machine/package-version confirmation and the sessionless,
   outcome-only installation route ([application installation](OPENCODE_INTEGRATIONS.md#application-installation)).
  WSL is refused before catalog persistence or installer calls; uncertain requests must never be replayed.
- **Scope**: Global is the default. Project shows a warning that the entry runs
  whenever the folder is opened and that GUI parts load only from Global. Whether
  a package has GUI parts (`features.gui`) is known only once OpenCode has loaded
  it, so a Project-declared GUI package is flagged in its tooltip afterwards.
  An OpenCode integration the reviewed catalog recognises
  ([OPENCODE_INTEGRATIONS.md](OPENCODE_INTEGRATIONS.md#recognition-and-state)) is
  known before installation: a `native` one is refused in Project
  (`global-only`, 422), and two specs of one integration are duplicates.
- **States**: the response publishes only the durable configured state
  (`reloadPending`). A just-added spec is `pending` (busy row, **Installing**)
  until `plugin.list` reports its exact target, which turns it into an ordinary
  active or failed row (`error` and native `ref` in the tooltip).
  `PLUGIN_SOURCE_PENDING_TIMEOUT_MS` (120 s) bounds that window: a source still
  absent afterwards, like any configured source the inventory never reports, is
  `unconfirmed` (**Not confirmed**, with a Refresh action), since a disabled
  package and a never-installed one look the same to `plugin.list`. `plugin.list`
  omits disabled plugins and exposes no package-to-ID link for them, so a disabled
  package with an exact `-id` rule shows two rows: its ID row with switches, and
  its unconfirmed source row carrying the Remove items.
- **Correlation**: snapshot sources carry `pluginId` when runtime inventory or a verified
  managed installation associates their source, so Remove items attach to ordinary plugin rows. A row offers removal only
  for declarations in a scope's own write target; inherited, inline and other
  documents are shown, never edited.

## CodeNomad-managed plugins

The server marks records `managedBy: "codenomad"` only after validating the installer-generated
entry and its content-addressed payload location. Recognition parses the exact generated
`plugins/codenomad-<feature>.ts` shape, used by `session-pruning`, `automation` and `missions`:
the lifecycle marker, generated `desktopPlugin` import/call shape, presence directories and
`<sha256>.mjs` payload must agree. Missions' provider/runtime artifact descriptors follow the
installer's generated shape. Validated storage retained outside the default data path remains
recognisable; paths use the daemon's dialect, including WSL's Linux file URLs and paths.
Never classify a plugin by its display name, ID or a `codenomad` prefix alone. A third-party
homonym retains its ordinary controls.

The per-feature build scripts emit a minimal descriptor on the runtime payload's first line:
`// CodeNomad plugin IDs: ["..."]`. These IDs are inside the SHA-256-verified payload bytes.
Detection reads them generically; every new feature builder must emit its actual exported IDs.
The current builders export `codenomad-session-pruning`, `codenomad.automation` and
`codenomad.missions`. The descriptor supplies IDs for correlating absent runtime entries with
exact or wildcard activation rules. Descriptor-less generated installations remain recognisable
by the validated source when the runtime reports them; synthesising an absent ID requires the
payload descriptor. Never add an ID/name allowlist or execute the payload during discovery.

The standalone `session-pruning-tui` entry (`@neuralnomads/codenomad-session-pruning/tui`)
exports `codenomad-session-pruning-tui` through the package's separate TUI path. The managed
installer publishes the desktop plugin factory from `session-pruning/desktop-plugin.ts`.
Recognise installer ownership through the validated entry and payload rather than adding a
name-based exclusion for the TUI entry.
Qualification follows the consumed native contracts without a daemon-version allowlist.

The UI excludes managed records from every ordinary plugin row, activation switch, package
check/update action and source-removal path. A compact warning above the Plugins list exposes
only managed plugins that are disabled, failed or loading-unconfirmed. Each warning row has
an `InfoPopoverButton` with available native error/ref details. Only a disabled row offers
**Re-enable**, through the existing activation mutation: append the positive exact ID, retain
the negative rule and all unrelated configuration. Use the disabling rule's Global/Project
scope when writable, otherwise the writable Project override. Native rules still determine
precedence. Keep the warning until a fenced inventory refresh confirms an active runtime
entry; a durable write alone leaves it visible. Native events and the existing Refresh action
drive reconciliation. Never restart OpenCode automatically.
Concurrent mutation/read reconciliation retains the newer runtime and provenance while applying
the durable activation rules. A confirmed native failure keeps its warning and details available.

## V2 contract

OpenCode applies plugin entries in configuration order. `-plugin.id` disables
an ID, `plugin.id` later re-enables it, `*` matches all plugins, and `prefix.*`
matches an ID prefix. Source declarations remain in place when an activation
rule is added.

The native plugin API offers `plugin.list`/`plugin.check`/`plugin.update`, and the
pinned client's `config.update` accepts only its declared preference fields, so
activation is one narrow, authenticated configuration-file mutation.

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
configuration permissions never come from synthetic UNC metadata. Never derive a
path from the CodeNomad process environment, CLI debug output or
`OPENCODE_CONFIG_CONTENT`. Reads return the canonical service directory; the UI
aliases an initial Windows/UNC request to that identity so native plugin events,
later session locations, and the original host path share one cache record.

If the location is the global configuration root, or Global and Project resolve
through symlinks/junctions to the same physical document, Project is unavailable.
Its switch remains visible but disabled, and the server rejects a direct Project
mutation. The higher-precedence Project fallback is also unavailable if its
physical destination escapes the active location through a symlink/junction; it
must never edit an ancestor/shared file to implement a location-local override.
Missing fallback documents are created only by an explicit mutation.

Global rules can be overridden by later project rules. Built-in OpenCode entries
remain in the authoritative snapshot without user activation controls. An exact
disabled ID remains available even when it is absent from `plugin.list`, so it
can be re-enabled. A plugin hidden only by a broad wildcard gets a control once
runtime inventory, an exact configured rule or a verified managed descriptor reveals its ID. Disabled synthesized
controls retain OpenCode's reserved `opencode.*` identity, so builtins stay hidden
when `plugin.list` omits inactive entries.

A scope without an explicit matching rule inherits predictably in the compact
switch UI: Global uses OpenCode's enabled baseline, while Project inherits the
resolved Global state. A Project override therefore never changes the displayed
Global switch, even though it controls the plugin's final effective state.
Object-form sources remain source records, but are also replayed as ordered add
operations when they re-enable an already resolved plugin, matching OpenCode's
native supervisor. Relative and `file://` local declarations are correlated with
the resolved runtime entrypoint before that ordered replay.

Changing sessions inside one worktree reuses its snapshot, and the first read
waits until the Plugins surface is visible and expanded. Location-scoped plugin events mark
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
operation. Activation rules and source declarations use the same primitive:
source add/remove runs through `PluginControls.editConfigDocument`, whose awaited
callback edits the freshly read document (`plugin-source-document.ts` holds the
spec validation, package identity and removal edit). The pinned connection is rechecked before committing its edit.

`PluginControls.read` supplies `targets[].expectedRevision` only when the displayed daemon plugin entries
match the raw writable document, including full options. The opaque HMAC binds the workspace, canonical
Location, scope, logical/physical destination, selected WSL distro, current authenticated client identity,
document existence, native mode, BOM and complete text. Its random key and connection tokens stay private
to the service instance; configuration values stay out of the token and diagnostics. Mutation-produced
overlays acquire removal authority through reconciliation. `PluginSources.remove` requires this token;
`editConfigDocument(..., signal?, strictDocuments?, expectedRevision?)` compares it inside the existing mutation queue before
editing the freshly read document. Changed options at the same source/index, content, destination, mode or
connection refuse with `stale` and require a fresh selection/confirmation.

1. Read at most 4 MiB and require valid UTF-8 JSON/JSONC with one array-valued
   `plugins` key.
2. Resolve physical file destinations, including symlinked parent directories,
   and fail closed on malformed content, invalid plugin entries, circular links,
   or filesystem errors.
3. Edit with `jsonc-parser`: append only the requested exact `id`/`-id` rule or
   source spec string, or delete exactly one verified element. Comments, source
   objects, options, unknown keys, ordering, indentation, line endings, and a
   UTF-8 BOM are retained.
4. Serialize in-process mutations and hold a per-target interprocess lock across
   the final source verification and atomic rename. The lock carries an owner
   nonce verified immediately before the rename, so a stalled owner fails with
   `conflict` instead of overwriting a successor. A stalled file/symlink lock
   is reaped like a stale directory. A same-directory temporary file is synced
   first with the source mode explicitly restored after creation (host `umask`
   cannot tighten it); an external mode-only change is a conflict. Crash
   leftovers (`*.tmp` with per-process random names) are never read and remain
   inert; locks self-heal after 30 s. Byte/mode comparisons and nonce verification detect conflicts before
   the atomic rename. An external editor can write after the last comparison; the native filesystem
   replacement boundary applies to that final interval. Never promise conditional atomic replacement
   against non-participating editors.

WSL performs bounded inspect/read/create/chmod/sync/rename operations inside the
selected distro, retaining native modes such as `0600`. Shell helpers prefer portable fallbacks (`realpath`,
`sync`, `sha256sum`/`shasum`); Ubuntu remains the tested distro for minimal busybox
images. A toggle uses five unpooled `wsl.exe` starts (`inspectMany`, `load`,
`prepare`, `commit`, `dispose`); batch edits add explicit source/nonce verification
while both physical locks remain held. Filesystem latency remains visible before
daemon RPCs on slow hosts.

Never add a server display cache: every read and mutation reissues `config.get` +
`plugin.list` (plus one `location.get` for session-scoped locations) and
re-resolves targets, so snapshots always reflect current daemon state. Expensive
work is bounded: one snapshot base per mutation with positional overlays,
per-write-target mutation queues, and UI-side coalesced trailing refreshes.

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
lag instead appends the requested exact rule.

The connection generation is rechecked after discovery, before file preparation,
and again immediately before the atomic rename. Mutations also enter the active
worktree's deletion fence, so worktree removal drains an admitted write and a
blocked write fails closed. The route never accepts a caller-provided config path
and refuses foreign locations, malformed runtime inventory, or IDs absent from the
authorized runtime/configured inventory.

Native settings share `readConfigDocuments` / `editConfigDocument`; the editor
receives the current acquired configuration entries and native target position.
Missions settings request strict document acquisition, rejecting JSON and JSONC
coexistence in the same layer; plugin source edits retain the selected target
and propagate their deadline signal through acquisition and commit. Missions'
`native-experimental-settings.ts` edits only schedules/depth, retaining explicit
companion values. Depth writes preserve inherited schedule activation when the
local block omits its flag. Schedule activation materializes inherited depth
only when creating a whole-block override. Adding schedules to an existing block
keeps its effective depth choice, including the native default selected by an
absent depth key. Existing file-byte expectations and the
physical replacement lock fence concurrent writers.

`editConfigDocuments` prepares and verifies each required target before its first
rename. The Missions activation journal records the plan before effects, an
attempt before each rename, and each exact acknowledgement. A read-only target
or conflicting source refuses preparation; a partial global/project write keeps
its durable receipts and preserves the successful write. An uncertain attempted
write is reconciled only by its exact result bytes, preserving a later explicit
OFF. `native-schedule-settings-activation.ts` acknowledges readiness only after
the native global and effective Location blocks both enable schedules, within
ten seconds, under the acquired connection and host/distro authority.

OpenCode watches these configuration roots. Never restart the daemon or report a
successful file write as an active plugin: the mutation response publishes the
durable configured state, and `config.updated` and `plugin.updated` trigger
fenced, coalesced refreshes until runtime state catches up.

## Runtime qualification

Activation requires only the global minimum in `opencode/runtime-support.ts`.
Read or discovery failures leave controls unavailable and never fall back to
guessed paths.

## Validation

- `scripts/test-plugin-runtime-native.mjs <absolute-cli>` runs an isolated native daemon and
  verifies the reported local source against the generated shim or referenced bundle and the
  session-pruning payload descriptor against the exported plugin ID.
- Managed provenance, descriptors, retained storage, Windows/WSL paths and link/integrity refusal:
  `desktop-plugin-managed.test.ts`; absent-runtime rules and scoped recovery: `plugin-controls.test.ts`.
- JSONC preservation, malformed input, optimistic conflict, and atomic replace:
  `plugin-control-document.test.ts`
- spec validation, package identity, append and exact removal (comments, CRLF,
  BOM, object entries, stale index): `plugin-source-document.test.ts`
- source add/remove ownership, scope availability, duplicates across scopes,
  rule retention, inventory correlation and the strict route:
  `plugin-sources.test.ts`
- confirmed-document revisions, full-options and connection replacement refusals, ordinary native removal
  without catalog/status/binding/census IO, and durable removal versus runtime state: `plugin-sources.test.ts`.
  `node --import tsx scripts/test-plugin-removal-native.mjs <absolute-cli>` qualifies the real authenticated
  HTTP route with an active native binding, unchanged Q8 and application/user files, and debug/trace scans
  inside a private runtime. The source and package-cache qualification also runs `test-plugin-sources-native.mjs`.
- native WSL path operations and permission retention, including source
  add/remove: `plugin-control-document-wsl.test.ts` (set
  `CODENOMAD_TEST_WSL_PLUGIN_CONTROLS` to a distro for the native fixture)
- real daemon loading: `node --import tsx scripts/test-plugin-sources-native.mjs
  <absolute-cli>` adds a registry spec (active, version), an unknown package
  (failed with `ref`), refuses a duplicate and a stale removal, and removes the
  source (unloaded, cache kept). `withProductRuntime(..., { registry })` points
  the isolated daemon's installs at the loopback fake npm registry of
  `scripts/fixtures/fake-npm-registry.mjs` through `npm_config_registry`; it
  answers 404 for unknown names, so package fixtures never reach the public
  registry.
- pending window, removal tracking and removable targets:
  `packages/ui/src/stores/plugin-sources.test.ts`
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
- package check/update menus, one native request per target and pending state
  across hiding: `packages/ui/tests/browser/plugin-packages.test.ts`
- Add window (Global default, Project warning, refusals), Installing until the
  inventory reports, version/update/ref tooltips, Remove items, the pending
  timeout with an injected clock and the GUI notice:
  `packages/ui/tests/browser/plugin-sources.test.ts`

## Agent conventions

- Recognise managed plugins on the server through validated installer entries and content-addressed payload locations. All ordinary UI paths exclude `managedBy: "codenomad"` records; surface managed failures only in the compact warning and its on-demand details, with scoped Re-enable for disabled entries.
- Present Global and Project as separate per-plugin columns so every mutation has an explicit scope. Cache display snapshots by instance and worktree directory, and refresh them only while the plugin surface is visible.
- Keep the Plugins surface minimal: plugin names, one compact row-action icon when applicable, and Global/Project switches. The row menu (`components/plugin-row-actions.tsx`, memoized item descriptors) names each exact operation: package check or update with its native target, **Remove from Global/Project** per removable declaration, and Refresh for unconfirmed sources; a single package item keeps its package icon. Put source/status/version/target details, failure `ref`s and the shared-cache effect of package updates in hover/focus tooltips. Do not add general descriptions, inline explanations, target footers or success commentary; source rows carry only a short state label (**Installing**/**Not confirmed**). The compact Refresh and Add icons occupy the name-column header; Refresh spins during loading and refresh; automatic display updates follow native events, reconnects and visible demand. Package writes use native inventory-validated targets, never plugin IDs; styles live in `styles/components/plugin-package-action.css` and `plugin-source-add.css`, and menu chrome is shared with `action-overflow-menu`.
- The Plugins Add menu (`components/plugin-add-menu.tsx`) uses stable item descriptors for **Add an integration…** and **Add a plugin…**. The integration catalog window (`integration-catalog-window.tsx`) uses shared window primitives, overlay surface, an upper-right close button and reviewed catalog IDs through `pluginSourcesStore.installIntegration`; native integrations lock the focusable scope selector to Global. Confirmation uses the shared 600 ms guard. Installation hints and reconciliation use the existing source store.
- The Add plugin window (`components/plugin-source-add.tsx`) is a transient `.window-*` popover without a close button: a `--surface-field` spec input, the native scope select (Global default, Project disabled when unavailable), the trust sentence and the Project warning. It closes on success and keeps refusals inline; it never announces an active plugin.
- Recognized integrations keep their Plugins row alongside their own Status section. Both use `PluginActivationSwitch` and `PluginRowActions` with shared mutation/in-flight state. Application installation and conversation attachment actions belong to the integration section. Source ambiguity labels its Plugins row **Non-conforming** and suppresses its integration section. Supplemental integration details use `InfoPopoverButton` or tooltips, with localized terse labels.
- Plugins that fail before exporting an ID remain visible by their native package target or local path, with failure details in the name tooltip; package entries retain check/update actions. Do not fabricate plugin IDs or activation switches for these entries; reconcile them into ordinary rows once native loading succeeds. Managed failures belong to the attention block.
