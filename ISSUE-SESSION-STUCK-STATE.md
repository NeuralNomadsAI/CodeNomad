# Session Gets Stuck - Requires Stop + New Message to Resume

## Description

When using CodeNomad web on mobile via VPN, AI responses sometimes get stuck in "thinking" state. The **workaround** is to:
1. Press the red STOP button
2. Send a new message (even just "?")
3. AI then responds normally again

This pattern suggests a **session state issue** rather than network/connection problem.

## Environment

**Server:**
- CodeNomad: `@neuralnomads/codenomad-dev` (latest)
- Host: Linux (192.168.50.45)
- Port: 9898 (HTTPS)
- Command: `npx @neuralnomads/codenomad-dev --host 0.0.0.0 --https-port 9898 --password XXXX --launch`

**Client:**
- Mobile browser via VPN
- Network: 192.168.50.3

**OpenCode:**
- Running on port 4096
- Debug logging enabled

## Reproduction Steps

1. Access CodeNomad from mobile browser
2. Start session with agent
3. Ask a question
4. AI starts responding
5. After some time, response **stops updating**
6. UI shows "thinking" or loading indicator
7. **Press STOP button (red)**
8. **Send any message (e.g., "?")**
9. **AI responds normally again** ✓

## Key Observation

**The workaround works reliably:**
- Stop + new message = AI comes back to life
- This means:
  - ✅ Connection is still alive (SSE working)
  - ✅ Server is responsive
  - ✅ OpenCode is running
  - ❌ Session is in a **stuck state**

## What This Tells Us

### NOT a Network Issue

If it were network:
- Stop button wouldn't help
- Sending "?" wouldn't reconnect
- Would need page refresh

### NOT an SSE Connection Issue

If SSE was broken:
- New message wouldn't reach server
- Response wouldn't come back
- Heartbeat pings would fail

### LIKELY a Session State Issue

Possible causes:

#### 1. Session Waiting for Something

**Theory:** Session enters a state where it's waiting for:
- User input (question/permission)
- Internal acknowledgment
- Some event that never arrives

**Evidence:**
- Stop button resets the state
- New message triggers state transition
- System is responsive

#### 2. Message Queue Blocked

**Theory:** Response gets stuck in a queue:
- First message fills some buffer
- Queue doesn't flush
- Stop clears the queue
- New message restarts streaming

#### 3. OpenCode Session Stuck

**Theory:** OpenCode session (not CodeNomad) gets stuck:
- Agent waiting for something
- Session in invalid state
- Stop cancels the OpenCode request
- New message creates fresh request

#### 4. UI State Desync

**Theory:** UI thinks session is busy when it's not:
- Backend finished/failed silently
- UI never got completion event
- Stop resets UI state
- New message syncs UI with reality

## Investigation

### Check OpenCode Logs During Stuck State

```bash
# While stuck, check logs
tail -f ~/.config/codenomad/logs/opencode-*.log

# Look for:
# - Last log entry timestamp
# - Any errors or warnings
# - "waiting for..." messages
# - Stuck in any particular state
```

### Check CodeNomad Server Logs

```bash
# Enable trace logging
export LOG_LEVEL=trace

# Watch logs during stuck event
journalctl -f | grep -E "codenomad|SSE|event"

# Look for:
# - Is server still sending events?
# - Last event sent before stuck
# - Any errors in event dispatch
```

### Check Browser DevTools

**Network Tab:**
- Is SSE connection still "Pending"?
- Are ping events still arriving every 15s?
- Last event received (timestamp)

**Console:**
- Any JavaScript errors?
- React/Solid errors?
- State warnings?

### Monitor Session State

Add logging to see session state transitions:

```javascript
// In UI code
console.log('Session status:', session.status)
console.log('Pending permission:', session.pendingPermission)
console.log('Pending question:', session.pendingQuestion)
```

## Possible Root Causes

### Cause 1: Session Status Not Updating

**Location:** `packages/ui/src/stores/session-state.ts` (or similar)

**Symptom:**
- Session status stuck on "working"
- Never transitions to "idle"
- UI shows loading forever
- Stop button sets status to "idle"
- New message starts fresh "working" state

**Fix:**
- Ensure status updates on error/completion
- Add timeout for "working" state
- Fallback to "idle" if no events for N seconds

### Cause 2: Wake-Lock Preventing State Change

**Connection to previous work:**
- Wake-lock activates when `status === "working"`
- What if status never changes from "working"?
- Wake-lock stays active
- Session appears stuck

**Test:**
- Temporarily disable wake-lock
- See if issue still occurs
- If not, wake-lock might be related

### Cause 3: OpenCode Stream Not Closing

**Location:** `packages/server/src/workspaces/` (OpenCode integration)

**Symptom:**
- OpenCode finishes response
- But doesn't send final "done" event
- CodeNomad waiting for completion
- Stop cancels the OpenCode request
- New message creates fresh request

**Fix:**
- Add timeout to OpenCode requests
- Detect silent failures
- Send completion event even on error

### Cause 4: SSE Event Lost/Dropped

**Symptom:**
- Server sends completion event
- Event gets lost in transit (VPN/mobile)
- Client never receives it
- Session stuck waiting
- New message forces resync

