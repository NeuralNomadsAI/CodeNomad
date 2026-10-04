# Missions autonomy: requirement, not an assumed architecture

The user authorized trial Missions and requested native recursive delegation by
default, with the existing managed-root mechanism only when a needed native
capability is unavailable. The subsequent clarification explicitly treats a
persistent plugin as a hypothesis, not a mandated implementation.

## What must be separate

1. Persisted data: the current MissionJournal already uses native plugin storage
   under `codenomad-missions/v2`. Unregistering tools does not delete that journal.
2. Installation: CodeNomad currently provisions a content-addressed plugin bundle
   and a discovery entry through DesktopPluginLifecycle.
3. Loading: OpenCode owns loading/setup/cleanup for each configured Location.
4. Product availability: desktopPlugin currently follows CodeNomad backend presence
   and disposes Missions tools/RPC/context/outbox when that presence expires.
   The wrapper/module is not necessarily itself unloaded.
5. Execution: native sessions and recursive children run inside OpenCode. Their
   runtime lifetime is not the lifetime of CodeNomad's browser window.
6. Recovery: persisted journal reconstruction is not live execution surviving an
   OpenCode server shutdown, nor automatic safe replay after a crash.

## Candidate, not rollout decision

A minimal configured native plugin could keep entry tools/RPC available while
releasing only per-Mission work when idle. Keeping that entry loaded does not
require a model loop, a workflow engine, a new process or a desktop backend.
Unloading the entire entry at the last completion would require an additional
reliable activation path before the next creation/read; it is not demonstrably
useful yet. The current notification outbox still scans periodically even with
no pending reports; a loaded-idle cost must not be asserted as already optimized.

Retain the existing desktop composition and closed durable-authority rollout.
Do not manufacture qualified native proofs or bypass its ownership gates.
Assess basic autonomy separately from CodeNomad-owned profile environment,
lifecycle controls, permissions requiring an absent human, and packaged hosts.

## Historical trials (superseded corrections retained below)

- Existing native integration runner passed again at
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-WdfWQ2`.
  It exercises actual OpenCode recursion with a scripted model, but uses the
  older `integration_*` seam, not the current full product path.
- `scripts/missions-autonomy/fixture.mjs` loads the actual shared
  `setupMissionsPlugin`, journal, reducer, control and four Mission tools in a
  private OpenCode 2.0.22 server. No CodeNomad backend or presence lease exists.
  It tests declared native work, explicit fallback with the native tool absent,
  observer detachment, report wakeup and private-server storage reconstruction.
- `scripts/missions-autonomy/live.mjs` attempts two-level native recursion with
  the real free `opencode/big-pickle` model and the same shared product. It does
  not copy user credentials. Observer detachment is not a packaged desktop close.
  The first live trial intentionally has no formal task rows, to separate basic
  execution/finalization from the declared-native-report integration gap.

## Actual findings and corrections so far

- Native snapshot RPC failed before even reading an empty map: OpenCode's output
  decoder rejects `not`, then regex `pattern`. Complete known/unknown receipt
  branches now preserve acknowledgement rules without `not`; bounded RPC-only
  shapes avoid regex while strict domain parsers and model input patterns remain.
- A freshly created fallback actor returned `variant: "default"` for an omitted
  requested variant. Exact undefined/default comparison refused the assignment.
  Native matching now normalizes those two equivalent defaults; other agent,
  provider, model and variant choices remain exact. Contract/replay identity
  remains unchanged. Evidence: `missions-child-environment-V4acsx/results.json`.
- Declared native tasks are still blocked at report: the actual child tool
  receives `Native report authority unavailable`; its coordinator then cannot
  finish with an open task. Evidence: `missions-child-environment-NFzz1z`.
  Do not call this a native OpenCode limitation or a successful product trial.
  It is the current product composition's missing report integration.
- Test-harness mistakes were also retained, not attributed to the product:
  model lists use `.data`; tool parts use `.name`; context hooks carry Agent.ID,
  not an Agent.Info object. Initial discovery must wait for plugin activation.

## Fresh shared-product fixture result

`missions-child-environment-JRoxuZ` completed with status
`passed-with-observed-native-report-gap`. The existing fallback completed its
assignment, persisted the report, woke and finished its coordinator without any
CodeNomad backend. The event viewer was detached before the worker reported.
After stopping/restarting only the private OpenCode server, a new client read
back the same two Mission maps. The native task report gap was reproduced and
retained; it was not patched away or reported as success. This uses a scripted
model with actual OpenCode sessions/tools, not a free-running real-model trial.

77 targeted tests pass (no skips), and the changed schemas/execution modules and
their tests pass scoped strict TypeScript. This is not a desktop rollout or final
gatekeeper closure.

## Real-model result: provider refusal, not a Mission outcome

The live trial at `missions-child-environment-4MG7v7` did not start any child or
Mission. Its first model request failed with native `provider.auth`, HTTP 403:
`OpenCode's free tier can only be used from within OpenCode`. The initial runner
missed the terminal event and surfaced a six-minute timeout instead. The retained
`events-before-detach.json` and `serve.log` establish the actual provider refusal.
The runner now stops on that native failure and leaves a capture window before
its watchdog. Do not spoof a first-party client or retry around this restriction.
A genuinely autonomous real-model trial still needs a provider authorized for
this client. The scripted-native fallback pass is not substituted for that trial.

