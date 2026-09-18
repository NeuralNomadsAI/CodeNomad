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
| Render cache | Explicit versioned values scoped to instance/session; no network scheduler or TTL policy. | UI `lib/global-cache.ts` |
| Virtualized lists | Session list, transcript and timeline use `virtua/solid`; virtualization limits rendered rows, not network refreshes. | UI `session-list.tsx`, `virtual-follow-list.tsx`, `message-timeline.tsx` |

Git updates are regulated, but not incremental: every new server status calculation
runs five Git commands plus untracked-file processing, and the UI also requests
native status. Continuous activity can sustain repeated full calculations and
selected-diff reads. This is not a completed-result cache.

The worktree cache is in memory. It does not reduce the first native inventory scan,
the cost of mandatory authoritative scans, or all latency in the serial event relay.
An isolated native fixture covers warm-cache create/remove visibility; browser
fixtures cover menu updates, focus, old responses and refresh bursts.

## Initial session hydration

Project identity and worktree discovery start independently. The root-directory
session page can publish before checkout discovery finishes; complete project-family
reconciliation still waits for verified worktree membership. Metadata-dependent
callers retain the combined worktree/project readiness barrier.

Restored composer catalogues and MCP/plugin decoration wait for initial session
hydration rather than filling the browser's per-origin HTTP queue ahead of it.
Delayed catalogue refreshes recheck client, location and request ownership before
dispatch. The first native connection can supersede an initial HTTP read without
passing through the reconnect recovery gate, so the current non-strict session-list
loader replaces that read unless a newer request, cancellation or disposal owns it.
