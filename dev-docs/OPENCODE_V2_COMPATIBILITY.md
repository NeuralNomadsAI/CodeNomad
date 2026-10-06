# OpenCode V2 compatibility and runtime qualification

## Current qualification policy

Qualify against the technical minimum and the latest published stable OpenCode
runtime (`@opencode/cli@latest`). A blocking minimum must follow a demonstrated
API/behavior dependency; the latest publication and client/plugin pin are not
sufficient reasons. Keep minimum requirements, recommended/tested versions and
unverified versions distinct.

CI records the resolved runtime version. Pin client/plugin dependencies together
to the release target and qualify them before publishing CodeNomad. Retained
compatibility code and historical-data handling do not imply support for older
runtimes. Keep detailed results in the change's PR and CI logs, not in per-version
reports. Update this reference in place.

PR #696's corrected technical minimum is **2.0.7**, when native step-start events
gain the `data.started` field consumed by the current Solid reducer. **2.0.24**
is the recommended release-tested target, not the minimum. Unlisted versions,
including prereleases/custom labels/future majors, undergo authenticated contract
recognition rather than being refused solely for their label. Missing canonical
APIs or session environment support produce a concrete incompatibility reason.
The bundled Node/npm installer and explicit daemon restart are distinct actions.
Pre-2.0.4 wire adapters and the pre-2.0.7 timestamp fallback are retired, including
remaining legacy live location serializers. Historical internal identity,
current import/cursor authorization, cancellation and connection checks remain.
The isolated 2.0.3→2.0.11 seed confirms native workspace-selector collapse while
preserving session IDs and complete history. See the
[transition register](OPENCODE_V2_POST_BETA.md) for actual coverage and release gates.

### Native Codex subscription usage

Codex/OpenAI quota reads require the **2.0.20** native `credential.list` API.
This is a feature-local dependency, not a new global minimum: a missing endpoint,
expired token or unsupported connection yields unavailable usage. The server
identifies a credential-endpoint HTTP 404 with a sanitized, feature-local upgrade
reason; the panel explains the required service version without blocking the app.
The server
resolves the owned session's native directory and provider integration, then uses
only that integration's first connection and its matching active ChatGPT OAuth
credential (`chatgpt-browser` or `chatgpt-headless`). It never reads host legacy
`auth.json`, Codex CLI credentials or SQLite, refreshes OAuth independently, or
substitutes another saved account. WSL uses the selected daemon's credentials.

Quota snapshots are scoped to the acquired native connection, instance, session,
directory, provider and selected credential identity. Warm and pending results
revalidate native selection before publication. Credentials remain server-only;
browser credential export and generic RPC are still blocked by the proxy.
Isolated HTTP/generated-client and rendered Solid fixtures cover these boundaries.
`node scripts/test-provider-usage-native.mjs <absolute-cli-path>` additionally
exercises the production quota adapter against a fresh native daemon/database with
synthetic OAuth/key credentials and mocked quota HTTP only. It passed on Windows
with 2.0.20, 2.0.21 and 2.0.22: active-account selection and `metadata.accountID`, warm-cache revocation
after switching to a key, and recovery despite a stale legacy file. This is not a
real WSL or live ChatGPT quota test; no real credentials or shared daemon are used.

### Side questions (`/btw`)

The composer-owned command calls native `session.generate({ sessionID, prompt })`
through the ownership-checked session proxy. It does not use `session.command`,
create a fork, replace session environment, or add transcript/inbox records.
The native API returns one text answer; there is no client-side context assembly
or tool loop. Closing/cancelling the ephemeral window aborts that request only.
`scripts/test-session-aside-native.mjs` uses a private daemon and local provider
to verify context reuse, unchanged idle history and generation during an active
main turn. It passes on 2.0.7 (technical minimum), 2.0.11 and 2.0.12, and runs in
the minimum/latest-stable CI matrix. These targeted results do not change the
global minimum, dependency pins or recommended release-tested version.

### 2.0.14 qualification baseline (2026-09-23)

The qualification baseline includes merged #751 (`0a31a8b3`). Server/UI client
and bundled-plugin dependencies were aligned at **2.0.14**, together with the
then-recommended/tested version. The technical minimum remains **2.0.7**. Newer
runtime labels continue through authenticated contract recognition; this update
does not widen the proxy allowlist or retry mutations under another contract.

