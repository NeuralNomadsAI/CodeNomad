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

## Local storage and Git transactions

`memory/store.ts` constructs `MemoryStore` from `ConfigLocation.baseDir`. The
server's listeners share this instance. Its lazily initialized repository is
`<baseDir>/memory/`, with `global/<id>.md` and
`projects/<projectId>/<id>.md`. Project IDs use the resolver's SHA-256 namespace.
Missing folders read as empty; invalid UTF-8, malformed or extra header fields,
duplicate YAML keys, filename/header mismatches, symbolic links and unreadable
files produce explicit scope errors. Storage bounds encoded files and journals
to 16 KiB and preserves Markdown content, including trailing whitespace and line
endings.

The server policy calls `mutate(namespace, decide)` to read a fresh scope and
choose `{ kind: "save", entry, result }`, `{ kind: "delete", id, result }` or
`{ kind: "none", result }`. The callback owns enablement, capacity, deduplication
and preservation of entry identity/provenance. Its decision and the resulting
commit share one repository-wide interprocess lock. `list` and `read` use the
same lock for existing storage; pristine empty reads leave the filesystem
unchanged. `read` resolves an exact ID first, then an exact title among safe entries.
`list` and `read` expose the agent-safe projection. `listForUI` returns every
entry with a freshly computed `flagged` boolean for human review.

Writes fsync a uniquely named temporary in the destination directory, then
rename over the target. A failed replacement preserves the target and removes
the pending journal. Before publication, an atomic `.transaction.json` records
the intended file operation and its unique transaction ID. A failed commit
keeps that journal, and later access completes the operation and its commit
before returning data. Interrupted deletions follow the same roll-forward
policy. Each accepted write has a commit, including identical content. Recovery
recognizes the transaction ID and tree at the current commit to avoid duplicate
history. Corrupt recovery data fails explicitly.

`memory/lock.ts` atomically publishes a populated `memory.lock/` directory next
to the repository. Its owner records a nonce, PID, native process-start identity,
hostname and platform. The shared `host-lifetime/process-identity.ts` adapter
qualifies the process generation: Linux boot ID/start ticks, Windows creation
ticks or the macOS native creation identity. The current process caches its own
qualified identity; failed qualification remains retryable. macOS execution uses
the bundled process-identity helper built by `build:host-helpers`.

Contenders wait up to 30 seconds for a matching live owner. A confirmed exit or a
different start identity proves that the recorded generation ended, including
when its PID belongs to another live process. Unknown process evidence and a
different execution host yield an explicit conflict while preserving ownership.
Records containing only a PID qualify for recovery after a confirmed PID exit.
After probing, the contender rereads the exact owner before recovery, fencing a
normal release and successor publication during the probe. Age remains only an
operation timeout; never use it to infer owner death.

Release verifies the nonce before each retirement attempt and retries Windows
sharing violations for up to 30 seconds. Atomic retirement frees the public name
before private-directory cleanup. Cleanup retries apply only to that private
directory; residual private artifacts leave future acquisition free. Recovery
keeps a nonempty `memory.lock.dead-<nonce>/` marker so concurrent recovery attempts
cannot move a successor's lock into the same destination. These small fencing
markers remain beside the repository and leave acquisition free.

`memory/git.ts` uses `runGitProcess` and `requireHostGit`. Missing host Git keeps
the shared `git_required` failure contract. Git commands explicitly name the
private repository and worktree, clear inherited `GIT_*` overrides, ignore
system/global Git configuration and use the local identity `CodeNomad Memory
<memory@codenomad.local>`. Template hooks, runtime hooks, signing, automatic GC,
fsmonitor and content filters are bypassed. Per-transaction indexes and Git
plumbing write exact bytes, commit and compare-and-swap the local branch;
the ordinary index is published after the commit. Unrecoverable Git metadata
or filesystem errors leave memory unavailable until the storage is repaired.

## Duplicate, capacity and safety rules

`memory/rules.ts` applies duplicate and capacity decisions inside the store's
locked mutation callback. `MemoryStore.save(namespace, content, sessionId,
enabled, id?)` checks the current enablement through the supplied synchronous
callback under that same lock. Successful saves return only `{ id, flagged }`
after the local commit. The lower-level `mutate` callback remains available to
owned policy consumers; it receives all stored entries, including flagged ones.

Titles compare after Unicode NFKC normalization, lowercasing, trimming and
whitespace collapsing. Exact title matches take priority. Otherwise distinct
significant text words use Jaccard similarity at a threshold of 0.75, requiring
at least four words on each side. `Intl.Segmenter` performs word segmentation
with a fixed `en` locale; its Unicode segmentation covers mixed-language text.
Stopwords from all ten UI languages apply together. Tokens must contain a Unicode
letter, excluding numbers while preserving names such as `node22`. The highest score wins; ties
resolve by ascending portable entry ID. Each save replaces at most one entry,
preserving its ID and creation time while updating content, time and session.

