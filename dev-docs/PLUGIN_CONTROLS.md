# OpenCode V2 plugin controls

The Plugins surface adds and removes plugin source declarations
(`opencode/plugin-sources.ts`, `stores/plugin-sources.ts`), toggles plugin
activation per scope, shows each plugin's version and update availability, and
runs native package check/update (`stores/plugin-package-actions.ts`). Plugin
options, local-path sources and package installation itself stay with OpenCode:
CodeNomad writes the declaration and OpenCode resolves, installs and loads it.

Git package rows show the installed manifest version, or a seven-character commit
when unavailable; details retain the full commit. The presence-scoped
`codenomad.plugin-versions` RPC reads only native inventory Git targets (64 maximum),
uses the daemon's read-only `@opencode/Npm.resolve` capability and reads at most
64 KiB of each regular, single-link `package.json`. Its installed revision must
match the displayed native revision. The private service key, callable resolver
and returned directory/revision are checked at runtime; missing capability,
malformed metadata or the two-second deadline leaves the short commit.
Native package checks and updates retain their target and commit authority.

## Source declarations

`POST /api/workspaces/:id/plugin-sources` (`{ location, scope, spec }`) appends
one string entry at the end of the scope's `plugins`; `DELETE` (`{ location,
scope, target, entryIndex, expectedRevision }`) removes one source with its plugin's
rules, or (`{ location, scope, pluginId, expectedRevision }`) an orphan ID's rules. Both routes are strict, map
errors like the activation route and add a stable `code` (`invalid-spec`,
`local-path`, `plugin-id`, `duplicate`, `stale`, `timeout`, `global-only`, `dependent-rule`).

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
  still declares `target` (a string, or an object's `package`) and that the snapshot
  of the freshly read document reads it as a source; otherwise `stale` (409). The same
  edit re-evaluates, in the [applied order](#applied-order) without that source, every
  string entry the snapshot reads as an exact rule of the source's `pluginId` in that
  document: a bare `id` is deleted unless a verified definition still precedes it (it
  would otherwise be a package spec OpenCode installs from the registry), and a `-id` is
  deleted only when the [loader proof](#loader-proof) shows no other loader is left;
  otherwise it stays and its row can be removed later. In every other document applied at the
  requesting location, a bare `id` that a verified definition preceded only through the
  removed source would become a package spec too: it is deleted from the location's other
  writable target in the same request, and anywhere else (inherited, inline or other
  documents) it refuses the whole removal with `dependent-rule` (422). Wildcards,
  prefixes, other plugins' rules and `-id` rules of other documents are never touched.
  A source without `pluginId` (disabled, failed before exporting an ID) keeps its rules.
  Each result must parse to its original minus exactly those elements, and OpenCode's
  package cache is never touched.
  `PluginControls.editPluginDocuments` performs the request: it holds the Global then the Project queue, checks the
  confirmed revision of the source's document, reads every writable target and prepares (locks in physical path
  order) and verifies each changed file before the first rename, so a refusal or failed check writes nothing.
  Commits follow safety order: dependent cleanups first, the source's document last, so a failure between renames
  leaves every remaining bare `id` after its definition. Locations that are not open (other projects sharing
  the Global document) cannot be enumerated: a bare `id` in their Project documents is not re-checked.
- **Orphan rules**: a control is `orphan` when it has no runtime entry, verified descriptor
  or builtin status and the [loader proof](#loader-proof) shows nothing can load its ID. Its
  row's **Remove from Global/Project** (per writable scope holding its exact rules) sends
  `pluginId`; the server recomputes `orphan` with the full proof inside the mutation lock and
  deletes those rules alone. Rule-only removal is refused for any other ID. An orphan row has no
  Global/Project switches. Reads list discovery only when some control lacks a runtime entry,
  descriptor and builtin status; without a certain listing (WSL, read error) no control is orphan.
- **Loader proof**: one predicate (`anotherLoader` in `plugin-controls.ts`) decides every
  removal that deletes a `-id`: source removal and rule-only removal of an orphan. A loader
  is possible when another document declaration exists (same `pluginId`, target or package
  identity), any declaration lacks an exported ID (it may define any ID), an inventory entry
  reports the ID and is not the removed source (whatever its path), or a discovery child may
  load it. The immediate children of the reported plugin(s)/ folders are listed once
  (`plugin-discovery-loaders.ts`, at most 256 per folder and per child folder, read-only); a
  child is excluded only when native discovery would skip it or it maps to inventory entries
  or a verified descriptor of other IDs only. An inventory entry maps to a child only when its
  path is that child's single selected entrypoint (`discoveryEntrypointOf`, as named or after
  resolving links and junctions); another module of the child (an `index` behind a `server`,
  a nested plugin) or an uncertain selection leaves it unclassified. A
  listing that is not certain (unmapped path, read error, too many children, WSL) counts as
  a possible loader. Activation deletes `-id` rules only to perform a requested enable (or
  while replacing them with a disable), so it needs no proof.
  Source removal is independent of catalog, family or binding count.
  The trusted Cancel-first confirmation names the plugin and exact scope, warns of interrupted availability
  and connections (including other projects for Global), and enables its scoped removal action after 600 ms.
  Unsent consent expires after 120 s and is revoked by navigation, invalidation or disconnection.
  Cancellation and expiry perform no mutation. The captured request is sent once; uncertain responses
  reconcile actual configuration through the existing invalidation/read path before any fresh user action.
   An integration's row menu offers application install/update when a fresh active native integration reports
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
  `PLUGIN_SOURCE_PENDING_TIMEOUT_MS` (120 s) bounds that window: a configured source still
  absent is `unconfirmed` (**Not confirmed**, with a Refresh action). `plugin.list`
  omits disabled plugins and exposes no package-to-ID link for them, so a disabled
  package with an exact `-id` rule shows two rows: its ID row with switches, and
  its unconfirmed source row carrying the Remove items. Removing that source leaves the
  ID row orphan, with its own Remove items.
- **Correlation**: snapshot sources carry `pluginId` when runtime inventory or a verified
  managed installation associates their source, so Remove items attach to ordinary plugin rows. Each declaration is
  classified first, with OpenCode's rule (`plugin/module.ts`): a target that is absolute after `file://` and `./`/`../`
  resolution is local, anything else a package. A package source is associated only by its exact native target. An
  explicit local declaration is associated only through a verified descriptor or the one local resolver (`declaredEntrypointOf`, built on the same `selectedEntrypoint` as discovery):
  native loading drops a declared file and resolves a declared folder `server` before `index`, so an inventory entry
  identifies the declaration only when its path is that single selected entrypoint, as named or after resolving links.
  Containment, a sibling module, several IDs at that entrypoint or an uncertain selection leave it without `pluginId`:
  it then counts as a possible loader of any ID and never authorizes a bare write. Through WSL (no host listing) local
  declarations stay unidentified. No lookup by raw target string crosses the classification: the inventory's target map
  holds package targets only, and the Plugins surface treats a declaration as loaded or attaches its Remove items only
  by `pluginId` or an exact package target, so an unidentified local declaration keeps its own row. A string or object
  entry whose exact target `plugin.list` reports as a package is a source at its first declaration, even when an
  earlier rule names the same ID, so a failed package keeps its Remove items. A row offers removal only
  for declarations in a scope's own write target; inherited, inline and other
  documents are shown, never edited.

