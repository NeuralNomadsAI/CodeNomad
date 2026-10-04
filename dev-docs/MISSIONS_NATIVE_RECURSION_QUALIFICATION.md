# Native recursion / continuity qualification — independent lane 4

Executed 2026-10-03 against the assigned **OpenCode 2.0.22** binary and installed
2.0.22 client/plugin types. Private runtime experiments, **not production trust
qualification or a unilateral architecture decision**.

## NEW ENV evidence follow-up — two runs, not a historical retrofit

This section closes the evidence-retention/full-map measurement gap identified
in the independent review
`C:/Users/Admin/AppData/Local/Temp/opencode/qualification-lane4-independent-3d3dd593-51db-44fc-b9aa-2e9aa416762e/REPORT.md:62–93`.
**Architecture verdict remains deferred.** Other lanes and their lifecycle,
restart, shell-effect and General-policy observations were not rerun or changed.

The old foreground continuation input count/hash/time remain **UNKNOWN in its
old artifacts**. Khag6I's old recursive trace still has no snapshot hash. New
measurements do not backfill either observation. The original 16-run
`qualification/RESULTS.json` remains byte-identical, SHA-256
`e389b2fa34ef2c9ecf52cf57fe1b64d6e01d99cee707349a8edc04ca1ad2fa81`.
The older material below is historical qualification, not full-process ENV
round-trip equality evidence.

### Executed scope and new records

Only these two new private native commands ran, from the experimental directory:

```powershell
node scripts/native-subsession-spike/qualification/environment-crash.mjs
node scripts/native-subsession-spike/qualification/recursion.mjs environment
```

| Current run | Private root suffix | Requests / sessions / events | Result |
| --- | --- | --- | --- |
| Two real ENV crash boundaries plus explicit fresh same-child continuation | uBSkac | 10 / 4 / 177 | Complete |
| Simultaneous A/B, child/grandchild, A2 root/continuations and backend detach | Ei4hDW | 42 / 11 / 552 | Complete |

