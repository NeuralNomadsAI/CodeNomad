# OpenCode compatibility and runtime qualification

## Qualification policy

Qualify the pinned client/plugin dependencies (moved together) against the
technical minimum and `@opencode/cli@latest` before publishing; CI records the
resolved runtime. Review a release from its exact tags, published npm packages
and an authenticated isolated OpenAPI dump (the tagged
`packages/protocol/openapi.json` can lag the runtime), never GitHub's compare
view; release notes are at [opencode.ai/changelog](https://opencode.ai/changelog)
(GitHub Releases cover V1 only). Keep results in the PR and CI logs, never as
per-version sections here.

Minimum runtime **2.2.3**, recommended **2.2.5** (`runtime-support.ts`), with
**2.2.3** client/schema/plugin pins. The minimum carries the image tool contract of
upstream [#60258](https://github.com/anomalyco/opencode/pull/60258), consumed by
the Images gallery, the Design agent and skills and the Images settings: one
name, `experimental_image_generate`, for the tool, its permission action, its job
type and its completion notices' `metadata.source` (`IMAGE_TOOL` in
`session-pruning/assets-gallery-proof.ts`), and the tool offered while an image
model is available unless `experimental.image_generate` is `false`
(`image-settings.ts` reads it that way). Notices wrap their text in
`<image id="…" state="…">`; the gallery reads the `Saved image: <path> (` line.
The minimum also provides the replay contract (below) consumed by the pinned
reducer and Code Mode JavaScript run-to-completion, whose regression
`scripts/test-codemode-jobs-native.mjs` runs in CI against minimum and latest.
Daemons below the minimum are refused with `native_contract`. Plugins share the
host Effect 4.0.6/Schema runtime. Unlisted/prerelease/custom/future labels
undergo authenticated contract recognition; missing canonical APIs, session
environment or the replay shape give a concrete reason. OpenCode reads older
stored data.

Missions schedules qualify the consumed Schedule API, effective
`experimental.schedules` flag and retained plugin/provider bundle independently
of general runtime admission: [native contracts](MISSIONS_NATIVE_CONTRACTS.md#schedule-integration-qualification)
and [transport](MISSIONS_NATIVE_SCHEDULE_TRANSPORT.md). Recognition uses the
consumed capabilities, including on future versions. Schedule delivery qualification
uses the recommended 2.2.5 runtime; keep results in PR/CI evidence.

### Native Codex subscription usage

Beyond the usage rules in [PROVIDER_ACCOUNTS.md](PROVIDER_ACCOUNTS.md):
Codex uses only the owned session's integration's first connection and its
matching active ChatGPT OAuth credential (`chatgpt-browser`/`chatgpt-headless`),
never Codex CLI credentials, SQLite or another saved account; WSL uses the
selected daemon's credentials. Snapshots are keyed by native connection,
instance, session, directory, provider and credential identity and revalidate
native selection before publication; the proxy keeps blocking browser credential
export and generic RPC. Fixture: `node scripts/test-provider-usage-native.mjs <cli>`
(synthetic credentials and mocked quota HTTP only).

### Side questions (`/btw`)

`/btw` calls only native `session.generate({ sessionID, prompt })` through the
ownership-checked proxy and shows its single text answer; the session's
environment, transcript and inbox stay untouched, and closing aborts only that
request. `scripts/test-session-aside-native.mjs` (private daemon, local
provider) runs in the minimum/latest CI matrix.

### Session goal (`/goal`)

The Status tab's goal line consumes OpenCode's built-in goal plugin
(`@opencode/schema/goal`): the `opencode.goal` RPC's `get({ sessionID })`, which
answers the Session's own `Goal.State` or null, and its `changed` event
(`rpc.opencode.goal.changed`, `{ sessionID, goal }`), published in the Session's
Location on every write. The instance proxy refuses plugin RPCs, so
`GET /api/workspaces/:id/sessions/:sessionId/goal` (`server/routes/session-goal.ts`)
is the read path: it reads the Session, checks its Location's ownership, calls the
fixed method in that Location and returns only the displayed fields
(`opencode/goal-contract.ts`). An `RpcError` of type `rpc.unavailable` or
`rpc.method_not_found` answers `unsupported`; any other failure or unreadable state
answers `unavailable`, and the line shows nothing for either. Pause, Resume and
Clear run the native `goal` command with `pause`, `resume` or `clear` through the
composer's command path (`executeCustomCommand`: session admission, instructions,
profile environment at the proxy); a refused command (`No active goal to pause.`)
shows its message in a notice. The relay routes plugin RPC events to the workspace
owning their Location, so the UI applies `changed` directly and reads only on
demand, on reconnect and after its own commands ([refresh rules](CACHE_REFRESH_CONVENTIONS.md)).
`scripts/test-session-goal-native.mjs` (private daemon, local provider whose plain
reply the goal reviewer rejects, pausing the goal) runs in the minimum/latest CI matrix.

### Contract notes

- Internal explicit transcript navigation consumes `message.list` through the
  existing session-owned proxy: initial `order: asc|desc`, `limit <= 200`, then
  opaque cursor-only continuation options. Both cursor directions preserve their
  originating order. Backend admission validates the qualified native
  `{ id, order, direction }` shape and rejects unknown formats or mixed
  cursor/order input. `scripts/test-opencode-message-pages-native.mjs` checks native
  import/replay and message continuations using an owned runtime and synthetic
  messages with zero provider requests. Enriched CodeNomad windows/outline/query
  readers retain their shared-local capability gate. Runtime version is evidence
  recorded by the check; feature admission follows the consumed API contract.

- Explicit endpoints have one controlled dispatch seam in
  `opencode/servers/transport.ts`; connection admission and probes supply its
  fetch instead of issuing an independent network request. Registered and ephemeral
  administrative probes share one read-only connection-owner lane, negotiating the
  consumed E1 OpenAPI contract and reading canonical `server.info()`. One five-second
  monotone operation deadline covers all phases. The shared bounded-response wrapper
  buffers at most eight MiB of decoded bytes for every success/error envelope before
  SDK parsing. The wrapper owns each Response at receipt, covering cancellation
  before and during the header-to-reader admission wait. Body/reader cancellation
  occurs once; late responses, held cleanup and cleanup rejection retain independent
  retirement. The Form (four MiB) and media (sixteen MiB) consumers share that same
  ownership boundary and keep their operation-specific deadlines. Cancellation and
  cleanup release the probe lane independently. The result
  projects negotiated feature policy, a validated numeric release or unavailable,
  check time and fixed diagnostic categories/phases. Regular fetch preserves
  streaming and native wire requests; the compatibility adapter continues to own
  location-context serialization and feature-contract recognition. Explicit E1
  admission always negotiates canonical sessions/chat, replay (`native` and
  compaction metadata), live Forms/permissions, catalogs and event routes. Agent/model
  selection POSTs require their consumed request fields; MCP/skill catalogue GETs
  require location selectors and the consumed response envelopes/entry fields.
  Optional catalogue descriptions and error display details stay optional. Missing
  required schemas/routes produce `missing_contract`; runtime release labels are
  admitted by consumed API contracts. Session environment, bundled plugins and integrated
  image enrichment retain separate capability policy. Local admission retains its
  consumed runtime requirements. Connection generations revoke captured clients,
  fetches, admissions, pending request-body readers and streaming responses on rotation/forget/disconnect/removal/shutdown;
  origin changes clear memory credentials before metadata publication. Endpoint/transport regressions exercise isolated HTTP/TLS
  servers, pinned DNS, trust and hostname verification, header isolation, redirect
  refusal, probe limits and streaming cancellation.
  `connections.test.ts` exercises independent targets, coalesced/fenced acquisition,
  the four-target budget, project leases, probe isolation and retained old wrappers.

- The internal event relay subscribes once per admitted explicit target and once
  through the local adapter. Native `/api/event` covers all Locations on its
  server; its connected marker confirms only the current attempt. The installed
  client's lazy shared subscriber has a 4,096-event count bound; the relay applies
  its own job, byte and ingestion-to-delivery deadlines. Captured source clients,
  exact native Locations and occurrence epochs fence routing. Global notifications
  reach only that source's occurrences; unknown deletions produce targeted gaps.
  Backend receipt/automatic-reply/quota enrichment admits its local capability
  before any deferred explicit work can reach local credentials or storage.
  UI dispatch validates binding/source and the status-established relay generation
  before wildcard and typed subscribers. A status arriving before occurrence
  hydration waits in a bounded cache for its exact binding; only the status replays.
  Legacy sourceless frames are local-only. Explicit daemon continuity tokens are
  attempt-local; URL trust permits ordinary reconnection without a provenance gate.
  Physical browser SSE health stays separate from target-native confirmation.
  Explicit reconnect skips unavailable worktree reads and live-only pending
  snapshots; the dock's source disclosure presents live-only coverage.

- Generated client URLs keep their `baseUrl` prefix and pass through unchanged;
  scheduling classifies API paths relative to the proxy prefix.
- The generated `experimental.session` methods and their `session` aliases use
  identical experimental wire routes for instructions, wait, log, import/export
  and stats. Stateless `experimental.generate.text` uses
  `/api/experimental/generate/text`; side questions use the separate session
  generation API. New client domains retain the proxy's explicit allowlist.
- The Solid reducer derives projected message IDs with
  `Session.Message.ID.fromEvent`: event fixtures must use native `evt_` IDs,
  producing `msg_` rows. Catalogue invalidations refresh only previously read
  resources; an active-session snapshot also fetches missing running-session
  metadata. Tool-file omission is opt-in; transcript and pruning reads preserve
  their full native projection.
- Service discovery/header construction, RPC envelopes, `SessionLegacy`, Form
  and Permission read codecs keep their consumed contracts. The private loaded
  Location map canonicalizes path flavor and trailing separators; pending
  recovery retains its existing-only leases and identity checks. Plugin setup
  remains activation-scoped; native services are acquired in the request graph.
- Internal explicit workspaces use the separate method/operation allowlist in
  `server/explicit-proxy.ts`. Sessions, chat, catalogs and manual native interruption
  replies share their captured endpoint/client/fetch and exact directory authority.
  Directory cursors stay directory-scoped; project IDs and ancestry grant no extra
  authority. Private workspace policy is checked before acquisition; workspace
  lifetime, connection generation and native session placement fence asynchronous
  work and response publication. Ordinary finite proxy responses are buffered up to 64 MiB
  before publication. Cookies, redirects, authentication challenges and incoming
  forwarding/auth/internal headers stay at the proxy boundary. Renderer chat actions send their captured explicit
  connection generation in `x-codenomad-connection-generation`; the proxy validates
  its single positive-integer value against current workspace capabilities before
  acquisition and throughout dispatch. A stale value returns `409 explicit_action_superseded`,
  localized by the renderer. The private header stays inside CodeNomad, allowing
  multi-request instructions/profile/send actions to retain their starting
  generation while renderer metadata updates are still in flight. Shared-local proxy
  sanitization also strips this private header while keeping local admission semantics.
  Uncertain mutations
  are never retried. Native file/working-diff reads, scoped background Shell reads
  and stops, and configured MCP connect/disconnect use the qualified explicit
  allowlist. Moves, PTYs, administrative operations, generic RPC, pending recovery
  and enriched receipts stay capability-gated. Session-media reads use the workspace
  capture, native message ID, current Location, undo boundary and digest, with no
  disk fallback. Public project opening selects a registered explicit server and
  validates its native directory before publication.
- Explicit renderer media admission uses passive raster MIME qualification and canonical same-session native references correlated with held message positions and digest. The shared `embedded-asset.ts` validator checks complete data-URI length, MIME/prefix, base64 alphabet/padding and unused bits before decoding. The 8 MiB URI ceiling is distinct from the 32 KiB transcript deferral threshold. Backend finite-response transport and media-reader bounds retain their separate contracts.
- The media route's request-local `OpenCode.make({ baseUrl, fetch })` wraps only its captured connection fetch, retaining authentication, directory encoding and transport revocation. The lightweight `session-media-contract.ts` supplies `MESSAGE_LIMIT` (16 MiB) to this reader and the stored-asset reader. HTTP applies it to the whole decompressed response, success or error, before the official client's text/JSON parser. Native/Undici fetch supplies decoded gzip/deflate/br bytes; reconstructed SDK responses preserve status/statusText/content type and remove stale encoding/length headers. Local reads use the same bound with their existing connection policy. Overflow and cancellation release the upstream reader under the route's 30-second, workspace and socket lifetime. Request observers also bound their acquisition wait without cancelling shared connection work.
- The proxy allowlist stays closed to pairing (`/api/pair`, `/auth/connect/*`),
  credential export/creation (`/api/credential`) and experimental voice
  (`/api/experimental/voice/session`); a runtime update never widens it or
  retries a mutation under another contract (`instance-proxy.test.ts`).
- Session creation needs an inspectable JSON object; the proxy rejects any
  `parentID` before forwarding (native `parentID` ignores the location).
- Service lifecycle uses the selected CLI's status/start/password and the
  registration fallback, never SDK `Service.ensure/stop` or an assumed default
  port. A user's `opencode service set env` value overrides CodeNomad's
  missing-daemon start variable of the same name; per-send
  `session.environment` applies independently.
- Plugin bundles externalize Effect and the plugin SDK because two Effect
  runtimes cannot share one native fiber and host Schema APIs differ across
  releases. Local plugin directories with a package name and `exports` resolve
  their entrypoints through that manifest (`session-pruning/package.test.ts`).
  Test hosts that spread the Promise plugin context must declare the
  `credential` domain. `%ProgramData%\opencode` is discovered after the global
  plugin root that `config.get` consumers take first; native fixtures redirect
  `ProgramData`. Package-install fixtures pass `withProductRuntime`'s `registry`
  option (a loopback fake npm registry, [Plugin controls](PLUGIN_CONTROLS.md#validation)).
- Relied-on upstream behaviors keep their regressions:
  `test-output-limit-native.mjs` (an output-length stop settles failed/idle with
  one user prompt) and `test-promise-tool-failure-native.mjs` (rejected Promise
  tools settle `error`; `permission.rejected` prevents the side effect).
- Upstream #52922 (Bus routing before Location fanout) is open: keep the
  discovery and event-relay mitigations.

### Replay contract

Text/reasoning/tool/step provider data is one `native` field (on a key shared by
a tool call and its result, the result wins). Summary compactions reference
`metadata.keepID`, with kept text in `metadata.recent`; provider compactions
replay from `native.messages`. On read, the `SessionLegacy` codec
(`@opencode/schema`) upgrades stored rows/events carrying `state`,
`providerState`, `providerResultState` or `recent` without rewriting bytes, and
drops a compaction's `providerContext.version`/`provenance` and a
`providerState` stored beside a `providerContext`. The UI reduces events with
the pinned `createData` (`stores/opencode-data.ts`); mismatched pins change
reasoning identity and `stores/session-actions.ts` refuses pruning
(`session-pruning-projection.test.ts`). Admission therefore requires
`Session.Message.Assistant.Text.native` without `state` and
`Session.Message.Compaction.Completed` with `metadata` but no `recent`
(`compatibility/negotiate.ts`). `planner.ts` hashes the
`SessionLegacy` projection and writes surviving stored parts back unchanged
(`pruning.test.ts`). CodeNomad never archives (`session.archived`/`unarchived`
only invalidate); the UI compaction part keeps `native` (`normalizers.ts`). The
packed pruning plugin declares every bare import, including `@opencode/schema`
(`package.test.ts`).

### Capability-checked loaded-only pending recovery

Explicit E1 manual interruptions retain request-local client, binding, native and
connection generations, metadata and native Location through dispatch and
acknowledgement. Global Forms use the once-encoded native directory on the captured
official client. Their human-answer hint remains local-service-only. Disconnect
and backend restoration retire admissions, retain editors and expose unknown
coverage in the dock's source details. Current live events admit only their exact
request. Explicit mutation failures and view activation schedule zero pending
recovery reads. A known explicit-server Form has an individually bounded native
GET through `explicit-form-verification.ts`: at most two Session GETs and one Form
GET, or one global Form GET. Its request-local official client wraps the captured
fetch with the shared `bounded-response-fetch.ts` seam. Every response, including
errors and Session placement reads, is limited to four MiB of decoded HTTP bytes
before SDK text/JSON parsing. One ten-second operation budget includes acquisition,
profile and pre/post placement checks. Non-200 status and invalid wire values remain
indeterminate. The consumed Form schema validates native special-number strings,
field conditions/options, state and complete answer before discarding answer and
cancellation message from the renderer projection. Permission GET remains closed;
stale permissions await their current live event.
The renderer revalidates at the deferred SDK callback's actual dispatch boundary.
Session placement tokens advance at accepted publication rather than at predicate
evaluation, keeping an old verification and its granted reply retired across
placement ABA. Equal placement refreshes preserve current owners. The source Form
editor keeps one composed polite result and a stable, guarded keyboard check control.
Receipt routes return structured `historyEnrichment` refusals before local/native
acquisition; local loaded-only recovery keeps its existing contract below.

Explicit CodeNomad event envelopes carry the captured connection-owner generation
in `source.connectionGeneration`, independently of the relay-attempt `generation`.
`liveGeneration` identifies each occurrence's status boundary, including a
same-attempt routing gap. The relay retains that boundary from recipient ingestion
through ownership waits and charges it in the queued envelope. Status replay keeps
its original boundary. Explicit missing/invalid correlation fails closed; local
sourceless and legacy status compatibility keep their existing admission.

The renderer captures source and transport-lifetime authority at dispatch. A
current creation can wait for matching server/capability metadata in either order,
without rereading or replaying its event. Matching metadata qualifies only its
captured current candidate. Gaps, stale statuses, incompatible metadata, client,
native-data, binding and Location changes retain their independent retirement
fences. Common prompt/inventory/media request owners retain their strict generation
contract. Form verification grants only the captured known identity; project coverage
retains the live-only policy.

Rules: [NATIVE_INTERRUPTION_UX.md](NATIVE_INTERRUPTION_UX.md). Pruning/history
methods have their own support and write checks.

The reader uses private native LocationServiceMap, Location, Form and Permission
services, scoped existing-only leases and repeated inventory/object-identity
checks. It preserves global/idle Forms and native numeric JSON codecs, returning
complete coverage (including empty cold directories) with the caller's actual
`originDirectory`. Bounds: 64 requested directories/selected placements, 2048
loaded keys, 1024 Forms and Permissions per placement/directory, 4 MiB UTF-8
output, a two-second reader deadline and the broker's 30-second overall deadline
(including Git ownership revalidation, eight directories at a time through the
Git worker). Overflow or unsafe serialization fails rather than truncates.

The UI sends at most eight directories per request within the escaped URL
budget, under its own ten-second deadline; recovering a whole history on a slow
filesystem can take arbitrarily long. The broker rejects overflowing raw JSON
numbers (including unknown metadata) before coverage/capability admission;
native numeric codec strings pass through unchanged.

`GET /api/workspaces/:id/pending-requests` keeps its UI wire shape and calls only
`POST /api/rpc/codenomad.pending-requests/snapshot?location[directory]=<root>`
with `{ "input": { "directories": [...] } }`. Legacy workspace identities are
rejected and never erased; workspace/connection replacement, root or candidate
deletion and changed authority fence dispatch and publication. Cold UI coverage
synthesizes a location from the validated native entry directory, never the
browser's alias. Only HTTP 400 with a strict bounded `RpcError` envelope
(`_tag: "RpcError"`, type `rpc.unavailable` or `rpc.method_not_found`, message of
at most 4,096 characters) means unsupported, and only after origin and candidate
revalidation. Plain 404s, other errors, malformed output, authentication failures,
reader errors, timeouts and overflow return non-authoritative 503s. An unverified
capability is deliberately never probed during an observed compaction.

Candidate traversal constructs no cold Locations; native HTTP middleware may
warm or rebuild the single bootstrap root, and root eviction or a config rebuild
constructs it again. Snapshots can go stale after leases release, so per-kind
mutation fences and settlement tombstones stay essential.

## Agent conventions

All managed bundle payloads (automation, session-pruning, Missions runtime and
Missions carrier provider) share `opencode/desktop-plugin-artifact.ts` for digest
verification, atomic repair and bounded lock retries. Provisioning verifies both
Missions payloads before publishing its shim or lease. Failures flow through the
shared provisioning error deduplication and pending-request recovery notice.

Artifact identities use exact BigInt device/inode values. When Windows pathname
stats report device zero, verification opens the name independently and compares
both handles' nonzero device and inode identities, then rechecks the regular,
single-link pathname and its size. The payload still passes full SHA-256 and EOF
verification; the pre-publication recheck repeats this verification for a missing
pathname device. Known device mismatches, inode changes and links fail closed.
Verification errors identify the failed file, identity, size or digest check.

- Desktop automation and pruning provisioning follows the authenticated OpenCode connection and its `config.get` global discovery directory, including reconnects. Replacing a connection aborts its in-flight provisioning: `opencode/desktop-plugin-provisioning.ts` logs that at debug as superseded (the new connection provisions again) and keeps errors for failures on the current connection, logging each distinct failure once with its consequence and repeats at debug until a provisioning succeeds. Bundle payloads are content-addressed (`<sha256>.mjs`) and shared by every backend of the namespace: `opencode/desktop-plugin-installation.ts` publishes one only by renaming a complete temporary copy, and replaces a name that holds other bytes or is not one regular file (an earlier write cut short, a link) the same way before the entry may point at it, so concurrent installers never read a partial payload and a damaged one never blocks later connections. Never derive a running daemon's roots from backend/startup environment or CLI `debug paths`. OpenCode watches the entire discovery root recursively: keep changing presence leases outside it, in the sibling `.codenomad/<root-hash>/` namespace. Retain existing outside-root storage; migrate inside-root storage while reading older backends' leases without writing there. WSL translates the daemon-reported paths through the selected distro only for filesystem access. Verify heartbeat stability with the isolated native automation fixture.
- Plugins register only at their next presence check, so a backend's first plugin RPC could arrive before registration and be refused. Followers acknowledge a lease with a `<lease>.ready` marker (current namespace only) once every follower of that directory in the native process has observed it while registered; routes calling bundled-plugin RPCs await `workspaceManager.desktopPluginsReady()` before reading or authorizing the session, so ownership checks and deletion-fence entry stay adjacent (bounded to 5 s, never rejects). The bound is paid in full only when no marker can arrive: no Location loaded yet, or pre-marker plugin copies still loaded after an upgrade. Do not replace this ordering with retries of refused reads.
  Each follower handle owns its admitted marker writes. Shutdown stops admission and its timer, joins reconciliation and registration disposal, then drains those writes before releasing its observations, including on disposal failure. Marker IO stays outside normal reconciliation; failed writes retry on a later live check. Overlapping followers keep independent lifetimes, while backend lease removal and the independently running daemon keep their own owners.
- The Design agent and skills follow backend leases, never a command or RPC. A backend requests them while an installed, enabled panel extension declares `opencode.designAgent` (`opencode/design/demand.ts`, refreshed on every extension-store change). `DesktopPluginLifecycle.setLeaseContent` writes the request (`{"version":1,"design":true}`, or an empty lease) into every session-pruning lease the backend retains, one per configuration namespace, and each new installation starts from it. Writes happen only when the request changes, through a temporary name outside the lease pattern and a rename, serialized with the heartbeat so a removed lease is never resurrected; a failed write retries at the next heartbeat. The shared presence observation (`desktop-plugin-presence.ts`, versioned process key) reads at most 256 bytes of each live lease: empty, unreadable, oversized or unknown-version leases request nothing, and Design is wanted while any live lease of the plugin's presence directories requests it, so one backend's expiry withdraws only its own request. The session-pruning plugin registers its agent and skill transforms once in its `effect`, before `followPresence` (`opencode/design/register.ts`), with content conditioned on a Location-local flag; reconciliation at the presence interval only flips the flag and calls `agent.reload()` and `skill.reload()` on an actual change, and the content loads on the first request. Never register these transforms from presence, an RPC or a command: a late registration bypasses the user's permission rules and overrides the user's own `design` agent or `design-*` skills, which always win. A runtime without agent or skill transforms gets no Design agent. `opencode/design/status.ts` classifies a Location's `GET /api/agent`: `present` when the prompt starts with the content mark, `user` otherwise, or `absent`. Validate with `opencode/design/*.test.ts` and `scripts/test-design-activation-native.mjs` (build the pruning bundle first); that fixture enables project discovery, so outside CI it refuses to run under the user's home unless `CODENOMAD_NATIVE_FIXTURE_PARENT` names a parent outside it.
- The shared native event relay consumes upstream events before slow routing I/O. Preserve per-session/PTY/Shell and per-recipient FIFO, validated full-location ownership, invalidation/connection/workspace fences and bounded-backlog reconnect recovery. When an ownership lookup still fails after its retry, the relay evicts that cache entry and pulses that recipient's status alone (`error` with `event routing failed`, then `connected`), so its clients run their reconnect reconciliation (one pass per instance, with later requests coalesced into one trailing pass, `ui/src/lib/trailing-resync.ts`). Pulses are leading and trailing, at most every 5 s, doubling to 60 s while failures persist. Never fail the shared subscription for one recipient's lookup: that resyncs every instance. A slow recipient must not block another or the shared SDK subscriber. Validate with the relay regressions and isolated native location fixture.
- Native OpenCode plugins share `packages/server/scripts/native-plugin-build.mjs`: never embed Effect or the public plugin SDK into daemon-loaded bundles (version boundaries: Qualification policy above). Keep backend-side OpenTunnel isolation separate, and run the bundle regression plus isolated plugin-runtime/pruning/automation/Missions fixtures when changing this boundary.
- The Design agent and skills exist once, as native OpenCode files in `packages/server/src/opencode/design/opencode/` (`agents/design.md`, `skills/design-*/SKILL.md`, `NOTICE.md`, `LICENSE-APACHE-2.0.txt`), which also work unchanged when copied into a project's `.opencode/` or the global OpenCode configuration folder; the public help links this folder for that use (`docs/help/<locale>/extensions.md#design-without-codenomad`), so moving it means updating those links. Each file keeps its licence notice in frontmatter comments and its references inside its own body: never add sibling files, CLI or form protocols, URLs or brand names (`design/content.test.ts` checks them, with the attribution of each adapted file). `design/content.ts` embeds the files as text through the build's `.md` loader and parses them strictly: bundles call `loadDesignContent()`; `tsx` cannot import `.md`, so checkout code and tests read the files and call `parseDesignContent()`. The agent prompt starts with `codenomad-design-content: <DESIGN_CONTENT_VERSION>`; raise the version whenever the skill, direction or recipe identifiers change. Validate content changes with that test, the self-contained bundle test in `native-plugin-build.test.mjs` and `scripts/test-design-content-native.mjs`. That native test enables project discovery, which walks every ancestor directory: outside CI it refuses to run under the user's home unless `CODENOMAD_NATIVE_FIXTURE_PARENT` names a parent outside it.
- Missions provisioning installs `provider.mjs` as a separate content-addressed local provider beside its content-addressed runtime. The managed shim supplies native absolute `{provider:{file,sha256},runtime:{file,sha256}}` paths as the factory's second argument; WSL translation applies only to backend filesystem I/O. Lease release and upgrades retain both payloads for native carrier recovery. Registration paths are acquired during arming in the current native RPC graph by `missions/native-schedule-installation.ts`, from the own-process record under native Global state and current ServerInfo URLs, then authenticated with exact-file public Service discovery.
