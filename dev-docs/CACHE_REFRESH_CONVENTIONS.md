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

Current daily/native-scheduled passages acquire a source identity before slices and reuse
the bounded selected-mission inventory owner without directory or finish-counter reads.
Body keys include that exact passage source. Owner revision fences publication separately
from frozen execution-source identity, preserving unchanged task/body windows through
unrelated journal updates. Archive reads retain their exact receipt and one range observation.
An outstanding current-body demand retains one 30-second deadline/cancellation lifetime
through every semantic slice, automatic restart and revalidation. Fulfillment ends that
operation; a later user extension/Retry can admit a fresh budget. Validate assembled
content before promoting it, and retain the last good display on expiry.

### Execution-server foundation contracts

`opencode/servers/connections.ts` implements the active-target contract and
`opencode/servers/types.ts` supplies its constants:
four explicit targets plus one reserved local target, atomic admission shared by
target across projects/windows, release on last project close, and retention while
an admitted target is offline. Restore order follows the existing queue; an excess
target stays reconnectable with a quota reason, without eviction. Explicit
Connect/Disconnect intent stays in memory; Disconnect cancels and fences work,
preserves tabs/drafts and never stops OpenCode. Connect without a project retains
its slot until Disconnect/shutdown or its first attach/last-close cycle.

The administrative probe contract uses a separate single lane, 5 s and 8 MiB,
without active slots, streams or retries. Aggregate event constants are 2,048
jobs/32 MiB/60 s, reserving 256 jobs/4 MiB for local work and assigning each
explicit source a fixed 448-job/7-MiB share without borrowing; secondary browser
reads remain two globally. Local-only operation retains 2,048 jobs/32 MiB.
Activating explicit shares shrinks new local admissions while already admitted
local work drains inside the aggregate ceiling. A denied admission during this
transition marks a gap, drains grandfathered work and then reconnects.
Generation-qualified capability snapshots are transient;
durable execution bindings use server ID and opaque directory.
Workspace metadata reads derive explicit capabilities from the connection owner's
already validated current connection, with zero acquisition, discovery or provisioning.
Invalidation and pending/failed negotiation expose unverified native E1 capabilities;
successful reacquisition publishes the current connection generation for all its
projects. Issued descriptors keep their historical capability snapshot. Relay event
source generations and connection capability generations have independent owners.

Explicit live interruption envelopes pair that captured connection generation with
the relay attempt and an occurrence's `liveGeneration` status boundary. Ownership
gap pulses advance the boundary even on one attempt. The relay snapshots it per
recipient before queueing and includes it in prepaid envelope bytes; publication
after ownership waits preserves that capture. Cached/replayed statuses retain the
same identity. The UI validates the correlation before delivery and retains its
backend-transport lifetime. Matching late metadata qualifies only current captured
interruption candidates, without scans, re-admission or network work. Prompt,
inventory, transcript and media owners keep their existing generation and ordering
rules. See [Native interruptions](NATIVE_INTERRUPTION_UX.md).
Capability snapshots retain the backend-transport owner captured before their
HTTP request or at workspace-event ingress, before restore deferral. Each ingress
has a distinct shallow capability snapshot; descriptor selection and display clones
retain that snapshot's owner. Absent capabilities preserve the displayed snapshot.
Publication consumes this provenance. A fresh current-transport snapshot qualifies the
matching current candidate; cached numeric equality across transport lifetimes
stays display-only. Retired occurrence boundaries remain held for that transport,
with new boundaries required for same-ID replacement admission.

Session placement owners live at the `session-state.ts` publication boundary.
Captures retain exact directory/workspaceID scalars and an opaque token; accepted
placement transitions replace that token synchronously before subscribers run,
including inner-Map mutations, HTTP merges and an A→B→A within one turn. Removal
retires the token and reinsertion starts a fresh owner. Equal placement and unrelated
metadata preserve it. Cold live requests may retain their event Location through
matching first hydration. Session actions, media continuations and Form admissions
consume this shared placement owner independently of native/connection generations.
Occurrence destruction retires its captured tokens while preserved session rows
remain display data for restoration.

