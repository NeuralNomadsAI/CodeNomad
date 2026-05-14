# Mobile Web: SSE Connection Stalls During Long Responses

## Description

When using CodeNomad web interface from mobile browser via VPN, the AI response sometimes "gets stuck" (stops updating) during long-running responses. The UI remains in "thinking" state but no new content appears.

## Environment

**Server:**
- CodeNomad version: `@neuralnomads/codenomad-dev` (latest)
- Host: Linux server (KDE)
- Command: `npx @neuralnomads/codenomad-dev --host 0.0.0.0 --https-port 9898 --password XXXX --launch`
- Network: Server on VPN (192.168.50.45)

**Client:**
- Device: Mobile phone
- Network: Connected via VPN (192.168.50.3)
- Browser: [To be determined - Chrome/Firefox/Safari]
- Connection: HTTPS to server:9898

**OpenCode:**
- Running: `opencode serve --port 4096`
- Logs: Debug level enabled

## Steps to Reproduce

1. Access CodeNomad from mobile browser via VPN
2. Start a session with an agent
3. Ask a complex question that generates a long response
4. Observe response starts streaming normally
5. After some time (varies), response stops updating
6. UI shows "thinking" or loading indicator
7. No error message displayed
8. Response never completes

## Expected Behavior

- Response should continue streaming until complete
- SSE connection should remain alive via heartbeat pings
- If connection drops, client should reconnect or show error
- Long responses should complete successfully

## Actual Behavior

- Response streams partially
- Then stops updating (no new content)
- UI remains in loading state
- No error shown to user
- Requires page refresh to recover

## Investigation

### SSE Implementation Found

Location: `packages/server/src/server/routes/events.ts`

