# Cache and refresh conventions

Use consistent refresh semantics across features. Keep domain-specific implementations
where their authority, lifetime or runtime differs.

## Common rules

- Keep the last successful display snapshot while a passive refresh runs.
- Share concurrent reads for the same identity. During a read, coalesce refresh
  requests into one pending follow-up rather than queueing one request per event.
- Invalidate on relevant events or mutations; an expired TTL only marks data stale
  for the next demand. Avoid background polling merely to keep a hidden view warm.
- A response must still belong to the current identity/generation before publication.
  Serialize follow-up reads so an older response cannot overwrite their result.
- Preserve the last good snapshot on refresh failure and permit recovery. Surface
  failures for explicit operations rather than reporting stale data as success.
- A successful mutation must be visible to its next dependent read. Display-cache
  policies must not weaken ownership checks or transactional revalidation.
- Treat a background update of a displayed collection as data, never as a user
  selection: preserve its open state, stable-key keyboard target and inline actions.

## Implementations and limits

| Area | Current behaviour | Implementation |
| --- | --- | --- |
| Session catalog | Per-window, per-workspace persistent display metadata for every known root and descendant. Byte-sized native partitions bound it, independently of session count and the draft string budget. Seed titles, ancestry, locations, selection and expansion before HTTP hydration. Cached rows carry unknown runtime status; the selected chain is revalidated directly, while the owned project inventory refreshes asynchronously. Partial/failed/directory-only initial pages never evict saved workspace families; a complete owned inventory reconciles absent rows with concurrent-update fences. | `stores/session-catalog-persistence.ts`, `session-catalog-hydration.ts`, `client-state-catalog-partitions.ts`, `session-api.ts` |
| Session outline | Structural indexes independent of transcript and excerpts; up to 16 memory snapshots / 200k entries (one larger active index allowed). Restoration persists up to 16 indexes / 200k entries / 16 MiB in optional content-addressed chunks. Saved geometry displays before full checkpoint revalidation; only changed ranges resend entries. The last range grows to 512 rows before another is added. Returning to an unchanged session reuses its index; native message changes revalidate checkpoints. Destructive mutation, generation, location/project and undo boundary fence reuse. Paused scans retain cursors. | `packages/ui/src/stores/session-outline.ts`, `session-outline-persistence.ts`, `client-state-outline-partitions.ts` |
| Timeline previews | At most 512 bounded Markdown excerpts. Visible-nearby batches of 12, hovered ID first; obsolete demand cancels. Thirty-second age prompts on-demand revalidation only. Generation, mutation and undo fence reuse. Previews never load transcript windows or change geometry. | `packages/ui/src/stores/timeline-previews.ts` |
| Providers/models | Retained signals; shared in-flight catalogue load; dirty-bit trailing refresh; instance, location and request-generation checks. `fetchProviders` itself reuses only in-flight loads. | `packages/ui/src/stores/session-api.ts` |
| Provider Usage | Panel-local snapshot; same-location `provider.updated` revalidates in place with one in-flight read and coalesced trailing demand. Window-label keys preserve quota DOM across responses. Duplicate transport statuses and instance/status/native-generation snapshots are no-ops. A changed native generation still fences quotas even if the disconnect was missed. Credential/integration/config events, native `server.connected`, real connection transitions and source changes clear the snapshot immediately and fence old responses/trailing demand. Failures revoke quotas, since the account may have changed. Only a visible panel reads, and quotas stay panel-local. | `components/session/provider-usage-panel.tsx`, `provider-usage-state.ts` |
| Stats | Backend-owned `state.ui.serviceUsage`; rules in [SETTINGS.md](SETTINGS.md), restoration below. Hiding/disposal fences in-flight publication; terminal hints use the shared five-second activity cooldown. | server `opencode/service-usage-cache.ts`, `service-usage.ts`; UI `settings/usage-settings-section.tsx` |
| Session model selection | Native selection events invalidate the displayed selection and never overwrite it, because SSE echoes can lag successful HTTP writes. Coalesced authoritative reads share the session admission queue with prompts and explicit selections; client/generation and captured-selection checks fence late responses. Catalog merges preserve pending optimistic choices; successful writes publish a fresh model object so pre-confirmation snapshots lose authority. Read failures retain display state until the next event or reconnect refresh. | `stores/session-model-reconciliation.ts`, `stores/session-action-queue.ts`, `stores/session-generation-recovery.ts` |
| OpenCode setup | Shared in-flight status read plus coalesced trailing refresh for focus/visibility/reconnect demand. Executable changes and explicit actions fence old responses. Failed reads retain version/path diagnostics but revoke the connected claim and stale reload/restart controls; Continue checks again before retrying the pending workspace. Activation requires a successful pre-action status read. | UI `stores/opencode-setup.ts`, `components/settings/opencode-setup-panel.tsx` |
| Filesystem invalidations | Host directory observations and native filesystem events coalesce before cache publication: 100 ms quiet-case delay, then at most once per five seconds in continuous activity; timers run only during activity. Explicit mutations/recovery invalidate immediately. Workspace versions target the browsing root and listed directory; only changed visible directories reread. Hidden/collapsed caches stay stale until demand. Bounded metadata falls back conservatively to full invalidation. | `filesystem-events.ts`, `useWorkspaceTree.ts`, server `workspaces/file-watches.ts` |
| Git changes | Shared filesystem cache invalidations debounce locally for 100 ms; one passive refresh plus a pending follow-up; hidden project/panel marked stale. Queued reads cancel on deactivation/disposal and request versions fence late status/diff results. Reads share the secondary HTTP budget. Server shares only in-flight status requests and runs status/diff process creation in the Git worker. | `useGitChanges.ts`, `filesystem-events.ts`, server `workspaces/git-status.ts` |
| Worktree display | Last successful server snapshot; demand-driven refresh after 10 s or invalidation; one scan per workspace; obsolete scans discarded and followed by validation; UI display requests coalesce with one trailing demand. Pending recovery can explicitly request `?fresh=true` once after a missing/not-owned inventory-only candidate. Concurrent fresh callers share their fresh read, never a cached completion. Fresh and display outcomes are independent on one serialized read/publication lane: a failed fresh read rejects its callers without dropping queued display demand or leaking freshness into later requests. | server `workspaces/worktree-inventory.ts`, UI `stores/worktrees.ts` |
| Worktree authority | Validated reads await stale-inventory revalidation; family transactions force scans. Ownership misses can bypass a warm inventory once per directory-cache lifetime. Create/remove requires a validated next display read. | server `workspaces/worktree-directory.ts`, `manager.ts` |
| Git ownership preflight | Common-directory reads resolve the enclosing checkout's administrative files (`.git`, `commondir`, `HEAD`/`objects`) directly on every call; concurrent reads share one pending read per directory. Environment overrides, paths inside `.git` and invalid layouts defer to Git, whose commands run with two process slots in a lazy worker, keeping Windows process creation off the HTTP/SSE thread. Completed/failed reads are removed immediately; a matching identity still requires native inventory validation. | server `workspaces/git-common-directory.ts`, `git-process.ts`, `git-worktrees.ts` |
| Render cache | Explicit versioned values scoped to instance/session, invalidated by version only. | UI `lib/global-cache.ts` |
| Background HTTP reads | Worktree display, Git status/diffs, project/location/status maps, composer catalogues, Shell lists and pending-request scans share two browser request slots across instances. Queued scans observe cancellation; per-request timeouts start at dispatch. Session/message reads and mutations stay independent so catalogue fan-out cannot occupy all HTTP/1.1 connections. | UI `lib/background-read-queue.ts`, `lib/sdk-manager.ts`, `stores/instances.ts`, `stores/worktrees.ts` |
| Virtualized lists | Session list, transcript and timeline use `virtua/solid`; virtualization bounds rendered rows only. | UI `session-list.tsx`, `virtual-follow-list.tsx`, `message-timeline.tsx` |

