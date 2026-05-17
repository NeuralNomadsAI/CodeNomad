---
title: Session List Refresh Icon Does Not Animate For Active Session
complexity: standard
track: implementation
slice: ui
status: active
assigned_to: developer
---

# Goal

Fix a reported UI bug: in the session list (left sidebar), the small refresh (reload) icon **does not animate** (no visible spinner) **when the user clicks it on the currently active session**, even though it animates correctly on any non-active session.

# Request Context

The Product Owner reported:

> "Found a bug where the little refresh icon in the session list doesn't animate if it's on the currently active session."

# Investigation Summary (Tech Lead)

Root cause: `loadMessages(..., { force: true })` in `packages/ui/src/stores/session-api.ts` silently early-returns when the target session is already present in the `loadingMessages` set (lines 728–731). The `force: true` flag only invalidates `messagesLoaded`; it does **not** bypass the `isLoading` short-circuit. The currently active session is the only session reliably in `loadingMessages` at click time, because of:

- `packages/ui/src/components/session/session-view.tsx:196` — `createEffect` calling `loadMessages` whenever the active session mounts.
- `packages/ui/src/stores/session-events.ts:622` — post-compaction reload using `force: true`.
- Any in-flight refetch already triggered by SSE-driven hydration.

When the user clicks the refresh icon on the active session, `await loadMessages(..., { force: true })` resolves in the same microtask. `handleReloadSession` (`session-list.tsx:229–251`) adds and removes the session id from `reloadingSessionIds` in the same microtask, so the browser never paints a frame with the spinner — the user sees no animation.

CSS is **not** the cause. `.session-item-active` (`session-layout.css:330–343`) and `@keyframes spin` (`utilities.css:142–144`) are clean and have no override that would interfere with `animate-spin` on a descendant `<svg>`.

A second, related defect is that `session-events.ts:622`'s post-compaction reload shares the same silent-drop behavior; after a compaction event, the UI can be left with stale messages until the next user-driven action. The fix below corrects both call sites.

# Scope

In scope:

- `packages/ui/src/stores/session-api.ts` — make `loadMessages({ force: true })` honest: when an in-flight load exists, await it then refetch, instead of silently dropping.
- `packages/ui/src/components/session-list.tsx#handleReloadSession` — wrap the await so the spinner is held for a minimum visible duration regardless of load speed.
- `packages/ui/src/lib/min-duration.ts` (new) — pure helper exporting `withMinimumDuration` and `MIN_RELOAD_SPINNER_MS`.
- `packages/ui/src/lib/min-duration.test.ts` (new) — `node:test`-based regression test for the helper.

Out of scope:

- Visual restyling of the icon.
- Refactoring of `session-list.tsx` / `session-api.ts` for file-length reduction (both are above 800 lines; flagged separately).
- Any other reload/refresh affordance in the app (git panel, diff panel, etc.).

# Acceptance Criteria

- AC-1: `loadMessages(instanceId, sessionId, { force: true })` no longer silently early-returns when the target session is already in `loadingMessages`. Instead, it awaits the in-flight request and then performs a fresh fetch. Concurrent `force: true` calls for the same session must serialize, not stack network calls in parallel.
- AC-2: Existing non-`force` dedupe behavior is preserved: when a load is already in flight and the caller passes `force: false` (or omits it), the call awaits the in-flight promise and returns without an extra fetch.
- AC-3: `handleReloadSession` in `session-list.tsx` guarantees a minimum visible spinner duration of `MIN_RELOAD_SPINNER_MS` (450 ms) so the spinner is perceptible even when the reload work resolves instantly.
- AC-4: A new pure helper `withMinimumDuration` lives in `packages/ui/src/lib/min-duration.ts` with injectable `now` / `delay` dependencies so it can be unit-tested without real time.
- AC-5: A `node:test` regression test in `packages/ui/src/lib/min-duration.test.ts` asserts the helper's behavior across the four cases (fast resolve, slow resolve, fast reject, slow reject) and runs green via `node --experimental-strip-types --test src/lib/min-duration.test.ts` from `packages/ui/`.
- AC-6: `npm run typecheck --workspace @codenomad/ui` and `npm run build --workspace @codenomad/ui` both pass.
- AC-7: Any discrepancies encountered are documented per the Discrepancy Resolution Policy.

# Implementation Notes

- The helper signature is `withMinimumDuration<T>(work: Promise<T>, minMs: number, deps?: { now?: () => number; delay?: (ms: number) => Promise<void> }): Promise<T>`. Both success and failure paths must respect the minimum duration (a failed reload should still show the spinner long enough to be perceptible before the toast appears).
- The in-flight dedupe in `session-api.ts` keys by `${instanceId}:${sessionId}`. Always clean up the map entry in a `finally` to avoid leaks. The `messagesLoaded` invalidation for `force: true` stays ahead of the await so any concurrent non-force caller arriving during the wait correctly observes "not loaded" and queues behind the new fetch.
- `MIN_RELOAD_SPINNER_MS = 450` is exported from the helper module so it is tunable in one place.

# Discussion Record

- PO reported the bug in chat. PMA scoped it as a `standard / implementation / ui` task (with investigation folded in because no separate Tech Lead subagent is available in this host) and executes it directly.
- Branch state mid-investigation drifted unexpectedly (a parallel session checked out `fix/mobile-session-list-blocks-tab-switch` and dropped the original task-060 file). PMA stashed the unrelated work and restarted from a clean `origin/dev` branch `fix/session-list-refresh-icon-animation`.

# Notes

- Base branch: `origin/dev`.
- Branch: `fix/session-list-refresh-icon-animation`.
- This task does not change product behavior; no SCR required.

# Post Implementation Task Updates

## Developer: Post Implementation Expectations

(to be filled in by the implementing agent before closure)
