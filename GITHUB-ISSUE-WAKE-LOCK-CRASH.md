# 🔴 CRITICAL: Screen lock causes system hang when wake-lock is active (KDE Wayland + Electron)

## Description

Locking the screen session via `loginctl lock-session` or KDE's screen lock while CodeNomad's wake-lock is active causes the Electron application to crash and the entire system to hang, requiring a hard reboot.

## Environment

- **OS**: Linux (KDE Plasma on Wayland)
- **CodeNomad Version**: 0.15.0 (dev mode)
- **Electron Version**: 39.0.0
- **Node Version**: Latest LTS
- **Build Mode**: Development (`npm run dev`)
- **Display Server**: Wayland (KDE Plasma)

## Steps to Reproduce

1. Start CodeNomad in dev mode:
   ```bash
   npm run dev
   ```

2. Create a new session with an agent

3. Ask a question to trigger agent work (status should be "working")

4. Verify wake-lock is active (optional verification):
   ```bash
   qdbus6 org.freedesktop.PowerManagement /org/freedesktop/PowerManagement/Inhibit HasInhibit
   # Should return: true
   ```

5. While agent is actively responding, lock the screen:
   ```bash
   loginctl lock-session
   ```
   Or use KDE's screen lock shortcut (typically Meta+L or configured key)

6. **Result**: Application crashes, system hangs completely

## Expected Behavior

According to [SCR-2026-04-21-001](docs/scrs/SCR-2026-04-21-001-wake-lock-system-sleep-only.md):

- ✅ Screen should lock successfully
- ✅ Agent should continue working in background
- ✅ Wake-lock should remain active (preventing system sleep)
- ✅ Display can sleep/lock
- ✅ User can unlock and see continued progress

## Actual Behavior

- ❌ Electron application crashes immediately
- ❌ System becomes completely unresponsive
- ❌ Requires hard reboot (power button)
- ❌ All work in progress is lost

## Impact

**Severity**: CRITICAL

This makes the wake-lock feature dangerous to use in production:
- Users lose work in progress
- System becomes unresponsive
- Forces hard reboot (potential data corruption/loss)
- Reproducible 100% of the time

## Investigation

### Code Review

The wake-lock implementation code is **correct**:

- Electron uses `powerSaveBlocker.start("prevent-app-suspension")` ✅
- Located in: `packages/electron-app/electron/main/ipc.ts:99`
- Mode is correct for allowing screen lock while preventing system sleep

### Runtime Verification

Wake-lock **does activate correctly**:
- Verified with D-Bus: `HasInhibit` transitions from `false` → `true` when agent starts working
- Uses `org.freedesktop.PowerManagement.Inhibit` interface (correct for KDE)
- Activation timing is immediate and correct

### The Problem

The crash occurs specifically when:
1. Wake-lock is active (D-Bus inhibitor registered)
2. AND user locks the screen session
3. ON KDE Wayland (not tested on X11 or other DEs)

## Root Cause Hypothesis

### Most Likely: Electron + Wayland + Lock Event Conflict

Electron 39 on Wayland may have a race condition or compatibility issue when:
- An active D-Bus power management inhibitor exists
- A Wayland session lock event occurs
- The compositor changes display state

This combination appears to trigger a crash in the Electron renderer or main process.

### Supporting Evidence

- Issue is 100% reproducible
- Only occurs when wake-lock is active
- Specific to Wayland (X11 behavior unknown)
- Electron's powerSaveBlocker on Linux uses D-Bus directly

## Proposed Solutions

### Option 1: Disable wake-lock on Wayland (Quick Fix)

```typescript
// In packages/ui/src/lib/native/wake-lock.ts
function hasAnyWakeLockSupport(): boolean {
  if (typeof window === "undefined") return false
  
  // TEMPORARY: Disable on Wayland until crash is resolved
  if (isElectronHost() && isWayland()) {
    console.warn("[wake-lock] Disabled on Wayland due to screen lock crash bug")
    return false
  }
  
  if (isElectronHost()) {
    const api = (window as any).electronAPI
    if (api?.setWakeLock) return true
  }
  // ... rest
}
```

### Option 2: Release wake-lock on session lock (Workaround)

```typescript
// In packages/ui/src/App.tsx or wake-lock.ts
// Listen for window blur (occurs before lock)
window.addEventListener('blur', () => {
  // Temporarily release wake-lock
  void setWakeLockDesired(false)
})

window.addEventListener('focus', () => {
  // Re-evaluate wake-lock need
  const hold = shouldHoldWakeLock()
  void setWakeLockDesired(hold)
})
```

### Option 3: Test alternative powerSaveBlocker mode

```typescript
// In packages/electron-app/electron/main/ipc.ts
// Try "prevent-display-sleep" instead
wakeLockId = powerSaveBlocker.start("prevent-display-sleep")
```

Note: This changes behavior - would also prevent screen lock (not desired per spec)

### Option 4: Migrate to Tauri for Wayland (Long-term)

Tauri uses native webview (not Chromium) and may have better Wayland compatibility.
- Already implemented in `packages/tauri-app/`
- Test if crash reproduces with Tauri build
- Consider Tauri as primary for Linux if Electron issues persist

## Additional Testing Needed

1. **Test on X11**: Does crash occur on X11 or only Wayland?
2. **Test on other DEs**: GNOME Wayland, Sway, etc.
3. **Test Tauri build**: Does the same crash occur with Tauri?
4. **Upstream Electron**: Search for similar issues in Electron repo

## Related Files

- Implementation: `packages/electron-app/electron/main/ipc.ts:92-117`
- Wake-lock manager: `packages/ui/src/lib/native/wake-lock.ts`
- Eligibility: `packages/ui/src/stores/wake-lock-eligibility.ts`
- Specification: `docs/scrs/SCR-2026-04-21-001-wake-lock-system-sleep-only.md`
- Test guide: `TESTING-WAKE-LOCK.md`
- Bug report: `BUG-REPORT-SCREEN-LOCK-CRASH.md`

## Tasks Affected

- ✅ Task 055 (Investigation): COMPLETE
- ✅ Task 056 (Specification): COMPLETE  
- ⚠️ Task 057 (Implementation): BLOCKED by this bug

## Logs

Crash logs captured:
- User journal: `crash-logs-20260514-012551.log` (local, not committed)
- System journal: `system-crash-logs-20260514-012552.log` (local, not committed)

Available for review if needed.

## Workaround for Users

**DO NOT use screen lock while CodeNomad agent is working on KDE Wayland.**

Alternative:
1. Wait for agent to finish before locking screen
2. Use Tauri build instead of Electron (if available)
3. Run on X11 instead of Wayland (if crash is Wayland-specific)

## Next Steps

1. Verify if crash occurs on X11
2. Test with Tauri build
3. Search Electron issue tracker for similar reports
4. Implement temporary workaround (Option 1 or 2)
5. Report to Electron upstream if confirmed as Electron bug

---

**This bug BLOCKS the wake-lock feature from production deployment until resolved.**

---

## For Developers

Full investigation documentation:
- See commit: `test(wake-lock): comprehensive investigation and critical bug discovery`
- Technical analysis: `wake-lock-verification-report.md`
- Test results: `WAKE-LOCK-TEST-RESULTS.md`
- Contribution summary: `CONTRIBUTION-SUMMARY.md`
