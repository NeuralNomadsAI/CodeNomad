# Session Tree Integration Steps

**Date:** 2026-01-11
**Approach:** Atomic commits, test after each step

---

## Guiding Principles

1. **One logical change per commit** - Easy to revert if broken
2. **Additive first, modify last** - New code before changing existing
3. **Test after each step** - Build must pass, basic functionality verified
4. **Types before implementation** - TypeScript catches errors early

---

## Step-by-Step Breakdown

### PHASE 1: Foundation (Low Risk)

#### Step 1.1: Add SessionStatus type
**File:** `types/session.ts`
**Risk:** LOW
**Change:** Add type and mapping function

```typescript
// ADD after existing imports
import type { SessionStatus as SDKSessionStatus } from "@opencode-ai/sdk/v2/client"

// ADD after existing types
export type SessionStatus = "idle" | "working" | "compacting"

export function mapSdkSessionStatus(
  status: SDKSessionStatus | null | undefined
): SessionStatus {
  if (!status || status.type === "idle") return "idle"
  return "working"
}
```

**Test:** Build passes, existing code unchanged

---

#### Step 1.2: Add status field to Session interface
**File:** `types/session.ts`
**Risk:** LOW-MEDIUM (may cause TS errors elsewhere)
**Change:** Add required status field

```typescript
// MODIFY Session interface
export interface Session {
  // ...existing fields
  status: SessionStatus  // ADD this line
}

// MODIFY createClientSession
export function createClientSession(
  sdkSession: SDKSession,
  instanceId: string,
  agent: string = "",
  model = { providerId: "", modelId: "" },
  status: SessionStatus = "idle"  // ADD parameter
): Session {
  return {
    ...sdkSession,
    parentId: sdkSession.parentID || null,
    agent,
    model,
    status,  // ADD this
  }
}
```

**Test:** Fix any TS errors in session creation sites

---

#### Step 1.3: Create opencode-api.ts utility
**File:** `lib/opencode-api.ts` (NEW)
**Risk:** LOW
**Change:** Create new utility file

```typescript
import { getLogger } from "./logger"

const log = getLogger("api")

export async function requestData<T>(
  promise: Promise<{ data?: T; error?: unknown }>,
  label: string
): Promise<T> {
  const response = await promise
  if (response.error) {
    log.error(`${label} failed:`, response.error)
    throw new Error(`${label} failed`)
  }
  if (response.data === undefined || response.data === null) {
    throw new Error(`${label} returned no data`)
  }
  return response.data
}
```

**Test:** Build passes

---

### PHASE 2: Core State - Read-Only Additions (Low Risk)

#### Step 2.1: Add SessionThread type
**File:** `stores/session-state.ts`
**Risk:** LOW
**Change:** Add type export

```typescript
// ADD after SessionInfo interface
export type SessionThread = {
  parent: Session
  children: Session[]
  latestUpdated: number
}
```

**Test:** Build passes

---

#### Step 2.2: Add expansion state signal
**File:** `stores/session-state.ts`
**Risk:** LOW
**Change:** Add signal (no usage yet)

```typescript
// ADD after existing signals
const [expandedSessionParents, setExpandedSessionParents] =
  createSignal<Map<string, Set<string>>>(new Map())
```

**Test:** Build passes

---

#### Step 2.3: Add getSessionThreads function
**File:** `stores/session-state.ts`
**Risk:** LOW
**Change:** Add read-only function

```typescript
// ADD after getSessionFamily
function getSessionThreads(instanceId: string): SessionThread[] {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions || instanceSessions.size === 0) return []

  const parents: Session[] = []
  const childrenByParent = new Map<string, Session[]>()

  for (const session of instanceSessions.values()) {
    if (session.parentId === null) {
      parents.push(session)
    } else if (session.parentId) {
      const children = childrenByParent.get(session.parentId) || []
      children.push(session)
      childrenByParent.set(session.parentId, children)
    }
  }

  const threads: SessionThread[] = parents.map((parent) => {
    const children = childrenByParent.get(parent.id) ?? []
    children.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))

    const parentUpdated = parent.time.updated ?? 0
    const latestChild = children[0]?.time.updated ?? 0

    return {
      parent,
      children,
      latestUpdated: Math.max(parentUpdated, latestChild),
    }
  })

  threads.sort((a, b) => b.latestUpdated - a.latestUpdated)
  return threads
}
```

