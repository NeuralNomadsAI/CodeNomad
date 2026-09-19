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
| Providers/models | Retained signals; shared in-flight catalogue load; dirty-bit trailing refresh; instance, location and request-generation checks. No completed-result TTL inside `fetchProviders` itself. | `packages/ui/src/stores/session-api.ts` |
| Git changes | Filesystem events debounce for 100 ms; one passive refresh plus a pending follow-up; hidden tab marked stale; request versions protect status/diff. Server shares concurrent status requests, not completed results. | `useGitChanges.ts`, `filesystem-events.ts`, server `workspaces/git-status.ts` |
| Worktree display | Last successful server snapshot; demand-driven refresh after 10 s or invalidation; one scan per workspace; obsolete scans discarded and followed by validation; UI requests coalesced. | server `workspaces/worktree-inventory.ts`, UI `stores/worktrees.ts` |
| Worktree authority | Validated reads await stale-inventory revalidation; family transactions force scans. Ownership misses can bypass a warm inventory once per directory-cache lifetime. Create/remove requires a validated next display read. | server `workspaces/worktree-directory.ts`, `manager.ts` |
| Native event relay | Consume the shared SDK stream before slow I/O; resolve locations FIFO per session/PTY/Shell, then deliver FIFO per entity and recipient. Ownership promises/2 s results are shared by recipient and full native location; another recipient never delays successful delivery. | server `workspaces/instance-events.ts`, `instance-event-queue.ts` |
| Render cache | Explicit versioned values scoped to instance/session; no network scheduler or TTL policy. | UI `lib/global-cache.ts` |
| Background HTTP reads | Worktree display, project/status maps and pending-request scans share two browser request slots across instances. Queued scans observe cancellation; per-request timeouts start at dispatch. Session/message and composer catalogue reads stay independent. | UI `lib/background-read-queue.ts`, `lib/sdk-manager.ts`, `stores/instances.ts`, `stores/worktrees.ts` |
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

Project identity and worktree discovery start independently. The root-directory
session page can publish before checkout discovery finishes; complete project-family
reconciliation still waits for verified worktree membership. Metadata-dependent
callers retain the combined worktree/project readiness barrier.

Restored selection identity is seeded before HTTP hydration. The saved session and
composer catalogues load once the client is ready, independently of the complete
project-family inventory. Supplemental metadata waits for session hydration.
Catalogue refreshes recheck client, location and request ownership before dispatch.
The first native connection can supersede an initial HTTP read without passing
through the reconnect recovery gate; session lists and catalogues replace those
obsolete reads unless a newer request, cancellation or disposal owns recovery.

Runtime-status responses cannot block list publication or overwrite newer SSE and
local admission state. Pending-request liveness refreshes the status map rather
than repeatedly traversing the entire historical session inventory.
