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

Global rules can be overridden by later project rules. The UI reports runtime
inventory separately from configured sources and rules, and requires an
explicit Global or Project choice before enabling a write. An exact disabled
ID remains in the configured inventory even when it is absent from
`plugin.list`, so it can be re-enabled. A plugin hidden only by a broad wildcard
cannot be named safely unless the runtime or an exact configured rule reveals
its ID.

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

## Supported runtime families

The feature uses only `config.get` and `plugin.list`, which are already consumed
through CodeNomad's connection-scoped compatibility transport.

| Runtime family | Evidence | Activation write |
| --- | --- | --- |
| `0.0.0-beta-19271` | Installed historical declarations contain location-scoped `config.get`, `plugin.list`, `ConfigEntry.plugins`, and plugin source/state metadata. Legacy workspace identity is preserved by the location context adapter. | Local JSONC rule; no legacy mutation endpoint. |
| `2.0.3` | Historical stable declarations expose the same read shapes and ordered plugin entries. | Local JSONC rule. |
| `2.0.4` | Pinned server/UI declarations and official V2 plugin/config documentation. | Local JSONC rule. |
| `2.0.5` | Modern contract family with native evidence recorded in `OPENCODE_V2_COMPATIBILITY.md`. | Local JSONC rule. |

There is no release-number-only gate. Unknown runtimes must first pass the
existing authenticated OpenAPI contract recognition. Read or discovery
failures leave controls unavailable and never fall back to guessed paths.

## Validation

- JSONC preservation, malformed input, optimistic conflict, and atomic replace:
  `plugin-control-document.test.ts`
- ownership, WSL/host path authority, precedence, visibility of disabled IDs,
  serialization, and scope mutations: `plugin-controls.test.ts`
- strict CodeNomad route and error mapping: `plugin-controls.test.ts` beside
  the route
- cache sharing, retained snapshots, generation fencing, and trailing refresh:
  `packages/ui/src/stores/plugin-controls.test.ts`
- real Solid UI, full stylesheet, explicit scope, square controls, mutation,
  and native event dispatcher: `packages/ui/tests/browser/plugin-controls.test.ts`
