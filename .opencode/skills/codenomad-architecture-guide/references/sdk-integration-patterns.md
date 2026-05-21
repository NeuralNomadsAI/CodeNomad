# SDK Integration Patterns

## Client Lifecycle

### SDK Manager

CodeNomad creates and manages `OpencodeClient` instances through `SDKManager`:

```typescript
// packages/ui/src/lib/sdk-manager.ts
class SDKManager {
  private clients = new Map<string, OpencodeClient>()
  
  createClient(instanceId: string, proxyPath: string): OpencodeClient {
    const baseUrl = buildInstanceBaseUrl(proxyPath)
    return createOpencodeClient({ baseUrl })
  }
}
```

### Worktree-Based Routing

SDK clients are routed per worktree, not just per instance:

```typescript
// packages/ui/src/stores/worktrees.ts
export function getOrCreateWorktreeClient(
  instanceId: string, 
  worktreeSlug: string
): OpencodeClient {
  const proxyPath = `/worktrees/${worktreeSlug}`
  return sdkManager.createClient(instanceId, proxyPath)
}
```

**Rule:** Always use `getOrCreateWorktreeClient()` rather than creating clients directly. This ensures:
- Correct base URL with worktree proxy path
- Client caching and reuse
- Proper cleanup on instance disposal

### Base URL Construction

```typescript
// packages/ui/src/lib/sdk-manager.ts
export function buildInstanceBaseUrl(proxyPath: string): string {
  const normalized = normalizeProxyPath(proxyPath)
  const base = stripTrailingSlashes(CODENOMAD_API_BASE)
  return `${base}${normalized}/`
}
```

## Error Handling

### RequestData Wrapper

All SDK calls go through `requestData()` for consistent error handling:

```typescript
// packages/ui/src/lib/opencode-api.ts
export async function requestData<T>(
  promise: Promise<{ data?: T; error? }>,
  operation: string
): Promise<T> {
  const response = await promise
  if (response.error) {
    log.error(`API error in ${operation}`, response.error)
    throw response.error
  }
  if (response.data === undefined) {
    throw new Error(`No data returned from ${operation}`)
  }
  return response.data
}
```

### Pattern

```typescript
// Always wrap SDK calls
const sessions = await requestData(
  client.session.list(),
  "session.list"
)

// Never call SDK directly without wrapper
// ❌ Wrong: const result = await client.session.list()
```

## Optimistic Updates

### Pattern

1. Update local state immediately
2. Make API call
3. Handle success/error
4. SSE events eventually confirm/converge

```typescript
// packages/ui/src/stores/message-v2/bridge.ts
export function removePermissionV2(instanceId: string, requestId: string) {
  // 1. Optimistic: Remove from local store
  updateMessageStore(instanceId, (store) => {
    store.permissions.delete(requestId)
  })
  
  // 2. API call (may fail)
  // 3. SSE event eventually confirms
}
```

### Reconciliation

SSE events from the server eventually reconcile optimistic state:

| Event | Handler | File |
|-------|---------|------|
| `message.part.updated` | `updateMessagePartV2()` | `bridge.ts` |
| `message.part.removed` | `removeMessagePartV2()` | `bridge.ts` |
| `permission.replied` | `removePermissionV2()` | `bridge.ts` |
| `question.replied` | `removeQuestionV2()` | `bridge.ts` |

### Race Condition Warning

Rapid successive operations can cause temporary desync:
- Delete part → quickly delete message → may error if part delete in flight
- Always check current state before optimistic updates

## Permission Flow

1. **Server emits** `permission.asked` or `permission.updated` SSE event
   - Pushed through instance event stream
2. **UI Store receives** via `serverEvents`
   - File: `packages/ui/src/stores/instances.ts`
   - **Branch:** IF `isPermissionAutoAcceptEnabled()` 
     - Mechanism: `drainAutoAcceptPermissions()` in `packages/ui/src/stores/permission-auto-accept.ts`
     - Action: Calls reply immediately, skips modal
   - **Branch:** ELSE 
     - Mechanism: Queued in `permissionQueues`
     - Action: Display modal
3. **UI Store:** `packages/ui/src/stores/message-v2/bridge.ts` calls `upsertPermissionV2()`
4. **UI Component:** `packages/ui/src/components/permission-approval-modal.tsx` displays
5. **User Action:** Calls `packages/ui/src/stores/instances.ts:sendPermissionResponse()`
6. **SDK Call:** `client.permission.reply()` via `packages/ui/src/lib/opencode-api.ts`
7. **Optimistic Update:** `removePermissionV2()` in bridge
8. **SSE Confirmation:** `permission.replied` event
   - **Branch:** IF SSE disconnected → `syncPendingPermissions()` reconciles on reconnect

## Session Event Handling

### SSE Event Types

| Event | Direction | Description |
|-------|-----------|-------------|
| `message.part.delta` | Server → UI | Streaming text update |
| `message.part.updated` | Server → UI | Part content changed |
| `message.part.removed` | Server → UI | Part deleted |
| `session.status` | Server → UI | Session status changed |
| `permission.asked` | Server → UI | New permission request |
| `permission.updated` | Server → UI | Permission updated |
| `permission.replied` | Server → UI | Permission resolved |
| `question.asked` | Server → UI | New question |
| `question.replied` | Server → UI | Question answered |
| `question.rejected` | Server → UI | Question rejected |

### Event Source Setup

```typescript
// packages/ui/src/lib/event-source-handlers.ts
export function attachEventSourceHandlers(
  source: EventSource, 
  options: EventSourceHandlerOptions
) {
  source.onmessage = (event) => {
    const payload = JSON.parse(event.data)
    options.onEvent(payload)
  }
  
  source.onerror = () => {
    options.onError?.()
  }
  
  ;(source as EventSourceWithClose).onclose = () => {
    options.onError?.()
  }
}
```

## Worktree Client Pattern

```typescript
// Always route through worktree
const worktreeSlug = getWorktreeSlugForSession(instanceId, sessionId)
const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)

// Then use client normally
const diff = await requestData(
  client.session.diff({ sessionID: sessionId }),
  "session.diff"
)
```

## Cleanup Pattern

```typescript
// On instance disposal
sdkManager.destroyClientsForInstance(instanceId)
messageStoreBus.unregister(instanceId)
clearCacheForInstance(instanceId)
```