Both roots have prefix
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-`.
**52 new provider requests, 12 clean native Tool/API process-map pairs**: the
seven recursive descendant calls, three additional root probes, and fg/bg
post-crash continuation. Four raw-inheritance child/grandchild pairs and two
post-restart startup-baseline probes also retain complete fingerprints as negative
controls. Neither native run failed or was repeated to obtain equal maps.
The existing 230-second/200-request bounds, one private serve at a time,
assigned executable/authenticated 2.0.22 check, credential-key stripping, private
HOME/config/DB and exact-owned-handle cleanup remained unchanged.

New append-only run records are in
`scripts/native-subsession-spike/qualification/ENV_FOLLOWUP_RESULTS.json`.
They contain execution-time source hash maps, exact result/raw-artifact hashes,
same-call input timing, immutable backend frames and complete per-key value
hashes. `ENV_FOLLOWUP_VERIFICATION.json` is the offline verifier's bounded summary.
The original aggregate was not regenerated with the historical summarize command.

Offline-only commands (no further native execution):

```powershell
node scripts/native-subsession-spike/qualification/environment-evidence.test.mjs
node scripts/native-subsession-spike/qualification/environment-contract-inventory.mjs
node scripts/native-subsession-spike/qualification/record-environment-followup.mjs C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-uBSkac
node scripts/native-subsession-spike/qualification/record-environment-followup.mjs C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-Ei4hDW
node scripts/native-subsession-spike/qualification/verify-environment-followup.mjs
```

The first offline check reproduced the **expected failed-before** lookup on the
actual old `8LpPg8/results.json` foreground readmission, without changing that
file. It then checked immutable retention, exact call/child/message correlation,
conflicting Windows-case aliases and complete missing/extra/mismatch detection.
`ENV_FOLLOWUP_OFFLINE.json` retains that old artifact's hash and the results.

### Every backend lifetime retained; same-call ENV dispatch before provider

The backend now captures fresh settings-read counters and a complete source
fingerprint immediately before the actual native `session.environment` call.
Every dispatch has its own `backendID`, backend generation, source-read ordinal,
dispatch ID, phase and native binding. Immutable frames are retained before
closure and after closure; crash continuations additionally assert their exact
write is already retained **before cleanup/reference replacement**.

uBSkac retains all four backend lifetimes in twelve immutable frames. Each
original admission and each fresh continuation is independently measured, not
borrowed from its sibling. All four complete inputs have **83 canonical keys**
and independently recorded hash
`114221c7fc09d4f81b1c876499200e17b2b0acb47640fd6cfb5a30f181057e59`.

| Call | Backend generation / read ordinal | Dispatch time | Written time | First child provider |
| --- | --- | ---: | ---: | --- |
| fg_write_settlement | 1 / 2 | 1791005656748 | 1791005656751 | None before crash |
| fg_write_settlement_continue | 2 / 2 | 1791005658334 | 1791005658337 | index 2, 1791005658364 |
| bg_after_env_receipt | 3 / 2 | 1791005659678 | 1791005659681 | None before crash |
| bg_after_env_receipt_continue | 4 / 2 | 1791005661636 | 1791005661640 | index 7, 1791005661664 |

Foreground actual child is `ses_effbe8000ffeVoIuJW1CiQWTki`, fresh parent owning
message `msg_100418c5d0019aHS5Oeiulnrbs`, backend
`1e7715f2-300f-4311-80a2-a9d88d54770a`. Background actual child is
`ses_effbe6f24ffepaFeGoZMepSkU7`, fresh parent owning message
`msg_1004198bb001dcBTCC2xtygpFD`, backend
`293267d1-772b-4395-aa86-6b472873b075`. Both fresh bindings have root policy
generation 3. Tool/API owning message IDs are also recorded independently.
Both real daemon replacements restore the unsafe startup baseline; both stale
native wakes still produce **zero child model requests** before explicit fresh
admission. Original assignment replay remains false and duplicate births zero.

For Ei4hDW, hash abbreviations below mean these **newly measured** full hashes:

* A1: `6813aa6433a74b5060e8705c2a55db7b68d0eb62c5e1f5e30abf8bd761aa2098`
* B1: `23b76cbfe8e75fad62c95f6d15283e3db288416b64d7d0636b1619f75aa5dcf1`
* A2: `f23e643cdfb61bf83a3bb216b7c1096cbead1707e48a41a205b113cd51037c20`

All writes use backend `bada2e8f-c8f9-47c4-aa62-4868b11b001f`, generation 1;
each descendant binding has root policy generation 2. Root ENV writes are direct
owned fixture API writes, not invented subagent bindings: their root/source
ordinal/timing and actual subsequent Tool/API message identities are recorded;
there is deliberately no parent-tool message ID for those root writes.

| Call / root probe | Source ordinal | Input count / hash | Written time | Provider index / time |
| --- | ---: | --- | ---: | --- |
| root_A1 | 1 | 84 / A1 | 1791005936791 | 0 / 1791005936831 |
| root_B1 | 2 | 84 / B1 | 1791005940055 | 8 / 1791005940076 |
| clean_A1 | 3 | 84 / A1 | 1791005942703 | 18 / 1791005942737 |
| clean_B1 | 4 | 84 / B1 | 1791005942826 | 19 / 1791005942844 |
| clean_grand_B1 | 5 | 84 / B1 | 1791005943720 | 22 / 1791005943741 |
| clean_grand_A1 | 6 | 84 / A1 | 1791005943949 | 23 / 1791005943969 |
| root_A2 | 7 | 83 / A2 | 1791005945798 | 30 / 1791005945820 |
| clean_continue_A2 | 8 | 83 / A2 | 1791005946289 | 32 / 1791005946311 |
| clean_grand_continue_A2 | 9 | 83 / A2 | 1791005946902 | 34 / 1791005946921 |
| detach_bound | 10 | 84 / B1 | 1791005949628 | 39 / 1791005949646 |

Simultaneously held A/B children were released before their independently bound
grandchildren; A2 root and same-child/grandchild continuation replace A1 and
remove the retired variable. Already-admitted B1 completes after real backend
closure. Every configured synthetic key, including a Unicode/newline/space value,
matches its own complete source-input value hash in both process entrypoints.

### Complete process maps: equality is FALSE, not an exclusion-based pass

The **same function** fingerprints the full manager-built dispatch map and the
full `process.env` inside actual native shell Tool / `session.shell` processes.
It uppercases Windows keys, sorts them ordinally and SHA-256 hashes exact
key/value pairs; values are never normalized. It records raw and canonical
counts, aliases, full-map hash and every key's value hash. Conflicting aliases
throw; identical-value aliases remain explicitly represented. No key is excluded
to manufacture equality. No complete value map or credential value is dumped.

Across **all twelve** clean process pairs:

| Comparison | Missing source keys | Extra runtime keys | Changed source values | Full-map equality |
| --- | --- | --- | --- | --- |
| Complete input → Tool | None | OPENCODE_SESSION_ID, OPENCODE_TERMINAL | PSMODULEPATH | **false** |
| Complete input → session.shell | None | OPENCODE_TERMINAL | PSMODULEPATH | **false** |
| Tool → session.shell | OPENCODE_SESSION_ID | None | None | **false** |

All source keys except the recorded `PSMODULEPATH` difference have equal value
hashes. **All-source-key equivalence is nevertheless false**; configured-owned
variable equivalence and complete-input dispatch verification are true. `PATH`
does not differ. All seven private password/bootstrap/storage keys in
`EXPECTED_ABSENT` are absent from both complete process maps: 168 checks over
24 clean process maps. Native/session Tool/API *selected-variable* agreement from
older tests must not be expanded into complete-map equality.

The new recursive run also captures the complete **84-key private startup map**.
An offline comparison of every fresh dispatch with that same-run map verifies
that **all 81 retained base keys have identical value hashes**, exactly
`OPENCODE_DB`, `OPENCODE_SERVER_PASSWORD` and `XDG_STATE_HOME` are removed, and
only the two/three explicitly configured synthetic profile keys are added.
Among credential-pattern names the startup map contains only the newly generated
private harness password; none survives dispatch. This directly measures complete
base-map preservation and stripping, rather than inferring it from two markers.
`baseEnvironmentComparisons` in the verification JSON preserves each full diff.
The shared harness strips ambient credential-pattern keys before private startup;
profiles contain dummy data, not user credentials. Per-key hashes remain private
evidence, not a claim that hashing actual user secrets would be safe.

Exact full hashes for the new crash continuations illustrate the distinction:

| Entry | Keys | Full canonical SHA-256 |
| --- | ---: | --- |
| Each independently captured complete source input | 83 | 114221c7fc09d4f81b1c876499200e17b2b0acb47640fd6cfb5a30f181057e59 |
| Foreground Tool process | 85 | 8c661d3a72c56a463fa5a7c84e3fdb933aa78c064d92a75df77939a457423104 |
| Foreground session.shell process | 84 | 3a8933071cd26a8033a060f0d62618958998314a1bc4ee58bb0c607c4e2ec643 |
| Background Tool process | 85 | 00d838951c931f9d9d9da11f49d71a45e4f01c1c168fb0645c00afcece8b684f |
| Background session.shell process | 84 | 3a8933071cd26a8033a060f0d62618958998314a1bc4ee58bb0c607c4e2ec643 |

For initial A1/B1, input/Tool/API counts are 84/86/85; A2 counts are 83/85/84.
Every remaining full process hash and per-key hash is retained in the new JSON
records; none are replaced with these example hashes.

Differences were investigated rather than dismissed. A **read-only** scan of
the assigned binary (SHA-256
`036a92f886fb4b738921ba29b21e490148c3f01ec73d772a920ba951b76cf0b4`)
found embedded native implementation at byte offsets 150568998 and 150068567:
the Tool assigns `D.env.OPENCODE_SESSION_ID=U.sessionID`, while shell creation
overlays `TERM="xterm-256color"` and `OPENCODE_TERMINAL="1"` on the session map.
The actual per-key hashes match the exact child/session ID and literal `1`;
these checks are in the offline verifier. This is static native implementation
evidence plus process measurements, not another native command or invented API.
`ENV_NATIVE_CONTRACT.json` preserves the fragments/offsets and binary hash.

Actual events name `C:\Program Files\PowerShell\7\pwsh.EXE`. Microsoft's
[PSModulePath documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.5)
documents reconstruction on every PowerShell startup. The exact machine-specific
transformation is still **UNKNOWN**; its mismatched value hashes remain present
and are not whitelisted/excluded. No process ENV identity guarantee is asserted.

### Changed-path / hash handoff for ENV-only re-review

Only three existing test sources changed: `backend.mjs` (full dispatch/retention
instrumentation), `environment-crash.mjs` (retain both fresh backends and Tool/API
probes), and the ENV branch of `recursion.mjs` (full probes plus root measurements).
Native gates, permissions, lifecycle flags, production ENV API, shared helpers,
original source and other lane files remain untouched.

New test sources under the same qualification directory are
`environment-evidence.mjs`, `environment-evidence.test.mjs`,
`environment-contract-inventory.mjs`, `record-environment-followup.mjs`, and
`verify-environment-followup.mjs`. New evidence files are `ENV_FOLLOWUP_RESULTS.json`,
`ENV_FOLLOWUP_OFFLINE.json`, `ENV_FOLLOWUP_VERIFICATION.json` and
`ENV_NATIVE_CONTRACT.json`. This document is the only changed report document.
The machine-readable aggregate includes **every** old-review/current source hash,
all changed source paths with before/after SHA-256, and this report's before/after
hash. Run-specific execution hashes are immutable; a diagnostic module added
between/after runs is not retroactively included in an earlier execution hash.

Both runs and final offline verification rehashed **2,225 primary and experiment
common files**, zero differences, digest
`6b8fa087eb40b0fbbe5ff08f39474708f5d820086d53bcb35e33a3c7cd13bfb4`.
Primary index remained
`21a5beee4071a842ef888dfbbfecfcc95cc42b69b378dff0268031ffbac222db`.
No old Temp artifact, historical hash claim, primary doc/source/index, other lane,
shared daemon, user storage or installation was modified. Production trust and
architecture conclusions remain outside this ENV-only follow-up.

## Historical 16-run qualification (retained below)

## Decision-relevant result

Native children are viable beyond depth one. Foreground depth-3 results,
concurrent deeper foreground/background families, and explicit same-child crash
continuations actually executed. The old absence of `session.create.parentID`
does **not** describe 2.0.22: authenticated current OpenAPI advertises it, and an
API-linked depth-3 family also executed a real model turn.

The serious limitations have narrower, tested workarounds:

* Clean profile ENV does not inherit and **does not survive daemon replacement**.
  Actual pre-first-provider descendant admission writes a fresh complete owned
  snapshot; a plugin-lifetime/generation fence rejects stale receipt wakes until
  explicit fresh admission. This worked for children/grandchildren, A/B concurrency,
  continuation/profile replacement, backend detach and two real ENV crash boundaries.
* Root interrupt cancels attached foreground execution through depth 3. It does
  not revoke background children or prevent their native notification wake.
  Durable native context gating prevented new provider requests after Stop;
  explicit bounded-family interrupt/inbox cancellation and explicit Play worked.
* **Model gating is not OS-process suspension.** Already-running Windows Node
  descendants performed their marker effects even after native interrupt or
  exact native `shell.remove`. These red observations are retained. Arbitrary
  shell side-effect suspension is not qualified.
* Raw authenticated `session.shell` bypasses model/tool hooks. The owned backend
  admission boundary rejected stopped-family shell/prompt requests before effects.

These findings support continued native-first/foreground integration research,
not abandoning all native children because background/OS guarantees are narrower.
They do not enable the existing product child dispatcher or close production gates.

## Reproduce

Use **only** working directory
`D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003`:

```powershell
node scripts/native-subsession-spike/qualification/recursion.mjs recursion
node scripts/native-subsession-spike/qualification/recursion.mjs permissions
node scripts/native-subsession-spike/qualification/recursion.mjs environment
node scripts/native-subsession-spike/qualification/general-policy.mjs
node scripts/native-subsession-spike/qualification/lifecycle.mjs
node scripts/native-subsession-spike/qualification/restart.mjs
node scripts/native-subsession-spike/qualification/environment-crash.mjs
node scripts/native-subsession-spike/qualification/entrypoints.mjs
node scripts/native-subsession-spike/qualification/shell-effects.mjs
node scripts/native-subsession-spike/qualification/graceful-handler.mjs
```

Each command has a 230-second private-server watchdog, bounded requests/waits,
200-provider-request ceiling, and depth cap 3. Each lane invocation used at most
one private serve process at a time; no sentinel was used. Cleanup owns exact
ChildProcess handles. Shell probes self-expire within eight seconds. No service
discovery/start/stop/ensure, shared daemon, application, user DB, installation,
upgrade, Vite cache, source mutation, staging, commit or push was used.

The assigned executable is
`C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe`,
launched only as `serve --hostname 127.0.0.1 --port 0 --print-logs`. Version and
OpenAPI are read via authenticated HTTP on that exact child. HOME/USERPROFILE,
APPDATA/LOCALAPPDATA, XDG, config, DB and project are private. Inherited OpenCode,
CodeNomad, XDG and WSL context is removed; current harness also drops credential-
bearing environment variable names without inspecting their values. Configuration
discovery, model fetch and updates are disabled. The provider is deterministic
loopback SSE with synthetic data, not a user account or real LLM.

The read-only existing isolation helper is imported; its old version-asserting
launcher is **not** used. Missing workspace-local installed dependencies are
resolved read-only from the original server dependency directory via Node's
resolver hook, without installs, junction changes or source redirects. TSX cache
is disabled, and temporary directories are private. No existing candidate file
was modified.

## Executed commands / artifact index

All roots below have prefix
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-`.
`qualification/RESULTS.json` is the machine-readable aggregate; it retains every
failure, matrix record, native consumption index and hash measurement.