## Fresh native-first product results

The preceding native-report gap is now corrected for the ordinary native path.
The coordinator reads real child conversation returns and records business
settlement through `mission_report` with `taskKey` and no qualified `contract`.
The journal stores `delivery: "coordinator-readout"`, without creating a child
actor, invocation binding, execution-termination proof or notification receipt.
Independent-root reports and the optional stronger native-provenance path remain
distinct. Known unfinished native execution still prevents global green finish.

`scripts/missions-autonomy/shared-live.mjs` uses the existing authenticated native
service and configured **GPT-6.1 Sol**. It does not copy credentials, modify global
config or start/stop the shared service. A fresh trial-only Location loads the
compiled actual shared core; it is not a desktop-composition qualification.
`missions-gpt-trial-pR5OLe` passed one native declaration, real child/grandchild,
native results, coordinator readout and global completion. All three native
sessions retain GPT-6.1 Sol; descendants never call `mission_report`.

The experiment found and corrected a missing RPC delivery enum and an incorrectly
derived pending-notification status for coordinator readouts. Those have dedicated
regressions. `missions-child-environment-p6k8It` now passes both native readout
and the previous independent-root fallback, plus private-server reconstruction.

Desktop presence loss now retains registration when active work, tracked native
execution, unacknowledged notifications or unknown storage remain. Idle close
disposes; reopening active registration does not rerun setup; actual native unload
still disposes and fences callbacks. This does **not** make the shipped desktop
fallback prompt/synthetic bridge independent of CodeNomad. Its profile admission
must remain fresh and failed mutations must never be replayed through a second
route. That remaining limitation is under empirical investigation.

The follow-up native capability test confirms the reason rather than assuming it:
OpenCode 2.0.22 plugin Context does not expose `ctx.client`, and its SessionDomain
excludes `environment`. An independently authenticated generated HTTP client can
write it; borrowing that transport is not a trusted profile/ownership delegation
for the plugin. Receipt: `missions-child-environment-mOKvYq/results.json`, zero
model requests and no credential copying. Therefore new root fallback admission
remains blocked until CodeNomad reconnects. Fully autonomous new sends would need
an additional trusted native capability/profile admission, outside this change.

A real experimental Tauri release was compiled and launched with a separate
`missions-empirical` profile, without replacing installed CodeNomad. It displayed
the GPT trial Mission and completed task. Actual native title-bar close was used.
Original CodeNomad windows stayed open, so this first observation is not evidence
of all desktop presence disappearing. The final source/resource timing correction
and fresh native close/reopen trial are tracked in `MISSIONS_EMPIRICAL_WORK_MAP.md`.
