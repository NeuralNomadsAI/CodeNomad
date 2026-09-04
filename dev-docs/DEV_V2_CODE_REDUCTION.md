# DEV-v2 Code Reduction Analysis

## Purpose

This document records the code-growth analysis for PR 647 and identifies later
reduction work. It separates measured facts, product decisions, and the
maintainer position on test volume so future cleanup does not remove behavior
by mistake.

Baseline:

- Comparison: `origin/dev...DEV-v2`
- Reviewed head: `dea20996`
- Files changed: 655
- Insertions: 52,866
- Deletions: 31,380
- Net change: **+21,486 lines**

These are repository line counts, not estimates from file sizes.

## Measured Result

### Mutually exclusive content categories

| Category | Net lines |
| --- | ---: |
| Tests | **+11,484** |
| Production source | +9,320 |
| Generated Tauri ACL/schema | +1,050 |
| Localization | +1,137 |
| Styles | +564 |
| Config and CI metadata | +64 |
| Build and release scripts | -32 |
| Lockfiles | -704 |
| Documentation | -1,397 |
| **Total** | **+21,486** |

Tests account for approximately **53% of the net increase**. Everything other
than tests contributes +10,002 net lines after documentation, lockfile, and
other reductions are included. The larger production share reflects product
and desktop work added after the original migration gate, not a restored V1
runtime.

### Package contribution

| Path | Added | Deleted | Net |
| --- | ---: | ---: | ---: |
| `packages/ui` | 24,753 | 13,725 | **+11,028** |
| `packages/tauri-app` | 9,193 | 3,250 | **+5,943** |
| `packages/electron-app` | 4,762 | 1,705 | **+3,057** |
| Outside `packages` | 3,130 | 2,774 | +356 |
| `packages/server` | 11,028 | 9,170 | **+1,858** |
| `packages/opencode-plugin` | 0 | 756 | **-756** |

The legacy plugin remains deleted. Current growth is concentrated in the UI,
desktop hosts, server automation/preview integration, and their tests.

## What V2 Actually Removed

The branch does not retain a second OpenCode V1 runtime. Approximately 8,001
lines of superseded architecture were deleted, including:

- per-workspace OpenCode runtime, process identity, and authentication;
- duplicate Tauri-native SSE transport;
- the custom V1 plugin stack;
- the custom background-process stack;
- V1 event and delta adapters;
- legacy Question UI and types;
- V1 workspace/session matching stores;
- unsupported message and tool deletion UI.

The V2 SDK and shared service therefore produced real deletion. The positive
balance comes from additional product behavior and validation around that
migration rather than a hidden V1 fallback.

## Where Growth Came From

The following feature clusters overlap and must not be added together. They
explain the original migration-gate shape at `878550ca`, not an exact second
accounting table for the current head.

| Feature cluster | Approximate net change |
| --- | ---: |
| Client state and restore across UI, Electron, and Tauri | +4,260 |
| Desktop multi-window lifecycle | +2,790 |
| V2 messages, pagination, timeline, and virtualization | +2,076 |
| Provider quota expansion | +1,070 |
| Forms replacing Questions | +576 |
| Worktree safety and session evacuation | +427 |
| Shared service replacing per-workspace runtime | -718 |

The migration grew beyond an SDK replacement. It also added independent
multi-window state, cross-host ownership, content-addressed persistence,
bounded message history, reconnect reconciliation, and stronger worktree and
proxy boundaries.

After that gate, `DEV-v2` also added Developer Mode automation, preview and
composer persistence, standalone preferences windows, desktop title bars and
menus, theme customization, broader UI harmonization, and the final bounded
timeline stabilization. Those additions explain why the current accounting
tables are larger than the historical feature-cluster estimates.

## Maintainer Position On Tests

The maintainer considers **+11,484 net test lines disproportionate**, even when
the tested behavior is valid. Test code has the same reading, maintenance,
mocking, fixture, and refactoring cost as production code. A migration should
not require readers to maintain almost ten thousand additional test lines
without demonstrating that each case protects a distinct stable contract.

This position does not call for deleting tests by percentage or weakening
security and persistence guarantees. It calls for testing stable use-case
boundaries instead of implementation sentences, repeated setup, one-line
helpers, and equivalent host-specific mechanics.

This follows Hona's *Code Like Luke* guidance:

- optimize code for the normal user flow;
- make patterns and abstractions pay for their total system cost;
- add complexity only from runtime evidence;
- keep one owner for state and behavior;
- test observable behavior at stable boundaries;
- avoid large mock systems and duplicated implementation tests.

Source: <https://gist.github.com/Hona/53142c07c9decb735392f132ace34003>

## Reduction Candidates

### 1. Consolidate repeated test mechanics

**Expected reduction: 300-600 lines initially. No product loss.**