| Command / attempt | Root suffix | Requests / sessions / events | Result |
| --- | --- | --- | --- |
| `recursion.mjs`, first | SlIXMX | 0 / 0 / 0 | Old no-parentID assertion disproved |
| `recursion.mjs`, second | wiQsSe | 4 / 2 / 56 | Default native depth limit reached; exact config knob recorded |
| `recursion.mjs`, third | XkNPCJ | 29 / 15 / 349 | Three recursion cases passed; contaminated General negative assertion failed |
| `recursion.mjs permissions` | znvkjp | 20 / 9 / 234 | Complete; permissive General observation is not a negative control |
| `recursion.mjs environment`, first | nXXDqv | 0 / 0 / 0 | Missing workspace-local fuzzysort; no installation attempted |
| `recursion.mjs environment`, second | Khag6I | 39 / 11 / 499 | Complete recursive fresh ENV / detach experiments |
| `lifecycle.mjs` | tR2OkJ | 34 / 25 / 455 | Complete raw and guarded lifecycle experiments |
| `restart.mjs` | aHtzji | 30 / 18 / 419 | Complete six crash boundaries and explicit continuations |
| `shell-effects.mjs`, first | MVBlF2 | 4 / 4 / 59 | Shell inventory queried wrong Location; retained failure |
| `shell-effects.mjs`, second | RVJCZc | 8 / 8 / 138 | Expected OS cancellation disproved by actual effect |
| `shell-effects.mjs`, third | NkXFan | 30 / 20 / 412 | Five measured OS-effect limits; not green cancellation claims |
| `environment-crash.mjs`, first | pelAK7 | 10 / 4 / 159 | ENV volatility and fresh re-admission measured |
| `environment-crash.mjs`, second | JPwpQA | 10 / 4 / 167 | Added actual stale-receipt native wake rejection |
| `entrypoints.mjs` | WwfCfP | 5 / 4 / 79 | Raw shell bypass, owned admission rejection and detach-before-gate |
| `general-policy.mjs` | u2dKQg | 3 / 2 / 48 | Real uncontaminated builtin-General negative control |
| `graceful-handler.mjs` | VmLlDu | 2 / 2 / 37 | Existing native SIGTERM handler: natural exit and plugin disposal |