Git updates are regulated but always full: each server status calculation runs
five Git commands plus untracked-file processing, and the UI also requests
native status. Continuous activity can sustain repeated full calculations and
selected-diff reads.

The worktree cache is in memory; the first native inventory scan and mandatory
authoritative scans pay their full cost. The event relay isolates these waits by
entity and recipient and never substitutes stale display data for authorization.

Pending recovery's fresh-read and session-family move-hold rules are in
[NATIVE_INTERRUPTION_UX.md](NATIVE_INTERRUPTION_UX.md). `worktrees.ts` captures
the exact source/target locations before the single move mutation and
`session-api.ts` releases them; missing/changing project metadata,
directory-only/partial inventories, failed activity and superseded reads never
release a newer move's hold. Notification history keeps its entries when
recovery later succeeds.

### Stats restoration and native cost

Rules: [SETTINGS.md](SETTINGS.md) (Stats). Storage is the backend
`SettingsService` UI state owner (also serving Preferences recreation and
browser/remote clients), one document per backend/profile. Only an opaque SHA-256
fingerprint is stored: authenticated `config.get` global discovery root, host or
WSL distro, authenticated service channel and exact backend opened folder, never
credentials, native paths, PID, transient port or workspace UUID. A changed
channel misses the cache; snapshots never authorize a Location or mutation.
Period and timezone stay separate; corrupt/oversized entries are display misses.