The 2.0.11-to-2.0.14 client contract adds `ConnectionCredentialInfo.method`
(`key` or `oauth`). Historical migration assertions retain full comparison of
the old connection fields and separately validate that the synthetic key
credential remains a key when the runtime exposes that metadata. They do not
discard unknown fields or relax session/history preservation checks.

With the 2.0.14 dependencies, isolated Windows fixtures pass native migrations
from 2.0.3 and beta-19271 to both 2.0.7 and 2.0.14, preserving complete history,
forks, pending inbox state and provider configuration. The same native suite
passes against both 2.0.7 and 2.0.14: discovery/automation, plugin provisioning/heartbeats, proxy and
ownership checks, worktrees, Forms/permissions, 241-message history queries,
1,501-message outline/window parity, pruning/concurrency/restart, per-send
environment, inclusive forks and idle/busy side questions. All storage and
daemons are synthetic and isolated. Detailed logs and remaining platform
qualification belong in the qualification PR/CI, not a separate version report.

The previous #751 compatibility failures on Linux, Windows and macOS all stop
at the same additive credential-metadata assertion. Local Windows migration
coverage completed; the subsequent 2.0.15 qualification also confirms the
corrected migrations on Linux, Windows and macOS in CI.
The separate system-message browser fixture still has two search timeouts:
it mocks HTTP APIs with `{}` and does not provide the current bounded history
query contract. Those tests use synthetic browser data, not a 2.0.14 daemon;
they are not native-runtime qualification evidence.

### 2.0.15 qualification baseline