**16 runs, 10 complete experiment runs, 6 preserved fixture failures, 228 provider
requests total**; never 228 in one run. The aggregate command was:

```powershell
node scripts/native-subsession-spike/qualification/summarize.mjs WwfCfP u2dKQg VmLlDu
```

Each root retains `results.json`, authenticated `openapi.json`, actual
`requests.json`, `events.json`, bounded `transcripts.json`, `sessions.json`,
`inboxes.json`, `hooks.jsonl`, `catalog.json`, `backend-trace.json`, `serve.log`,
the generated exact plugin, private DB and independent filesystem markers.
Crash-phase ENV traces also live in `results.json.allBackendTraces`.
Private auth material stays private; reports contain identities, booleans,
synthetic markers and complete snapshot hashes, not credential values.

## Structured qualification matrix

| Capability | Status | Actual observation / scope |
| --- | --- | --- |
| Legal custom `mode=all`, explicit recursive permission, depth=3 | SUPPORTED | Root → child → grandchild → great-grandchild; native tools invoked by provider SSE, not `tool.execute` test doubles |
| Default depth=1 | OBSERVED_LIMIT | Native error explicitly names `experimental.subagent_depth`; increasing it to 3 worked |
| Foreground leaf result consumption | SUPPORTED | Each immediate parent issued a subsequent provider request containing the leaf report; index links are in aggregate JSON |
| Concurrent deeper fg/bg under one parent | SUPPORTED | Distinct actual native call/message/child bindings, two held deep leaves concurrently active |
| Nested background notification consumption | SUPPORTED | Immediate parent's subsequent real provider request contains the leaf result; root idle is not family completion |
| Current `session.create({parentID})` | SUPPORTED | Current OpenAPI plus real API-linked depth-3 execution; not claimed equivalent to permission-controlled tool launch |
| Builtin General negative control | SUPPORTED | u2dKQg has no global `* allow`; native subagent tool filtered, zero nested births. Earlier permissive case intentionally excluded |
| Denied subagent / primary-only mode | SUPPORTED | Native error and zero child binding/birth; wrapper preserves native permissions and selection |
| Permission birth snapshot | SUPPORTED | Shell deny inherited by child and grandchild. After parent allow, same child remains denied; a newly born child has shell |
| Raw child profile inheritance | OBSERVED_LIMIT | Child/grandchild see daemon baseline, not A/B owned roots' cleaned snapshots |
| Fresh complete descendant ENV admission | WORKAROUND_TESTED | Before first child provider, authenticated backend validates exact stored call/message/parent chain, owned Location and deletion identity, then real manager snapshot + native ENV API |
| Concurrent A/B, same-child/grandchild continuation, A2 replacing A1 | WORKAROUND_TESTED | Tool shell and native session.shell agree; removed marker absent; private DB/password/XDG state variables absent |
| Backend detach after admission | SUPPORTED | Already-admitted native child completes with cleaned snapshot; no backend required for its existing execution |
| Backend detach before admission | WORKAROUND_TESTED | Child birth may exist; native tool errors before child provider request. Birth is not authorization or successful admission |
| Raw foreground interrupt at depth3 | SUPPORTED | Root and all three attached descendants become inactive with `interrupted` outcomes |
| Raw background root interrupt | OBSERVED_LIMIT | Child family remains active; real late native notification causes another root provider request |
| Durable Stop + native context gate | WORKAROUND_TESTED | Actual late root wake rejected at context boundary; zero new provider requests across known family |
| Captured executable after Stop | WORKAROUND_TESTED | Native execute.before gate rejects pre-Stop captured shell; independent forbidden marker absent |
| Pause explicit bounded-family interrupt / inbox cancel | WORKAROUND_TESTED | Explicit native receipts, known-family interrupts and pending inbox cancellation; not atomic recursive suspension |
| Explicit Play | WORKAROUND_TESTED | Same child ID continued; parent really consumes result; no automatic assignment replay |
| Stop irreversibility / daemon replacement | WORKAROUND_TESTED | Running-after-stopped control rejected; native plugin storage rehydrates generations; post-restart synthetic admitted but zero provider requests |
| Pending Forms / shell permissions at depth3 | WORKAROUND_TESTED | Actual native question Form and inherited ask permission, interrupted/cancelled/rejected without grant bypass or marker effect |
| Raw post-Stop prompt / synthetic vs consumption | WORKAROUND_TESTED | Native admission can still occur; context/generate hooks prevent consumption. Not an admission veto |
| Raw `session.shell` after Stop | OBSERVED_LIMIT | Actual marker effect despite model/tool hooks; owner must protect this non-model entrypoint |
| Owned descendant shell/prompt after Stop | WORKAROUND_TESTED | Authenticated owned route rejects before native dispatch/effect |
| Crash: creation-before-binding / persisted progress / provider awaiting, fg+bg | OBSERVED_LIMIT | Family identities/transcripts retained, activity gone, zero automatic requests; first gap has no binding. No crash atomicity invented |
| Explicit continuation after six crashes | WORKAROUND_TESTED | Same child, zero duplicate births; new explicit continuation input, not original assignment replay; actual returned text consumed by parent |
| Real ENV write-settlement and receipt-before-provider crash | OBSERVED_LIMIT | ENV not durable: marker absent and private startup-variable presence returns after restart |
| Reject stale ENV receipt wake, then fresh admission | WORKAROUND_TESTED | Plugin-lifetime/generation context fence rejects actual synthetic wake; explicit owned continuation writes a new complete snapshot before provider. Lifetime fence is not native attestation |
| Completed child before parent consumption, graceful handler path | WORKAROUND_TESTED | Existing native SIGTERM listener invoked privately; natural process exit, plugin disposal, same DB child success/report retained. No host force-kill on that path |
| Ordinary Windows OS-signal graceful stop | UNTESTED | No public daemon shutdown endpoint; invoking the existing handler is a tested workaround, not an OS-signal claim |
| Already-running OS effects after gate / interrupt / shell.remove | OBSERVED_LIMIT | NkXFan actual effects occurred in all five fg/bg cases despite zero new model requests; native cancellation ACK is not process-tree effect fencing |
| Atomic new-descendant race, signed production authority, exactly-once business reports | UNTESTED | No fake claims, no background dispatcher or automatic replay added |