**Fix:**
- Add event acknowledgment system
- Client ACKs important events
- Server retries if no ACK
- Or add idempotency to handle duplicates

## Testing Protocol

### Test 1: Reproduce with Logging

1. Enable trace logging:
   ```bash
   export LOG_LEVEL=trace
   # Restart CodeNomad
   ```

2. Ask question from mobile

3. When it gets stuck:
   - **DON'T press stop yet**
   - Check server logs
   - Check browser DevTools
   - Note last event received
   - Wait 30 seconds
   - **THEN press stop**
   - Check what logs appear
   - Send "?"
   - Check what logs appear

4. Compare logs before/after stop

### Test 2: Disable Wake-Lock

**Temporary disable** wake-lock to test if related:

```typescript
// In packages/ui/src/lib/native/wake-lock.ts
export function setWakeLockDesired(nextDesired: boolean): Promise<boolean> {
  // Temporarily always return false
  return Promise.resolve(false)
}
```

Rebuild UI, test again. Does issue persist?

### Test 3: Add Session State Logging

```typescript
// In session state store
createEffect(() => {
  console.log('[SESSION]', sessionId, 'status:', session.status)
  console.log('[SESSION]', sessionId, 'pendingPermission:', session.pendingPermission)
  console.log('[SESSION]', sessionId, 'pendingQuestion:', session.pendingQuestion)
})
```

Watch console when stuck. What's the state?

### Test 4: Desktop Browser Comparison

Test same workflow from desktop browser (via VPN):
- Does it get stuck?
- If not, mobile-specific state issue
- If yes, general state issue

## Proposed Solutions

### Solution 1: Add Session Timeout

Automatically reset stuck sessions:

```typescript
// In session state management
let lastEventTime = Date.now()

// On any session event
onSessionEvent(() => {
  lastEventTime = Date.now()
})

// Watchdog
setInterval(() => {
  if (session.status === 'working' && Date.now() - lastEventTime > 60000) {
    // Stuck for 60s, reset to idle
    console.warn('Session stuck, resetting to idle')
    setSessionStatus('idle')
  }
}, 10000)
```

### Solution 2: Add "Done" Event Fallback

Ensure completion is always signaled:

```typescript
// After OpenCode request
try {
  await streamOpenCodeResponse()
} finally {
  // ALWAYS send done, even on error
  sendSessionEvent({ type: 'done', sessionId })
}
```

### Solution 3: Add UI Recovery Button

Instead of user figuring out Stop + "?", add explicit button:

```jsx
{session.status === 'working' && isStuck && (
  <button onClick={recoverSession}>
    Response stuck? Click to recover
  </button>
)}
```

Where `isStuck` = no events for 30s.

### Solution 4: Implement Event Acknowledgment

Client ACKs critical events:

```typescript
// Server sends event
send({ type: 'response-chunk', id: 123, data: '...' })

// Client ACKs
POST /api/events/ack { eventId: 123 }

// Server tracks unacked events
// Resends if no ACK within timeout
```

### Solution 5: Add Health Check Endpoint

Periodic health check to detect stuck state:

```typescript
// Client checks session health
setInterval(async () => {
  const health = await fetch('/api/sessions/health')
  if (health.stuck) {
    // Auto-recover
    recoverSession()
  }
}, 30000)
```

## Quick Workaround (Current)

**What works now:**
1. Press red STOP button
2. Send any message (e.g., "?")
3. Continue conversation

**Better workaround to document:**
```
If response gets stuck:
1. Click STOP
2. Type: "continue" or "go on"
3. AI will resume with rest of answer
```

## Files to Investigate

**Server (OpenCode integration):**
```bash
cd /home/dark/Project/codenomad
find packages/server/src -name "*.ts" | xargs grep -l "opencode"
```

**UI (Session state):**
```bash
find packages/ui/src -name "*session*.ts" | head -10
```

**Event handling:**
```bash
grep -r "EventSource\|eventsource" packages/ui/src/
```

## Priority

**High** - Common issue affecting primary use case

Unlike the wake-lock crash bug (critical but rare), this is a **frequent annoyance** that affects usability.

## Relationship to Wake-Lock Bug

**Question:** Could these be related?

- Wake-lock activates when `status === "working"`
- If session gets stuck in "working" state...
- Wake-lock stays active
- Screen lock might conflict with active wake-lock
- Could explain the crash?

**Test:**
1. Let session get stuck
2. Check wake-lock status: `qdbus6 ... HasInhibit`
3. If true, wake-lock is still active
4. This confirms status isn't resetting

## Next Steps

1. **Reproduce with full logging** (Test 1)
2. **Collect session state** during stuck (Test 3)
3. **Compare desktop vs mobile** (Test 4)
4. **Check if wake-lock related** (Test 2)
5. **Implement Solution 1** (session timeout) as quick fix
6. **Report to upstream** with findings

---

**Reporter:** @JDis03  
**Date:** May 14, 2026  
**Workaround:** Stop + send any message  
**Status:** Investigation needed - likely session state bug  
**Priority:** High (frequent issue, impacts UX)
