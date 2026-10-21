# Native interruption UX

The shell slots `InterruptionDock` into the active session or the no-session
composer; navigating sessions moves it without recreating request editors, and
the composer stays mounted with its draft. The dock is non-modal; accent tokens
also colour its icon and leading border. Clicking the collapsed external-request
badge expands the selected request in place, like the project badge.

For keyboard heights too short for the whole stack, a measured minimum reserves
the header, footer and one usable input; the session stack then scrolls as a
whole instead of clipping controls, and field scrolling can chain into it.

## Ownership and navigation

- Native pending queues are authoritative; never decide from a transcript scan
  whether a request can be answered. Requests without a tool source use the same panel.
- External previews are labelled “Other conversation”; the label and strong title
  carry provenance independently of colour.
- Global Forms have no owning conversation. Their compact preview uses a distinct
  project-request label, supports in-place expansion and never invents a source link.
- Session-row selection with pending requests targets that session's request
  through `interruptionFocus`.
- The dock shows the request kind and source session; with several requests the
  position/count and arrows appear, disabling at the first/last request without
  wrapping. Selection stays pinned even when a permission arrives ahead of a
  question; only explicit navigation or settlement changes it. Keyed editors keep
  partial answers and rejection reasons through native object replacement.
- Collapse only hides the panel body. It never cancels or refuses a request.
- Deferred session-activation focus must recheck the current input and modal owner
  when it runs, and expire when the pane deactivates or unmounts. An answer field
  focused during navigation retains keyboard input instead of yielding to the composer.
- Only the dock submits replies; transcript tools never register permission
  shortcuts, render response forms or keep interruption reveal state.
- Replies/cancellations go through the native stores, with their mutation error
  handling, pending-request reconciliation and global location headers. A failed
  request remains editable. Never replay a mutation automatically.
- Large permission diffs use bounded source access and the usual approval rules. Request/diff identity fences late clipboard completions.

## Transcript history

The `question` renderer displays question/answer pairs from native tool input and
`metadata.answers`. It works for live tool completion and rehydrated history; it
never invents a local assistant/user message or persists a parallel transcript.
Native completed answers remain readable there and are the authority; native
errors use the tool error renderer.

A provider/auth Form never gets a synthetic transcript receipt.

Permission decisions have a separate CodeNomad-owned durable receipt: request,
resources, confirmed decision (`once`, `always`, `reject`), and the supplied reason
when known. Receipts are read-only transcript annotations. A source message
anchors the receipt; requests without one remain available as session receipts.
Reads are bounded and ownership-checked.

Native permission events are ephemeral and replies omit the reason. CodeNomad
therefore captures confirmed replies and observed native settlements separately,
since a native settlement can come from another client or a cascade. Yolo
decisions are identified as automatic. A failed or ambiguous reply never becomes
a fabricated decision and is never replayed automatically. Decisions made while
CodeNomad was offline have no receipt; never reconstruct one from a tool's
success/error or from saved permission rules.

Permission snapshots and receipts live under the CodeNomad profile's
`permission-receipts` directory, in atomic per-request files. The namespace uses
the execution host, native discovery root and authenticated service channel;
credential rotation starts a new namespace. Session deletion removes its receipts.
Stored text is capped at 4096 characters and resources at 64 entries, without
native metadata or diffs. Reads return up to 100 receipts and scan at most
500 records per page, so an empty page can still have a continuation cursor.
Reconnect recovery enumerates loaded native Locations and filters them through
registered-only workspace ownership before querying pending permissions. This
includes descendant directories inside the project and its worktrees; it never
uses the daemon's default directory as a substitute or triggers strategy discovery.

## Validation

`tests/browser/interruption-dock.test.ts` exercises real Solid session, transcript,
composer and panel components, the native event dispatcher and isolated HTTP fixtures:
native answer rendering and history rehydration, dock-only pending questions,
draft retention, stable selection, bounded navigation, failure/retry, in-flight
submission, remote settlement, source-less permissions, global Forms and narrow-screen
geometry with reachable footer actions.

`permission-fallback-diff.test.ts` keeps the dock's full-source access,
changed-diff and late-copy regressions. Both run on isolated fixtures only.

