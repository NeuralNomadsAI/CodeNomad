# Mobile SSE Connection Resilience - Root Cause Analysis

**Date:** May 28, 2026  
**Branch:** `fix/mobile-network-resilience`  
**Status:** Root cause identified, fix pending implementation

## Problem Statement

On mobile networks with poor connectivity or high latency, users experience:

1. Message sent but no response received
2. "Abort" button pressed to cancel the waiting request
3. Response only arrives after:
   - User sends another message (triggers reconnection), OR
   - Page is manually refreshed

**Expected behavior:** Server processes message and sends response immediately

## Detailed Analysis

### Server-Side Flow (events.ts, connection-manager.ts)

```
Server → Client: ping (every 15 seconds, line 53 in events.ts)
         heartbeat = setInterval(() => { reply.raw.write(...) }, 15000)

Client → Server: pong (HTTP POST to /api/client-connections/pong)

Server waiting: 45 second timeout without pong (STALE_CONNECTION_TIMEOUT_MS, line 3 in connection-manager.ts)
         If no pong received → connection marked as stale
         Sweep interval: 5 seconds (STALE_SWEEP_INTERVAL_MS)
```

### Client-Side Flow (server-events.ts)

```typescript
// Line 47-56: When ping received
(payload) => {
  void serverApi
    .sendClientConnectionPong({
      ...getClientIdentity(),
      pingTs: payload.ts,
    })
    .catch(() => {
      debugWarn("sse", "Pong failed (connection already closed)")
    })
}
```

The pong is sent via **separate HTTP POST** (api-client.ts:548-552):
```typescript
sendClientConnectionPong(payload): Promise<void> {
  return request<void>("/api/client-connections/pong", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}
```

## Root Cause

**On mobile networks with poor connectivity:**

1. **User sends message** → arrives at server OK, processing begins
2. **Server sends ping** via established SSE connection ✓ (works fine)
3. **Client receives ping**, attempts to respond with **HTTP POST pong**
4. **POST fails** due to:
   - Network timeout (mobile latency)
   - Network switch (WiFi ↔ cellular)
   - High packet loss
   - Result: `Client connection not found` error

5. **Server never receives pong** → assumes client is dead
6. **Server closes SSE connection after 45s timeout**
7. **Message responses get stuck in event queue** (unable to send on closed connection)
8. **Client shows "Abort" error** to user

**Why it works after sending another message:**
- New message triggers reconnection
- New SSE connection established
- Queued events from previous message now deliverable
- Both old and new responses arrive together

**Evidence from logs:**
```
[20:53:14.814] ERROR actions: sendMessage failed: No network connection
[20:53:43.500] ERROR api: Request failed: POST /api/client-connections/pong - Client connection not found
[20:53:43.501] WARN sse: Pong failed (connection already closed)
```

Timeline:
- Message sent (14.8s)
- ~29 seconds later: Pong POST fails → server closes connection

## Critical Path

1. **events.ts:27-79** — SSE connection setup with heartbeat ping
2. **connection-manager.ts:73-96** — Pong reception and timeout sweep
3. **server-events.ts:47-56** — Client pong response (HTTP POST)
4. **api-client.ts:548-552** — HTTP POST implementation (no retry logic)

## Proposed Solutions

### Option A: Add Retry Logic to Pong POST (Quick Win)
- **File:** `packages/ui/src/lib/server-events.ts`
- **Change:** Implement exponential backoff retry for pong
- **Risk:** Low
- **Benefit:** Improves reliability for transient failures
- **Limitation:** Still uses separate HTTP request

**Implementation:**
```typescript
// Retry up to 3 times with exponential backoff
sendPongWithRetry(payload, maxRetries = 3, delayMs = 100)
```

### Option B: Send Pong via SSE Channel (Robust Solution)
- **File:** `packages/server/src/server/routes/events.ts`
- **Change:** Allow client to send messages through SSE (not just receive)
- **Risk:** Medium (protocol change)
- **Benefit:** No separate HTTP request, reuses working connection
- **Limitation:** Requires client/server coordination

**Implementation:**
```
Client → Server: Can send special "codenomad.client.pong" event through SSE
         Uses existing EventSource connection (no new HTTP request)
```

## Recommendation

**Start with Option A** (retry logic) because:
1. ✓ Low risk, easy to verify
2. ✓ Handles transient network issues
3. ✓ Quick to implement and deploy
4. ✗ Still has fundamental limitation (separate HTTP request)

**If Option A insufficient, move to Option B** for comprehensive solution.

## Test Scenarios

To verify fix effectiveness:

1. **Slow network (throttle to 3G):**
   - Send message, verify response arrives
   - No "Abort" button needed

2. **Network switch (WiFi → mobile):**
   - Send message on WiFi
   - Switch to mobile mid-transmission
   - Verify response still arrives (with delay if needed)

3. **High packet loss:**
   - Use network simulator
   - 10-20% packet loss
   - Verify pong retries succeed

4. **Intermittent connectivity:**
   - Brief disconnects between ping/pong
   - Verify graceful recovery

## Files Involved

**Server:**
- `packages/server/src/server/routes/events.ts` — SSE setup, ping interval
- `packages/server/src/clients/connection-manager.ts` — Pong timeout logic

**Client:**
- `packages/ui/src/lib/server-events.ts` — Pong response handler
- `packages/ui/src/lib/api-client.ts` — HTTP POST implementation
- `packages/ui/src/lib/event-source-handlers.ts` — SSE event listeners

## Next Steps

1. Implement Option A (pong retry logic)
2. Test on mobile networks with poor connectivity
3. Monitor logs for retry patterns
4. If needed, escalate to Option B (SSE-based pong)
