# Cache and refresh conventions

Use consistent refresh semantics across features. Keep domain-specific implementations
where their authority, lifetime or runtime differs.

## Common rules

- Keep the last successful display snapshot while a passive refresh runs.
- Share concurrent reads for the same identity. During a read, coalesce refresh
  requests into one pending follow-up rather than queueing one request per event.
- Invalidate on relevant events or mutations; a TTL expiring does not itself start
  work. Avoid background polling merely to keep a hidden view warm.
- A response must still belong to the current identity/generation before publication.
  Serialize follow-up reads so an older response cannot overwrite their result.
- Preserve the last good snapshot on refresh failure and permit recovery. Surface
  failures for explicit operations rather than reporting stale data as success.
- A successful mutation must be visible to its next dependent read. Display-cache
  policies must not weaken ownership checks or transactional revalidation.
- Updating a displayed collection is not a user selection. Preserve its open state,
  stable-key keyboard target and inline actions through background refreshes.

## Current implementations and limits

| Area | Current behaviour | Implementation |
| --- | --- | --- |
| Session catalog | Per-window, per-workspace persistent display metadata for every known root and descendant. Byte-sized native partitions impose no session-count cutoff and consume no draft string budget. Seed titles, ancestry, locations, selection and expansion before HTTP hydration. Cached rows carry unknown runtime status; the selected chain is revalidated directly, while the owned project inventory refreshes asynchronously. Partial/failed/directory-only initial pages never evict saved workspace families; a complete owned inventory reconciles absent rows with concurrent-update fences. | `stores/session-catalog-persistence.ts`, `session-catalog-hydration.ts`, `client-state-catalog-partitions.ts`, `session-api.ts` |
| Session outline | Structural indexes independent of transcript and excerpts; up to 16 memory snapshots / 200k entries (one larger active index allowed). Restoration persists up to 16 indexes / 200k entries / 16 MiB in optional content-addressed chunks. Saved geometry displays before full checkpoint revalidation; unchanged ranges do not resend entries. The last range grows to 512 rows before another is added. Unchanged session returns make no read; native message changes revalidate checkpoints. Destructive mutation, generation, location/project and undo boundary fence reuse. Paused scans retain cursors. | `packages/ui/src/stores/session-outline.ts`, `session-outline-persistence.ts`, `client-state-outline-partitions.ts` |
| Timeline previews | At most 512 bounded Markdown excerpts. Visible-nearby batches of 12, hovered ID first; obsolete demand cancels. Thirty-second age prompts on-demand revalidation only. Generation, mutation and undo fence reuse. No transcript-window loads or geometry changes. | `packages/ui/src/stores/timeline-previews.ts` |
| Providers/models | Retained signals; shared in-flight catalogue load; dirty-bit trailing refresh; instance, location and request-generation checks. No completed-result TTL inside `fetchProviders` itself. | `packages/ui/src/stores/session-api.ts` |
| Provider Usage | Panel-local snapshot; same-location `provider.updated` revalidates in place with one in-flight read and coalesced trailing demand. Window-label keys preserve quota DOM across responses. Duplicate transport statuses and instance/status/native-generation snapshots are no-ops, not reconnects. A changed native generation still fences quotas even if the disconnect was missed. Credential/integration/config events, native `server.connected`, real connection transitions and source changes clear the snapshot immediately and fence old responses/trailing demand. Failures revoke quotas rather than retain a possibly different account. Hidden panels do not read; no global browser quota cache. | `components/session/provider-usage-panel.tsx`, `provider-usage-state.ts` |
| Stats | Backend-owned `state.ui.serviceUsage` saves eight validated display snapshots and eight period choices (1 MiB aggregate). Authenticated native discovery root/execution host/channel fingerprint plus exact opened folder, not workspace UUID, isolate snapshot reuse. Native aggregation, optional restoration and owner checks run independently; discovery cannot hold fresh totals. Backend admission order controls the saved period across windows, not response order or client timestamps. Preferences never writes the opener's client state. Previous totals/charts remain explicitly stale through same-owner disconnect/errors; a verified different owner/discovery identity revokes them. A mounted, document-visible Stats section reads; hiding/disposal cancels queued demand and fences in-flight publication. Terminal hints use the shared five-second activity cooldown. Native hidden/minimized/occluded window behavior is not qualified (see below). No polling or transcript reads. | server `opencode/service-usage-cache.ts`, `service-usage.ts`; UI `settings/usage-settings-section.tsx` |
| Session model selection | Native selection events invalidate rather than overwrite the displayed selection, because SSE echoes can lag successful HTTP writes. Coalesced authoritative reads share the session admission queue with prompts and explicit selections; client/generation and captured-selection checks fence late responses. Catalog merges preserve pending optimistic choices; successful writes publish a fresh model object so pre-confirmation snapshots lose authority. Read failures retain display state until the next event or reconnect refresh. | `stores/session-model-reconciliation.ts`, `stores/session-action-queue.ts`, `stores/session-generation-recovery.ts` |
| OpenCode setup | Shared in-flight status read plus coalesced trailing refresh for focus/visibility/reconnect demand. Executable changes and explicit actions fence old responses. Failed reads retain version/path diagnostics but revoke the connected claim and stale reload/restart controls; Continue checks again before retrying the pending workspace. Activation requires a successful pre-action status read. | UI `stores/opencode-setup.ts`, `components/settings/opencode-setup-panel.tsx` |
| Filesystem invalidations | Host directory observations and native filesystem events coalesce before cache publication: 100 ms quiet-case delay, then at most once per five seconds in continuous activity, with no idle timer. Explicit mutations/recovery invalidate immediately. Workspace versions target the browsing root and listed directory; only changed visible directories reread. Hidden/collapsed caches stay stale until demand. Bounded metadata falls back conservatively to full invalidation. | `filesystem-events.ts`, `useWorkspaceTree.ts`, server `workspaces/file-watches.ts` |
| Git changes | Shared filesystem cache invalidations debounce locally for 100 ms; one passive refresh plus a pending follow-up; hidden project/panel marked stale. Queued reads cancel on deactivation/disposal and request versions fence late status/diff results. Reads share the secondary HTTP budget. Server shares concurrent status requests, not completed results, and runs status/diff process creation in the Git worker. | `useGitChanges.ts`, `filesystem-events.ts`, server `workspaces/git-status.ts` |
| Worktree display | Last successful server snapshot; demand-driven refresh after 10 s or invalidation; one scan per workspace; obsolete scans discarded and followed by validation; UI display requests coalesce with one trailing demand. Pending recovery can explicitly request `?fresh=true` once after a missing/not-owned inventory-only candidate. Concurrent fresh callers share their fresh read, never a cached completion. Fresh and display outcomes are independent on one serialized read/publication lane: a failed fresh read rejects its callers without dropping queued display demand or leaking freshness into later requests. | server `workspaces/worktree-inventory.ts`, UI `stores/worktrees.ts` |
| Worktree authority | Validated reads await stale-inventory revalidation; family transactions force scans. Ownership misses can bypass a warm inventory once per directory-cache lifetime. Create/remove requires a validated next display read. | server `workspaces/worktree-directory.ts`, `manager.ts` |
| Git ownership preflight | Common-directory reads resolve the enclosing checkout's administrative files (`.git`, `commondir`, `HEAD`/`objects`) on every call, without a Git process; concurrent reads share one pending read per directory. Environment overrides, paths inside `.git` and invalid layouts defer to Git, whose commands run with two process slots in a lazy worker, keeping Windows process creation off the HTTP/SSE thread. Completed/failed reads are removed immediately; a matching identity still requires native inventory validation. | server `workspaces/git-common-directory.ts`, `git-process.ts`, `git-worktrees.ts` |
| Native event relay | Consume the shared SDK stream before slow I/O; resolve locations FIFO per session/PTY/Shell, then deliver FIFO per entity and recipient. Ownership promises/2 s results are shared by recipient and full native location; another recipient never delays successful delivery. | server `workspaces/instance-events.ts`, `instance-event-queue.ts` |
| Render cache | Explicit versioned values scoped to instance/session; no network scheduler or TTL policy. | UI `lib/global-cache.ts` |
| Background HTTP reads | Worktree display, Git status/diffs, project/location/status maps, composer catalogues, Shell lists and pending-request scans share two browser request slots across instances. Queued scans observe cancellation; per-request timeouts start at dispatch. Session/message reads and mutations stay independent so catalogue fan-out cannot occupy all HTTP/1.1 connections. | UI `lib/background-read-queue.ts`, `lib/sdk-manager.ts`, `stores/instances.ts`, `stores/worktrees.ts` |
| Virtualized lists | Session list, transcript and timeline use `virtua/solid`; virtualization limits rendered rows, not network refreshes. | UI `session-list.tsx`, `virtual-follow-list.tsx`, `message-timeline.tsx` |