**Test:** Build passes, can call from console

---

#### Step 2.4: Add expansion query functions
**File:** `stores/session-state.ts`
**Risk:** LOW
**Change:** Add read-only functions

```typescript
// ADD after getSessionThreads
function isSessionParentExpanded(instanceId: string, parentSessionId: string): boolean {
  return Boolean(expandedSessionParents().get(instanceId)?.has(parentSessionId))
}

function getVisibleSessionIds(instanceId: string): string[] {
  const threads = getSessionThreads(instanceId)
  if (threads.length === 0) return []

  const expanded = expandedSessionParents().get(instanceId)
  const ids: string[] = []

  for (const thread of threads) {
    ids.push(thread.parent.id)
    if (expanded?.has(thread.parent.id)) {
      for (const child of thread.children) {
        ids.push(child.id)
      }
    }
  }

  return ids
}
```

**Test:** Build passes

---

### PHASE 3: Core State - Write Functions (Medium Risk)

#### Step 3.1: Add expansion mutation functions
**File:** `stores/session-state.ts`
**Risk:** MEDIUM
**Change:** Add write functions

```typescript
// ADD after getVisibleSessionIds
function setSessionParentExpanded(
  instanceId: string,
  parentSessionId: string,
  expanded: boolean
): void {
  setExpandedSessionParents((prev) => {
    const next = new Map(prev)
    const currentSet = next.get(instanceId) ?? new Set<string>()
    const updated = new Set(currentSet)

    if (expanded) {
      updated.add(parentSessionId)
    } else {
      updated.delete(parentSessionId)
    }

    if (updated.size === 0) {
      next.delete(instanceId)
    } else {
      next.set(instanceId, updated)
    }

    return next
  })
}

function toggleSessionParentExpanded(instanceId: string, parentSessionId: string): void {
  const isExpanded = isSessionParentExpanded(instanceId, parentSessionId)
  setSessionParentExpanded(instanceId, parentSessionId, !isExpanded)
}

function ensureSessionParentExpanded(instanceId: string, parentSessionId: string): void {
  if (!isSessionParentExpanded(instanceId, parentSessionId)) {
    setSessionParentExpanded(instanceId, parentSessionId, true)
  }
}
```

**Test:** Build passes, can toggle expansion from console

---

#### Step 3.2: Add setSessionStatus function
**File:** `stores/session-state.ts`
**Risk:** MEDIUM
**Change:** Add new function (will eventually replace setSessionCompactionState)

```typescript
// ADD after setActiveParentSession
function setSessionStatus(instanceId: string, sessionId: string, status: SessionStatus): void {
  withSession(instanceId, sessionId, (session) => {
    if (session.status === status) return
    session.status = status
  })
}
```

**Test:** Build passes

---

#### Step 3.3: Add setActiveSessionFromList function
**File:** `stores/session-state.ts`
**Risk:** MEDIUM
**Change:** Add function that handles parent/child active selection

```typescript
// ADD import at top
import { batch } from "solid-js"

// ADD after setSessionStatus
function setActiveSessionFromList(instanceId: string, sessionId: string): void {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return

  if (session.parentId === null) {
    setActiveParentSession(instanceId, sessionId)
    return
  }

  const parentId = session.parentId
  if (!parentId) return

  batch(() => {
    setActiveParentSession(instanceId, parentId)
    setActiveSession(instanceId, sessionId)
  })
}
```

**Test:** Build passes

---

#### Step 3.4: Update exports
**File:** `stores/session-state.ts`
**Risk:** LOW
**Change:** Export new functions

```typescript
export {
  // ...existing exports

  // ADD these
  getSessionThreads,
  getVisibleSessionIds,
  isSessionParentExpanded,
  setSessionParentExpanded,
  toggleSessionParentExpanded,
  ensureSessionParentExpanded,
  setActiveSessionFromList,
  setSessionStatus,
}
```

**Test:** Build passes

---

### PHASE 4: API Layer Updates (High Risk)

#### Step 4.1: Fix session creation to include status
**File:** `stores/session-api.ts`
**Risk:** MEDIUM
**Change:** Add status field to all session creation