Explicit-ID edits preserve the selected entry and report `conflict` when
duplicate selection resolves to another entry. New entries at the exact 60/200 limits
produce `full`, with titles and a merge-or-delete instruction. Replacements
remain available at capacity. Flagged entries count toward capacity; the safe
save API includes only safe titles in its capacity diagnostics. Human clients
can inspect all titles through `listForUI`.

`memory/language-data.ts` contains stopwords and suspicious override,
safety-bypass and credential-exfiltration patterns for en, fr, de, es, he, ja,
ne, ru, tr and zh-Hans, plus role-spoofing markers. Both title and text are
checked after NFKC/case normalization and removal of invisible format controls.
Every read recomputes the flag from current file contents, so external edits
take effect immediately. Agent reads omit flagged entries entirely; human
review retains their content. Patterns are conservative heuristics: consumers
must continue treating all memory as untrusted data. Reference entries are
stored, compared and reviewed as literal text. Never resolve their URLs or
filesystem targets.

## Authorized HTTP operations

`memory/api.ts` owns the UI/tool operation contract and is re-exported by
`api-types.ts`. `POST /api/memory` takes `{ operation, context? }`; operations
are `list`, `read` with `query` (exact ID first, then title), `save` with `content`,
and `delete`. Every operation names `scope: global | project`. Project UI calls
carry the existing Preferences context as `{ workspaceId, directory? }`; the
server resolves that opened record and authorizes the directory before deriving
its namespace. The UI edits existing agent entries and preserves their session
provenance. Agent writes record the invoking native session.

`GET /api/memory/settings` reads the sole `server.memoryEnabled` preference;
absence means disabled. `PUT` takes `{ enabled: boolean }`. Its writes and all
HTTP configuration patches share the memory repository lock with mutations.
Mutation callbacks freshly read configuration authority under that lock, then
reject disabled writes. Human review remains readable while disabled. Disabling
uses the lock independently of stored entry parsing, so malformed scopes remain
disableable. Settings writes refresh authoritative configuration before merging
to preserve external fields.

Reads return content-derived SHA-256 revisions over all entry fields. Explicit-ID
saves and deletes require the displayed revision; stale or missing entries yield
`conflict`. Mutations revalidate current session/project ownership under the
repository lock before publication. Implicit agent saves retain duplicate
replacement policy. UI entries include freshly computed `flagged` and, when
flagged, `warning: suspected_injection`. Agent lists contain safe headers and
revisions; reads contain safe text; save acknowledgements contain only ID,
revision and flag. Safe capacity errors include safe titles and a merge-or-delete
instruction. Errors expose only the shared business code and fixed safe copy.

The native `sendMemoryInput` transport uses the existing loopback registration,
local token and WSL bridge adapter. `memory-probe` checks the native session's
current location against the backend's authorized directories, independently of
desktop/browser capabilities; `memory-input` repeats ownership at execution.
Discovery requires exactly one owning backend. UI paths use ordinary browser
authentication; native admission grants access only to the private bridge path.
After successful commits/settings changes, `memory.changed` invalidates readers
without carrying entry content, titles, IDs or directory information.

## Bundled native tool

`opencode/memory/desktop-plugin.ts` supplies `codenomad_memory` while a backend
presence lease is live. Its four actions require `scope`; `read` takes `query`
(exact ID or title), `save` takes `title`, `type`, `text`, and an explicit edit
additionally takes `id` and `revision`; `delete` requires `id` and `revision`
from a fresh read. The plugin derives provenance from `tool.sessionID` and
delegates every operation to `sendMemoryInput`. Safe capacity titles reach the
agent with a merge-or-delete instruction. An unconfirmed write instructs a
list/read verification before another decision to write.

`build:memory` uses the common native bundle settings. The desktop and standalone
server provision its content-addressed payload through `DesktopPluginLifecycle`
once their loopback bridge publication succeeds. Leases keep the tool's
registration aligned with backend presence, including withdrawal and reopening.

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
node --import tsx --test packages/server/src/server/routes/memory.test.ts packages/server/src/server/standalone-bridge.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
node --import tsx scripts/test-memory-instructions-native.mjs <absolute-opencode-executable>
node --import tsx --test packages/server/src/opencode/memory/*.test.ts
npm run build:memory --workspace @neuralnomads/codenomad
node --import tsx scripts/test-memory-tool-native.mjs <absolute-opencode-executable>
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
