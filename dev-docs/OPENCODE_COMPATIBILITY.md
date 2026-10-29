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
**2.1.0** client/plugin pins. The minimum carries the image tool contract of
upstream [#60258](https://github.com/anomalyco/opencode/pull/60258), consumed by
the Images gallery, the Design agent and skills and the Images settings: one
name, `experimental_image_generate`, for the tool, its permission action, its job
type and its completion notices' `metadata.source` (`IMAGE_TOOL` in
`session-pruning/assets-gallery-proof.ts`), and the tool offered while an image
model is available unless `experimental.image_generate` is `false`
(`image-settings.ts` reads it that way). Notices wrap their text in
`<image id="…" state="…">`; the gallery reads the `Saved image: <path> (` line.
The minimum also provides the replay contract (below) consumed by the pinned 2.1
reducer and Code Mode JavaScript run-to-completion, whose regression
`scripts/test-codemode-jobs-native.mjs` runs in CI against minimum and latest.
Daemons below the minimum are refused with `native_contract`. Plugins share the
host Effect 4.0.6/Schema runtime. Unlisted/prerelease/custom/future labels
undergo authenticated contract recognition; missing canonical APIs, session
environment or the replay shape give a concrete reason. OpenCode reads older
stored data.

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

- Desktop automation and pruning provisioning follows the authenticated OpenCode connection and its `config.get` global discovery directory, including reconnects. Replacing a connection aborts its in-flight provisioning: `opencode/desktop-plugin-provisioning.ts` logs that at debug as superseded (the new connection provisions again) and keeps errors for failures on the current connection, logging each distinct failure once with its consequence and repeats at debug until a provisioning succeeds. Bundle payloads are content-addressed (`<sha256>.mjs`) and shared by every backend of the namespace: `opencode/desktop-plugin-installation.ts` publishes one only by renaming a complete temporary copy, and replaces a name that holds other bytes or is not one regular file (an earlier write cut short, a link) the same way before the entry may point at it, so concurrent installers never read a partial payload and a damaged one never blocks later connections. Never derive a running daemon's roots from backend/startup environment or CLI `debug paths`. OpenCode watches the entire discovery root recursively: keep changing presence leases outside it, in the sibling `.codenomad/<root-hash>/` namespace. Retain existing outside-root storage; migrate inside-root storage while reading older backends' leases without writing there. WSL translates the daemon-reported paths through the selected distro only for filesystem access. Verify heartbeat stability with the isolated native automation fixture.
- Plugins register only at their next presence check, so a backend's first plugin RPC could arrive before registration and be refused. Followers acknowledge a lease with a `<lease>.ready` marker (current namespace only) once every follower of that directory in the native process has observed it while registered; routes calling bundled-plugin RPCs await `workspaceManager.desktopPluginsReady()` before reading or authorizing the session, so ownership checks and deletion-fence entry stay adjacent (bounded to 5 s, never rejects). The bound is paid in full only when no marker can arrive: no Location loaded yet, or pre-marker plugin copies still loaded after an upgrade. Do not replace this ordering with retries of refused reads.
- The Design agent and skills follow backend leases, never a command or RPC. A backend requests them while an installed, enabled panel extension declares `opencode.designAgent` (`opencode/design/demand.ts`, refreshed on every extension-store change). `DesktopPluginLifecycle.setLeaseContent` writes the request (`{"version":1,"design":true}`, or an empty lease) into every session-pruning lease the backend retains, one per configuration namespace, and each new installation starts from it. Writes happen only when the request changes, through a temporary name outside the lease pattern and a rename, serialized with the heartbeat so a removed lease is never resurrected; a failed write retries at the next heartbeat. The shared presence observation (`desktop-plugin-presence.ts`, versioned process key) reads at most 256 bytes of each live lease: empty, unreadable, oversized or unknown-version leases request nothing, and Design is wanted while any live lease of the plugin's presence directories requests it, so one backend's expiry withdraws only its own request. The session-pruning plugin registers its agent and skill transforms once in its `effect`, before `followPresence` (`opencode/design/register.ts`), with content conditioned on a Location-local flag; reconciliation at the presence interval only flips the flag and calls `agent.reload()` and `skill.reload()` on an actual change, and the content loads on the first request. Never register these transforms from presence, an RPC or a command: a late registration bypasses the user's permission rules and overrides the user's own `design` agent or `design-*` skills, which always win. A runtime without agent or skill transforms gets no Design agent. `opencode/design/status.ts` classifies a Location's `GET /api/agent`: `present` when the prompt starts with the content mark, `user` otherwise, or `absent`. Validate with `opencode/design/*.test.ts` and `scripts/test-design-activation-native.mjs` (build the pruning bundle first); that fixture enables project discovery, so outside CI it refuses to run under the user's home unless `CODENOMAD_NATIVE_FIXTURE_PARENT` names a parent outside it.
- The shared native event relay consumes upstream events before slow routing I/O. Preserve per-session/PTY/Shell and per-recipient FIFO, validated full-location ownership, invalidation/connection/workspace fences and bounded-backlog reconnect recovery. When an ownership lookup still fails after its retry, the relay evicts that cache entry and pulses that recipient's status alone (`error` with `event routing failed`, then `connected`), so its clients run their reconnect reconciliation (one pass per instance, with later requests coalesced into one trailing pass, `ui/src/lib/trailing-resync.ts`). Pulses are leading and trailing, at most every 5 s, doubling to 60 s while failures persist. Never fail the shared subscription for one recipient's lookup: that resyncs every instance. A slow recipient must not block another or the shared SDK subscriber. Validate with the relay regressions and isolated native location fixture.
- Native OpenCode plugins share `packages/server/scripts/native-plugin-build.mjs`: never embed Effect or the public plugin SDK into daemon-loaded bundles (version boundaries: Qualification policy above). Keep backend-side OpenTunnel isolation separate, and run the bundle regression plus isolated plugin-runtime/pruning/automation/Missions fixtures when changing this boundary.
- The Design agent and skills exist once, as native OpenCode files in `packages/server/src/opencode/design/opencode/` (`agents/design.md`, `skills/design-*/SKILL.md`, `NOTICE.md`, `LICENSE-APACHE-2.0.txt`), which also work unchanged when copied into a project's `.opencode/` or the global OpenCode configuration folder; the public help links this folder for that use (`docs/help/<locale>/extensions.md#design-without-codenomad`), so moving it means updating those links. Each file keeps its licence notice in frontmatter comments and its references inside its own body: never add sibling files, CLI or form protocols, URLs or brand names (`design/content.test.ts` checks them, with the attribution of each adapted file). `design/content.ts` embeds the files as text through the build's `.md` loader and parses them strictly: bundles call `loadDesignContent()`; `tsx` cannot import `.md`, so checkout code and tests read the files and call `parseDesignContent()`. The agent prompt starts with `codenomad-design-content: <DESIGN_CONTENT_VERSION>`; raise the version whenever the skill, direction or recipe identifiers change. Validate content changes with that test, the self-contained bundle test in `native-plugin-build.test.mjs` and `scripts/test-design-content-native.mjs`. That native test enables project discovery, which walks every ancestor directory: outside CI it refuses to run under the user's home unless `CODENOMAD_NATIVE_FIXTURE_PARENT` names a parent outside it.
