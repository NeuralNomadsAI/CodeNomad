# Agent memory contracts

## Entry model

`packages/server/src/memory/model.ts` owns the shared server contract:

- Scopes: `global` (60 entries) and `project` (200 entries).
- Types: `fact`, `preference`, `reference`.
- Markdown header: `id`, `title`, `type`, `createdAt`, `updatedAt`, `sessionId`.
- Content: `text`, preserved by validation; at most 2,000 Unicode code points.
- Title: nonblank, single-line, at most 60 Unicode code points.
- IDs: one portable filename segment, 1–128 ASCII letters, digits, underscores
  or hyphens, beginning with a letter or digit; Windows device names are rejected.
- Dates: ISO datetimes with a timezone; session provenance is required.

`validateMemoryContent` validates mutation input. `validateMemoryEntry` validates
the complete header and content; storage readers pass `malformed` as the error
code. Unknown fields fail validation. `MemoryError` carries one of `disabled`,
`full`, `conflict`, `invalid`, `unreadable`, `git_unavailable`, `malformed`, and an
optional title list for capacity errors. UI callers translate codes and keep
underlying filesystem, Git and configuration errors private.

## Project identity

`memory/project-identity.ts` resolves an already-authorized session directory.
The server owns this input. An identity establishes the memory namespace;
directory authorization remains with workspace/session ownership.

The selected remote is `origin`, otherwise the lexically first remote name.
`forge/remote.ts` supplies one shared validated parser with separate repository
and forge policies. Repository normalization accepts HTTP(S), SSH, Git and
SCP-style network addresses, strips credentials, query, fragment, surrounding
slashes and `.git`, lowercases the host, preserves repository path case and every
explicit port, and produces `authority/repository-path`. Equivalent SSH/SCP and
HTTPS addresses without explicit ports share an identity.

An absent or unparseable selected remote uses the shared repository's physical
root: the parent of its common `.git` directory, or the physical common Git
directory for bare/separate layouts. Subfolders and linked worktrees therefore
share the local fallback. A verified non-Git directory uses its own real path.
Other Git/discovery failures return an error. Windows host fallback paths are
case-folded. WSL executes Git and `realpath` in the selected distro and preserves
Linux path case; local fallbacks include the case-folded distro name. Both WSL
UNC spellings resolve through that execution-host adapter.

The namespace is SHA-256 of `remote:<normalized-remote>` or
`local:<canonical-local-path>`. Only the hash and source kind leave the resolver;
remote credentials and physical fallback paths stay private. Callers resolve
again for authoritative operations so remote edits and session moves take effect.

## Optional native instructions capability

`memory/instructions-capability.ts` reads the authenticated `/openapi.json`
through the acquired connection and the bounded shared contract reader. It
recognizes GET on
`/api/experimental/session/{sessionID}/instructions/entries`, plus PUT and DELETE
on that path's `/{key}` item. Recognition uses the API contract independently of
the runtime version label.

| Result | Consumer policy |
| --- | --- |
| `supported` | Admit memory integration after its other ownership and enablement checks. |
| `unsupported` | Keep memory inactive silently and preserve the saved preference. |
| `authentication` | Recover connection authentication; retain the preference. |
| `unavailable` | Treat the current read as unavailable and requalify on later demand; retain the preference. |

Only a valid authenticated OpenAPI document establishes absence. HTTP 401/403
are authentication failures. A discovery 404, transport failure, timeout,
oversized response or malformed document is unavailable. Concurrent probes share
one read per connection. Supported/unsupported results are retained with weak
connection ownership; failures are released. A replacement connection qualifies
anew, and every caller checks that its connection is still current before and
after awaiting. The probe performs only a read.

## Native child-session admission

Native instruction entries belong to their own session. The qualified
integration point for native children is an awaited
`ctx.session.hook("prompt", async event => …)` registered during plugin setup.
The callback uses `event.sessionID`, awaits the server bridge's current
preference, owned session location and readable titles, then awaits
`ctx.session.instructions.entry.put` or `remove` for `codenomad.memory` before
returning. Hooks run after Location plugin activation and before prompt inbox
admission. Preparation failure rejects that admission before a model call.

Register the hook together with the plugin's activation lifetime. Preserve other
instruction keys. Resolve each child's own server-authorized location rather
than copying a parent's project identity or title list. Missing instruction APIs
use the silent optional-capability policy above. Native synthetic/control inputs
have their own admission paths; integrations using them must synchronize their
named entry at their corresponding owned boundary.

The first model request includes the named entry in the assembled system
instructions. On resumed sessions native instruction changes also reach the
model as context-update notices at the next step boundary. Consumers follow
these native update semantics.

## Validation

```text
node --import tsx --test packages/server/src/memory/*.test.ts packages/server/src/forge/forge.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
node --import tsx scripts/test-memory-instructions-native.mjs <absolute-opencode-executable>
```

Set `CODENOMAD_MEMORY_TEST_WSL_DISTRO` to a disposable-test-capable local distro
and run `node --import tsx --test --test-name-pattern="real WSL" packages/server/src/memory/project-identity.test.ts`
separately to include the real WSL Git/worktree test. The native instructions regression
uses a private authenticated daemon, private home/configuration/database and a
loopback synthetic provider. It checks session-local parent entries, first-call
child instructions through the awaited hook, resumed-child updates, removal of
only the memory key and rejection of failed preparation with an empty inbox. Its plugin bundle uses
`packages/server/scripts/native-plugin-build.mjs`.

## Agent conventions

- Keep entry validation, project identity, storage, session admission and UI
  projections in their own narrowly scoped modules.
- Capacity and duplicate replacement are storage decisions; the shared limits and
  validation contract remain authoritative for every mutation entry point.
- A missing storage folder represents an empty scope. Unreadable or malformed
  scope data must remain explicitly unavailable.
- Keep external memory as explicit `reference` entries. Never discover, read or
  import other agents' memory files automatically.