## CodeNomad-managed plugins

The server marks records `managedBy: "codenomad"` only after validating the installer-generated
entry and its content-addressed payload location. Recognition parses the exact generated
`plugins/codenomad-<feature>.ts` shape, used by `session-pruning`, `automation`, `missions` and `memory`:
the lifecycle marker, generated `desktopPlugin` import/call shape, presence directories and
`<sha256>.mjs` payload must agree. Missions' provider/runtime artifact descriptors follow the
installer's generated shape. Validated storage retained outside the default data path remains
recognisable; paths use the daemon's dialect, including WSL's Linux file URLs and paths.
WSL publication and recognition translate those paths through the selected distro for
host filesystem IO. The reserved WSL UNC redirector may report device zero for both
pathname and handles: independent handles must still agree on a nonzero inode and size,
with regular single-link files, stable bounded reads and the payload's SHA-256 verified.
Payload mapping translates its parent directory and preserves the exact basename, so file
links remain detectable instead of being dereferenced by path translation.
Configuration-document reads, permissions and mutations use native distro IO.
Never classify a plugin by its display name, ID or a `codenomad` prefix alone. A third-party
homonym retains its ordinary controls.

The right panel's [Missions gesture](MISSIONS.md#activation) uses the existing
activation mutation with a managed-identity requirement and an exact Global rule.
Managed attention omits a Missions disable decided by the exact Global
`-codenomad.missions` rule. Other disables retain scoped **Re-enable**.

