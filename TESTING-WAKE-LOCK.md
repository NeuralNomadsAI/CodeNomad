# Wake Lock Testing Guide for CodeNomad

**Platform**: KDE Plasma on Wayland  
**Date**: May 14, 2026  
**Related**: Tasks 055-057, SCR-2026-04-21-001

---

## Prerequisites

Before testing, ensure you have:

- ✅ KDE Plasma desktop environment running
- ✅ CodeNomad dependencies installed (`npm install` completed)
- ✅ OpenCode CLI installed (`opencode --version` works)
- ✅ Two terminal windows or tmux/screen session

---

## Test Setup

### Terminal 1: Wake Lock Monitor

```bash
cd /home/dark/Project/codenomad
./test-wake-lock-kde.sh monitor
```

This will display real-time wake lock status:
- `◉ WAKE LOCK: ACTIVE` = System sleep prevented
- `○ WAKE LOCK: INACTIVE` = Normal power management

### Terminal 2: Run CodeNomad

```bash
cd /home/dark/Project/codenomad
npm run dev
```

The Electron app should launch with the CodeNomad UI.

---

## Test Cases

### Test 1: Wake Lock Activation During Active Work ✓

**Purpose**: Verify wake lock activates when agent is working

**Steps**:
1. Start CodeNomad and create a new session
2. Select an agent (e.g., "General Purpose Agent")
3. Ask a question that will take 20+ seconds to answer:
   ```
   "Explain React hooks in detail with code examples"
   ```
4. **IMMEDIATELY** check Terminal 1 (monitor)

**Expected Results**:
- ✅ Monitor shows: `◉ WAKE LOCK: ACTIVE`
- ✅ Session status in UI shows "Working..." or spinner
- ✅ `systemd-inhibit --list` shows Electron inhibitor

**Actual Results** (fill in after testing):
```
Wake lock status: [ ACTIVE / INACTIVE ]
Session status: [ __________ ]
Notes: 


```

---

### Test 2: Wake Lock Release After Work Completes ✓

**Purpose**: Verify wake lock releases when agent finishes

**Steps**:
1. Continue from Test 1
2. Wait for the agent to complete its response
3. Check Terminal 1 when response is fully displayed

**Expected Results**:
- ✅ Monitor shows: `○ WAKE LOCK: INACTIVE`
- ✅ Session status shows idle/waiting for input
- ✅ `systemd-inhibit --list` no longer shows Electron

**Actual Results**:
```
Wake lock status: [ ACTIVE / INACTIVE ]
Session status: [ __________ ]
Notes:


```

---

### Test 3: Screen Lock Compatibility ✓

**Purpose**: Verify screen can lock while work is active

**Steps**:
1. Start a long-running agent task (e.g., "Write a comprehensive guide to TypeScript")
2. While agent is working, press **Ctrl+Alt+L** to lock screen
3. Wait 5 seconds
4. Unlock screen and check CodeNomad

**Expected Results**:
- ✅ Screen locks successfully
- ✅ Agent continues working in background
- ✅ Response continues after unlock
- ✅ Wake lock remains active during screen lock

**Actual Results**:
```
Screen locked: [ YES / NO ]
Agent continued working: [ YES / NO ]
Wake lock status during lock: [ ACTIVE / INACTIVE ]
Notes:


```

---

### Test 4: Display Sleep Compatibility ✓

**Purpose**: Verify display can sleep while work is active

**Steps**:
1. In KDE System Settings, set display sleep to 1 minute:
   ```
   System Settings → Power Management → Energy Saving
   → Screen Energy Saving: 1 minute
   ```
2. Start a long-running agent task (3+ minutes)
3. Don't touch keyboard/mouse for 1 minute
4. Wait for display to turn off
5. Move mouse to wake display

**Expected Results**:
- ✅ Display turns off after 1 minute
- ✅ Agent continues working (check Terminal 1 via SSH or wake display)
- ✅ Response continues/completes when display wakes

**Actual Results**:
```
Display turned off: [ YES / NO ]
Agent continued working: [ YES / NO / UNKNOWN ]
Work completed successfully: [ YES / NO ]
Notes:


```

---

### Test 5: System Sleep Prevention ✓

**Purpose**: Verify system does NOT sleep during active work

**Steps**:
1. In KDE System Settings, set suspend timeout to 2 minutes:
   ```
   System Settings → Power Management → Energy Saving
   → Suspend Session: After 2 minutes
   ```
2. Start a long-running agent task (5+ minutes)
3. Don't touch keyboard/mouse for 3 minutes
4. System should NOT suspend

**Expected Results**:
- ✅ System does NOT suspend while work is active
- ✅ Wake lock remains active for entire work duration
- ✅ System CAN suspend after work completes

**Actual Results**:
```
System suspended during work: [ YES / NO ]
Wake lock duration: [ _____ seconds/minutes ]
System suspended after work ended: [ YES / NO / NOT TESTED ]
Notes:


```

---

### Test 6: Wake Lock Excludes Pending Permission ✓

**Purpose**: Verify wake lock releases when waiting for user permission

**Steps**:
1. Trigger an action requiring permission (e.g., file write, git operation)
2. Wait for permission dialog to appear
3. Check Terminal 1 monitor

**Expected Results**:
- ✅ Monitor shows: `○ WAKE LOCK: INACTIVE`
- ✅ UI shows permission dialog
- ✅ Session status is NOT "working"