## Trust, continuity and interpretation boundaries

The environment seam composes actual `WorkspaceManager.getSessionEnvironment`,
`ownsLocation`, native connection checks, `WorktreeDeletionFence`, fresh settings,
`AuthManager`, authenticated HTTP and actual native session/tool reads. It does
not manufacture product writer attestation, waive production root grants, trim
the environment to two markers, or ship new product entrypoints.

The native wrapper changes only the captured executor; input/schema/options and
native permission path remain native. Progress is observed and its call/child
binding persisted before first child execution in these runs. Native birth,
plugin binding, environment dispatch, receipt and model consumption are separate
boundaries, **not one atomic transaction**. Exact `session.tool.progress` events
remain in raw traces; event arrival alone is not an await barrier.

The monotonic root policy and Stop terminal rule are owned **private fixture**
control state in native plugin storage. Model gates can leave admitted synthetics
and native failed/interrupted outcomes: projection must not reinterpret these as
business task completion or erase terminal Stop. Direct native clients retaining
their authentication remain outside a backend-only mutation fence.

Crash experiments show native identity/transcript persistence, not resurrection
of captured executors. Six explicit continuations produced **zero duplicate child
births**, and no original assignment was auto-replayed. Exactly-once business
assignment/report delivery remains **UNKNOWN**: this lane uses native tool return
text, not a production transactional Mission report protocol. Foreground and
background guarantees must be evaluated separately.

