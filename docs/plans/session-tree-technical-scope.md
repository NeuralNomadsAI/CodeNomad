# Session Tree Technical Scope

**Date:** 2026-01-11
**Status:** Scoping (No code changes)

---

## Overview

This document details the exact changes needed to integrate v0.6.0 session tree functionality, focusing on high-risk files and their modification scope.

---

## File-by-File Analysis

### 1. `stores/session-state.ts` (HIGH RISK)

**Current Lines:** ~400
**v0.6.0 Additions:** ~340 lines
**Risk Level:** HIGH - Core state management

#### New Types Added

```typescript
// New type for organizing sessions into threads
export type SessionThread = {
  parent: Session
  children: Session[]
  latestUpdated: number  // Max of parent/children update times
}

// Status indicator type (permission takes priority)
export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

// Counts for status badges on instance tabs
type InstanceIndicatorCounts = {
  permission: number
  working: number
  compacting: number
}
```

#### New Signals Added

```typescript
// Track which parent sessions are expanded in the tree
const [expandedSessionParents, setExpandedSessionParents] =
  createSignal<Map<string, Set<string>>>(new Map())

// Cache indicator counts per instance (for status badges)
const [instanceIndicatorCounts, setInstanceIndicatorCounts] =
  createSignal<Map<string, InstanceIndicatorCounts>>(new Map())
```

#### New Functions Added

| Function | Purpose | Complexity |
|----------|---------|------------|
| `getIndicatorBucket()` | Determine status priority (permission > compacting > working > idle) | Low |
| `adjustIndicatorCounts()` | Increment/decrement indicator counters | Medium |
| `recomputeIndicatorCounts()` | Full recompute from session map | Medium |
| `getInstanceSessionIndicatorStatusCached()` | Get cached status for instance | Low |
| `syncInstanceSessionIndicator()` | Sync indicator state | Low |
| `getSessionThreads()` | Build sorted thread list from sessions | Medium |
| `isSessionParentExpanded()` | Check if parent is expanded | Low |
| `setSessionParentExpanded()` | Set expansion state | Low |
| `toggleSessionParentExpanded()` | Toggle expansion | Low |
| `ensureSessionParentExpanded()` | Expand if not already | Low |
| `getVisibleSessionIds()` | Get IDs visible based on expansion | Medium |
| `setActiveSessionFromList()` | Set active, handling parent/child | Medium |
| `setSessionStatus()` | NEW - replaces `setSessionCompactionState` | Low |

#### Modified Functions

| Function | Change | Risk |
|----------|--------|------|
| `withSession()` | Now returns `void \| boolean`, tracks indicator bucket changes | **MEDIUM** - Signature change |

#### Removed/Replaced

| Item | Replacement |
|------|-------------|
| `setSessionCompactionState()` | `setSessionStatus()` |

#### Dependencies Introduced

```typescript
import { batch } from "solid-js"  // For batching state updates
import { requestData } from "../lib/opencode-api"  // New API helper
```

---

### 2. `stores/session-api.ts` (HIGH RISK)

**Current Lines:** ~670
**v0.6.0 Changes:** ~100 lines modified
**Risk Level:** HIGH - API calls and session management

#### Key Changes

1. **Status fetching in `fetchSessions()`:**
   ```typescript
   // NEW: Fetch status for all sessions
   let statusById: Record<string, any> = {}
   try {
     const statusResponse = await instance.client.session.status()
     statusById = statusResponse.data as Record<string, any>
   } catch (error) {
     log.error("Failed to fetch session status:", error)
   }
   ```

2. **Session creation includes status:**
   ```typescript
   // Session now includes status field
   const session: Session = {
     ...existingFields,
     status: "idle",  // NEW
   }
   ```

3. **Indicator sync calls:**
   ```typescript
   // After session changes, sync indicator
   syncInstanceSessionIndicator(instanceId, sessionMap)
   ```

4. **Fork API signature change:**
   ```typescript
   // OLD
   async function forkSession(
     instanceId: string,
     sourceSessionId: string,
     options?: { messageId?: string; parentId?: string }
   )

   // NEW - parentId removed from options
   async function forkSession(
     instanceId: string,
     sourceSessionId: string,
     options?: { messageId?: string }
   )
   ```