The fast host/channel/folder key restores only the period; reusing metrics
requires the full discovery identity. Late discovery
attaches identity only when its unsaved opaque live connection token matches
the fresh response. Receipt order is assigned before connection acquisition and
admitted only on an owned current connection into a bounded frontier (64
entries, retired-order floor); client `from`/`to` never act as freshness.
Optional publication is capped at 32 pending operations, rechecks ownership,
uses the 10-second discovery deadline and drains on backend close. Reconnect
checks host/channel/folder without discovery; a display without a verified
discovery identity is never adopted by a changed live connection, and unknown
observations never relabel old metrics.

Hidden, minimized and occluded native Preferences windows are unqualified:
Electron's Preferences bridge exposes minimize only as an action, and Tauri
exposes no Preferences visibility observation. Native `session.stats`
re-aggregates the whole range on every GET (31-day windows, compaction events in
batches of 500, even with `tools: "none"`), so large histories are slow upstream.

### Event relay ordering and recovery

Beyond the relay rule in [OPENCODE_COMPATIBILITY.md](OPENCODE_COMPATIBILITY.md)
(server `workspaces/instance-events.ts`, `instance-event-queue.ts`): per-session
order includes move/delete, unrelated sessions have no global order, other
scoped events keep FIFO per complete native location and global notifications
have their own lane. Ownership promises/2 s
results are shared per recipient and full location. Ingestion-time worktree
invalidation and local inventory changes fence pending ownership checks;
stopped/reopened workspaces and disconnected stream generations cannot publish
late work. Budgets: 2,048 retained jobs, 32 MiB conservatively counted serialized
payload, 60 s per routing job including queue wait; a breach fails that
subscriber, clears its queue and emits the normal error/reconnect statuses. Never
silently drop a delta or restart the shared daemon. Rate-limited slow-routing
logs separate event age, location resolution, queue wait and ownership time
(type/recipient metadata only).

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

The saved session and its last captured catalog are restored together; catalogs
are optional, versioned graph extensions shared by Electron and Tauri. Older
snapshots simply need one successful catalog load before they can offer this
cache. Corrupt catalog chunks discard only display metadata, retaining selected
identity, drafts and other state. Native aggregate byte/partition limits apply
atomically and are the only bound on the catalog. This display cache never
grants directory authorization or persists transcript bodies or permissions.
The saved session and composer catalogues load once the client is ready,
independently of the complete project-family inventory. Supplemental metadata waits for session hydration.
Creation-ownership release starts alongside saved-session hydration; its HTTP
acknowledgement must not gate the visible conversation.
The visible project's first session page, project identity and worktree
membership bypass the secondary budget, as does saved ancestry. Otherwise a slow
Git/permission scan can hide every other-worktree conversation until it finishes.
The first project page publishes verified families additively, without waiting
for the historical cursor traversal. Historical pages and restored chains from
other projects share that budget, so their parallel hydration cannot queue ahead
of the visible transcript.
Before selection is known, root pages also share the secondary budget. Pending
root/ancestry reads observe active selection and leave that queue immediately
when selected, without restarting already dispatched requests (`lib/prioritized-read.ts`).
Catalogue refreshes recheck client, location and request ownership before dispatch.
The first native connection can supersede an initial HTTP read without passing
through the reconnect recovery gate; session lists and catalogues replace those
obsolete reads unless a newer request, cancellation or disposal owns recovery.

Runtime-status responses cannot block list publication or overwrite newer SSE and
local admission state. Pending-request liveness refreshes only the status map,
never re-traversing the whole session inventory.

## Agent conventions

- The browser opens only a few connections to the CodeNomad server. The selected transcript and its metadata read directly; secondary panel and timeline reads (plugin controls, outlines/previews) go through `secondaryRead` in `lib/api-client.ts`, sharing the bounded `backgroundReads` budget. Provider usage stays direct (superseded reads run to completion and are fenced), and so does the OpenCode status read awaited by Restart/Start, so daemon-bound reads in the shared budget can never hold it. Startup effects must not track app-wide state they only await (`untrack` readiness gates), or every restored workspace update restarts and requeues the transcript read. Search visibility must be value-diffed before its close effect: reactive instance metadata can change while search stays closed, and running search cleanup then would cancel the initial transcript read. Restore tests must exercise reactive identity accessors and assert visible messages as well as request counts.