`permissions/receipts.test.ts` exercises disk reload, all decisions, native versus
manual/Yolo provenance, cascades, ownership, deletion and mutation failure paths.
`tests/browser/permission-receipts.test.ts` covers reload, hidden tools, empty-page
pagination, SSE refresh, stale reads and long receipts in light/dark mobile layouts.
`node scripts/test-permission-receipts-native.mjs` runs isolated native recovery
against project/worktree roots and descendant Locations, with external replies
and disk reload. It never uses a shared daemon or user database.

`tests/browser/mobile-interruption.test.ts` exercises the real instance shell with
Android touch emulation, session navigation, saved maximum composer height,
portrait/landscape/short layouts, simulated keyboard resize/pan, global/background
Forms and permission actions. Never substitute width-only component captures for
this shell-level geometry regression.
It also covers local and recursive-subagent provenance, compact external previews,
explicit in-place expansion, retained hidden drafts, explicit source navigation,
global Forms and late-arriving ancestry on desktop and mobile.

## Agent conventions

- Native questions and permissions are answered in the shell-owned `InterruptionDock`, slotted above the composer. Pending questions appear only in the dock; the transcript retains native completed question results. Badges target the dock via `interruptionFocus`; omit transcript-source and answer-in-dock links. Keep selection stable by request kind/id across queue refreshes, with bounded previous/next navigation hidden for a single request. Preserve request drafts across refreshes and session navigation. Keep its square, height-bounded chrome in `styles/components/interruption-dock.css`, with a token-based accent header and fixed action footer outside the scrolling request content.
- Keep disclosure chevrons leading without changing their directions, and retain the normal question/permission icon for every source. Collapsed unrelated-conversation requests show the full shared red `session-permission` badge (shield and localized request-status text) at the trailing end of the header, separate from the request icon.
- Requests from the open conversation and its recursive descendants can expand normally. Other conversations first appear as a compact, explicitly expandable preview; answering stays in place. Keep persistent textual provenance prominent (other conversation, subagent with parent, or sessionless project request), with an explicit View conversation action for session-owned requests. Arrival never replaces the request being edited or navigates sessions. Newly selected external requests after settlement remain compact until explicitly opened. Hidden/inert keyed editors retain drafts, and only an expanded editor compacts the composer. Project badges open the dock in place rather than silently navigating to another conversation.
- Durable permission decisions render through `components/permission-receipts.tsx` outside native tool visibility, with bounded mounted-row reads and a paginated session disclosure for unanchored receipts. Virtualized rows remount continuously: `stores/permission-receipt-cache.ts` retains each row's completed snapshot (no re-read on remount) and shares in-flight reads among mounted rows on the dedicated one-slot `receiptReads` lane; a read no mounted row awaits is cancelled. Receipt-change events (mounted or not) and reconnects invalidate; pagination writes are fenced by the invalidation generation. Keep receipts out of native message/copy/search/speech projections; styles live in `styles/messaging/permission-receipts.css`.
- An expanded interruption temporarily reduces the composer to its minimum without changing its saved height or draft; resizing resumes after collapse/settlement. `instance/shell/useInterruptionViewport.ts` bounds the request/composer stack to the visual viewport during keyboard resize/pan. Keep the dock non-shrinking and its footer reachable on short mobile layouts.
- Completed question receipts share native answer decoding with text projection through `tool-call/renderers/question-data.ts`. Preserve selected-option descriptions and verbatim free text; keep remaining choices in a native disclosure. Receipt styles live in `styles/messaging/tool-call/question.css`.
- Automatic pending-request recovery uses the authenticated loaded-only broker in `packages/server/src/server/routes/pending-requests.ts`; it must never fall back to ordinary lists across inactive worktrees, on any daemon version. Validate directory ownership before querying and every returned placement before publishing; retain execution-host authority even for cold/empty coverage, including WSL and path aliases. Preserve idle/global Forms, per-kind mutation fences and settled-request tombstones. Missing capability, errors or incomplete coverage retain known queues/drafts immediately; the existing notification system warns once after two consecutive incomplete recoveries (the 30-second liveness pass retries transient failures) and stays quiet until successful recovery or removal. Never add a permanent banner or dedicated icon. Compaction deferral, invalidation and rehydration do not notify, count toward or rearm the warning. Rehydration does not clear queues. Only explicit settlement reconciliation uses an ordinary list at that request's authorized location. Capability is negotiated per connection, never inferred from a version label; validate actual private graph/queue contracts, never an untested-version allowlist.
- Pending recovery reconciles a missing/not-owned inventory-only candidate with one explicit fresh worktree read before retrying the loaded-only broker. A removed display descriptor never proves queue absence: historical exclusions still require the broker's fresh ownership/filesystem proof. Root, selected catalogue, active sessions and known requests remain required. Unreconciled session-family moves retain source/target directory authority after failed post-move reads or inventory removal; a complete owned native project inventory plus fresh activity, begun after the native mutation returned, releases that hold, including members authoritatively absent/deleted/moved outside the scope. Do not pin holds to historical member IDs. Selector busy/target state is separate: the latest actual move task clears it on settlement even if directory recovery remains uncertain. Failed fresh reads must reject, never be disguised as success by a cached trailing read. Never replay a move, infer idle from a vanished checkout, or clear history/drafts to silence the warning. See `dev-docs/CACHE_REFRESH_CONVENTIONS.md`.
- Pending discovery admission lives in `workspaces/pending-discovery.ts`. Observe authenticated compaction events before ownership routing; this backend-only state never grants event visibility. Defer legacy full lists and unverified broker reads with non-authoritative 503s before inventory reads and recheck at forwarding. Verified loaded-only capability is connection-scoped. Settlement reconciliation headers require an exact, workspace-bound grant from an authorized mutation attempt and still undergo normal ownership checks. Bounded shared `session.active` probes recover missed ends only when the session becomes inactive; failures retain the hold. UI coalesces deferred refreshes without clearing unscanned queues or replaying mutations. Already-admitted reads, already-loaded Locations and wholly unobserved compactions remain mitigation limits.
- Pending recovery treats idle historical session directories as optional hints only. Root, catalogue, inventoried worktrees, active sessions and known permission/Form placements remain required. The broker may exclude an optional hint rejected by directory ownership, but still queries valid idle subdirectories and negotiates the actual loaded-only RPC at the owned root for an all-excluded batch. Exclusion never provides empty coverage or clears queues; transport, identity and returned-placement failures remain errors. Recheck required placements when responses arrive so live requests cannot be hidden by stale optional classification. A candidate's ownership/deletion-fence failure or a rejected placement reports only that directory's non-authoritative error (and a rejected placement withholds capability verification); root/origin/connection changes, malformed native coverage and timeouts still fail the batch. Ownership fans must not spawn Git per candidate: common-directory reads use the checkout's administrative files (`workspaces/git-common-directory.ts`), because the shared worker runs two Git processes and each Windows spawn can cost up to a second, which starves recovery across hundreds of worktrees. Each response carries phase-only `Server-Timing`.
- The incomplete-recovery warning names its project, cause, folders and the sessions that required them (`stores/pending-recovery-cause.ts`); the broker reports a per-directory error reason. Never fall back to a generic message.
- Pending recovery admits exactly what the workspace manager owns for prompts and live events, including a nested checkout of another repository inside the opened folder; each admitted directory's own Git common directory must be unchanged after native IO. Unowned optional historical hints may be excluded when fresh filesystem evidence proves an unrelated Git common directory, or an absent path outside the checkout under a canonical existing parent. Revalidate the exact negative evidence, resolver result and any known identity/fence after native IO. An exclusion never queries the foreign path, publishes empty queue coverage or deletes a session; all-excluded batches still negotiate through the owned root. Unknown ownership, access errors and required/active/known-request locations remain errors. Keep these distinctions covered by the pending route and client recovery tests.
- The same presence-owned bundle exposes only `codenomad.pending-requests.snapshot` for loaded-only Form/Permission recovery. Its private native-service reader checks native RPC capability and actual graph, existing-only lease, queue, codec and identity contracts without a version allowlist; keep tested evidence distinct from incompatibility and do not raise the global minimum speculatively. The authenticated pending broker uses one established owned execution-host root and fixed RPC POST, never candidate `location.get`, ordinary queue GETs, debug inventory or the unreleased `/api/location/pending` API. Validate origin, full coverage and every placement before connection-scoped capability admission; only an HTTP 400 strict `RpcError` envelope of type `rpc.unavailable`/`rpc.method_not_found` with a bounded message denotes unsupported, never authorization for a worktree-wide fallback. Other failures retain queues non-authoritatively. Preserve compaction admission, deletion/connection fences, global Forms and settlement tombstones. See `dev-docs/OPENCODE_COMPATIBILITY.md` for bootstrap warming and snapshot limits.