5. **Uses new `requestData()` helper:**
   ```typescript
   // OLD
   const response = await instance.client.session.fork(request)
   if (!response.data) throw new Error("No data")
   const info = response.data as SessionForkResponse

   // NEW
   const info = await requestData<SessionForkResponse>(
     instance.client.session.fork(request),
     "session.fork"
   )
   ```

#### Imports Changed

```typescript
// Added
import { mapSdkSessionStatus, type SessionStatus } from "../types/session"
import { syncInstanceSessionIndicator } from "./session-state"
import { requestData } from "../lib/opencode-api"
import { reconcilePendingPermissionsV2 } from "./message-v2/bridge"

// Removed
import { stopInstance } from "./instances"
import { setSessionCompactionState } from "./session-compaction"
```

---

### 3. `stores/session-events.ts` (MEDIUM-HIGH RISK)

**Current Lines:** ~640
**v0.6.0 Changes:** ~220 lines added/modified
**Risk Level:** MEDIUM-HIGH - SSE event handling

#### New Event Handler

```typescript
// NEW: Handle session status events
export function handleSessionStatus(
  instanceId: string,
  sessionId: string,
  event: EventSessionStatus
): void {
  const status = mapSdkSessionStatus(event.properties.status)
  ensureSessionStatus(instanceId, sessionId, status)
}
```

#### New Helper Functions

```typescript
// Apply status change with guards
function applySessionStatus(
  instanceId: string,
  sessionId: string,
  status: SessionStatus
): void

// Fetch session info if not in local state
async function fetchSessionInfo(
  instanceId: string,
  sessionId: string
): Promise<Session | null>

// Ensure session has correct status, fetching if needed
function ensureSessionStatus(
  instanceId: string,
  sessionId: string,
  status: SessionStatus
): void
```

#### Pending Fetch Tracking

```typescript
// Prevent duplicate fetches for same session
const pendingSessionFetches = new Map<string, Promise<void>>()
```

#### Imports Changed

```typescript
// Added
import type { EventSessionStatus } from "@opencode-ai/sdk"
import { requestData } from "../lib/opencode-api"
import { createClientSession, mapSdkSessionStatus, type SessionStatus } from "../types/session"
import { syncInstanceSessionIndicator } from "./session-state"
import { removeMessagePartV2, removeMessageV2 } from "./message-v2/bridge"

// Removed
import { setSessionCompactionState } from "./session-compaction"
```

---

### 4. `types/session.ts` (LOW RISK)

**Changes:** ~20 lines
**Risk Level:** LOW - Type additions

#### New Type

```typescript
export type SessionStatus = "idle" | "working" | "compacting"
```

#### New Function

```typescript
// Map SDK status to our simpler status
export function mapSdkSessionStatus(
  status: SDKSessionStatus | null | undefined
): SessionStatus {
  if (!status || status.type === "idle") return "idle"
  return "working"  // "busy" and "retry" both mean working
}
```

#### Session Interface Change

```typescript
export interface Session {
  // ...existing fields
  status: SessionStatus  // NEW: Required field
}

export function createClientSession(
  sdkSession: SDKSession,
  instanceId: string,
  agent: string = "",
  model = { providerId: "", modelId: "" },
  status: SessionStatus = "idle"  // NEW: Parameter
): Session
```

---

### 5. `stores/sessions.ts` (LOW RISK)

**Changes:** ~30 lines
**Risk Level:** LOW - Re-exports only

#### New Exports

```typescript
export {
  // Existing exports...

  // NEW exports
  ensureSessionParentExpanded,
  getSessionThreads,
  getVisibleSessionIds,
  isSessionParentExpanded,
  setActiveSessionFromList,
  setSessionParentExpanded,
  setSessionStatus,
  toggleSessionParentExpanded,
}
```

#### New SSE Handler Registration

```typescript
sseManager.onSessionStatus = handleSessionStatus
```

---

### 6. `lib/opencode-api.ts` (NEW FILE)

**Lines:** ~30
**Risk Level:** LOW - Utility function

```typescript
// Helper to unwrap SDK responses with consistent error handling
export async function requestData<T>(
  promise: Promise<{ data?: T; error?: unknown }>,
  label: string
): Promise<T> {
  const response = await promise
  if (response.error) {
    throw new Error(`${label} failed: ${JSON.stringify(response.error)}`)
  }
  if (!response.data) {
    throw new Error(`${label} returned no data`)
  }
  return response.data
}
```