Provider requests and returned `NATIVE_CONSUMED` text prove mechanical consumption,
not a real LLM's comprehension, reliability, or willingness to recurse/report.
No production profiles/accounts, shared storage, actual desktop quit or hostile
multi-owner production scenario was qualified.

## Frozen-source proof

Every run hashed all **2,225** original candidate files in both primary and the
experiment against the rollback manifest. All report zero baseline differences
and unchanged pre/post measurements. Ordered path/hash digest used by this lane:
`6b8fa087eb40b0fbbe5ff08f39474708f5d820086d53bcb35e33a3c7cd13bfb4`.
Rollback manifest's separately encoded digest remains
`0b22cdd75f4f94658620472367cd0cfb9955eaa469b6f0d816b66506f91f1dfa`.
Later phases also measure the untouched primary index before/after:
`21a5beee4071a842ef888dfbbfecfcc95cc42b69b378dff0268031ffbac222db`.
No index mutation command was run. Only this lane's new qualification directory
and this document were written in the experiment; original source/docs unchanged.

## Sources read

* Experimental `AGENTS.md`, `dev-docs/MISSIONS_CONTINUITY_SPIKE.md` and existing
  `test-missions-child-environment.mjs` plus runtime/plugin/backend/admission helpers.
* Installed 2.0.22 Promise client generated types and plugin session/tool hooks;
  each private daemon's authenticated OpenAPI and actual catalogs/provider bodies.
* V2 only: `https://opencode.ai/v2/docs/build/plugins`, `/build/client`, `/agents`,
  `/tools`, `/config`. Current served contract takes precedence over older claims
  or contradictory docs (notably parentID and current permission update shape).