Server/UI client, bundled plugin and recommendation advance together to **2.0.15**;
the technical minimum stays **2.0.7**. The upstream client now preserves a
`baseUrl` path prefix ([#50428](https://github.com/anomalyco/opencode/pull/50428)).
CodeNomad removes its former prefix-repair workaround: the generated URL passes
through unchanged, while scheduling classifies the API path relative to the
proxy prefix. A regression using the real generated client reproduced duplicate
proxy prefixes before this correction and verifies exact DELETE/PUT instruction
paths afterward, including deployments with an additional base path.

Declared native API errors are now `Error` instances retaining `_tag`/data
([#50788](https://github.com/anomalyco/opencode/pull/50788)); existing error
classification remains applicable. Undeclared HTTP 500 responses still surface
as `UnexpectedStatus`. Additive contracts include project `time.active`, session
metadata updates and their event; these do not add new proxy routes or minimum
runtime requirements. Runtime changes also cover media/provider handling,
Code Mode expression support and Windows CLI update/uninstall coordination.

These changes do **not** establish a fix for #750's remaining CodeNomad
pre-forward exception. Updating only the CLI cannot replace the client bundled
with CodeNomad. Keep #750 open until a reproducing desktop send verifies its
specific failure; synthetic qualification is not that reproduction.

With the 2.0.15 pins, Windows qualification passes the native suites on both
2.0.7 and 2.0.15 (automation/discovery, proxy/ownership/worktrees, history/pruning,
environment, forks and idle/busy side questions), plus all four historical
migrations from 2.0.3/beta-19271 to minimum/current. The environment fixture's
duplicate prefix workaround was removed too; its initial 403 was reproduced on
both runtimes and the corrected real-manager/native-shell cases pass on both.
CI run `35848468936` confirms historical migrations on Linux, Windows and macOS,
plus native pruning/UI on Linux and macOS. Both Windows runtime suites complete
their 2.0.7/2.0.15 native cases, then fail because the merge-ref workflow invokes
the newer blank-session fixture absent from the checked-out PR head. Integrating
`dev` brings that fixture into the branch; its native checks pass locally on both
runtimes with the 2.0.15 client. The separate Windows pruning/UI CI process exits
without an exception diagnostic. A local Node 24.20.0 run also exits abruptly,
but the subsequent instrumented run passes the complete native/UI suite. Keep
startup phase diagnostics for a recurrence; this passing rerun does not establish
the cause or a fix for the intermittent exit. Detailed results and remaining CI
gates belong in #752 rather than being inferred from other passing platforms.

### Previous stable target: 2.0.16

Server/UI client, bundled plugin and recommendation advance together to **2.0.16**;
the evidence-based minimum remains **2.0.7**. Comparing the tagged
`packages/protocol/openapi.json` documents for 2.0.15 and 2.0.16 finds identical
paths and component schemas. Published client declarations differ only in the
optional `ClientError` detail; plugin declarations are unchanged.

Client failures now include status/content-type/cause detail in `message`
([#50929](https://github.com/anomalyco/opencode/pull/50929)). Structured `reason`,
`cause`, and declared native error fields remain available. Generated-client
regressions exercise the real proxy adapter and error formatter for HTTP 500,
wrong content type and transport errors, retaining one prefixed request with
credentials and no mutation replay. The 2.0.15 URL correction remains required.

The release also adds MCP resource tools and Code Mode operations, provider/media
fixes and runtime read/subagent improvements. These are upstream runtime changes;
this qualification does not expose additional proxy APIs or introduce new media,
provider-authentication or transcript UI workflows. The shared npm native-upgrade
boundary stays at 2.0.15; installer activation remains separate from daemon restart.
Windows qualification with Node 24.20.0 passes 98 server tests, 75 UI tests,
25 setup/auth-recovery browser scenarios and three tool-image browser scenarios,
plus server/UI/Electron typechecks and production server/UI/plugin builds. All
four historical migrations (2.0.3 and beta-19271 to 2.0.7 and 2.0.16) pass.
The 2.0.16 native pruning/UI suite passes through concurrency, persistence and
restart. The isolated npm upgrade advances the installed CLI to 2.0.16 while
preserving the running 2.0.15 daemon's version and PID.

Native suites pass on both 2.0.7 and 2.0.16 with the 2.0.16 dependencies:
automation/discovery, relay/proxy/ownership, worktrees, Forms/permissions,
history/pruning/concurrency, per-send environment, inclusive forks, idle/busy
side questions and blank-session cleanup. The Git-degraded scenario passes on
2.0.16 and on the isolated minimum-runtime rerun described below.

The minimum-runtime Git-degraded fixture initially retained the advisory after
PATH recovery; its isolated rerun passes without code changes. Preserve that
failure as unresolved intermittent evidence, not a corrected regression. The
independent gatekeeper reports zero actionable findings. Detailed native suite
completion and cross-platform qualification belong in the PR/CI; do not treat
unchanged wire types or a passing rerun as proof of untested behavior.

### Previous stable target: 2.0.18

Server/UI client, bundled plugins and recommendation advance together to **2.0.18**;
the demonstrated minimum remains **2.0.7**. The published 2.0.16→2.0.18 client
adds `server.pair()`, `server.connect()` and optional `Shell.Info.signal`.
The native authenticated 2.0.18 schema has 115 paths: the existing 113 paths are
unchanged, with `/api/pair` and `/auth/connect/{code}` added. Component changes
are limited to the optional Shell signal and the two pairing response schemas.
The tagged `packages/protocol/openapi.json` is stale (113 paths); use the actual
runtime schema and published declarations when reviewing this boundary.

CodeNomad retains its authenticated service connection and explicit proxy allowlist;
the new pairing routes are not exposed. Plugin declaration changes concern TUI
model variants; CodeNomad's server-plugin surface is unchanged. Upstream also
flushes batched transcript deltas before starting the next content block, reports
signal-terminated Shells, fixes provider/reasoning budgets and restores the Shell
no-output placeholder. The 2.0.18 provider-context decoder upgrades pre-2.0.15
media in stored compaction checkpoints. These are reasons to prefer the newer
runtime, not new CodeNomad API dependencies or a higher minimum.

The native npm upgrade fixture follows the recommendation constant while keeping
2.0.15 as its source boundary; installation and daemon restart remain separate.
Detailed qualification results and independent review belong in the PR and CI.

Windows qualification with Node 24.20.0 passes the seven native suites on 2.0.7
with the 2.0.18 dependencies, and the 2.0.18 native/UI acceptance on its diagnostic
rerun. The first 2.0.18 pruning/UI run exited with Windows heap-corruption status
`0xC0000374` while loading browser/server dependencies, after native history and
proxy checks passed. The earlier 2.0.16 dependency baseline passes against runtime
2.0.18 too. The passing rerun does not explain or fix the intermittent exit
previously recorded above. Both historical migrations (2.0.3 and beta-19271) to
2.0.18 pass; the native npm installation leaves the 2.0.15 daemon and PID intact.

### Previous stable target: 2.0.19

The recommendation and synchronized server/UI client and plugin pins advance to
**2.0.19**; the timestamp-based minimum remains **2.0.7**. The authenticated native
2.0.19 OpenAPI has the same 115 paths and component schemas as native 2.0.18.
All published client, plugin, protocol and schema declarations are byte-identical
(30, 60, 36 and 102 declaration files respectively). No new API adapter or proxy
route follows from this release.

Upstream refactors compaction and adjusts output limits to the context window
(with a 256k output cap), including bounded shrinking after provider overflow
rejections. It also improves provider prompt-cache reuse and session affinity,
one-shot generation attribution, error classification and media handling. Native
Shell tools add `AGENT=1`, `OPENCODE=1`, default `AI_AGENT=opencode` and the current
`OPENCODE_SESSION_ID`; these native tool conventions are distinct from CodeNomad's
per-send session environment snapshot. Qualification must exercise compaction,
history persistence, side questions and environment propagation, not infer them
from the unchanged HTTP schema alone. Detailed outcomes belong in the PR/CI.

The seven native suites pass on both 2.0.7 and 2.0.19 with the new pins, including
pruning/compaction, history navigation, proxy/relay ownership, automation, per-send
environment, forks, side questions, blank-session cleanup and Git-degraded recovery.
Both historical migrations to 2.0.19 and the isolated native npm upgrade pass;
the latter preserves the running 2.0.15 daemon's version and PID.

Ordinary native/UI runs stopped at Vite import with shell exit 116, reproduced
with a 2.0.18 runtime control and the previous dependency pins. Per-import traces
now isolate that phase more precisely. These observations do not establish the
same cause as the earlier heap-corruption exit, or resolve the fixture failure.
The full native/UI acceptance passes when a diagnostic launcher preloads Vite
before the native fixture. That run changes import order, not the assertions or
runtime; it provides acceptance coverage without proving the ordinary launcher
is reliable. Keep both outcomes visible in the PR.

### Previous stable target: 2.0.20

The recommendation and synchronized server/UI client and plugin pins advance to
**2.0.20**; the demonstrated timestamp-based minimum remains **2.0.7**. Authenticated
native OpenAPI adds `GET`/`POST /api/credential` (116 paths, with the previous 115
path definitions unchanged). Credential export/creation remains outside the
workspace proxy; a regression verifies rejection before any upstream request.
Existing components gain optional `Session.StructuredError.response.body` and
connection `status` (`needs_auth`, message and optional URL); the other additions
describe credentials. Published declarations propagate these additions and expose
the plugin's `integration.connection.status` reporting method. No consumed API
requires a production adapter or higher runtime minimum. The UI normalizer retains
the optional response body while keeping the existing display message contract.

Upstream also improves provider error messages, Bedrock/Mistral reasoning blocks,
prompt caching, ChatGPT token-sharing authentication and database-file permissions.
The new CLI `service disabled` setting controls implicit CLI connections; isolated
validation with CodeNomad's real lifecycle confirms explicit `service start` and
authenticated discovery still work with `disabled=true`, without clearing it.
CodeNomad never writes native service configuration to accommodate the setting.

Seven native suites pass on both 2.0.7 and 2.0.20 with the new pins. Native/UI
acceptance also passes through the ordinary launcher, without Vite preloading.
This passing run does not identify or fix the intermittent Windows import failure
documented above. Historical migrations, standalone plugin acceptance and isolated
npm upgrade pass; upgrade preserves the running 2.0.15 daemon's version and PID.
Detailed test counts, environment and final review/CI outcomes belong in the PR.

### Previous stable target: 2.0.21

The recommendation and synchronized server/UI client and plugin pins advance to
**2.0.21**; the global minimum remains **2.0.7**, and Codex Usage's feature-local
credential-list requirement remains **2.0.20**. Authenticated native OpenAPI keeps
116 paths: only form cancellation changes, with an optional `message` query and
optional `message` in cancelled `Form.State`. Existing cancellation without a
message remains supported. A synthetic native fixture verifies session/global
cancellation both ways, including exact preservation of URL-sensitive text.

Published declarations change in two client files, one protocol file and one
schema file; all 60 plugin declaration files are unchanged. No new consumed API
or required field justifies an adapter or higher minimum. Plugin optional OpenTUI
peer floors advance to 0.5.14; CodeNomad does not install these terminal peers.
The release also fixes provider context-overflow classification, passthrough and
prompt-cache behavior, avoids reinjecting ancestor instructions, adds namespaced
session identity headers to provider requests, and makes native browser tools
conditional on desktop attachment. CodeNomad's own automation acceptance passes.

Seven native suites pass on both 2.0.7 and 2.0.21 with the new pins. The native
Codex Usage fixture also passes on 2.0.21 with synthetic credentials and mocked
quota HTTP. Ordinary-launcher native/UI acceptance, standalone plugin acceptance,
historical migrations and isolated npm upgrade pass. Upgrade leaves the running
2.0.15 daemon and PID unchanged. The full server run has one Windows Git-fixture
cleanup `EPERM`; its unchanged focused rerun passes. Retain this failure and the
historical intermittent Vite/import limitation rather than claiming either fixed.
Detailed counts, review and CI outcomes belong in the PR.

### Current stable target: 2.0.22

The recommendation and synchronized server/UI client and plugin pins advance to
**2.0.22**. The general minimum remains **2.0.7**, and Codex Usage's native
credential-list requirement remains **2.0.20**. Authenticated native OpenAPI keeps
116 paths, adding optional `parentID` and a parent-not-found response to session
creation. A native fixture confirms that this variant ignores the supplied
location and inherits the parent's directory. CodeNomad does not consume it:
the workspace proxy rejects any `parentID` on creation before native forwarding,
including an owned parent or malformed value. Creation requires an inspectable
JSON object rather than an opaque body; ordinary owned root creation and the
existing ownership-checked fork API remain available.

Other schema changes add optional provider `headerTimeout`, allow `false` for
`chunkTimeout`, and make configured model capability overrides partial. Published
declarations change in 4/30 client, 2/60 plugin, 3/36 protocol and 4/102 schema
files. Plugins additionally expose native session removal and compaction;
CodeNomad adds no new plugin operation or proxy route. Runtime changes include
header/chunk/whole-response timeout handling and bounded timeout retries, provider
cache/error/tool-history fixes, MCP shutdown cleanup and forward-compatible model
capability defaults. None establishes a new consumed API dependency.

Windows qualification with Node 24.20.0 passes the seven native suites on both
2.0.7 and 2.0.22, plus the explicit proxy suite. Native/UI pruning acceptance
passes using the committed parent runner and #828's early dependency import order.
This is an import-order harness workaround, not proof of repairing the underlying
Windows heap corruption. Standalone plugin acceptance, historical migrations from
2.0.3 and beta-19271, and native Codex Usage pass on 2.0.22. Native npm upgrade
installs 2.0.22 while retaining the running 2.0.15 daemon's version and PID.
The compaction-isolation fixture additionally passes on 2.0.22, preserving a
second session's progress while the first provider response is held. Detailed
test counts, limits, independent review and remote CI results belong in the PR.

### OpenCode 2.0.24 qualification

Client/plugin pins and the recommended target are **2.0.24**; the technical
minimum remains **2.0.7**. The authenticated isolated Windows daemon exposes 117
OpenAPI paths (116 on 2.0.22), adding `/api/vcs/init`. Its 167 structural schema
changes predominantly declare `LocationNotFoundError` on location-sensitive
routes; other changes add optional `ServerInfo.capabilities.persistentPty`, a
literal WorktreeError `_tag` and the VCS-init error. No proxy route is added.
Published declarations change in 11/30 client files (+service-probe), 3/60
plugin files, 8/36 protocol files and 3/102 schema files (three retired legacy
IDE/question declarations removed). CodeNomad does not import those removed
declarations or adopt VCS init. None demonstrates a higher blocking minimum.

Native service contender/probe and persistent-PTY handoff internals changed,
but CodeNomad still uses its selected CLI status/start/password adapter and
bounded authenticated registration fallback, not SDK `Service.ensure/stop`.
These upstream changes do not authorize automatic replacement/restart of the
shared daemon. The existing lifecycle and proxy regressions remain applicable.

The source review also accounts for behavior changes beyond generated APIs:

- Non-native compaction can select the configured compaction agent's model and
  budget; native compaction keeps its native path. CodeNomad delegates compaction
  to OpenCode and does not reproduce that selection. The isolation fixture tests
  concurrent progress, not every alternate summarizer-model configuration.
- ChatGPT temporarily stops remote `/models` synchronization and uses the native
  fallback catalog; local providers share discovery/cache logic and automatic
  defaults prefer text-capable models. CodeNomad consumes native catalogs and
  connection metadata, not those internal discovery implementations. Synthetic
  usage/account tests do not certify real provider availability or OAuth login.
- MCP retries are bounded to transient connection/read-only catalog failures;
  OAuth callback success waits for token exchange. These remain native-owned:
  no CodeNomad mutation replay or credential-secret read is introduced.
- Windows instruction ancestry now compares directory identity case-insensitively;
  skill frontmatter accepts `disable-model-invocation`. Native instruction/skill
  resolution remains authoritative. Subagent completion inserts paragraph breaks
  between text blocks; this changes text, not the message/event envelope.
- Persistent PTY runtime directories move under native state, with availability
  advertised in server metadata and best-effort restart handoff. CodeNomad does
  not select those directories or initiate handoff during connection. No live
  desktop terminal-survival test across a service restart is claimed here.

These changes are not grounds for a higher minimum or a runtime allowlist.

Windows validation uses Node **25.2.1** and Bun **1.3.14**, not the Node version
recorded for the preceding qualification. Twelve isolated 2.0.24 suites pass:
automation, pruning, Location/worktree/proxy/event relay, environment, fork,
aside, degraded Git, prompt skills, provider usage/accounts, permission receipts
and blank-session cleanup. The same 2.0.24 client/plugin dependencies pass nine
isolated suites on the minimum 2.0.7 runtime: automation, pruning,
Location/worktree/proxy/event relay, environment, fork, aside, degraded Git,
prompt skills and blank-session cleanup. Provider usage/accounts and permission
receipt suites remain operation-specific current-runtime checks, not new global
minimum claims. A real 2 MiB synthetic compaction passes with a
second session completing before releasing the first session's provider and
with the pruning outline enabled. Shared server/UI/plugin builds and typechecks
pass. The 37 pending-request UI tests and browser interruption regressions cover
unsupported capability, partial recovery, compaction, reconnection, settlement,
late responses and editor drafts.

The broad UI unit run reports 1189 passes and two failures, reproduced unchanged
from the base revision in an extracted source tree: `classic-dark-surfaces`' old
accent-hover expectation and `tool-content`'s copy-text expectation. Neither test
path imports the runtime client (its OpenCode imports are type-only). Do not
describe that suite as green or fold unrelated UI fixes into this qualification.
Detailed receipts, package integrity hashes and command logs belong in the PR.

### Capability-checked loaded-only pending recovery

The bundled pruning entry also registers the fixed read-only
`codenomad.pending-requests.snapshot` RPC under its existing backend-presence
lifecycle. Registration requires the actual native RPC capability, not a runtime
or Effect version allowlist. Each read validates the native graph/queue contracts
below and fails non-authoritatively if they are absent or incompatible. Tested
versions are evidence, not permission to block an untested version. The global
minimum remains **2.0.7**. Existing pruning/history
methods retain their own support and write checks.

The reader uses private native LocationServiceMap, Location, Form and Permission
services, scoped existing-only leases and repeated inventory/object-identity
checks. It preserves global/idle Forms and native numeric JSON codecs, returning
complete coverage (including empty cold directories) with actual caller
`originDirectory`. Bounds are 64 requested directories/selected placements,
2048 loaded keys, 1024 Forms and Permissions per placement/directory, 4 MiB
UTF-8 output and a two-second reader deadline. The broker's 30-second overall
deadline includes bounded Git ownership revalidation (eight directories at a
time through the existing Git worker). Overflow or unsafe serialization
fails rather than truncates. This remains unsupported internal coupling;
qualification must distinguish untested contracts from demonstrated failures.
An unfamiliar label alone never disables the reader.

The UI sends at most eight directories per request, also retaining the escaped
URL budget, to bound Git-heavy historical authorization within its independent
ten-second request deadline. This imposes no whole-history scan deadline or
completion guarantee on arbitrarily slow filesystems. The broker rejects
overflowing raw JSON numbers before coverage/capability admission, including
unknown metadata; native numeric codec strings remain unchanged.

`GET /api/workspaces/:id/pending-requests` retains its existing UI wire shape and
uses only the authenticated connection's fixed
`POST /api/rpc/codenomad.pending-requests/snapshot?location[directory]=<root>` with
`{ "input": { "directories": [...] } }`. The root comes from the established
workspace's owned native Location, never startup environment or a submitted
candidate. The broker validates requested directories/common-repository identity,
native execution-host origin, full coverage and every returned placement,
including cold/empty authority and WSL translations/aliases. Legacy workspace
identities are rejected rather than erased. Workspace/connection replacement,
root and candidate deletion and changed directory authority fence dispatch and
publication. Cold UI coverage synthesizes a location from the validated native
entry directory, not the browser's alias.

Only HTTP 400 with a bounded, declared native `RpcError` type `rpc.unavailable`
or `rpc.method_not_found` means `supported:false`. Plain 404s, malformed output,
authentication failures, reader errors, timeouts and overflow return
non-authoritative 503s; they neither clear queues nor retry native mutations.
Successful capability negotiation is connection-scoped and occurs only after
all origin/coverage/placement checks. The existing compaction guard defers an
unverified capability before inventory work and again before forwarding. It
cannot probe during an observed compaction until capability was previously
verified; this conservative hold is intentional. On **every runtime version**, a
missing capability retains known requests and reports incomplete recovery. It
never triggers ordinary queue lists across historical/inactive worktrees. Only
settlement reconciliation reads the explicitly authorized request location;
this does not certify automatic discovery of missing requests on unsupported
daemons. Rehydration retains known queues and drafts until authoritative
coverage or settlement; bounded snapshots never retire settlement tombstones.
No general RPC proxy, native pending-API
dependency, provisioning mutation, reload or service restart was added.

Candidate traversal does not construct cold Locations. Native HTTP middleware
may still warm/rebuild the single bootstrap root before handler execution;
root eviction/config rebuild is not a construction-free guarantee. Snapshots
can stale after leases release or transport, so existing per-kind mutation
fences and settlement tombstones remain essential. This work does not fix
existing graph/Bus/TUI CPU costs or claim live desktop acceptance. Isolated
published production-loader/authenticated-router proof and ordinary bundle
resolution are separate from desktop deployment qualification; detailed checks
and receipts belong in the PR.

The 2.0.22→2.0.24 source audit finds unchanged LocationServiceMap, Form,
Permission, RPC handler and queue schemas; LocationServiceMap's implementation
wrapper changes only its TypeScript error parameter. Effect stays rc.112.
The published production-discovery/authenticated-router fixture passes separately
on 2.0.22 and 2.0.24, including three actual Git worktrees and 100 cold candidates:
four preloaded Locations remain four, and native boot logs show no additional
Location construction. Active/idle permissions and ordinary/global Forms are
recovered, and absent/expired/returning backend presence follows the existing
lifecycle. These results are not exhaustive qualification of every runtime.
Untested, future/custom or missing version labels do not block registration;
RPC and graph/queue capability validation remain mandatory on each read.

After removing the unjustified version gate, the native fixture passes on
**2.0.23 and 2.0.24**, with the same 100 cold candidates, three actual worktrees,
four retained Locations/native boots and recovered global queues. All 29 focused
reader/broker/admission tests pass. Registration tests cover 2.0.7–2.0.24,
future/custom/prerelease/missing labels and a throwing `app` getter to ensure
version metadata is never consulted. The tagged 2.0.7–2.0.24 source comparison
finds unchanged existing-only LocationServiceMap and queue-list contracts;
older changes affect cancellation/rejection feedback and types, not this read.
No source or test evidence justified the removed version allowlist.

Deployment acceptance remains separate. After deploying the new CodeNomad
bundle, observe passive request recovery with inactive worktrees: compare native
Location boot/eviction counts and process RSS/private memory over a comparable
window, recording explicit user actions separately. An explicitly confirmed
shared-service restart may release Locations accumulated before the fix; neither
an upgrade nor this recovery code restarts or evicts them automatically. Without
a memory profile, do not attribute the entire observed 10 GiB to this fallback.