---

### 7. `stores/session-compaction.ts` (REMOVAL CANDIDATE)

**Status:** May be deprecated
**v0.6.0 Action:** `setSessionCompactionState` replaced by `setSessionStatus`

The compaction state is now unified into the general session status. Check if file can be removed entirely or if other functions are still used.

---

## Risk Matrix

| File | Risk | Reason | Mitigation |
|------|------|--------|------------|
| `session-state.ts` | **HIGH** | Core signals, many new functions | Incremental merge, comprehensive tests |
| `session-api.ts` | **HIGH** | API changes, new parameters | Test all API calls individually |
| `session-events.ts` | **MEDIUM-HIGH** | SSE handling, async flows | Monitor event stream in dev tools |
| `types/session.ts` | **LOW** | Type additions | TypeScript will catch mismatches |
| `sessions.ts` | **LOW** | Just re-exports | Straightforward merge |
| `opencode-api.ts` | **LOW** | New utility | No conflicts |

---

## Breaking Changes

### 1. Session Type Change
```typescript
// OLD: status was optional/implicit
interface Session {
  pendingPermission?: boolean
}

// NEW: status is required
interface Session {
  status: SessionStatus  // Required
  pendingPermission?: boolean
}
```

**Impact:** All session creation must include `status` field.

### 2. `withSession()` Signature Change
```typescript
// OLD
function withSession(
  instanceId: string,
  sessionId: string,
  updater: (session: Session) => void
): void

// NEW: updater can return false to skip update
function withSession(
  instanceId: string,
  sessionId: string,
  updater: (session: Session) => void | boolean
): void
```

**Impact:** Existing updaters still work (void return), but new pattern allows early exit.

### 3. `forkSession()` Options Change
```typescript
// OLD
options?: { messageId?: string; parentId?: string }

// NEW
options?: { messageId?: string }
```

**Impact:** If we use `parentId` option anywhere, it must be removed.

---

## Dependency Graph

```
session-state.ts (core signals)
    ↑
session-api.ts (API calls) ← opencode-api.ts (helper)
    ↑
session-events.ts (SSE handlers)
    ↑
sessions.ts (re-exports + SSE registration)
    ↑
UI Components
```

---

## Integration Order

### Phase 1: Types and Utilities (Safe)
1. Add `SessionStatus` type to `types/session.ts`
2. Add `mapSdkSessionStatus()` function
3. Create `lib/opencode-api.ts` with `requestData()`

### Phase 2: Core State (Careful)
1. Add new signals to `session-state.ts`:
   - `expandedSessionParents`
   - `instanceIndicatorCounts`
2. Add indicator count functions
3. Add thread/expansion functions
4. Modify `withSession()` signature

### Phase 3: API Layer (Careful)
1. Update `fetchSessions()` to fetch status
2. Update session creation to include status
3. Add `syncInstanceSessionIndicator()` calls
4. Update `forkSession()` signature

### Phase 4: Event Handlers (Test Heavily)
1. Add `handleSessionStatus()` handler
2. Add helper functions for status management
3. Register new SSE handler in `sessions.ts`

### Phase 5: Exports (Safe)
1. Update `sessions.ts` exports
2. Verify all components can access new functions

---

## Testing Checklist

### Unit Tests
- [ ] `getSessionThreads()` returns correct thread structure
- [ ] `getVisibleSessionIds()` respects expansion state
- [ ] Indicator counts increment/decrement correctly
- [ ] `withSession()` early exit works

### Integration Tests
- [ ] Session creation includes status
- [ ] Fork creates child session correctly
- [ ] SSE status events update session status
- [ ] Indicator badge reflects active sessions

### E2E Tests
- [ ] Parent session shows expand chevron when has children
- [ ] Clicking chevron toggles children visibility
- [ ] Active child auto-expands parent
- [ ] Delete session updates tree correctly

---

## Rollback Plan

If integration fails:
1. Revert to branch before changes
2. Keep `session-compaction.ts` as fallback
3. Status field can be made optional temporarily

---

*Document created: 2026-01-11*