**Actual Results**:
```
Wake lock status during permission: [ ACTIVE / INACTIVE ]
Permission dialog appeared: [ YES / NO ]
Notes:


```

---

### Test 7: Wake Lock Excludes Pending Question ✓

**Purpose**: Verify wake lock releases when waiting for user question response

**Steps**:
1. Trigger a workflow that asks a clarifying question
2. Wait for question prompt to appear
3. Check Terminal 1 monitor

**Expected Results**:
- ✅ Monitor shows: `○ WAKE LOCK: INACTIVE`
- ✅ UI shows question prompt
- ✅ Session status is NOT "working"

**Actual Results**:
```
Wake lock status during question: [ ACTIVE / INACTIVE ]
Question prompt appeared: [ YES / NO ]
Notes:


```

---

## Verification Checklist

After completing all tests, verify implementation matches specification:

### Code Implementation ✓
- [x] Electron uses `prevent-app-suspension` (verified in code)
- [x] Tauri uses `display: false, idle: true, sleep: false` (verified in code)
- [x] Web has no wake lock fallback (verified in code)
- [x] Eligibility excludes `pendingPermission` (verified in code)
- [x] Eligibility excludes `pendingQuestion` (verified in code)

### Runtime Behavior (fill in after testing)
- [ ] Wake lock activates during "working" status
- [ ] Wake lock releases when work completes
- [ ] Screen can lock while work is active
- [ ] Display can sleep while work is active
- [ ] System does NOT sleep while work is active
- [ ] Wake lock does NOT activate for pending permission
- [ ] Wake lock does NOT activate for pending question

---

## Troubleshooting

### Monitor shows "Wake lock is INACTIVE" but agent is working

**Possible causes**:
1. Electron IPC handler not receiving setWakeLock calls
2. powerSaveBlocker.start() failing silently
3. Session status not properly set to "working"

**Debug steps**:
```bash
# Check Electron console logs
# Look for "[wake-lock]" messages

# Check session status in UI developer tools:
# Right-click → Inspect → Console
# Type: sessionStore.sessions
```

### Screen lock doesn't work during active session

**This would be a BUG** - the implementation should allow screen lock.

**Report**:
1. Note exact steps to reproduce
2. Check if using Tauri or Electron
3. Verify platform (Linux/KDE/Wayland)
4. Include relevant logs

### System suspends despite active work

**This would be a BUG** - wake lock should prevent suspension.

**Debug steps**:
```bash
# Check if inhibitor is actually registered:
systemd-inhibit --list | grep -i electron

# Check journalctl for suspend events:
journalctl -b | grep -i "suspend\|sleep" | tail -20
```

---

## Platform-Specific Notes

### KDE Plasma on Wayland
- Uses `org.freedesktop.PowerManagement.Inhibit` D-Bus interface
- Screen lock: Ctrl+Alt+L or `loginctl lock-session`
- Check inhibitors: `qdbus6 org.freedesktop.PowerManagement /org/freedesktop/PowerManagement/Inhibit HasInhibit`

### Expected D-Bus Behavior
When wake lock is active, systemd-inhibit should show:
```
WHO      UID  USER  PID   COMM     WHAT   WHY                           MODE
electron 1000 user  12345 electron sleep  Active CodeNomad session      block
```

---

## Advanced Testing

### Monitor D-Bus Messages

Watch for PowerManagement inhibit/uninhibit calls:
```bash
dbus-monitor --session "interface='org.freedesktop.PowerManagement.Inhibit'"
```

### Check Electron powerSaveBlocker

In Electron DevTools console:
```javascript
// This won't work from renderer, but main process logs should show:
// powerSaveBlocker.start("prevent-app-suspension")
```

### Verify keepawake config (Tauri)

If testing Tauri build, check Rust logs for:
```
display: false
idle: true  
sleep: false
```

---

## Reporting Results

After testing, update this file with:

1. **Summary**: Overall PASS/FAIL for each test
2. **Environment**: KDE version, kernel, graphics driver
3. **Issues Found**: Any unexpected behavior
4. **Recommendations**: Suggested fixes or improvements

Then commit results:
```bash
git add TESTING-WAKE-LOCK.md
git commit -m "test: wake-lock manual testing results on KDE Wayland"
```

---

## Quick Reference Commands

```bash
# Start monitor
./test-wake-lock-kde.sh monitor

# Check wake lock once
./test-wake-lock-kde.sh check

# Run CodeNomad
npm run dev

# Check systemd inhibitors
systemd-inhibit --list

# Lock screen manually
loginctl lock-session

# Check if Electron is running
ps aux | grep electron

# Check D-Bus inhibit status
qdbus6 org.freedesktop.PowerManagement /org/freedesktop/PowerManagement/Inhibit HasInhibit
```

---

## Next Steps After Testing

1. If tests PASS:
   - Update `wake-lock-verification-report.md` with runtime confirmation
   - Mark tasks 055-057 as verified
   - Update user documentation

2. If tests FAIL:
   - Document exact failure scenario
   - Check implementation in relevant file:
     - Electron: `packages/electron-app/electron/main/ipc.ts`
     - UI: `packages/ui/src/lib/native/wake-lock.ts`
     - Eligibility: `packages/ui/src/stores/wake-lock-eligibility.ts`
   - File bug report with reproduction steps

---

**Happy Testing!** 🧪
