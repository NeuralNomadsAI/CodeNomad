# Permission Banner Debug Investigation - 2026-01-05

## CRITICAL BUG REPORT

**Status**: UNRESOLVED  
**Severity**: HIGH - Core permission system non-functional  
**Branch**: merge/trueupstream-dev-2026-01-05  
**Build**: macOS ARM64, Electron 39.0.0, SDK v2 (@opencode-ai/sdk 1.1.1)

---

## USER-REPORTED SYMPTOMS

1. **Permission Banner**: Clicking "Allow Once" button causes banner to disappear
2. **Inline Permission**: The inline permission in chat still shows "Waiting for earlier permission responses"
3. **System Response**: Server doesn't detect/accept the confirmation
4. **Result**: Permission workflow completely broken

---

## INVESTIGATION TIMELINE

### Phase 1: Initial Fix Attempt (FAILED)
**Hypothesis**: State desynchronization between legacy queue and v2 message store  
**Fix Applied**: Added `removePermissionV2(instanceId, requestId)` call in `sendPermissionResponse` function  
**Result**: NO CHANGE - Issue persists

**Files Modified**:
- [instances.ts](packages/ui/src/stores/instances.ts#L565-L591) - Added v2 store cleanup
- [permission-approval-modal.tsx](packages/ui/src/stores/permission-approval-modal.tsx) - Type compatibility fixes

**Build**: Completed successfully, TypeScript: 0 errors

### Phase 2: Deep Code Archaeology

#### Architecture Discovery: Dual Permission System

The codebase has **TWO separate permission tracking systems** that must stay synchronized:

**1. Legacy Permission Queue** (instances.ts)
```typescript
// Location: packages/ui/src/stores/instances.ts
interface PermissionQueue {
  permissions: Map<string, PermissionRequestLike[]>
}

// Functions:
- addPermissionToQueue(instanceId, permission)
- removePermissionFromQueue(instanceId, requestId)
- getPermissionQueue(instanceId)
- activePermissionId (signal)
```

**2. V2 Message Store** (message-v2/instance-store.ts)
```typescript
// Location: packages/ui/src/stores/message-v2/instance-store.ts
interface PermissionState {
  active: PermissionEntry | null    // Currently active permission
  queue: PermissionEntry[]          // Queued permissions
  byMessage: {                      // Permissions indexed by message/part
    [messageKey]: {
      [partKey]: PermissionEntry
    }
  }
}

// Functions:
- upsertPermission(...)
- removePermission(permissionId)
- getPermissionState(messageId?, partId?)
```

#### Critical Functions Involved

**1. sendPermissionResponse** (instances.ts:565-591)
```typescript
async function sendPermissionResponse(
  instanceId: string,
  sessionId: string,
  requestId: string,
  reply: PermissionReply
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    await requestData(
      instance.client.permission.reply({
        requestID: requestId,
        reply,
      }),
      "permission.reply",
    )

    // Remove from queue after successful response
    removePermissionFromQueue(instanceId, requestId)
    
    // CRITICAL: Also remove from v2 message store to keep state in sync
    removePermissionV2(instanceId, requestId)  // ← Added in failed fix
  } catch (error) {
    log.error("Failed to send permission response", error)
    throw error
  }
}
```

**2. removePermission** (instance-store.ts:803-822)
```typescript
function removePermission(permissionId: string) {
  setState(
    "permissions",
    produce((draft) => {
      // Remove from queue
      draft.queue = draft.queue.filter((item) => item.permission.id !== permissionId)
      
      // Activate next queued permission
      if (draft.active?.permission.id === permissionId) {
        draft.active = draft.queue[0] ?? null  // ← Should activate next permission
      }
      
      // Remove from byMessage index
      Object.keys(draft.byMessage).forEach((messageKey) => {
        const partEntries = draft.byMessage[messageKey]
        Object.keys(partEntries).forEach((partKey) => {
          if (partEntries[partKey].permission.id === permissionId) {
            delete partEntries[partKey]
          }
        })
        if (Object.keys(partEntries).length === 0) {
          delete draft.byMessage[messageKey]
        }
      })
    }),
  )
}
```

**3. getPermissionState** (instance-store.ts:826-832)
```typescript
function getPermissionState(messageId?: string, partId?: string) {
  const messageKey = messageId ?? "__global__"
  const partKey = partId ?? "__global__"
  const entry = state.permissions.byMessage[messageKey]?.[partKey]
  if (!entry) return null
  const active = state.permissions.active?.permission.id === entry.permission.id
  return { entry, active }  // ← Returns { entry, active: boolean }
}
```

#### SSE Event Handlers

**handlePermissionUpdated** (session-events.ts:448-455)
```typescript
function handlePermissionUpdated(instanceId: string, event: { type: string; properties?: PermissionRequestLike } | any): void {
  const permission = event?.properties as PermissionRequestLike | undefined
  if (!permission) return

  log.info(`[SSE] Permission request: ${getPermissionId(permission)} (${getPermissionKind(permission)})`)
  addPermissionToQueue(instanceId, permission)
  upsertPermissionV2(instanceId, permission)  // ← Adds to v2 store
}
```

**handlePermissionReplied** (session-events.ts:457-465)
```typescript
function handlePermissionReplied(instanceId: string, event: { type: string; properties?: PermissionReplyEventPropertiesLike } | any): void {
  const properties = event?.properties as PermissionReplyEventPropertiesLike | undefined
  const requestId = getRequestIdFromPermissionReply(properties)
  if (!requestId) return

  log.info(`[SSE] Permission replied: ${requestId}`)
  removePermissionFromQueue(instanceId, requestId)
  removePermissionV2(instanceId, requestId)  // ← Removes from v2 store
}
```

#### UI Components

**Global Banner** (permission-approval-modal.tsx)
- Shows modal dialog at top of screen
- Triggered by clicking "Approval Required" button in toolbar
- Displays the currently active permission from legacy queue
- On button click → calls `sendPermissionResponse` → should close modal

**Inline Permission** (tool-call.tsx)
- Embedded in message stream next to tool call
- Uses v2 store's `getPermissionState()` to check if active
- Shows buttons OR "Waiting for earlier permission responses" based on `active` flag

**Key Code in tool-call.tsx** (lines 269-309):
```typescript
const permissionState = createMemo(() => store().getPermissionState(props.messageId, toolCallIdentifier()))

const pendingPermission = createMemo(() => {
  const state = permissionState()
  if (state) {
    return { permission: state.entry.permission, active: state.active }
  }
  return toolCallMemo()?.pendingPermission
})

const isPermissionActive = createMemo(() => pendingPermission()?.active === true)

// Used in render:
<Show
  when={active}
  fallback={<p class="tool-call-permission-queued-text">Waiting for earlier permission responses.</p>}
>
  <div class="tool-call-permission-actions">
    <button onClick={() => handlePermissionResponse("once")}>Allow Once</button>
    <!-- ... -->
  </div>
</Show>
```

---

## ROOT CAUSE THEORIES

### Theory 1: Dual Call Race Condition ❓
**Problem**: `sendPermissionResponse` removes permission synchronously, then SSE event arrives and tries to remove it again  
**Evidence**:
- Both `sendPermissionResponse` and `handlePermissionReplied` call `removePermissionV2`
- SSE event arrives ~100-500ms after API call
- Possible race condition in state updates

**Question**: Does double-removal cause state corruption?

### Theory 2: Permission ID Mismatch ⚠️
**Problem**: Banner shows permission A (from legacy queue) but inline shows permission B (from v2 store)  
**Evidence**:
- Banner disappears (legacy queue updated)
- Inline still shows "Waiting..." (v2 store not updated correctly)
- Two different permission tracking systems may have different IDs

**Question**: Are we removing the right permission from the right store?

### Theory 3: Server Not Sending SSE Event 🚨
**Problem**: Server doesn't send `permission_replied` event after API call succeeds  
**Evidence**:
- User sees no console logs for "[SSE] Permission replied"
- Only client-side removal happens
- V2 store never gets updated via SSE

**Question**: Is the SDK v2 client's `permission.reply` API properly triggering the event?

### Theory 4: V2 Store Activation Logic Bug 🎯
**Problem**: `removePermission` doesn't properly activate next queued permission  
**Evidence**:
```typescript
draft.queue = draft.queue.filter((item) => item.permission.id !== permissionId)
if (draft.active?.permission.id === permissionId) {
  draft.active = draft.queue[0] ?? null  // ← Should work, but maybe doesn't?
}
```
- After removal, `draft.queue[0]` should be next permission
- But `draft.active` might not update reactively
- SolidJS memo `isPermissionActive()` might not re-run

**Question**: Is the store mutation properly triggering SolidJS reactivity?

### Theory 5: ByMessage Index Corruption ⚠️
**Problem**: Permission removed from `queue` and `active` but still exists in `byMessage` index  
**Evidence**:
```typescript
// removePermission cleans up byMessage:
Object.keys(draft.byMessage).forEach((messageKey) => {
  const partEntries = draft.byMessage[messageKey]
  Object.keys(partEntries).forEach((partKey) => {
    if (partEntries[partKey].permission.id === permissionId) {
      delete partEntries[partKey]  // ← Removes from index
    }
  })
})
```
- `getPermissionState` looks up in `byMessage` first
- If cleanup fails, stale entry remains
- Component continues showing old permission

**Question**: Is the messageKey/partKey calculation correct?

---

## DEBUGGING ATTEMPTS

### Attempt 1: Console Inspection (FAILED)
Tried to access `window.__instances` to inspect v2 store state  
**Result**: `undefined` - store not exposed to console

### Attempt 2: Add Debug Logging (NOT TRIED)
**Recommendation**: Add console.log statements to trace permission flow:

```typescript
// In removePermission (instance-store.ts):
function removePermission(permissionId: string) {
  console.log('[DEBUG] removePermission called:', permissionId)
  console.log('[DEBUG] Current active:', state.permissions.active?.permission.id)
  console.log('[DEBUG] Current queue:', state.permissions.queue.map(p => p.permission.id))
  
  setState("permissions", produce((draft) => {
    draft.queue = draft.queue.filter((item) => item.permission.id !== permissionId)
    console.log('[DEBUG] After filter, queue:', draft.queue.map(p => p.permission.id))
    
    if (draft.active?.permission.id === permissionId) {
      draft.active = draft.queue[0] ?? null
      console.log('[DEBUG] Set new active:', draft.active?.permission.id)
    }
    // ... rest of function
  }))
  
  console.log('[DEBUG] Final active:', state.permissions.active?.permission.id)
  console.log('[DEBUG] Final queue:', state.permissions.queue.map(p => p.permission.id))
}

// In sendPermissionResponse (instances.ts):
async function sendPermissionResponse(...) {
  console.log('[DEBUG] sendPermissionResponse called:', requestId)
  await requestData(...)
  console.log('[DEBUG] API call succeeded, removing from queues')
  
  removePermissionFromQueue(instanceId, requestId)
  console.log('[DEBUG] Removed from legacy queue')
  
  removePermissionV2(instanceId, requestId)
  console.log('[DEBUG] Removed from v2 store')
}

// In handlePermissionReplied (session-events.ts):
function handlePermissionReplied(...) {
  const requestId = getRequestIdFromPermissionReply(properties)
  console.log('[DEBUG] SSE permission_replied event:', requestId)
  // ... rest
}
```

### Attempt 3: Check SSE Events (NOT TRIED)
**Recommendation**: Monitor DevTools Network tab for SSE events:
1. Open DevTools → Network tab
2. Filter by "EventStream" or search for SSE endpoint
3. Trigger permission → click "Allow Once"
4. Check if `permission_replied` event arrives
5. Inspect event payload structure

---

## FAILED FIX DETAILS

### Commit to Revert
```
commit: [hash unknown]
message: "fix(permissions): sync v2 message store when responding to permissions

CRITICAL FIX: Permission banner \"Allow Once\" was non-functional because
sendPermissionResponse only updated legacy queue (removePermissionFromQueue)
but not v2 message store (removePermissionV2), causing state desync.

Root cause: v2 store maintains separate \"active\" permission state. When
permission removed from legacy queue only, v2 store kept stale active state,
preventing next permission from activating. tool-call.tsx checks
isPermissionActive() from v2 store, showed \"Waiting for earlier permission
responses\" instead of action buttons.

Solution: Call removePermissionV2(instanceId, requestId) after successful
permission.reply API call to maintain state consistency.

Fixes user-reported issue where clicking permission banner did nothing."
```

**Why It Failed**:
- Hypothesis was wrong: v2 store WAS already being updated by SSE event handler
- Adding duplicate `removePermissionV2` call didn't fix the issue
- Root cause is something else (see theories above)

### Also Revert This Commit
```
commit: [hash unknown]  
message: "fix: permission banner not working - use proper type helpers

- Use getPermissionSessionId() instead of manual casting
- Use getPermissionKind() and getPermissionDisplayTitle() for display
- Ensure compatibility with upstream PermissionRequestLike type
- Fixes issue where clicking 'Allow Once' on permission banner did nothing"
```

**Why Revert**:
- User confirmed this fix also didn't work
- Type helpers are correct but don't address core issue

---

## NEXT STEPS FOR DEBUGGING

### 1. Add Comprehensive Logging ✅
Add debug logs to all permission functions (see code snippets above)  
**Goal**: Trace exact permission flow from button click to state update

### 2. Monitor SSE Events ✅
Check if `permission_replied` event arrives from server  
**Goal**: Confirm server is sending the event

### 3. Inspect Permission IDs ✅
Log permission IDs at each step  
**Goal**: Verify we're removing the correct permission

### 4. Test removePermission in Isolation ✅
Create test case that directly calls `removePermission` with mock data  
**Goal**: Verify v2 store activation logic works

### 5. Check SolidJS Reactivity ✅
Add logs in `permissionState` memo to see when it re-runs  
**Goal**: Confirm component reactively updates when store changes

### 6. Compare Legacy vs V2 Queue ✅
Log both queues side-by-side after removal  
**Goal**: Find any synchronization mismatch

---

## FILES OF INTEREST

### Core Permission Logic
- `packages/ui/src/stores/instances.ts` - Legacy permission queue
- `packages/ui/src/stores/message-v2/instance-store.ts` - V2 permission store
- `packages/ui/src/stores/message-v2/bridge.ts` - Bridge between systems
- `packages/ui/src/stores/session-events.ts` - SSE event handlers

### UI Components
- `packages/ui/src/components/permission-approval-modal.tsx` - Global banner modal
- `packages/ui/src/components/tool-call.tsx` - Inline permission display

### Type Definitions
- `packages/ui/src/types/permission.ts` - Helper functions for permission data

### SSE Management
- `packages/ui/src/lib/sse-manager.ts` - SSE event routing
- `packages/ui/src/stores/sessions.ts` - Registers SSE handlers

---

## SDK V2 MIGRATION CONTEXT

This bug emerged after merging upstream commits that migrated from SDK v1 to v2:

**Key Changes**:
- `@opencode-ai/sdk` 1.1.1 (v2 client)
- New permission type: `PermissionRequestLike` (replaces old `Permission`)
- New v2 message store architecture with separate permission tracking
- SSE events changed structure (properties field added)

**Migration Complications**:
- Dual permission system during transition period
- Legacy queue still in use for backward compatibility
- V2 store added for new architecture
- Both must stay synchronized

**Upstream Commits Merged**: 8 commits including:
- SDK v2 migration
- ANSI rendering support
- Session status updates
- Permission system updates

---

## REPRODUCTION STEPS

1. Launch CodeNomad from Applications
2. Start a new chat session
3. Trigger a permission request (e.g., file write operation)
4. Click toolbar "Approval Required" button → banner appears
5. Click "Allow Once" button in banner
6. **BUG**: Banner disappears but inline permission shows "Waiting for earlier permission responses"
7. System doesn't proceed with the operation

---

## POTENTIAL WORKAROUNDS

### Workaround 1: Use Inline Buttons Only
**Hypothesis**: If inline buttons work, disable banner modal  
**Test**: Click "Allow Once" on inline permission instead of banner

### Workaround 2: Revert to Legacy Queue Only
**Hypothesis**: Remove v2 store integration temporarily  
**Risk**: Breaks upstream compatibility, not sustainable

### Workaround 3: Force Refresh After Permission
**Hypothesis**: Add hard refresh of permission state after removal  
**Implementation**: Call `store().refreshPermissions()` after `removePermissionV2`

---

## CRITICAL QUESTIONS TO ANSWER

1. ❓ Is the `permission_replied` SSE event arriving from the server?
2. ❓ Are we removing the same permission ID from both stores?
3. ❓ Does `removePermission` properly update `draft.active` to next queue item?
4. ❓ Is the SolidJS reactivity chain working (store → memo → UI update)?
5. ❓ Are there multiple instances of the permission with different IDs?
6. ❓ Is the `byMessage` index being cleaned up correctly?
7. ❓ Does the SDK v2 client's `permission.reply` API work as expected?
8. ❓ Is there a timing issue between API call and SSE event?

---

## CONCLUSION

The permission system is **broken at a fundamental level** after the SDK v2 migration. The dual permission tracking system (legacy + v2) introduces synchronization complexity that has not been properly resolved.

**Current Status**: Two attempted fixes failed. Root cause unknown. Extensive debugging with logging needed to trace permission state flow.

**Recommended Approach**: 
1. Revert failed fix commits
2. Add comprehensive debug logging
3. Run step-by-step reproduction with DevTools open
4. Analyze logs to identify exact failure point
5. Fix root cause, not symptoms

**Estimated Effort**: 4-6 hours of deep debugging + fix implementation + testing

---

## HANDOVER NOTES

For the next debugging session:

1. **Start with logging**: Add all debug logs from "Attempt 2" section above
2. **Monitor SSE**: Keep DevTools Network tab open to watch events
3. **Test both paths**: Try inline buttons AND banner buttons separately
4. **Check permission IDs**: Log IDs at every step to verify they match
5. **Read this document thoroughly**: All findings are documented here

**Do NOT** make assumptions about the root cause. Follow the evidence from logs.

Good luck! 🚀
