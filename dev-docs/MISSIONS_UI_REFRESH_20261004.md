# Missions: upstream refresh and shared navigation

> Historical 2026-10-04 scope and receipts. The installation authorization below
> applied to that completed refresh, not the ongoing PR #866 delivery. Current
> work permits source changes, isolated tests and publication; no new installation,
> release, merge or live-Mission/configuration changes. See the description of
> [PR #866](https://github.com/NeuralNomadsAI/CodeNomad/pull/866) and
> [`MISSIONS_REFACTOR_VALIDATION.md`](MISSIONS_REFACTOR_VALIDATION.md) for current
> preferences/depth, recurrence and qualification status.

## Scope and authority

The user authorized updating the existing experiment from `upstream/dev`, improving
Missions navigation and useful recursive delegation, committing/pushing this branch,
building a Tauri Windows bundle and replacing the local installation with a backup.
This does not authorize merging into upstream, publishing a release, converting the
running Android Mission or changing native runtime depth/permissions.

The working branch remains `experiment/missions-native-subsessions-20261003` in
`D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003`.
The original integration worktree and unrelated #824 work remain untouched.

## Upstream integration

- Preserved the previously validated experimental sources in checkpoint `bbfd12f1`.
- Backed up all 648 changed/untracked paths before integration to
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-before-upstream-20261004-50d610a5`.
- Merged `upstream/dev` at `04654996` through merge commit `6e953e77` before
  implementing the new Mission navigation.
- Retained both Mission messages and upstream permission receipts in all ten
  locales. Retained upstream's simplified interruption dock and tests protecting
  existing Mission-reader/file-preview context.
- Initial integration checks: 117 server regressions and 15 interruption-dock
  browser regressions passed; UI typecheck passed. These are scoped receipts,
  not a claim of final aggregate qualification.

## Intended UI contract

- Shared descriptive list item: two text lines followed by status at the start
  and always-visible actions at the end. Measured insufficient width switches
  actions to the existing shared overflow menu, with keyboard/focus support.
- Work uses the same item in a compact one-line form. Only the section disclosure
  remains; task details move into the eye-opened central reader.
- The task reader combines the brief, navigable dependencies, execution/profile
  context, report/result/evidence/artifact and exact conversation navigation.
  Native execution, business readout and notification remain distinct facts.
- Conversations shows genuine observed native ancestry rather than a flat actor
  inventory. The count includes displayed distinct descendants. Unknown ancestry
  or activity is never fabricated from task dependencies or stale catalogue data.
- Existing per-window selection/reader identities, cache-first visible demand,
  native ownership, lifecycle/admission fences and explicit recovery remain intact.

## Delegation contract

Native OpenCode owns the actual execution tree, permissions and depth ceiling.
Five allowed levels are a maximum, not a target. Mission guidance should encourage
parallel independent ready work and child-owned recursive decomposition when
useful, and propagate the relevant bounded assignment and role/safety instructions
to helpers. Ordinary native descendants return through their parent; the coordinator
settles declared tasks without duplicate child business reports. No synthetic
depth, runtime configuration write, denied-call root fallback or ambiguous replay.

## Final receipts

- Delegation policy/protocol implementation: 227 focused server tests passed,
  scoped strict typing passed. Full server typing with the existing private
  lockfile declarations passed; shared linked dependencies were not repaired.
- Fresh real GPT-6.1 Sol native trial passed against the compiled shared core:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-gpt-trial-IbvkOJ/results.json`.
  Mission `msn_fbc9cfc601f81ae359e074c7` completed with one coordinator readout,
  no child report copies and genuine root/child/grandchild ancestry. The trial
  explicitly requested this bounded recursion at private depth 3; it does not
  prove automatic five-level decomposition or concurrent sibling admission.
  Existing authenticated daemon PID 12896 remained alive, no credentials were
  copied, and the running Android Mission/configuration was not changed.
- Fresh isolated native presence/lifetime regression passed (seven scenarios in
  one native test), with private database/configuration and scripted provider:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-lifetime-native-BhItNA`.
- Integrated browser migration: 134 tests in the twelve existing owned Missions
  browser files passed, without skipped safety assertions. Native capture replay
  used historical evidence; it is not a new host/transport trial.
- The first broad UI/server unit runs were exploratory, not final qualification:
  the UI run found two inherited palette/image test mismatches; the server helper
  accidentally selected every route via its absolute worktree path, including
  `files-history` requiring the missing shared `fuzzysort` dependency. The helper
  now filters basenames. Shared dependencies are not modified to mask this issue.
- A dormant durable-host admission test's 15-second deadline expired during real
  Windows fixture setup. All safety assertions are retained with a bounded
  60-second test deadline; the isolated exact case passed in 17.96 seconds.
  This is structural fixture coverage, not durable desktop activation evidence.
- Independent server/skills gatekeeper closed at **P1/P2/P3 = 0** with an
  independent integration-seam review and 278 passing focused tests. Scope:
  canonical prompt generation, generation/replay boundaries, recursive policy
  and server upstream integration; not UI or strong durable-host activation.
- The inherited unit mismatches were verified byte-identical on experiment HEAD
  and `upstream/dev`: the calibrated Classic accent is no longer the historical
  `#0080FF`, and tool copy now uses lazy `getCopyText()`. Only tests were updated
  to preserve those upstream contracts. Production palette/image code is unchanged.
  Fresh all-UI browser-condition units passed: **1,274**, zero failures.
- First independent UI gatekeeper identified two P2 and one P3 issues: cold
  conversation hydration used a metadata-only refresh, valid external-parent
  boundaries hid native descendants, and attention/cleanup rows lost focus on
  unchanged refetch. These require correction and independent re-review before
  source closure; passing migrated tests alone was not sufficient.
- Real RTL drawer regression exposed SUID sibling isolation hiding Solid's portal
  wrapper around the visible modal. `HostedDrawer` makes the modal root a direct
  child of the existing geometry host without bypassing modal authority. Isolated
  LTR/RTL tests cover stacking, previously hidden siblings, close/reopen/disposal,
  focus/keyboard, Escape/backdrop and geometry. The exact accessible deep-child
  tap in the production shell passed; native desktop remains to be verified.
- Whole native-family replay additionally showed that the upstream dock correctly
  retains its selected request rather than auto-selecting a newly queued permission.
  Mission attention navigation must target the exact still-open native request,
  not only its session; the regression verifies one descendant reply and no
  uncorrelated global reply. Do not restore upstream's removed reveal controls.
- Cold navigation now uses bounded native `hydrateRestoredSessionChain` reads
  in both callers instead of metadata-only catalogue refresh. Missing/deleted
  sessions and connection/source/conversation ABA transitions remain fenced;
  75 distinct targeted browser regressions passed before final source closure.
- Declared actors with an external native parent remain roots of the Mission
  forest, without displaying that external ancestor. Ordinary missing parents,
  cycles and incomplete declared membership still fail closed (31 scoped tests).
- Attention and cleanup rows retain native identity keys and read current
  descriptors/receipts after refetch. Exact focus and open-menu tests, stale
  continuation and ABA tests passed (13 scoped browser regressions).
- Exact dock focus now scopes ID by native session and optional request kind.
  Missing explicit request IDs preserve the current editor instead of selecting
  an unrelated queued request. Mission attention rechecks navigation origin and
  the exact still-pending native queue after hydration, without creating a second
  answer path. Collision/disappearance tests retain the question draft and issue
  zero native replies; full integrated family/dock revalidation follows.

Pending coherent UI assembly, independent gatekeeper review/corrections to zero,
fresh aggregate validation, branch push, serialized packaging and installed-host verification.
Historical native/desktop evidence remains historical; do not relabel it as proof
of this updated build. Existing offline-admission and dormant durable-host limits
documented in `MISSIONS_NATIVE_PRODUCT_ACCEPTANCE.md` remain unchanged.

## Second upstream refresh before compilation

The user requested a second refresh because additional PRs merged while source
qualification was running. Fetched `upstream/dev` at `5c523e3f` and incorporated
#844 (explicit runtime restart recovery), #845 (mobile interruption geometry),
and #846 (answer focus during session activation). Preserved the in-progress
follow-up in local checkpoint `30b2cb8d`, with an external file backup at
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-before-second-upstream-20261004-194056`.
Merge `8e1ebd32` is conflict-free; UI typecheck passed afterward. All new activation
and mobile behavior is retained alongside Missions; this is not a runtime upgrade
or shared-daemon restart. Earlier aggregate runs with source changes are not final
qualification; the integrated seam checks and independent review are rerun before
compilation/deployment.

## Built and installed candidate

The user explicitly requested compilation immediately, without waiting for more
global exploratory checks, then confirmed that installation of the NSIS bundle
must not be forgotten. Production source was frozen at merge `8e1ebd32`:

- Independent Missions UI re-review: **P1/P2/P3 = 0**, including same-active-child
  RTL request selection before owned drawer close and disappearance during cold
  hydration. Independent latest-upstream seam review: **P1/P2/P3 = 0**.
- Integrated family/drawer/dock/activation/mobile/setup browser run: **79/79**,
  zero failures or skips. Native updater service units: **22/22**.
- All UI units on the integrated candidate: **1,276/1,276**. The aggregate helper
  flagged Tauri CLI's Cargo.toml byte rewrite during compilation; its Git-filtered
  blob still equals HEAD (`ec13494194fa4916e752b915dee05199a96f4fd2`). This is not
  a production UI change, but the raw byte-manifest check is not called a pass.
- Missions server aggregate: **1,096/1,096** before the second upstream refresh.
  No Missions server source changed in the second refresh; updater changes were
  independently tested above. Earlier whole-checkout manifest changes retain
  their honest failed aggregate exit status.
- Exploratory full browser run: **630 tests, 623 passed, 6 failed, 1 skipped**,
  with source changed during execution. Three auth cases were contaminated by
  a shared-cache Vite EPERM; two session-rendering cases passed the exact current
  isolated rerun (2/2); the mobile drawer-dismissal assertion now awaits the
  transition and passed in the integrated family run. This is not a fully green
  global browser qualification. No shared caches or dependencies were repaired.
- UI, isolated server compilation, three native plugin builds, serialized locked
  production dependency staging and packaged static/import/asset smoke checks
  passed. Packaged Node is v24.20.0; native OpenCode remains 2.0.22.
- Tauri `build --bundles nsis` completed its optimized release in 1m57s and
  produced `packages/tauri-app/target/release/bundle/nsis/CodeNomad_0.20.1_x64-setup.exe`.
  Existing dead-code warnings remain. The CLI also warned that the binary lacks
  `__TAURI_BUNDLE_TYPE`; automatic updater recognition is not qualified by this
  installation. The actual NSIS install completed successfully.

Final SHA-256 identities:

- Executable: `15e4abbbbbaf863108bf0946bf2cdaf04ab90aa21d63ef6c4ba446f6d35440ce`.
- NSIS: `d3bd35a4d6fd462d5ff4b421387e30b2f77368f01ba240178c9e02018a86ed36`.
- UI index: `5cd05c70ececd5d359884d31d207f8d0d1169dc6bb30c459566a001703b3b69b`.

Backed up all **12,385** existing installation files and verified their copies at
`C:/Users/Admin/AppData/Local/CodeNomad-backups/20261004-195130-nsis-refresh/previous`.
Gracefully closed only the exact owned installed native host and backend; shared
daemon PID **12896**, creation `2026-10-03T15:34:55.337994+02:00`, remained unchanged.
Ran the actual installer with `/S /UPDATE /NS` and the exact existing destination;
update mode does not uninstall user data. Exit **0**; verified the installed
executable plus **12,288** candidate resource files. Old unreferenced assets may
remain, following the ordinary NSIS update behavior; no broad cleanup was added.

Relaunched the installed ordinary profile without trial flags: host PIDs
**17344/27724**, backend **28712/33968**, visible native window title CodeNomad.
Configuration and native state directories were not edited/deleted, and the running
Android Mission was not mutated. Native automation still reports no visible target
for this session, so actual reader/profile/Mission restoration is not claimed as
visually inspected. Deployment receipt:
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-nsis-install-20261004.json`.

## File-size signals

No threshold-only refactor is included. Manually touched source files above the
warning threshold in this UI/policy follow-up are
`packages/ui/src/components/instance/instance-shell2.tsx` (approximately 1,315 lines)
and `packages/server/src/opencode/missions-plugin.ts` (approximately 606 lines).
The preserved experiment also includes existing large sources:
`packages/server/src/missions/control.ts` (1,214), `model.ts` (800), `journal.ts`
(529), and `packages/ui/src/components/tool-call/renderers/task.tsx` (577).
Upstream integration retains the large server routing/workspace files and existing
transcript/store modules; splitting them is not part of this delivery.