Renderer restoration follows that durable binding for tab reconciliation,
occurrence numbering and preserved-state merges. A runtime tab ID can claim a
saved tab only with a matching server/directory identity. Local-only normalization
is shared in `lib/project-identity.ts`; explicit paths retain exact spelling.
Session catalogs, outline chunks, attachments and session IDs inherit the saved
workspace shell's server identity, keeping existing per-instance reducer keys.
Optional chunk corruption keeps its current bounded degradation behavior.
Accepted tab removal publishes after fallback selection and captures immediately;
ordinary edits retain the debounced capture. Both paths honor restoration,
ownership and native shutdown gates.
Explicit tabs restore through their saved server/directory binding. Unknown targets
stay preserved for repair. Recognized development credential references are
discarded during import; live connection authority stays in memory.

The backend/config `SettingsService` shares the connection owner across windows.
Target reservation happens synchronously before negotiation; same-target callers
share one pending promise. Initial admission failure releases its reservation;
invalidation of an admitted target retains it for retry and credential rotation.
`retainProject(binding)` returns an idempotent occurrence lease; the last release
aborts requests and releases the slot, including a prior Connect pin. Disconnect
fences immediately; held leases and opportunistic workspace reads require explicit
Connect before resuming. New project/restoration intent and Connect acquire slots;
plain reads never reserve one. The caller's existing restoration queue determines
admission order. Captured transports check their generation at dispatch, after
negotiation/body preparation and on response/stream completion. Late results and
retired invalidation callbacks cannot affect replacement generations.