The per-feature build scripts emit a minimal descriptor on the runtime payload's first line:
`// CodeNomad plugin IDs: ["..."]`. These IDs are inside the SHA-256-verified payload bytes.
Detection reads them generically; every new feature builder must emit its actual exported IDs.
The current builders export `codenomad-session-pruning`, `codenomad.automation`,
`codenomad.missions` and `codenomad.memory`. The descriptor supplies IDs for correlating absent runtime entries with
exact or wildcard activation rules. Descriptor-less generated installations remain recognisable
by the validated source when the runtime reports them; synthesising an absent ID requires the
payload descriptor. Never add an ID/name allowlist or execute the payload during discovery.
Qualification follows the consumed native contracts without a daemon-version allowlist.

The UI excludes managed records from every ordinary plugin row, activation switch, package
check/update action and source-removal path. A compact warning above the Plugins list exposes
only managed plugins that are disabled, failed or loading-unconfirmed. Each warning row has
an `InfoPopoverButton` with available native error/ref details. Only a disabled row offers
**Re-enable**, through the existing activation mutation: it removes the exact disabling rule when that
alone re-enables the plugin, otherwise it replaces it with the positive exact ID, keeping all unrelated
configuration. Use the disabling rule's Global/Project
scope when writable, otherwise the writable Project override. Native rules still determine
precedence. Keep the warning until a fenced inventory refresh confirms an active runtime
entry; a durable write alone leaves it visible. Native events and the existing Refresh action
drive reconciliation. Never restart OpenCode automatically.
Concurrent mutation/read reconciliation retains the newer runtime and provenance while applying
the durable activation rules. A confirmed native failure keeps its warning and details available.
Status and details distinguish Global, Project, inherited/external and virtual rule origins;
the Re-enable action names its writable destination independently of that origin.
Virtual origins remain visible in details when the native rule has no filesystem path.

## V2 contract

OpenCode applies plugin entries in configuration order. `-plugin.id` disables
an ID, `plugin.id` later re-enables it, `*` matches all plugins, and `prefix.*`
matches an ID prefix. Every string without `-` is one ordered add operation: it selects plugins only
when it matches a plugin ID already defined or loaded earlier in that order, or is `*`, `prefix.*` or
`opencode.*`; otherwise OpenCode loads it as a package (an npm install for a bare name). A lone `plugin.id`
whose package has not loaded yet is therefore fetched from the registry (`packages/core/src/config/plugin/source.ts`
and `packages/core/src/plugin/supervisor.ts` in OpenCode). Source declarations remain in place when an
activation rule is written.

### Applied order