Git updates are regulated, but not incremental: every new server status calculation
runs five Git commands plus untracked-file processing, and the UI also requests
native status. Continuous activity can sustain repeated full calculations and
selected-diff reads. This is not a completed-result cache.

The worktree cache is in memory. It does not reduce the first native inventory scan,
or the cost of mandatory authoritative scans. The event relay isolates these waits
by entity and recipient; it never substitutes stale display data for authorization.
An isolated native fixture covers warm-cache create/remove visibility; browser
fixtures cover menu updates, focus, old responses and refresh bursts.

Pending recovery must not promote stale display descriptors indefinitely. After a
missing/not-owned result for a directory required **only** by the displayed inventory,
it requests one fresh inventory and retries loaded-only recovery only if that directory
is no longer required. Root, selected catalogue, active sessions and known request
placements remain required; failed/unchanged refreshes retain the incomplete result.
An optional historical hint still needs the broker's existing fresh filesystem and
ownership evidence, including post-native-I/O revalidation. Exclusion never supplies
empty queue coverage, clears a draft, deletes history or changes a session's location.
This adds no timer or ordinary Form/permission-list fallback. Existing notification
history is not retroactively removed when recovery later succeeds.

A failed or partial session-family move is different from idle history. Source and
target directory authority survives failed native reconciliation and inventory
removal. Selector busy/target state is independent and clears when its latest move
task settles, even if directory recovery remains uncertain. `worktrees.ts` captures
the exact locations before the single mutation; `session-api.ts` releases them only
after a complete owned project inventory and fresh activity, from a read begun after
the mutation returned. Authoritative absence from that same scope counts too:
deleted, moved-away or stale resident member IDs cannot pin the hold forever.
Missing/changing project metadata, directory-only/partial inventories, failed activity
and superseded reads cannot release a newer move's hold. Known requests and active
placements remain independently required. This does not change native move/rollback
behavior or replay an uncertain move. A failed fresh inventory request rejects even
if a cached trailing read was queued; it never loops through cached retries.