| Area | Current behaviour | Implementation |
| --- | --- | --- |
| Session catalog | Per-window, per-workspace persistent display metadata for every known root and descendant. Byte-sized native partitions bound it, independently of session count and the draft string budget. Seed titles, ancestry, locations, selection and expansion before HTTP hydration. Cached rows carry unknown runtime status; the selected chain is revalidated directly, while the owned project inventory refreshes asynchronously. Partial/failed/directory-only initial pages never evict saved workspace families; a complete owned inventory reconciles absent rows with concurrent-update fences. | `stores/session-catalog-persistence.ts`, `session-catalog-hydration.ts`, `client-state-catalog-partitions.ts`, `session-api.ts` |
| Session outline | Structural indexes independent of transcript and excerpts; up to 16 memory snapshots / 200k entries (one larger active index allowed). Restoration persists up to 16 indexes / 200k entries / 16 MiB in optional content-addressed chunks. Saved geometry displays before full checkpoint revalidation; only changed ranges resend entries. The last range grows to 512 rows before another is added. Returning to an unchanged session reuses its index; native message changes revalidate checkpoints. Destructive mutation, generation, location/project and undo boundary fence reuse. Paused scans retain cursors. | `packages/ui/src/stores/session-outline.ts`, `session-outline-persistence.ts`, `client-state-outline-partitions.ts` |
| Timeline previews | At most 512 bounded Markdown excerpts. Visible-nearby batches of 12, hovered ID first; obsolete demand cancels. Thirty-second age prompts on-demand revalidation only. Generation, mutation and undo fence reuse. Previews never load transcript windows or change geometry. | `packages/ui/src/stores/timeline-previews.ts` |
| Providers/models | Retained signals; shared in-flight catalogue load; dirty-bit trailing refresh; instance, location and request-generation checks. `fetchProviders` itself reuses only in-flight loads. | `packages/ui/src/stores/session-api.ts` |
| Provider Usage | Panel-local snapshot; same-location `provider.updated` revalidates in place with one in-flight read and coalesced trailing demand. Window-label keys preserve quota DOM across responses. Duplicate transport statuses and instance/status/native-generation snapshots are no-ops. A changed native generation still fences quotas even if the disconnect was missed. Credential/integration/config events, native `server.connected`, real connection transitions and source changes clear the snapshot immediately and fence old responses/trailing demand. Failures revoke quotas, since the account may have changed. Only a visible panel reads, and quotas stay panel-local. | `components/session/provider-usage-panel.tsx`, `provider-usage-state.ts` |
| Session goal | Per instance/session snapshot of the shown session's `/goal`. The goal line's demand (Status shown) reads through the secondary budget: one read plus one trailing follow-up. `rpc.opencode.goal.changed` publishes at once and fences replies requested before it (per-session version); an unreadable change reads again. Reconnects (`server.connected`, connected status, stream open) re-read demanded sessions; the line's commands read their outcome. A failed read keeps the last goal; deletion and workspace stop drop it. | `stores/session-goal-store.ts`, `session-goal.ts` |
| Integration binding | Demand-only authority for the shown instance/Location/session/integration, shared across Status sections and their picker through the secondary budget. Invalidations immediately publish `unknown` and fence older replies; events coalesce over 300 ms with one trailing follow-up. Reconnect/open reconcile demand, disconnect revokes authority, and read failures publish `unknown`. Last-demand release aborts and drops state. Every admitted attachment mutation invalidates and rereads its captured target in `finally` while demanded. | `stores/integration-bindings-store.ts`, `integrations.ts` |
| Stats | Backend-owned `state.ui.serviceUsage`; rules in [SETTINGS.md](SETTINGS.md), restoration below. Reads follow explicit demand, terminal hints (shared five-second activity cooldown), reconnect and visibility; never poll. Hiding/disposal fences in-flight publication. | server `opencode/service-usage-cache.ts`, `service-usage.ts`; UI `settings/usage-settings-section.tsx` |
| Session model selection | Native selection events invalidate the displayed selection and never overwrite it, because SSE echoes can lag successful HTTP writes. Coalesced authoritative reads share the session admission queue with prompts and explicit selections; captured instance request authority fences dispatch and publication, including explicit connection rotation. Returned session identity and explicit Location are validated; captured-selection checks retain newer choices. Catalog merges preserve pending optimistic choices; successful writes publish a fresh model object so pre-confirmation snapshots lose authority. Read failures retain display state until the next event or reconnect refresh. | `stores/session-model-reconciliation.ts`, `stores/session-action-queue.ts`, `stores/session-generation-recovery.ts` |
| Instance preferences/history | Per-key write owners and publication epochs fence HTTP cache publication before subscriptions run. Newer same-context writes supersede older ACKs; captured action authority also gates preference writes after rotation. Every accepted server snapshot advances the epoch, including equal data. A current ACK crossed by an event uses up to three 10-second authoritative reads to resolve ordering; retired writes publish nothing and never replay. The cache/subscription is the single accepted mutation publisher. Subscription and load cleanup remove only their captured owners; explicit retirement invalidates cache/read/write owners before reuse. Incoming valid snapshots retain their own authority, independent of the action that installed a subscription. | `lib/storage.ts`, `stores/instance-config.tsx` |
| OpenCode setup | Shared in-flight status read plus coalesced trailing refresh for focus/visibility/reconnect demand. Executable changes and explicit actions fence old responses. Failed reads retain version/path diagnostics but revoke the connected claim and stale reload/restart controls; Continue checks again before retrying the pending workspace. Activation requires a successful pre-action status read. | UI `stores/opencode-setup.ts`, `components/settings/opencode-setup-panel.tsx` |
| Filesystem invalidations | Host directory observations and native filesystem events coalesce before cache publication: 100 ms quiet-case delay, then at most once per five seconds in continuous activity; timers run only during activity. Explicit mutations/recovery invalidate immediately. Workspace versions target the browsing root and listed directory; only changed visible directories reread. Hidden/collapsed caches stay stale until demand. Bounded metadata falls back conservatively to full invalidation. | `filesystem-events.ts`, `useWorkspaceTree.ts`, server `workspaces/file-watches.ts` |
| Git changes | Shared filesystem cache invalidations debounce locally for 100 ms; one passive refresh plus a pending follow-up; hidden project/panel marked stale. Queued reads cancel on deactivation/disposal and request versions fence late status/diff results. Reads share the secondary HTTP budget. Server shares only in-flight status requests and runs status/diff process creation in the Git worker. | `useGitChanges.ts`, `filesystem-events.ts`, server `workspaces/git-status.ts` |
| Worktree display | Last successful server snapshot; demand-driven refresh after 10 s or invalidation; one scan per workspace; obsolete scans discarded and followed by validation; UI display requests coalesce with one trailing demand. Pending recovery can explicitly request `?fresh=true` once after a missing/not-owned inventory-only candidate. Concurrent fresh callers share their fresh read, never a cached completion. Fresh and display outcomes are independent on one serialized read/publication lane: a failed fresh read rejects its callers without dropping queued display demand or leaking freshness into later requests. | server `workspaces/worktree-inventory.ts`, UI `stores/worktrees.ts` |
| Worktree authority | Validated reads await stale-inventory revalidation; family transactions force scans. Ownership misses can bypass a warm inventory once per directory-cache lifetime. Create/remove requires a validated next display read. | server `workspaces/worktree-directory.ts`, `manager.ts` |
| Git ownership preflight | Common-directory reads resolve the enclosing checkout's administrative files (`.git`, `commondir`, `HEAD`/`objects`) directly on every call; concurrent reads share one pending read per directory. Environment overrides, paths inside `.git` and invalid layouts defer to Git, whose commands run with two process slots in a lazy worker, keeping Windows process creation off the HTTP/SSE thread. Completed/failed reads are removed immediately; a matching identity still requires native inventory validation. | server `workspaces/git-common-directory.ts`, `git-process.ts`, `git-worktrees.ts` |
| Transcript pages | Session reducer reads and first latest-window loads merge their page with the rows streamed during the fetch; only destructive events (deletion, revert commit, inbox cancellation, compaction boundaries) restart a reducer read. Reloads and history windows keep revision checks. Event-driven projections coalesce to one pass per animation frame. Rules in [TRANSCRIPT.md](TRANSCRIPT.md). | UI `stores/opencode-data.ts`, `opencode-projection-frame.ts`, `opencode-data-read-merge.ts`, `session-api.ts` |
| Mission bodies | Display-only content-route reads keyed by workspace, project, mission and selector; continuations pinned to their first slice's digest, read only as far as the shown page needs. One read at a time per body with coalesced demand. The panel's maps are compact: a descriptor in place of each body. A shown body is read again when its map's descriptor names another digest (a map naming no descriptor expects nothing); a plugin update, reconnect or new stream advances the entry's invalidation epoch, so a request sent before it neither settles nor parks the body and one fresh read follows. The last good body stays shown until the newer one covers it; failures (a plugin without content reads included) show beside it and park until demand, an invalidation or Retry. Intents copying inputs (edit prefill, Save as brief) accept only bodies whose digests are their snapshot's descriptors. Unshown bodies stay within 4 MiB / 128 bodies, LRU. Never authority. Rules in [MISSIONS.md](MISSIONS.md) (Body display, Compact maps). | UI `stores/mission-content-store.ts`, `stores/mission-content.ts`, `components/mission-target-bodies.ts` |
| Mission task pages | A compact map holds a page of its tasks; reads further (`loadTasks`: a window of 50 or tasks by name) name the map's display order and run in turn per mission, an identical waiting read coalesced and a running one followed by one trailing read. Each read is recorded before it is sent; rows, reports and reads each keep the revision of the page that answered them, so a page vouches only for what it answered. An answer in the shown order merges into the list read's own map (a row it holds stays unless a page answered it later), a refusal or another order reads the list again. List publications keep the rows of the same order (last good display), drop caches of maps no longer listed, and read again each read last answered before the map's revision, from scratch in another order. A failure keeps the rows with Try again and parks its read until a later revision or an explicit retry; it stays shown until a read answers it, whatever else succeeds. Attention windows count as covered only for the attention sequence they answered. A body a row read further describes is expected at that page's revision; an older plugin's undescribed history is read again when its report metadata changes. `clear` fences reads in flight (epoch and cache identity). Reads share the secondary background budget. Never authority. Rules in [MISSIONS.md](MISSIONS.md) (Task pages). | UI `stores/mission-store.ts`, `stores/mission-task-pages.ts` |
| Mission panel inventory | Live picker/cleanup discovery uses explicit 50-row logical windows through `panelPage`. Content digests verify that window; a separate order digest covers the collection's row values and fences further selections. Only selected/reader-wanted missions load bounded headers and task windows; root collection/extension descriptors permit exact field reads. Every window retains its own revision and failed selector. A failed middle window stays failed through unrelated successes; changed cursors park for explicit restart/Retry. Passive refresh reads first windows and wanted headers, preserving expanded displays without replaying every read after unrelated revisions. Initial discovery point-reads the durable finish counter before hints; completion seeding happens once, independently of partial summary maxima. Exact cleanup reconciliation keeps its existing single-mission path. Every transfer retains the shared secondary slot through bounded stream cleanup, with one 30-second logical deadline and source-specific preallocation limits. Hints serialization/order work remains in the append lane and linear in the whole chosen collection per transfer. | UI `stores/mission-panel-inventory.ts`, `lib/mission-task-page-read.ts`; server `missions/mission-panel-page.ts`, `mission-panel-header.ts`, `MissionControl.panelPage` |
| Opt-in Mission live windows | `panelPage` activity selects at most 160 actors of one mission; marks select at most 16 hint contexts of 10 actors. Native observation reuses existing budgets and root/connection/deletion fences after the append exclusion. Every continuation re-observes and refuses changed content; zero automatic restarts and no retained observation cache. Partial/unknown family and request coverage stay explicit, including off-page actors. Consumers park failed windows, retain last-good display and restart changed rows from their first piece explicitly. | server `missions/mission-activity-context.ts`, `mission-panel-observation.ts`, `activity.ts` |
| Mission task transport | One requested window or named read through `panelPage`, 64 KiB per response and 16 KiB per selector. Each secondary slot covers headers plus bounded body consumption/cancellation; one 30-second deadline starts before the store queue and covers final hash/validation/publication. Window text admits at most 8 Mi UTF-16 units, 24 MiB UTF-8, 64 MiB cumulative wire bodies and bounded JSON structure/nested compact shapes. Digest/length/header, semantic selector/report/counter checks and UTF-16LE SHA-256 precede publication; WebCrypto and the pinned browser-safe fallback cover secure and HTTP-only origins. Partial text is operation-local; failures park with Retry, while supersession stays distinct from empty success. Last-owner release advances a monotonic mission lifetime; concurrent owners preserve it. Live readers own reconnect refresh demand independently of the panel. | UI `lib/mission-task-page-read.ts`, `mission-task-page-schema.ts`, `mission-task-window-budget.ts`, `mission-task-read-lifetime.ts`, `stores/mission-store.ts` |
| Internal explicit transcript pages | One native page per demand, up to 200 messages. Originating order and captured client/binding/native/connection-generation authority stay in the existing window owner in memory. Selected-session navigation is foreground; other page reads share the two secondary slots. Same-intent consumers share current reads; a replacement authority starts fresh. Pages merge native live changes without polling; historical membership stays bounded. Failed/empty probes preserve the resident passage and saved anchor. Cold unsupported anchors keep their position pending explicit latest-page recovery. | UI `stores/session-api.ts`, `message-v2/message-window.ts`; [SESSION_HISTORY_NAVIGATION.md](SESSION_HISTORY_NAVIGATION.md) |
| Render cache | Versioned display values scoped to instance/session. Explicit Markdown stores sanitized HTML with its producing binding and reauthorizes before publication; mismatched/unqualified snapshots use the unknown-source policy. The instance owner's memory-only `renderBinding` survives component remounts and cache eviction. Native-reference Markdown reparses on demand. Cached tool diff HTML shares the publication filter. Local-image candidates for explicit content are reauthorized against current held native references; legacy scans retain their per-object/revision cache. | UI `lib/global-cache.ts`, `lib/markdown-html-policy.ts`, `lib/markdown-local-images.ts` |
| Deferred media HTTP | One captured connection per user-demanded media read. Every upstream envelope is buffered within 16 MiB of decompressed bytes before SDK parsing, with cancellation on overflow, 30-second deadline, socket close or retired authority. Session/Location/undo/digest are revalidated before immutable-byte publication. | Server `opencode/session-media-fetch.ts`, `server/routes/session-media.ts` |
| Known Form verification | One explicit source-editor gesture, one native Form GET; Session GET before/after for session Forms, exact encoded directory for globals. Two existing global secondary slots, ten seconds including queue/acquisition/profile, four MiB per decoded success/error response before SDK parsing. Captured source, immutable binding, client/native/connection generation, backend transport, request revision and attempt fence publication. Terminal/indeterminate results retain drafts; changed editor fields stay indeterminate. Coverage stays unknown/live-only and retry requires another gesture. | UI `stores/form-verification.ts`; server `explicit-form-verification.ts`, `opencode/bounded-response-fetch.ts` |
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
have their own lane. `server.connected` is relayed with a `daemon` field: an
opaque token held only for the current source by the relay, issued randomly.
Local tokens remain stable across verified same-source reconnects and rotate
with the source (the superseded credential-bearing key is dropped with it).
Explicit tokens are attempt-local. Tokens release on disposal and are absent
from unattributed streams. The UI gates reconnect transcript continuity on a
matching token and keeps a hard reset otherwise. Ownership promises/2 s
results are shared per source, recipient and full location. Ownership/session
caches retain at most 1,024 entries each; PTY/Shell/global-Form placement caches
retain at most 1,024 entries each with a 60-second idle TTL. Ingestion-time worktree
invalidation and local inventory changes fence pending ownership checks;
stopped/reopened workspaces and disconnected stream generations cannot publish
late work. Budgets: 2,048 retained jobs, 32 MiB conservatively counted serialized
payload including each delivery envelope. Resolution and all recipient delivery
capacity are charged together at ingestion; unused reservations release on
resolution and prepaid deliveries keep their original deadline. The deadline is
60 s from ingestion through resolution and delivery; a breach fails that source,
clears its queue and emits attributed error/reconnect statuses with a structured
gap reason. FIFO drains and ingestion yield every 32 events/jobs. Never
silently drop a delta or restart the shared daemon. Rate-limited slow-routing
logs separate event age, location resolution, queue wait and ownership time
(type/recipient metadata only).