- Table-drive repeated event-routing and lifecycle cases.
- Share contract vectors between Electron and Tauri where both hosts implement
  the same persisted-state protocol.
- Extract setup only after repeated examples expose a stable shared contract.
- Keep distinct proxy ownership, traversal, authentication, migration, and
  destructive-lifecycle cases; these protect separate trust boundaries.

Largest test-growth locations to review first:

| Net lines | Path |
| ---: | --- |
| +1,214 | `packages/ui/src/stores/session-request-authority.test.ts` |
| +1,150 | `packages/ui/src/stores/opencode-data.test.ts` |
| +847 | `packages/server/src/server/__tests__/instance-proxy.test.ts` |
| +773 | `packages/tauri-app/src-tauri/src/client_state/tests.rs` |
| +622 | `packages/ui/src/stores/session-actions.test.ts` |
| +610 | `packages/server/src/workspaces/instance-events.test.ts` |
| +470 | `packages/electron-app/electron/main/client-state.test.ts` |
| +436 | `packages/server/src/workspaces/manager.test.ts` |

Line count alone is not grounds for deletion. Each review must identify the
stable contract, redundant cases, and retained failure signal.

### 2. Remove dead message bridge APIs

**Expected reduction: 100-120 production lines. No product loss after caller
verification.**

Audit unused exports in `packages/ui/src/stores/message-v2/bridge.ts`, the dead
structured clone helper in `instance-store.ts`, unused notification helpers,
and compatibility aliases in `tool-call-state.ts`.

### 3. Reassess dual message-state authority

**Potential reduction: 800-1,500 lines. Design decision required.**

Messages currently pass through native `createData`, a normalized custom
message store, and a projection bridge. Determine whether live events and REST
history can feed one owner directly while pagination-window and optimistic-send
state remain separate UI concerns.

Do not begin by deleting either store. First document which authority owns:

- live event reconciliation;
- REST history and cursors;
- optimistic identities;
- resident pagination windows;
- reconnect generations;
- rendering order.

Proceed only if one authority can own each invariant without recreating the
removed layer elsewhere.

### 4. Stop tracking generated desktop artifacts

**Tracked reduction: up to 737 lines. Runtime reduction: zero.**

Generated Tauri ACL and schema outputs can leave the reviewed source set only
if CI and release builds regenerate and verify them deterministically. This
reduces repository and review noise, not implementation complexity.

### 5. Remove legacy state migration after its support window

**Expected reduction: 700-1,100 lines later. Time-gated.**

Electron, Tauri, and UI code still read shipped V1 client-state envelopes and
legacy host locations. Record the last release that must accept those formats,
then remove migration readers and tests only after that upgrade path expires.

### 6. Remove the one-variant shared-service wrapper

**Expected reduction: 30-60 lines. Low priority.**

`OpenCodeSharedServiceOptions.kind` has one legal value. Pass the real lifecycle
and identity requirements directly unless a second observed variant exists.

### 7. Reconsider non-migration product scope

Provider quota work contributes approximately +1,070 net lines. Removing it is
valid only if the product does not need the feature. Moving it to another PR
improves review scope but does not reduce the repository.

## Explicit Non-Candidate

Content-addressed client-state persistence is not a no-loss cleanup target.
Electron and Tauri already had separate native V1 adapters for one shared
logical snapshot. DEV-v2 extends that shared protocol with multiple windows,
partitions, atomic publication, cross-host ownership, and recovery boundaries.

Removing partitioning could save substantial code, but would also remove
large-snapshot support, independent partition writes, and partial corruption
recovery. Treat that as a product downgrade requiring an explicit decision,
not as routine refactoring.

## Execution Order

1. Capture current test names and the stable behavior each protects.
2. Remove verified dead production APIs.
3. Consolidate repetitive tests without changing their observable assertions.
4. Measure the diff and runtime after each package-level pass.
5. Decide the message-state authority from documented invariants.
6. Remove migration compatibility only after its support deadline.
7. Reassess optional product scope separately from architecture cleanup.

## Guardrails

- Prefer net-negative changes; report production, tests, generated files, and
  documentation separately.
- Do not introduce a framework, code generator, or generic harness solely to
  reduce line count.
- Use the rule of three before extracting shared test machinery.
- Preserve trust-boundary validation, data-loss prevention, accessibility, and
  observed race fixes.
- Every removed test must be redundant with a retained stable-boundary test or
  protect behavior that has been explicitly removed.
- Run the focused package checks after each pass and the complete UI, server,
  Electron, and Tauri suites before integration.

## Completion Criteria

The reduction is complete when:

- the resulting diff is net negative;
- no retained product behavior loses its only regression signal;
- test setup and mocks are smaller than the behavior they prove;
- message state has one documented owner per invariant;
- legacy compatibility has an explicit removal date;
- updated measurements replace the baseline tables in this document.