`opencode/plugin-activation-order.ts` models that order for every mutation. Builtin, SDK and directory-discovered
plugins (including verified CodeNomad descriptors) are defined before every document; documents then apply in
`config.get` order (Global before Project), entries in array order. `plugin.list` gives no discovery origin, only a
local plugin's resolved server entrypoint, so CodeNomad mirrors native discovery (`plugin/source-directory.ts`,
`plugin/host.ts`): it examines only the immediate children of the `plugin/` and `plugins/` folders of each
configuration directory `config.get` reports, a `.ts`/`.js` file child loading as itself and a directory child
through `Host.resolve`, `server` before `index`. One function, `discoveryEntrypointOf` in
`plugin-discovery-loaders.ts`, returns the child's single selected entrypoint for both positive writes and the loader
proof's child mapping: the file child itself, or the one `server.<ext>` candidate (else the one `index.<ext>`) with a
Node-inferred extension (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs`) that is a regular file resolving
inside the folder (relative paths are checked by whole `..` segment, so internal names such as `..entry.js` stay
inside). The Bun resolver has its own extension order and directory rules, so a selection is certain only when both
runtimes agree on the exact name. A child is skipped only on proof: a dangling link, a file child without a
`.ts`/`.js` name, an entry that is neither file nor directory, or a folder with no entry whose name is `server` or
`index`, or starts with `server.` or `index.`, in any letter case (case-insensitive file systems resolve
`Server.js`). Every doubt leaves the child unclassified: a read error, a candidate group other than exactly one
exact-case `server.<ext>` (else `index.<ext>`), a candidate that is not a regular file, or an entrypoint resolving
outside the folder. Write decisions (activation and removal, inside their mutation lock) count a reported local
entry as discovered only when that selection is exactly its path, as named or after resolving links, so a deleted
folder or a `server` module taking precedence over a reported `index` defines nothing. Without a host listing (WSL)
nothing is verified and the bare write is refused. Display reads keep the cheap shape check
(`discoveryEntrypointShape`). Nested modules, package `main`, `server/index` and symlinked real paths never count, and
any other undeclared inventory entry (a removed declaration the daemon still reports while it reloads) defines
nothing. Each
add carries the ID it verifiably defines: the runtime reports that exact ID for that source, or a verified managed
descriptor. `-x` disables only plugins defined before it, and an add selects only plugins defined before it. The
snapshot classifies each positive entry the same way: it is an activation rule only when a definition precedes it,
never because an earlier `-id` names the ID, and otherwise a source declaration (a package spec).

- **Uncertainty**: wherever the model cannot prove a fact, it refuses positive bare writes and keeps negative `-id`
  rules, which install nothing.
- **Safe positive rule**: a bare `id` at a position is written only when a verified definition precedes it, or the
  ID is a reserved `opencode.*` selector. CodeNomad appends at the end of the target document, so a definition in a
  later document (Global rule, Project declaration) never qualifies.
- **Requested state**: a scope's state evaluates the documents through that scope's last one, for that ID only,
  wildcards included. Without a verified definition in that prefix the ID is assumed defined first, so every rule
  that could apply to it does. An activation succeeds only when this state is the requested one; a disappearing row
  keeps the wildcard state it evaluates to.

The native plugin API offers `plugin.list`/`plugin.check`/`plugin.update`, and the
pinned client's `config.update` accepts only its declared preference fields, so
activation is one narrow, authenticated configuration-file mutation.

## Authority and precedence

UI plugin controls and source requests select `backendOf(instanceId)` and send
the raw workspace ID from `parseInstanceKey`. Native package actions, MCP reads
and toggles, and skill discovery use the owning backend's root proxy client.
Captured attachment signals fence queued work, late publications and dependent
refreshes; completed operations release their own busy state. Missing owners and
backend errors fail closed, while local requests retain their existing wire format.

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
their selected entrypoint (see **Correlation**) before that ordered replay.

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
source add runs through `PluginControls.editConfigDocument`, whose awaited
callback edits the freshly read document, and removal through `PluginControls.editPluginDocuments` over the
location's writable documents (`plugin-source-document.ts` holds the spec validation, package identity and removal
edit). The pinned connection is rechecked before committing each edit.

`PluginControls.read` supplies `targets[].expectedRevision` only when the displayed daemon plugin entries
match the raw writable document, including full options. The opaque HMAC binds the workspace, canonical
Location, scope, logical/physical destination, selected WSL distro, current authenticated client identity,
document existence, native mode, BOM and complete text. Its random key and connection tokens stay private
to the service instance; configuration values stay out of the token and diagnostics. Mutation-produced
overlays acquire removal authority through reconciliation. `PluginSources.remove` requires this token;
`editPluginDocuments` (like `editConfigDocument(..., signal?, strictDocuments?, expectedRevision?)`) compares it inside the
mutation queues before editing the freshly read documents. Changed options at the same source/index, content, destination, mode or
connection refuse with `stale` and require a fresh selection/confirmation.

1. Read at most 4 MiB and require valid UTF-8 JSON/JSONC with one array-valued
   `plugins` key.
2. Resolve physical file destinations, including symlinked parent directories,
   and fail closed on malformed content, invalid plugin entries, circular links,
   or filesystem errors.
3. Edit with `jsonc-parser`: append one source spec string, delete one verified source element with its
   plugin's verified exact rules (or an orphan ID's rules), or write one activation. Element deletions take their
   ranges from the parse tree (`deletePluginEntries`), which keeps compact arrays valid. An activation tries, in
   order, deleting the target document's exact `id`/`-id` rules for that plugin, deleting them and appending the
   requested rule, and appending it, and writes the first that reaches the [requested state](#applied-order) while
   any bare `id` it writes satisfies the safe positive rule. When none qualifies the route refuses with `forbidden`
   before any write. Entries the snapshot reads as source declarations (a package named like its ID), broad
   selectors and other files are never deleted, and a placeholder or watcher-lag projection (not no-op safe) only
   appends. Each deleted entry is re-verified in the read document. Comments, source
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
lag instead appends the requested exact rule without deleting earlier ones.

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
depth editor writes `experimental.subagent_depth` alone, and
`native-experimental-settings.ts` refuses a block whose Missions settings are
malformed or duplicated. Existing file-byte expectations and the
physical replacement lock fence concurrent writers.

Missions schedule activation reads these documents and writes none. A discovered
explicit OFF or native environment OFF refuses preparation; an enabled Location
receives a ready proof. `native-schedule-settings-activation.ts` acknowledges
readiness after the effective native Location setting reads ON,
under the acquired connection and host/distro authority.

OpenCode watches these configuration roots. Never restart the daemon or report a
successful file write as an active plugin: the mutation response publishes the
durable configured state, and `config.updated` and `plugin.updated` trigger
fenced, coalesced refreshes until runtime state catches up.

## Runtime qualification

Activation requires only the global minimum in `opencode/runtime-support.ts`.
Read or discovery failures leave controls unavailable and never fall back to
guessed paths.

## Validation

- Backend-owned plugin controls/sources, native package actions, MCP reads/toggles
  and skill discovery, missing owners, refusal handling, local wire parity and
  attachment revocation: `packages/ui/src/lib/backend-plugin-routing.test.ts`.
- `scripts/test-plugin-runtime-native.mjs <absolute-cli>` runs an isolated native daemon and
  verifies the reported local source against the generated shim or referenced bundle and the
  session-pruning payload descriptor against the exported plugin ID.
- `node --import tsx scripts/test-plugin-git-version-native.mjs <absolute-cli>` qualifies
  the native read-only resolver, installed Git manifest version, commit correlation and
  native check/update behavior in an isolated cache.
- Managed provenance, descriptors, retained storage, Windows/WSL paths and link/integrity refusal:
  `desktop-plugin-managed.test.ts`; absent-runtime rules and scoped recovery: `plugin-controls.test.ts`.
- `CODENOMAD_TEST_WSL_PLUGIN_CONTROLS=Ubuntu` enables the real Linux-filesystem/UNC
  publication, recognition, tamper and link checks in `desktop-plugin-managed-wsl.test.ts`,
  alongside the native document suite in `plugin-control-document-wsl.test.ts`.
- JSONC preservation, malformed input, optimistic conflict, atomic replace, and rule replacement with
  re-verified deletions: `plugin-control-document.test.ts`
- rule replacement on toggle (no growth over repeated toggles, removal-only re-enable and disable, broad
  selectors, rules in another scope, source declarations named like their ID, managed re-enable), and the
  removal-only or refused enables of IDs without a preceding verified definition, wildcards left disabling, undeclared
  local inventory counted only at the entrypoint native discovery selects (nested plugins, deleted entrypoints, an
  `index` behind a `server` and ambiguous candidates refused), and an explicit local folder never defining a nested
  plugin's ID or a declared file defining one:
  `plugin-controls.test.ts`; the applied-order evaluator: `plugin-activation-order.test.ts`
- spec validation, package identity, append and exact removal (comments, CRLF,
  BOM, object entries, stale index, rules removed with their source, compact arrays): `plugin-source-document.test.ts`
- source add/remove ownership, scope availability, duplicates across scopes, rule removal with the source (active and
  failed plugins, wildcards, other plugins and scopes kept), rule retention for unknown IDs, bare names loaded as
  packages, rules kept for a failed ID-less package or a remaining declaration, a bare ID removed when it would
  precede the remaining definition, the Project's dependent bare ID removed with a Global source (or the removal
  refused for an inline document), the source document committed last under an injected commit failure, a disable
  kept while a plugin(s)/ folder still discovers the plugin (also through a junction to the declared folder) or
  another inventory entry reports its ID, one loader proof for orphan rows, rule-only and source removal (a
  disabled discovered file, an unidentified declaration), a discovery child identified only by its own entrypoint (a
  nested plugin's inventory leaves it unclassified) and only by the selected entrypoint (`server` before `index`), a
  folder skipped only on proof (`Server.js`, a linked entrypoint inside or outside the folder keep the disable), an
  explicit local declaration identified only by its own selected entrypoint (a nested plugin neither identifies it
  nor counts as the removed source's own entry), a
  bare name after its own `-id` read as a package,
  orphan rule removal and refusal,
  inventory correlation and the strict route:
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
  inventory reports, version/update/ref tooltips, Remove items (failed packages and switchless orphan rule rows included;
  an unidentified local declaration keeps its own row), the pending
  timeout with an injected clock and the GUI notice:
  `packages/ui/tests/browser/plugin-sources.test.ts`

## Agent conventions

- Recognise managed plugins on the server through validated installer entries and content-addressed payload locations. All ordinary UI paths exclude `managedBy: "codenomad"` records; surface managed failures only in the compact warning and its on-demand details, with scoped Re-enable for disabled entries.
- Serialization tests await the held mutation's worktree identity lookup before launching competing scopes. Target discovery performs asynchronous filesystem reads, so arrival order is observed explicitly; the independent scope completes while a second same-target mutation stays queued.
- Source-add deadline tests await admission of both parallel configuration reads and advance mocked timers through timeout and grace. Release and join the abandoned reads before checking durable bytes.
- Present Global and Project as separate per-plugin columns so every mutation has an explicit scope. Cache display snapshots by instance and worktree directory, and refresh them only while the plugin surface is visible.
- Keep the Plugins surface minimal: plugin names and versions, one compact row-action icon when applicable, and Global/Project switches. The row menu (`components/plugin-row-actions.tsx`, memoized item descriptors) names each exact operation: package check or update with its native target, **Remove from Global/Project** per removable declaration, and Refresh for unconfirmed sources; a single package item keeps its package icon. Put source/status/version/target details, failure `ref`s and the shared-cache effect of package updates in hover/focus tooltips. Do not add general descriptions, inline explanations, target footers or success commentary; source rows carry only a short state label (**Installing**/**Not confirmed**). The compact Refresh and Add icons occupy the name-column header; Refresh spins during loading and refresh; automatic display updates follow native events, reconnects and visible demand. Package writes use native inventory-validated targets, never plugin IDs; styles live in `styles/components/plugin-package-action.css` and `plugin-source-add.css`, and menu chrome is shared with `action-overflow-menu`.
- The Plugins Add menu (`components/plugin-add-menu.tsx`) uses stable item descriptors for **Add an integration…** and **Add a plugin…**. The integration catalog window (`integration-catalog-window.tsx`) uses shared window primitives, overlay surface, an upper-right close button and reviewed catalog IDs through `pluginSourcesStore.installIntegration`; native integrations lock the focusable scope selector to Global. Confirmation uses the shared 600 ms guard. Installation hints and reconciliation use the existing source store.
- The Add plugin window (`components/plugin-source-add.tsx`) is a transient `.window-*` popover without a close button: a `--surface-field` spec input, the native scope select (Global default, Project disabled when unavailable), the trust sentence and the Project warning. It closes on success and keeps refusals inline; it never announces an active plugin.
- A recognized integration has exactly one surface, its Plugins row ([integration rows](OPENCODE_INTEGRATIONS.md#ui-read-model)): display name, version, `PluginActivationSwitch` with its `integration` flag (the settings switch accent, `ACCENT_SWITCH_SX`, instead of the green plugin variant), and under it a state line that always says where the integration stands and acts when it can (install or update the application part, attach or detach the displayed conversation). Its `PluginRowActions` menu adds the connection line, documentation and application (re)installation before the ordinary items. Source ambiguity labels a Plugins row **Non-conforming** and attributes it to no integration. Supplemental integration details use tooltips with localized terse labels.
- Plugins that fail before exporting an ID remain visible by their native package target or local path, with failure details in the name tooltip; package entries retain check/update actions and their declaration's Remove items, while a failed local row never takes a declaration's Remove items (the declaration keeps its own row). Do not fabricate plugin IDs or activation switches for these entries; reconcile them into ordinary rows once native loading succeeds. Managed failures belong to the attention block.
- Plugins rows use the app's ordinary tooltips: the native `title` attribute (multi-line with `\n`) on names, the state line, switches and row actions, never Kobalte `Tooltip` or a custom tooltip surface. A row's details also go into a hidden element the row names through `aria-describedby` (`<name id>-details`), and every control keeps its `aria-label`, so keyboard and screen-reader users get the same text.
