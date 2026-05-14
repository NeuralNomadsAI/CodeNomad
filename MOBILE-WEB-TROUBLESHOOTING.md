# CodeNomad Mobile Web - Troubleshooting

**Setup**: CodeNomad web server → VPN → Mobile browser  
**Issue**: AI "se queda pensando" después de un rato  
**Date**: May 14, 2026

---

## Current Configuration

### Server
```bash
# Running on host
npx @neuralnomads/codenomad-dev \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

# OpenCode backend
opencode serve --port 4096
```

### Network
- **Server IP**: 192.168.50.45
- **Mobile IP**: 192.168.50.3 (via VPN)
- **Port**: 9898 (HTTPS)
- **Protocol**: Server-Sent Events (SSE) for streaming

### Active Connections
```
192.168.50.45:9898 <--> 192.168.50.3 (mobile)
127.0.0.1:4096 (opencode) <--> 127.0.0.1:9898 (codenomad)
192.168.50.45 --> 160.79.104.10:443 (Anthropic API)
```

---

## Problem: "Se queda pensando"

### Symptoms
- AI starts responding normally
- After some time (how long?), stops updating
- UI shows "thinking" or loading state
- Doesn't complete the response

### Possible Causes

#### 1. SSE Connection Timeout (Most Likely)

**What happens:**
- Mobile browsers/VPN can timeout SSE connections
- Connection drops but UI doesn't realize
- No error shown, just stops

**Diagnostic:**
```bash
# On server, check for SSE errors
journalctl -u codenomad -f | grep -i "sse\|stream\|timeout"

# Check OpenCode logs
tail -f ~/.config/codenomad/logs/opencode-*.log
```

**Indicators:**
- No new data in browser Network tab (SSE connection)
- Server logs show connection closed
- Mobile switches networks (WiFi ↔ Cellular)

#### 2. VPN Keep-Alive Issues

**What happens:**
- VPN drops idle connections after N minutes
- Long-running requests get killed
- Mobile network changes (4G → WiFi) breaks VPN

**Diagnostic:**
```bash
# Check VPN connection stability
# On mobile, look for VPN reconnections

# On server, check for dropped connections
netstat -tn | grep 9898
```

#### 3. Mobile Browser Background Throttling

**What happens:**
- Mobile browser puts tab in background
- JavaScript execution slowed/stopped
- SSE events queued or dropped

**Indicators:**
- Only happens when switching apps
- Works fine when browser in foreground
- iOS Safari more aggressive than Chrome

#### 4. OpenCode API Timeout

**What happens:**
- Anthropic API has long response
- OpenCode times out
- CodeNomad doesn't handle timeout gracefully

**Diagnostic:**
```bash
# Check OpenCode logs for API errors
grep -i "timeout\|error" ~/.config/codenomad/logs/*.log

# Check if Anthropic connection is still alive
lsof -i -P -n | grep 160.79.104.10
```

#### 5. Memory/CPU Issues on Mobile

**What happens:**
- Mobile browser runs out of memory
- Tab gets killed or frozen
- Long responses consume too much RAM

**Indicators:**
- Only happens with very long responses
- Browser shows "page unresponsive" warning
- Other tabs also affected

---

## Diagnostics

### Step 1: Check Server Logs

```bash
# Real-time monitoring
tail -f ~/.config/codenomad/logs/opencode-*.log

# Look for these patterns:
# - "Stream closed"
# - "Connection timeout"
# - "Error sending SSE"
# - "Client disconnected"
```

### Step 2: Monitor Network Connections

```bash
# Watch active connections
watch -n 1 'lsof -i -P -n | grep -E "9898|4096"'

# Look for connections appearing/disappearing
# Check if mobile IP (192.168.50.3) stays connected
```

### Step 3: Test from Server Directly

```bash
# Access from server itself (eliminate VPN/mobile variables)
curl https://localhost:9898

# Or use browser on server
firefox https://localhost:9898
```

### Step 4: Check VPN Stability

```bash
# On server, ping mobile continuously
ping 192.168.50.3

# Watch for:
# - Packet loss
# - High latency spikes
# - Connection drops
```

### Step 5: Browser Developer Tools (on mobile)

- Open DevTools on mobile (if available)
- Check Network tab → EventStream
- Look for SSE connection status
- Check Console for JavaScript errors

---

## Solutions

### Solution 1: Increase SSE Timeout (Server)

Edit CodeNomad server config to increase SSE keep-alive:

```bash
# Find config file
~/.config/codenomad/config.json

# Or environment variable
export CODENOMAD_SSE_TIMEOUT=300000  # 5 minutes in ms
```

**Note:** Need to find where CodeNomad sets SSE timeout.

### Solution 2: Enable SSE Keep-Alive Pings

Configure server to send periodic keep-alive events:

```javascript
// In CodeNomad server code
// Send ping every 30 seconds to keep connection alive
setInterval(() => {
  res.write(': ping\n\n')
}, 30000)
```

**Location to modify:** `packages/server/src/` (SSE handler)

### Solution 3: VPN Optimization

```bash
# On VPN server, increase timeout
# (WireGuard example)
PersistentKeepalive = 25

# OpenVPN example
keepalive 10 60
```

### Solution 4: Use WebSocket Instead of SSE

SSE is one-way. WebSocket is bidirectional and more mobile-friendly.

**Pros:**
- Better mobile support
- Built-in keep-alive
- Automatic reconnection

**Cons:**
- Requires CodeNomad code changes
- More complex than SSE

### Solution 5: Progressive Response Rendering

Instead of one long response, render in chunks:

```javascript
// Render message as it arrives
// Don't wait for complete response
// Show partial content immediately
```