```typescript
// In fetchSessions(), MODIFY session creation:
sessionMap.set(apiSession.id, {
  // ...existing fields
  status: existingSession?.status ?? "idle",  // ADD
})

// In createSession(), MODIFY:
const session: Session = {
  // ...existing fields
  status: "idle",  // ADD
}

// In forkSession(), MODIFY:
const forkedSession: Session = {
  // ...existing fields
  status: "idle",  // ADD
}
```

**Test:** Build passes, create session works

---

#### Step 4.2: Add status fetching to fetchSessions
**File:** `stores/session-api.ts`
**Risk:** MEDIUM-HIGH
**Change:** Fetch status from API

```typescript
// In fetchSessions(), ADD after response check:
let statusById: Record<string, any> = {}
try {
  const statusResponse = await instance.client.session.status()
  if (statusResponse.data && typeof statusResponse.data === "object") {
    statusById = statusResponse.data as Record<string, any>
  }
} catch (error) {
  log.error("Failed to fetch session status:", error)
  // Continue without status - graceful degradation
}

// MODIFY session creation to use status:
const rawStatus = statusById[apiSession.id]
const status: SessionStatus = rawStatus?.type === "busy" || rawStatus?.type === "retry"
  ? "working"
  : existingSession?.status === "compacting"
    ? "compacting"
    : "idle"

sessionMap.set(apiSession.id, {
  // ...existing fields
  status,
})
```

**Test:** Sessions load with correct status

---

### PHASE 5: Re-exports (Low Risk)

#### Step 5.1: Update sessions.ts exports
**File:** `stores/sessions.ts`
**Risk:** LOW
**Change:** Re-export new functions

```typescript
import {
  // ...existing imports

  // ADD
  ensureSessionParentExpanded,
  getSessionThreads,
  getVisibleSessionIds,
  isSessionParentExpanded,
  setActiveSessionFromList,
  setSessionParentExpanded,
  setSessionStatus,
  toggleSessionParentExpanded,
} from "./session-state"

export {
  // ...existing exports

  // ADD
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

**Test:** Build passes, exports accessible

---

### PHASE 6: Indicator Counts (Medium Risk) - OPTIONAL

*Can be deferred if basic functionality works*

#### Step 6.1: Add indicator types and signals
**File:** `stores/session-state.ts`
**Risk:** MEDIUM
**Change:** Add indicator tracking

```typescript
// ADD types
export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

type InstanceIndicatorCounts = {
  permission: number
  working: number
  compacting: number
}

// ADD signal
const [instanceIndicatorCounts, setInstanceIndicatorCounts] =
  createSignal<Map<string, InstanceIndicatorCounts>>(new Map())
```

---

#### Step 6.2: Add indicator functions
*Details in full scope document*

---

### PHASE 7: Event Handlers (High Risk) - OPTIONAL

*Can be deferred until basic tree UI works*

#### Step 7.1: Add handleSessionStatus
**File:** `stores/session-events.ts`

#### Step 7.2: Register handler
**File:** `stores/sessions.ts`

---

## Commit Sequence

| # | Description | Risk | Files |
|---|-------------|------|-------|
| 1 | Add SessionStatus type | LOW | types/session.ts |
| 2 | Add status to Session interface | LOW | types/session.ts |
| 3 | Create opencode-api.ts | LOW | lib/opencode-api.ts |
| 4 | Add SessionThread type | LOW | session-state.ts |
| 5 | Add expansion signal | LOW | session-state.ts |
| 6 | Add getSessionThreads | LOW | session-state.ts |
| 7 | Add expansion query functions | LOW | session-state.ts |
| 8 | Add expansion mutation functions | MED | session-state.ts |
| 9 | Add setSessionStatus | MED | session-state.ts |
| 10 | Add setActiveSessionFromList | MED | session-state.ts |
| 11 | Export new state functions | LOW | session-state.ts |
| 12 | Fix session creation status | MED | session-api.ts |
| 13 | Add status fetching | MED | session-api.ts |
| 14 | Update sessions.ts exports | LOW | sessions.ts |

**Checkpoint after step 14:** All backend ready for UI integration

---

## Verification Commands

After each step:
```bash
# Build check
npm run build

# Type check
npx tsc --noEmit

# Quick manual test
# 1. Open app
# 2. Create session
# 3. Verify no console errors
```

---

## Rollback Points

- **After Step 3:** Can revert if types break things
- **After Step 11:** Can revert if state functions break
- **After Step 14:** Full backend complete, safe checkpoint

---

*Ready to proceed with Step 1.1?*