**Current heartbeat:**
```typescript
const heartbeat = setInterval(() => {
  const ping = { ts: Date.now() }
  reply.raw.write(`event: codenomad.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
}, 15000) // Ping every 15 seconds
```

**Headers set:**
```typescript
reply.raw.setHeader("Content-Type", "text/event-stream")
reply.raw.setHeader("Cache-Control", "no-cache")
reply.raw.setHeader("Connection", "keep-alive")
```

### Possible Causes

1. **VPN Timeout**
   - VPN may drop idle SSE connections despite pings
   - Need to test if 15s interval is sufficient
   - Mobile network handoffs (WiFi ↔ Cellular) may break VPN

2. **Mobile Browser Throttling**
   - Background tabs may pause JavaScript
   - SSE event handling may be delayed/dropped
   - iOS Safari more aggressive than Android Chrome

3. **Intermediate Proxy/NAT Timeout**
   - Router/firewall between server and mobile
   - May timeout long-lived HTTP connections
   - VPN software may have own timeout settings

4. **Client-Side Reconnection Missing**
   - When SSE connection drops, does client detect it?
   - Is there automatic reconnection logic?
   - Does UI notify user of connection loss?

## Diagnostic Data Needed

Next occurrence, collect:

1. **Exact timestamp** when response stopped
2. **Duration** of response before stall (10s? 30s? 2min?)
3. **Server logs** from that timestamp:
   ```bash
   tail -100 ~/.config/codenomad/logs/opencode-*.log
   journalctl -u codenomad -S "YYYY-MM-DD HH:MM:SS"
   ```
4. **Browser DevTools:**
   - Network tab → EventStream connection status
   - Console errors (if any)
   - Application tab → Service Workers
5. **Network conditions:**
   - Did mobile switch networks during response?
   - VPN connection stable?
   - Other apps working normally?

## Proposed Solutions

### Option 1: Increase Ping Frequency

Change heartbeat from 15s to 10s or 5s:

```typescript
const heartbeat = setInterval(() => {
  const ping = { ts: Date.now() }
  reply.raw.write(`event: codenomad.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
}, 5000) // More frequent pings for mobile/VPN
```

**Pros:** Simple, may prevent timeouts  
**Cons:** Slightly more bandwidth, not guaranteed fix

### Option 2: Client-Side Reconnection Logic

Detect stalled connection and reconnect:

```typescript
// In client (packages/ui/)
let lastEventTime = Date.now()

eventSource.onmessage = (event) => {
  lastEventTime = Date.now()
  // ... handle event
}

// Check for stalled connection
setInterval(() => {
  if (Date.now() - lastEventTime > 30000) {
    // No event in 30s (including pings), reconnect
    console.warn("SSE connection stalled, reconnecting...")
    reconnectSSE()
  }
}, 10000)
```

**Pros:** More robust, handles all timeout scenarios  
**Cons:** Requires client-side code changes

### Option 3: Response Chunking with Acknowledgment

Server waits for client ACK before continuing:

```typescript
// Server sends chunk, waits for pong
send(chunk)
await waitForPong(timeout)
send(nextChunk)
```

**Pros:** Guarantees delivery, detects dead connections  
**Cons:** Adds latency, complex implementation

### Option 4: WebSocket Instead of SSE

Migrate from SSE to WebSocket for bidirectional communication:

**Pros:**
- Better mobile support
- Built-in ping/pong
- Automatic reconnection support
- Detects broken connections faster

**Cons:**
- Major refactor required
- SSE is simpler and works for most cases

### Option 5: Progressive UI Updates

Show partial response even if connection lost:

```typescript
// UI shows what was received so far
// Button to "Continue" or "Retry" if stalled
```

**Pros:** Better UX, user can see progress  
**Cons:** Doesn't fix underlying issue

## Testing Plan

### Test 1: Desktop Browser (Control)
- Access from desktop browser (same VPN)
- Ask same long question
- Does it complete?
- **If yes:** Mobile-specific issue
- **If no:** Server/backend issue

### Test 2: Mobile Browser (Local Network)
- Connect mobile to server's LAN (no VPN)
- Ask long question
- Does it complete?
- **If yes:** VPN issue
- **If no:** Mobile browser issue

### Test 3: Different Mobile Browsers
- Test on Chrome, Firefox, Safari
- See if behavior differs
- Identify browser-specific issues

### Test 4: Shorter Ping Interval
- Modify heartbeat to 5s
- Restart server
- Test from mobile
- Does it help?

### Test 5: Monitor Server Logs
- Enable trace logging
- Ask question from mobile
- Watch logs in real-time
- See if server detects disconnect

## Monitoring Script

```bash
#!/bin/bash
# Save as: monitor-mobile-connection.sh

MOBILE_IP="192.168.50.3"
PORT="9898"

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')
  CONN=$(lsof -i -P -n | grep "$MOBILE_IP" | grep "$PORT")
  
  if [ -n "$CONN" ]; then
    echo "[$TIMESTAMP] ✓ Mobile connected"
  else
    echo "[$TIMESTAMP] ✗ Mobile DISCONNECTED"
  fi
  
  sleep 2
done
```

Run during testing to catch disconnections.

## Client-Side Investigation

Need to check:

1. **Where is EventSource created?**
   ```bash
   cd /home/dark/Project/codenomad
   grep -r "EventSource\|eventsource" packages/ui/src/
   ```

2. **Is there reconnection logic?**
   ```bash
   grep -r "reconnect\|onerror.*EventSource" packages/ui/src/
   ```

3. **How are timeouts handled?**
   ```bash
   grep -r "timeout.*event\|sse.*timeout" packages/ui/src/
   ```

## Related Code Locations

**Server (SSE):**
- `packages/server/src/server/routes/events.ts` - Main SSE endpoint
- `packages/server/src/events/bus.ts` - Event bus implementation
- `packages/server/src/clients/connection-manager.ts` - Connection tracking

**Client:**
- `packages/ui/src/` - Frontend code (need to find EventSource usage)

## Workarounds for Users

Until fixed:

1. **Keep browser in foreground**
   - Don't switch apps during AI response
   - Prevents background throttling

2. **Use stable network**
   - Stay on WiFi during response
   - Avoid switching WiFi ↔ Cellular

3. **Refresh if stuck**
   - F5 or pull-to-refresh
   - Session should resume (check if this works)

4. **Break up long questions**
   - Ask shorter, focused questions
   - Reduces timeout risk

5. **Use desktop when possible**
   - More stable for long responses
   - Can access same server via VPN

## Priority

**Medium-High** - Affects mobile users significantly

This is a usability issue rather than critical bug, but impacts primary use case for mobile access.

## Labels

- bug
- mobile
- sse
- network
- vpn
- user-experience

---

**Reporter:** @JDis03  
**Date:** May 14, 2026  
**Status:** Investigation in progress
