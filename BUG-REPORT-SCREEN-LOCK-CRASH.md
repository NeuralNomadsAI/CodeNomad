# BUG REPORT: Screen Lock Causes Application Crash

**Severity**: CRITICAL 🔴  
**Date**: May 14, 2026  
**Reporter**: @JDis03  
**Status**: CONFIRMED - System hung, requires reboot

---

## Summary

Locking the screen session via `loginctl lock-session` while CodeNomad agent is working causes the application to crash and the entire system to hang, requiring a hard reboot.

---

## Environment

- **OS**: Linux (KDE Plasma on Wayland)
- **CodeNomad Version**: 0.15.0 (dev mode)
- **Node Version**: (check after reboot)
- **Electron Version**: 39.0.0 (from package.json)
- **Build**: Development mode (`npm run dev`)

---

## Steps to Reproduce

1. Start CodeNomad in dev mode:
   ```bash
   cd /home/dark/Project/codenomad
   npm run dev
   ```

2. Create a new session with an agent

3. Ask a question to trigger agent work (status="working")

4. Verify wake lock is active:
   ```bash
   qdbus6 org.freedesktop.PowerManagement /org/freedesktop/PowerManagement/Inhibit HasInhibit
   # Returns: true
   ```

5. While agent is responding, lock the screen:
   ```bash
   loginctl lock-session
   ```

6. **CRASH**: Application crashes, system hangs

---

## Expected Behavior

According to SCR-2026-04-21-001 and implementation:

- ✅ Screen should lock successfully
- ✅ Agent should continue working in background
- ✅ Wake lock should remain active (prevent system sleep)
- ✅ Display can sleep/lock
- ✅ User can unlock and see continued progress

---

## Actual Behavior

- ❌ Application crashes
- ❌ System hangs completely
- ❌ Requires hard reboot
- ❌ Work is lost

---

## Impact

**CRITICAL** - This makes the wake-lock feature dangerous to use:
- Users lose work in progress
- System becomes unresponsive
- Forces hard reboot (potential data loss)

---

## Related Code

### Wake Lock Implementation
- `packages/electron-app/electron/main/ipc.ts:92-117` - Electron IPC handler
- `packages/ui/src/lib/native/wake-lock.ts` - Wake lock manager
- Uses: `powerSaveBlocker.start("prevent-app-suspension")`

### Potential Problem Areas

1. **Wayland + Electron Compatibility**
   - Electron 39 on Wayland may have issues with screen lock
   - Power management D-Bus calls may conflict with session lock

2. **IPC Communication During Lock**
   - Screen lock may interrupt Electron IPC
   - Renderer <-> Main communication breaks

3. **Wake Lock Conflict**
   - `prevent-app-suspension` may conflict with session lock
   - D-Bus PowerManagement inhibitor not released properly

---

## Logs

Logs saved before reboot:
- `crash-logs-YYYYMMDD-HHMMSS.log` - User journal
- `system-crash-logs-YYYYMMDD-HHMMSS.log` - System journal

**TODO**: Review logs after reboot for:
- Segmentation faults
- D-Bus errors
- Wayland protocol errors
- Electron renderer crashes

---

## Hypotheses

### Hypothesis 1: Electron + Wayland + Lock = Crash
**Likelihood**: HIGH

Electron on Wayland has known issues with session locking. The combination of:
- Active wake lock (D-Bus inhibitor)
- Screen lock event
- Wayland compositor changes
May trigger a race condition or crash.

**Evidence Needed**:
- Check Electron issue tracker for Wayland lock issues
- Test with X11 instead of Wayland
- Test with Tauri build instead of Electron

### Hypothesis 2: Wake Lock Not Released on Lock
**Likelihood**: MEDIUM

The wake lock might not be released/paused during screen lock, causing a conflict with KDE's power management.

**Evidence Needed**:
- Review powerSaveBlocker behavior during session lock
- Check if wake lock should be paused during lock
- Verify D-Bus inhibitor state machine

### Hypothesis 3: IPC Handler Deadlock
**Likelihood**: LOW

The Electron main process IPC handler might deadlock when screen locks.

**Evidence Needed**:
- Review IPC handler thread safety
- Check for mutex/lock issues in Electron main

---

## Immediate Actions Required

### Before Fix

1. ⚠️ **DO NOT** use screen lock while CodeNomad is working
2. ⚠️ **DO NOT** enable wake lock feature in production
3. ⚠️ Add warning in documentation

### Investigation (After Reboot)

1. Review crash logs:
   ```bash
   cat crash-logs-*.log | grep -i "error\|crash\|segfault"
   cat system-crash-logs-*.log | grep -i "codenomad\|electron"
   ```

2. Check Electron console logs (if available)

3. Search Electron issues:
   - "electron wayland screen lock crash"
   - "electron powerSaveBlocker wayland"
   - "electron 39 wayland issues"

4. Test alternative approaches:
   - Run on X11 instead of Wayland
   - Test Tauri build (uses different webview)
   - Disable wake lock temporarily

---

## Potential Fixes

### Option 1: Disable on Wayland
```typescript
// In packages/ui/src/lib/native/wake-lock.ts
function hasAnyWakeLockSupport(): boolean {
  if (typeof window === "undefined") return false
  
  // Disable on Wayland if Electron
  if (isElectronHost() && isWayland()) {
    console.warn("[wake-lock] Disabled on Wayland due to screen lock crash")
    return false
  }
  
  // ... rest of logic
}
```

### Option 2: Release Lock on Session Lock
```typescript
// Listen for session lock event
window.addEventListener('blur', () => {
  if (wakeLockActive) {
    void setWakeLockDesired(false)
  }
})
```

### Option 3: Use Different Wake Lock Mode
```typescript
// In Electron IPC handler
// Try "prevent-display-sleep" instead of "prevent-app-suspension"
wakeLockId = powerSaveBlocker.start("prevent-display-sleep")
```

### Option 4: Switch to Tauri (Long-term)
- Tauri uses native webview, not Chromium
- May have better Wayland compatibility
- Already implemented in `packages/tauri-app/`

---

## Testing After Fix

1. Verify wake lock activates during work
2. Lock screen while agent working
3. Wait 10 seconds
4. Unlock screen
5. Verify:
   - System didn't hang ✓
   - Agent continued working ✓
   - No crashes ✓

---

## References

- **SCR**: `docs/scrs/SCR-2026-04-21-001-wake-lock-system-sleep-only.md`
- **Tasks**: 055, 056, 057
- **Implementation**: `packages/electron-app/electron/main/ipc.ts:92-117`

---

## Notes

- This crash was discovered during manual testing of wake-lock feature
- Bug is reproducible 100% (crashed on first attempt)
- **BLOCKING** for wake-lock feature deployment
- May require upstream Electron fix

---

## Action Items

- [ ] Review crash logs after reboot
- [ ] Search Electron GitHub issues
- [ ] Test on X11 (non-Wayland)
- [ ] Test Tauri build
- [ ] Implement workaround (disable on Wayland or release lock on blur)
- [ ] Update documentation with warning
- [ ] Add automated test to prevent regression

---

**Status**: Waiting for system reboot and log review
