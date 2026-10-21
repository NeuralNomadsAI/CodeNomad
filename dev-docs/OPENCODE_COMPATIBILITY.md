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

Minimum and recommended runtime: **2.1.2** (`runtime-support.ts`), with **2.1.0**
client/plugin pins. Earlier native Code Mode breaks JavaScript run-to-completion
(lost shared updates, async caller resumed before its first await);
`scripts/test-codemode-jobs-native.mjs` keeps the red/green regression, run in
CI against minimum and latest. The pinned 2.1 reducer consumes the replay
contract (below), so 2.0.x daemons are refused with `native_contract`. Plugins
share the host Effect 4.0.1/Schema runtime. Unlisted/prerelease/custom/future
labels undergo authenticated contract recognition; missing canonical APIs,
session environment or the replay shape give a concrete reason. OpenCode 2.1
reads older stored data.

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

### Contract notes

- Generated client URLs keep their `baseUrl` prefix and pass through unchanged;
  scheduling classifies API paths relative to the proxy prefix.
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
  releases. Test hosts that spread the Promise plugin context must declare the
  `credential` domain. `%ProgramData%\opencode` is discovered after the global
  plugin root that `config.get` consumers take first; native fixtures redirect
  `ProgramData`.
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

- Desktop automation and pruning provisioning follows the authenticated OpenCode connection and its `config.get` global discovery directory, including reconnects. Replacing a connection aborts its in-flight provisioning: `opencode/desktop-plugin-provisioning.ts` logs that at debug as superseded (the new connection provisions again) and keeps errors for failures on the current connection. Never derive a running daemon's roots from backend/startup environment or CLI `debug paths`. OpenCode watches the entire discovery root recursively: keep changing presence leases outside it, in the sibling `.codenomad/<root-hash>/` namespace. Retain existing outside-root storage; migrate inside-root storage while reading older backends' leases without writing there. WSL translates the daemon-reported paths through the selected distro only for filesystem access. Verify heartbeat stability with the isolated native automation fixture.
- Plugins register only at their next presence check, so a backend's first plugin RPC could arrive before registration and be refused. Followers acknowledge a lease with a `<lease>.ready` marker (current namespace only) once every follower of that directory in the native process has observed it while registered; routes calling bundled-plugin RPCs await `workspaceManager.desktopPluginsReady()` before reading or authorizing the session, so ownership checks and deletion-fence entry stay adjacent (bounded to 5 s, never rejects). The bound is paid in full only when no marker can arrive: no Location loaded yet, or pre-marker plugin copies still loaded after an upgrade. Do not replace this ordering with retries of refused reads.
- The shared native event relay consumes upstream events before slow routing I/O. Preserve per-session/PTY/Shell and per-recipient FIFO, validated full-location ownership, invalidation/connection/workspace fences and bounded-backlog reconnect recovery. A slow recipient must not block another or the shared SDK subscriber. Validate with the relay regressions and isolated native location fixture.
- Native OpenCode plugins share `packages/server/scripts/native-plugin-build.mjs`: never embed Effect or the public plugin SDK into daemon-loaded bundles (version boundaries: Qualification policy above). Keep backend-side OpenTunnel isolation separate, and run the bundle regression plus isolated plugin-runtime/pruning/automation/Missions fixtures when changing this boundary.