### Stats restoration and remaining native cost

Stats uses the existing backend `SettingsService` UI state owner, not an extra file,
localStorage, or the native per-main-window restoration graph. The same owner is
available to Electron/Tauri Preferences recreation and browser/remote clients.
Each backend/profile owns its own document. Only an opaque SHA-256 fingerprint
is stored: native global discovery root (from authenticated `config.get`), host or
WSL distro, authenticated service channel, and exact backend opened folder. No
credentials, native paths, PID, transient port (when authenticated), or workspace
UUID are serialized. Changing the authenticated service channel deliberately
misses the cache; snapshots never authorize a Location or mutation. Period and
timezone stay separate, and corrupt/oversized entries are optional display misses.

Fresh aggregation does not await discovery or cache restoration. The UI starts a
cheap authenticated owner check, an optional cache read and native aggregation
in parallel. Initial native reads can restore the selected period synchronously
from bounded UI state using the fast execution-host/channel/folder owner key;
that preference is not authorization to reuse metrics. Cache data still requires
the full native discovery identity. A late cache response never replaces fresh
totals or their period. Late discovery may attach identity metadata only when its
opaque live connection token matches the fresh response; tokens are not saved.

The backend assigns monotonically increasing receipt order before asynchronous
connection acquisition. Only an owned, current connection admits that order to
the bounded owner/timezone frontier (64 entries, retired-order floor). The latest
admitted request chooses the saved period, including across windows. Older
responses and out-of-order discovery cannot publish over it. Client `from`/`to`
values never act as freshness authority. Optional snapshot publication is capped
at 32 pending operations, rechecks connection/workspace/admission ownership and
uses the existing 10-second discovery deadline; backend close aborts and drains
these operations before their Settings owner can be disposed.

