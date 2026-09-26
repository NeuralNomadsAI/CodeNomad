# V2 product integration series

Base: `dev@a77e37ef` (OpenCode client/plugin 2.0.18; technical minimum 2.0.7).
The user requested eight individually reviewed PRs, all kept open and unmerged.
Implementation is coordinated in one conversation. Each branch builds on the
preceding reviewed branch; each PR describes only its own delta.

| Order | PR | Branch | Deliverable | Reviewed implementation head |
| --- | --- | --- | --- | --- |
| 1 | [#789](https://github.com/NeuralNomadsAI/CodeNomad/pull/789) | `feat/v2-01-code-mode` | Native execute script/call presentation | `aaee7d5a` — zero |
| 2 | [#790](https://github.com/NeuralNomadsAI/CodeNomad/pull/790) | `feat/v2-02-web-results` | Web search results and provider form | `3e443abe` — zero |
| 3 | [#791](https://github.com/NeuralNomadsAI/CodeNomad/pull/791) | `feat/v2-03-skills` | Explicit native skill attachments | `ea3b4ef6` — zero |
| 4 | [#792](https://github.com/NeuralNomadsAI/CodeNomad/pull/792) | `feat/v2-04-web-settings` | Web search configuration and credentials | `c3b05383` — zero |
| 5 | [#793](https://github.com/NeuralNomadsAI/CodeNomad/pull/793) | `feat/v2-05-provider-accounts` | Individual provider accounts | `ef172992` — zero |
| 6 | [#794](https://github.com/NeuralNomadsAI/CodeNomad/pull/794) | `feat/v2-06-plugin-updates` | Native plugin check/update controls | `f7cbbf05` — zero |
| 7 | [#795](https://github.com/NeuralNomadsAI/CodeNomad/pull/795) | `feat/v2-07-mcp-code-mode` | Per-server default/on/off Code Mode | `4f97fa6e` — zero |
| 8 | [#796](https://github.com/NeuralNomadsAI/CodeNomad/pull/796) | `feat/v2-08-usage` | Native usage dashboard | `a3388fee` — review pending |

Every PR needs focused tests, rendered evidence for UI, and an independent
gatekeeper review published on GitHub. Findings are corrected and re-reviewed
until none remain. No PR is merged. Native mutations use isolated test data;
the shared user daemon is not a test target. Runtime requirements follow
demonstrated contracts, not the dependency pin. Track any adjustments and
capability boundaries in the relevant PR rather than silently shrinking scope.

## Contract notes

- Execute: OpenCode 2.0.7 and 2.0.18 `packages/core/src/codemode/tool.ts` expose
  `input.code`, `metadata.toolCalls[]` (`tool`, `status`, optional `input`),
  and `metadata.error`. Individual calls have no result/error text field.
  Native text/file content remains owned by the shared tool output pipeline.
- Web search: verified tagged 2.0.7/2.0.18 `tool/plugin/websearch.ts`.
  Persisted content is Markdown headings, optional Published lines and snippets;
  structured execution output is not part of message history. Consent uses
  `metadata.kind = websearch.provider` and a required string choice/provider.

## Open PRs

- #789: Code Mode; gatekeeper zero findings at `aaee7d5a` after resolving live
  disclosure/focus loss. https://github.com/NeuralNomadsAI/CodeNomad/pull/789#pullrequestreview-5326475808
- #790: Web results/consent; gatekeeper zero findings at `3e443abe`.
  https://github.com/NeuralNomadsAI/CodeNomad/pull/790#pullrequestreview-5326492067
- #791: Native skill attachments; gatekeeper zero findings at `ea3b4ef6`, after
  adding bounded skill draft persistence to the window-state codec.
  https://github.com/NeuralNomadsAI/CodeNomad/pull/791#pullrequestreview-5326551568

## Skill validation

`scripts/test-prompt-skills-native.mjs` passes against isolated 2.0.7 and
2.0.18 executables: native catalog, ID-only prompt, native skill expansion,
historical attachment identity and queued payload. Location startup registers
plugins progressively; visible catalog demand therefore consumes native skill
and config events, coalesces trailing reads and fences view changes. No local
file scraping or prompt-body skill injection is used.

## Web settings boundary

PR #792 gatekeeper reached zero findings at `c3b05383`:
https://github.com/NeuralNomadsAI/CodeNomad/pull/792#pullrequestreview-5326614696

OpenChamber's `/api/config/websearch` is its own backend endpoint, not a native
OpenCode 2.0.18 method. CodeNomad edits the selected authorized document via the
existing host/WSL atomic configuration machinery, preserving foreign fields and
comments. Native configuration watching applies edits; no `location.reload`.
The isolated fixture validates global watching on 2.0.7/2.0.18 and project
document persistence/reset. It disables project discovery to exclude ancestor
user config; project precedence is covered by deterministic backend tests.

## Provider account contract

PR #793 reached zero findings at `ef172992` after fixing parent remounts,
external activation invalidation and late save acknowledgments:
https://github.com/NeuralNomadsAI/CodeNomad/pull/793#pullrequestreview-5326686059

Native integration connections are ordered with the active credential first,
followed by other credentials and environment sources. Isolated 2.0.7 and
2.0.18 fixtures validate multiple key creation, activation, rename and individual
removal without secret material in catalog output. Global mutations use only
the explicit credential ID. Browser validation covers preserving unsaved labels
through native invalidations and failed saves without automatic write replay.

## Plugin package updates

PR #794 reached zero findings at `f7cbbf05` after stable ownership fencing:
https://github.com/NeuralNomadsAI/CodeNomad/pull/794#pullrequestreview-5326715646

Native check/update validates package targets against the Location's fresh native
inventory, and the native package cache is shared by all Locations. UI actions
select one target (not a plugin ID), disclose shared scope in their tooltip, and
retain target-level pending admission across component/view lifetimes. Local,
builtin and SDK sources do not offer package updates. Isolated local-registry
fixtures pass on 2.0.7 and 2.0.18: installed 1.0.0, detected 1.1.0, rejected an
unknown target, updated and observed native reloading without location.reload.

## MCP Code Mode source controls

PR #795 reached zero findings at `4f97fa6e`, including lower-priority declared
source resolution and activity propagation through both production mount paths:
https://github.com/NeuralNomadsAI/CodeNomad/pull/795#pullrequestreview-5326743092

The native default is on; false exposes direct tools, and removing the field
restores the default. Global/Project controls edit only an existing declaration,
since native precedence replaces the entire same-name server object. No cloning
of inherited credentials and no reconstruction through mcp.add. Targeted JSONC
edits reuse document conflict/ownership/deletion/connection/WSL admission.
The compact disclosure loads only while open, reconciles native events/reconnects,
and fences stale Location responses. Isolated 2.0.7/2.0.18 validation covers native
global discovery/hot reload, three states, unchanged connection configuration,
missing-source refusal and foreign-directory refusal. Project precedence is
tested deterministically; disabled synthetic servers do not exercise MCP calls.

## Native usage dashboard

Usage is a Preferences section in browser, Electron and Tauri navigation. It
explicitly aggregates the entire connected service, including independent clones
and unrelated projects. After gatekeeper reproduced native project-ID collisions
across independent clones, the user was asked whether to authorize service-wide
aggregates or retain an unavailable folder-scoped dashboard. The user explicitly
selected **Global au service**. The initial folder-scoped design was the
assistant's choice and is retired, not represented as a native guarantee.

The dedicated service-usage endpoint requires the authenticated application and a
current workspace connection; no native project/directory selector is accepted.
Stats always request tools:none, with explicit timezone and a maximum 366-day
range. UI offers rolling 7/30/90/365-day windows,
recorded tokens/cost, session/subsession/step counts, models and daily activity.
Costs are native recorded values, not billing invoices or subscription quotas.
No transcript fetch or background polling is used. Service scope is prominently
displayed and translated in all locales.

Isolated 2.0.7 and 2.0.18 fixtures create two repositories, a worktree and an
independent same-history clone, generate through a loopback synthetic provider
and verify explicit service totals, native tokens/models/activity and tools:none.
Backend tests cover bounded inputs, client-supplied project/directory/tool
rejection and late connection/workspace
changes. Browser tests cover real Preferences reachability, narrow layout,
period changes, failure reconciliation and stale/disposed requests. UI/server/
Electron typechecks and native Preferences tests pass; Tauri allowlist updated,
but no Tauri rebuild or native desktop relaunch is claimed for this series.

## Series integration evidence and size signals

Production UI build passes on the combined eight-feature head `a3388fee`.
The cross-series shared-stylesheet browser run passed 21 scenarios on that head;
the service-scope correction adds its own replacement regressions afterward.
All eight PRs were confirmed open on GitHub; reviews for #789–#795 are attached
to their exact current heads. Reviews use COMMENTED because the current GitHub
account cannot approve its own PRs. Remote CI is not represented by these local
results and was not continuously polled. The series worktree is
`D:\CodeNomad\.codenomad\worktrees\v2-product-plan`; this conversation remains
attached to `D:\CodeNomad`.

Existing files touched above the repository's size guidance (approximate lines;
recorded as refactor signals, without unrelated refactoring):

| File | Lines |
| --- | ---: |
| `packages/server/src/server/http-server.ts` | 2,328 |
| `packages/server/src/opencode/plugin-controls.ts` | 842 |
| `packages/server/src/api-types.ts` | 696 |
| `packages/server/src/server/__tests__/instance-proxy.test.ts` | 1,082 |
| `packages/tauri-app/src-tauri/src/preferences_window.rs` | 664 |
| `packages/ui/src/components/prompt-input.tsx` | 1,118 |
| `packages/ui/src/components/provider-auth/provider-manager-modal.tsx` | 871 |
| `packages/ui/src/components/session/session-view.tsx` | 700 |
| `packages/ui/src/lib/api-client.ts` | 628 |
| `packages/ui/src/lib/i18n/messages/{de,en,es,fr,he,ja,ne,ru,tr,zh-Hans}/settings.ts` | 704–718 each |
| `packages/ui/src/stores/session-actions.ts` | 696 |
| `packages/ui/src/stores/session-actions.test.ts` | 1,040 |