The connection owner's synchronous admitted-slot snapshot/observer owns relay
membership. Each admitted explicit target has one runner, including a Connect pin
without recipients. Initial failures, reservations, probes and excess targets have
no runner. Offline retry retains the slot with exponential jittered backoff capped
at 30 seconds; rotation revokes the current iterator and queued work. Last release,
Disconnect and disposal cancel the runner without stopping OpenCode. Credential
changes interrupt an offline retry timer immediately. Per-next abort listeners
release on settlement. Late project
attachment receives its current status and native connected marker. Source and
relay-attempt generation are captured before enqueueing, separately from workspace
epochs, connection assertions and the daemon token. Locationless session reads use
the captured source client. Unknown deletions/placements trigger a bounded gap pulse
only for that source's occurrences. Native worktree events invalidate local
inventories only when sourced from the local service.

The event bus retains only current occurrence statuses for new subscribers.
Workspace stop/error evicts that occurrence's statuses synchronously, including
when last-lease release has already disposed its relay. Offline admitted projects
retain their current status; relay source/occurrence fences govern late work.

### UI event stream liveness

`lib/server-events.ts` restarts the shared UI event stream once a connected
stream has carried no batch, open or ping for 45 s (`lib/stream-staleness.ts`,
checked every 15 s, once per silent episode); an `online` event or the page
becoming visible restarts it as soon as that threshold has elapsed. Each
connection attempt starts its own threshold. The restart takes the ordinary
reconnect path, so the reconnect refresh reconciles state. The server pings
every 15 s (`server/routes/events.ts`): keep the threshold at several ping
intervals.