Disconnect keeps only explicitly stale, last-known-owner display data; it grants
no connected or mutation authority. Reconnect checks host/channel/folder promptly
without discovery. A different owner clears old data, and a different full
discovery identity clears it when verified. If a previous fresh display had no
verified discovery identity, a changed live connection cannot adopt it blindly.
Unknown/failing reconnect observations do not relabel old metrics as new data.

**Native visibility limit:** the visibility regressions change the document's
visibility state synthetically. The reviewed Electron Preferences bridge exposes
minimize as an action but no passive visible/minimized subscription; host-side
`BrowserWindow.isVisible/isMinimized` is not a renderer hook. No corresponding
shared Preferences visibility observation is exposed by the Tauri abstraction.
The gatekeeper's isolated native minimize/background probes did not produce a
hidden document. This change does not claim Electron/Tauri hidden/minimized or
occlusion acceptance. A visible but unfocused window is not necessarily unseen,
so blur is deliberately not treated as hidden. No native window framework or
installed-user-app probe was added; reliable native visibility remains separate
work if the hosts do not publish document visibility transitions.

The isolated browser test recreates both the renderer and SettingsService, changes
the workspace UUID, and delays `session.stats` by 2 s: observed cold display
2,120 ms, restored totals/charts 81 ms, followed by replacement from the current
read. A separate hidden-start regression fails on the original component (one
Stats call while hidden, expected zero). These are fixture observations, not a
claim about the user's service or upstream speed. Additional deferred-promise
regressions hold discovery through native admission and fresh rendering, release
abandoned 30-day reads after a seven-day selection, recreate the backend/renderer,
and verify same-owner disconnect retention and changed-owner/discovery rejection.

Reviewed OpenCode 2.1.0 source (`packages/server/src/handlers/session.ts:71-90`,
`packages/core/src/session/stats.ts:85-190,282-315`) invokes aggregation on every
GET, without a completed-result cache. It queries all matching message rows in
31-day windows, extracts JSON usage fields and folds them in memory. Even with
`tools: "none"`, it enumerates service session IDs and queries compaction usage
events in batches of 500. Identical no-change GETs repeat that work; this is full
range re-aggregation, not evidence about SQLite's physical query plan. The
isolated native fixture's four synthetic sessions took 18.72/16.42/14.62 ms for
three identical reads. Large-history latency remains upstream work; no server
aggregation optimization or native database change is included here.

### Event relay ordering and recovery

- Ordering is per native session (including move/delete), PTY or Shell and recipient,
  not a global order across unrelated sessions. Other scoped events retain FIFO for
  their complete native location; global notifications have their own lane.
- Worktree invalidation happens at ingestion and fences pending ownership checks.
  Local inventory changes also invalidate routing ownership. Stopped/reopened
  workspace incarnations and disconnected stream generations cannot publish late work.
- Budgets are 2,048 retained jobs, 32 MiB of conservatively counted serialized event
  payloads, and 60 s per routing job including its queue wait. A breach fails that subscriber, clears queued
  work and emits the normal error/reconnect statuses for authoritative UI recovery.
  Never silently discard an individual delta or restart the shared daemon.