**This might already be implemented**, just need to verify.

### Solution 6: Add Reconnection Logic

Client-side code to detect stalled connection and reconnect:

```javascript
// Pseudo-code
let lastEventTime = Date.now()

setInterval(() => {
  if (Date.now() - lastEventTime > 30000) {
    // No event in 30s, reconnect
    reconnectSSE()
  }
}, 10000)
```

### Solution 7: Mobile-Specific Optimizations

```javascript
// Detect mobile and adjust timeouts
if (isMobile()) {
  // Shorter timeouts
  // More aggressive keep-alive
  // Auto-reconnect on background/foreground
}
```

---

## Immediate Actions You Can Take

### 1. Keep Browser in Foreground
- Don't switch apps while AI is responding
- Prevents background throttling

### 2. Use Stable Network
- Stay on WiFi (don't switch to cellular mid-response)
- Avoid network transitions

### 3. Shorter Questions
- Break long requests into smaller parts
- Reduces chance of timeout

### 4. Check Server Logs After Hang
```bash
ssh user@vpn-server
tail -100 ~/.config/codenomad/logs/opencode-*.log
```

### 5. Monitor Server Resources
```bash
# Check if server is overwhelmed
htop
# Look at CPU, memory, network I/O
```

---

## Testing Protocol

### Test 1: Reproduce the Issue

1. Start session on mobile
2. Ask complex question (long response expected)
3. Note exact time when it "gets stuck"
4. Check server logs at that timestamp
5. Document findings

### Test 2: Compare Desktop vs Mobile

1. Ask same question from desktop browser
2. Does it complete successfully?
3. If yes → mobile/VPN issue
4. If no → server/API issue

### Test 3: Test from Local Network

1. Connect mobile to same LAN as server (no VPN)
2. Ask question
3. Does it still hang?
4. If no → VPN issue
5. If yes → mobile browser issue

### Test 4: Test Different Browsers

On mobile:
- Chrome
- Firefox
- Safari (iOS)
- Brave

See if behavior differs.

---

## Monitoring Script

Create a monitoring script to catch the issue:

```bash
#!/bin/bash
# Save as: monitor-codenomad.sh

LOG_FILE="/tmp/codenomad-monitor.log"

echo "Monitoring CodeNomad connections..." | tee -a "$LOG_FILE"

while true; do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    
    # Check if mobile is connected
    MOBILE_CONN=$(lsof -i -P -n | grep "192.168.50.3" | grep "9898")
    
    # Check OpenCode status
    OPENCODE_PID=$(pgrep -f "opencode serve")
    
    echo "[$TIMESTAMP]" >> "$LOG_FILE"
    echo "Mobile connection: $MOBILE_CONN" >> "$LOG_FILE"
    echo "OpenCode PID: $OPENCODE_PID" >> "$LOG_FILE"
    
    # Alert if mobile connection dropped
    if [ -z "$MOBILE_CONN" ]; then
        echo "⚠️  Mobile disconnected!" | tee -a "$LOG_FILE"
    fi
    
    sleep 5
done
```

Run it:
```bash
chmod +x monitor-codenomad.sh
./monitor-codenomad.sh &
```

---

## Configuration to Try

### Current Config (detected)
```bash
npx @neuralnomads/codenomad-dev \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch
```

### Suggested Config (add timeouts)
```bash
# Check available options
npx @neuralnomads/codenomad-dev --help

# Look for timeout/keepalive options
# May need to set via environment variables
```

---

## Code Investigation Needed

### Find SSE Implementation

```bash
cd /home/dark/Project/codenomad
grep -r "text/event-stream\|ServerSentEvents\|EventSource" packages/server/
```

### Check for Timeout Configuration

```bash
grep -r "timeout\|keepalive" packages/server/src/
```

### Review OpenCode Integration

```bash
# How does CodeNomad talk to OpenCode?
grep -r "opencode.*serve\|opencode.*client" packages/server/
```

---

## Information to Collect

Next time it hangs, collect:

1. **Exact timestamp** when it stopped
2. **How long** into the response (10s? 30s? 2min?)
3. **Browser console** errors (if any)
4. **Server logs** from that timestamp
5. **Network tab** - is SSE connection still open?
6. **Did you switch apps** or lock screen?
7. **Network change** during response? (WiFi/Cellular)

---

## Related Files in CodeNomad

```
packages/server/
├── src/
│   ├── index.ts           # Main server entry
│   ├── server.ts          # Express server setup
│   ├── routes/            # API endpoints
│   ├── opencode/          # OpenCode integration
│   └── sse/               # SSE implementation (if exists)
```

---

## Community Issues to Check

Search upstream issues for:
- "SSE timeout"
- "mobile browser"
- "connection drops"
- "VPN"
- "keeps thinking"

Link: https://github.com/NeuralNomadsAI/CodeNomad/issues

---

## Next Steps

1. **Reproduce and document** exact conditions
2. **Collect logs** when it happens
3. **Test different scenarios** (local, desktop, browsers)
4. **Investigate SSE code** in CodeNomad server
5. **Report findings** to upstream with evidence

---

## Quick Workarounds

### Workaround 1: Refresh Page
- When stuck, refresh browser
- Session should resume (if CodeNomad has session persistence)

### Workaround 2: Restart Question
- Cancel stuck response
- Ask question again (maybe shorter)

### Workaround 3: Use Desktop
- Access via desktop browser when possible
- More stable for long responses

### Workaround 4: Keep Interaction
- Scroll page occasionally
- Prevents mobile browser sleep

---

**Status**: Investigation in progress  
**Priority**: High (affects primary use case)  
**Next**: Reproduce and collect detailed logs