## Initial session hydration

Instance-config readers share a cold load while its initiating caller remains current.
A surviving reader whose shared owner retires joins a current replacement (at most
three joined loads) or starts one read under its own authority before returning.
Failed current replacement loads reject before dependent model/default selection and
leave the snapshot unloaded for explicit recovery. Ordinary first-load failures keep
their existing best-effort default. Load cleanup removes only its captured owner.
Preference saves retain their best-effort publication contract; history callers keep
their ordinary predicate, independently of OpenCode session authority.

Native explicit transcript page coalescence includes the existing load signal/epoch
and current source window alongside instance authority. Superseded reads release
new same-intent demand before their promise settles. The pre-read row snapshot is
merged again after a dependent model read; empty native latest replies with
residents retain their passage and reading anchor before any live-row merge.
Receipt enrichment admission precedes component mounting, cache acquisition and
queued receipt dispatch for explicit bindings.

Explicit occurrences use the internal exact-Location session policy in
`stores/session-inventory-scope.ts`. Their first bounded page publishes independently
of project/worktree discovery and runtime activity. Continuations run on demand
through the shared two-slot secondary queue, with cursor-only native requests.
Passive first-page refreshes share their in-flight read and coalesce demand into
one trailing refresh; strict/cancelable operations retain their own request owner.
Selected first pages and selected restored ancestry keep foreground promotion.
Client, binding, native-data generation and connection-capability generation fence
dispatch, publication, targeted lookup and absence reconciliation. Saved cursors
from a superseded traversal remain unusable until a fresh first-page read.
The traversal owner holds its captured-row references and fetched IDs until the
terminal page qualifies exact absence reconciliation; concurrent row changes win.
Snapshots survive partial pages and read failures. Native title search is one
bounded page with an incomplete-result notice. Ordinary session listing has its
own authority, separate from pending-request recovery.

The session traversal also owns failed-continuation provenance. Retry keeps that
cursor and snapshot while the traversal remains current; a fresh first-page read
clears the continuation failure. Native event metadata lookups reuse the inventory's
client/binding/native/connection-generation fence before dispatch and publication.
Pending status lookups coalesce only while that captured authority is current.
Their status/retry continuations also check the latest native lifecycle order,
including newer events on the same connection. Metadata merges compare the row
captured before the read with the live row, preserving runtime authority supplied
by concurrent hydration and subsequent native events.
Inventory, ancestry, search and targeted metadata reads share request ordering.
Weak row provenance retains their HTTP snapshot through pending/status projections
and native/local edits: a current lookup can update fields supplied by an earlier
read while preserving fields changed since that snapshot. Runtime authority keeps
its separate pre-read baseline; runtime-only projections retain metadata provenance.
An external move updates the held native Location before exact-scope projection,
preserving its native parent and draft. Debounced move refreshes recheck their
captured occurrence before dispatch and after dependent reads; candidate projects
share the source server. Explicit candidates require the exact opaque directory,
and their refresh reads only the bounded session page. Local worktree discovery
keeps its existing scope.

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