- Rate-limited slow-routing logs separate upstream event age, location resolution,
  recipient-queue wait and ownership time. They contain event type/recipient metadata,
  not message or tool contents.
- The isolated native location fixture holds one recipient's ownership check while
  testing ordered delivery to another and a second subscriber on the same SDK client.

## Initial session hydration

App-tab records retain identity across metadata refreshes, reordering and restoration
of sibling projects. Their payload getters stay reactive; Solid's identity-keyed
rendering must not remount existing shells or restart their Git readers on each update.
Visible Git panels precede queued bulk scans within the same two-request secondary
budget, so inventory/permission fan-out cannot leave an opened panel waiting behind
every restored checkout. Deactivation removes queued panel reads.
The optional SDK status read propagates cancellation into the transport and has a
dispatch-time deadline. Explicit refresh/mutation continuations retain their panel
generation and worktree identity; late results cannot reset another draft or launch
hidden-panel diffs. The server also bounds untracked-numstat submission and admits
worktree authority commands ahead of pending display commands in the Git worker.

Project identity and worktree discovery start independently. The root-directory
session page can publish before project identity or checkout discovery finishes; complete project-family
reconciliation still waits for verified worktree membership. Metadata-dependent
callers retain the combined worktree/project readiness barrier.

Restored selection identity is seeded before HTTP hydration. The saved session and
its last captured catalog are restored together; catalogs are optional, versioned
graph extensions shared by Electron and Tauri. Older snapshots simply need one
successful catalog load before they can offer this cache. Corrupt catalog chunks
discard only display metadata, retaining selected identity, drafts and other state.
The existing native aggregate byte/partition limits still apply atomically; no
session-count slice or age expiry truncates the catalog. This display cache grants
no directory authorization and persists neither transcript bodies nor permissions.
The saved session and
composer catalogues load once the client is ready, independently of the complete
project-family inventory. Supplemental metadata waits for session hydration.
Creation-ownership release starts alongside saved-session hydration; its HTTP
acknowledgement must not gate the visible conversation.
The visible project's first session page, project identity and worktree
membership bypass the secondary budget, as does saved ancestry. Otherwise a slow
Git/permission scan can hide every other-worktree conversation until it finishes.
The first project page publishes verified families additively, without waiting
for the historical cursor traversal. Only the complete inventory removes absent
rows. Historical pages and restored chains from other projects share that budget,
so their parallel hydration cannot queue ahead of the visible transcript.
Before selection is known, root pages also share the secondary budget. Pending
root/ancestry reads observe active selection and leave that queue immediately
when selected, without restarting already dispatched requests (`lib/prioritized-read.ts`).
Catalogue refreshes recheck client, location and request ownership before dispatch.
The first native connection can supersede an initial HTTP read without passing
through the reconnect recovery gate; session lists and catalogues replace those
obsolete reads unless a newer request, cancellation or disposal owns recovery.

Runtime-status responses cannot block list publication or overwrite newer SSE and
local admission state. Pending-request liveness refreshes the status map rather
than repeatedly traversing the entire historical session inventory.

## Agent conventions

These rules moved here from `AGENTS.md`, which indexes this document; they bind every change in this area.

- The browser opens only a few connections to the CodeNomad server. The selected transcript and its metadata read directly; secondary panel and timeline reads (plugin controls, outlines/previews) go through `secondaryRead` in `lib/api-client.ts`, sharing the bounded `backgroundReads` budget. Provider usage stays direct (superseded reads are fenced, not cancelled), and so does the OpenCode status read awaited by Restart/Start, so daemon-bound reads in the shared budget can never hold it. Startup effects must not track app-wide state they only await (`untrack` readiness gates), or every restored workspace update restarts and requeues the transcript read. Search visibility must be value-diffed before its close effect: reactive instance metadata can change while search stays closed, and running search cleanup then would cancel the initial transcript read. Restore tests must exercise reactive identity accessors and assert visible messages, not only request counts.
