# OpenCode Process Lifecycle Fixes

## Executive Summary

Investigation revealed **four critical issues** causing OpenCode processes to accumulate and consume memory even after users believe they've closed sessions:

1. **Session/Instance Confusion** - Users think closing a "session" stops the process (it doesn't)
2. **macOS Window Close Leak** - Closing the Electron window leaves all processes running
3. **No Folder Deduplication** - Opening the same folder creates multiple processes
4. **No Orphan Recovery** - Crashed apps leave zombie processes with no cleanup

---

## Issue 1: Session vs Instance Mental Model Mismatch

### Problem
Users don't understand that:
- **Sessions** = conversations (data only, no process)
- **Instances/Workspaces** = OpenCode processes

The UI uses confusing terminology ("Close Session" vs "Delete" vs "Stop") without explaining the process implications.

### Evidence
- `handleCloseSession()` only calls `clearActiveParentSession()` - no process termination
- `handleCloseInstance()` shows confirmation "Stop OpenCode instance? This will stop the server." - but this is only on the instance tab X button
- Session list shows "Close Session" option that does NOT stop anything

### Impact
Users close sessions expecting to free resources, but processes keep running indefinitely.

### Proposed Fixes

#### 1A. UI Clarity Improvements (Low effort, high impact)
- Remove "Close Session" action entirely (it's misleading)
- Keep only "Delete Session" with clear tooltip: "Deletes conversation history. The OpenCode process continues running."
- Add process indicator to sidebar showing: "1 process running (PID: 12345)"
- Add memory usage indicator per instance

#### 1B. Auto-cleanup Option (Medium effort)
- Add preference: "Stop instance when last session is deleted"
- When enabled, deleting the final session in an instance triggers `stopInstance()`
- Default: OFF (to preserve current behavior for power users)

#### 1C. Idle Instance Detection (Higher effort)
- Track last activity timestamp per instance
- Add preference: "Stop idle instances after X minutes"
- Show warning before auto-stopping: "Instance idle for 30 minutes. Stop to free resources?"

---

## Issue 2: macOS Window Close Leaves Processes Running

### Problem
On macOS, closing the window (red X) doesn't quit the app - this is standard macOS behavior. However, the Era Code server and all OpenCode processes continue running invisibly.

### Evidence
```typescript
// main.ts - Window close does NOT stop server
mainWindow.on("closed", () => {
  mainWindow = null  // Just dereferencing
  // cliManager.stop() is NEVER called
})

// Only before-quit stops the server
app.on("before-quit", async (event) => {
  await cliManager.stop()  // This is correct, but not called on window close
})
```

### Impact
- User closes window thinking they're done
- Reopens app later - NEW server spawns (port 0 = ephemeral)
- Old server + all its OpenCode processes still running
- Repeat = exponential process accumulation

### Proposed Fixes

#### 2A. Stop Server on Window Close (Recommended)
```typescript
mainWindow.on("closed", () => {
  // Kill server when window closes
  cliManager.stop().catch(() => {})
  // ... existing cleanup
})
```
- Matches Tauri behavior (which already does this correctly)
- Simple, no edge cases
- User reopening window gets fresh start

#### 2B. Alternative: Reconnect to Existing Server
- On window reopen, detect if server is still running
- Reconnect instead of spawning new server
- More complex, requires health checks and state sync
- NOT RECOMMENDED for initial fix

---

## Issue 3: No Folder Deduplication

### Problem
Opening the same folder multiple times creates multiple independent:
- Workspace records (different IDs)
- OpenCode processes (different PIDs)
- UI tabs

### Evidence
```typescript
// manager.ts - No path lookup
async create(folder: string): Promise<WorkspaceDescriptor> {
  const id = `${Date.now().toString(36)}`  // Always unique
  // NO check: this.workspaces.values().find(w => w.path === folder)
  this.workspaces.set(id, descriptor)
}
```

### Impact
- Accidental duplicate instances waste resources
- Editing same file from two instances = potential conflicts
- User confusion about which instance is "correct"

### Proposed Fixes

#### 3A. Block Duplicate Folders (Recommended)
- Before creating workspace, check if path already exists
- If exists: activate existing instance instead of creating new one
- Show toast: "Folder already open - switching to existing instance"

#### 3B. Warn But Allow (Alternative)
- Show confirmation: "This folder is already open in another instance. Create duplicate?"
- Allow power users to intentionally create duplicates
- Track duplicates with visual indicator

#### 3C. Server-Side Enforcement
- Add path index to WorkspaceManager
- Return existing workspace ID if path matches
- `create()` becomes idempotent for same path

---

## Issue 4: No Orphan Process Recovery

### Problem
If Electron crashes (or is force-killed), child processes become orphans:
- No PID registry persisted to disk
- No startup cleanup scan
- No health monitoring during runtime

### Evidence
- `CliProcessManager` stores PID only in memory: `this.child`
- No file at `~/.config/era-code/server.pid`
- `app.whenReady()` immediately spawns new CLI without checking for existing

### Impact
- Force-quit or crash = permanent zombie processes
- Each app restart potentially adds more orphans
- Only fix is manual `killall opencode` or reboot

### Proposed Fixes

#### 4A. PID Registry (Essential)
```typescript
// On server start
fs.writeFileSync(PID_FILE, String(child.pid))

// On clean shutdown
fs.unlinkSync(PID_FILE)

// On app startup
if (fs.existsSync(PID_FILE)) {
  const oldPid = parseInt(fs.readFileSync(PID_FILE))
  if (processExists(oldPid)) {
    process.kill(oldPid, 'SIGTERM')
  }
}
```

#### 4B. Process Name Detection (Complementary)
- On startup, scan for processes named "opencode" or "era-code"
- Kill any that match and aren't the current process
- More aggressive but catches edge cases

#### 4C. Workspace PID Tracking (For OpenCode Processes)
- Persist workspace PIDs to `~/.config/era-code/workspaces.json`
- On server startup, kill any orphaned workspace processes
- Structure: `{ "workspace-id": { "pid": 12345, "folder": "/path" } }`

#### 4D. Health Monitoring (Nice to have)
- Periodic HTTP health check to server
- If server dies unexpectedly, show user notification
- Option to auto-restart or cleanup

---

## Implementation Priority

| Priority | Issue | Fix | Effort | Impact |
|----------|-------|-----|--------|--------|
| **P0** | macOS window leak | 2A: Stop on window close | Low | Critical |
| **P0** | Orphan recovery | 4A: PID registry | Low | Critical |
| **P1** | Session confusion | 1A: UI clarity | Medium | High |
| **P1** | Folder dedup | 3A: Block duplicates | Medium | High |
| **P2** | Orphan recovery | 4C: Workspace PIDs | Medium | Medium |
| **P2** | Session cleanup | 1B: Auto-cleanup option | Medium | Medium |
| **P3** | Idle detection | 1C: Idle timeout | High | Medium |
| **P3** | Health monitoring | 4D: Health checks | High | Low |

---

## Recommended Implementation Order

### Phase 1: Stop the Bleeding (P0 fixes)
1. **2A**: Add `cliManager.stop()` to window close handler
2. **4A**: Implement server PID file with startup cleanup

### Phase 2: Prevent Accumulation (P1 fixes)
3. **3A**: Add folder deduplication check
4. **1A**: Improve UI terminology and add process indicators

### Phase 3: Enhanced Cleanup (P2 fixes)
5. **4C**: Persist workspace PIDs for orphan cleanup
6. **1B**: Add "stop on last session delete" preference

### Phase 4: Polish (P3 fixes)
7. **1C**: Idle instance detection
8. **4D**: Runtime health monitoring

---

## Files to Modify

### Phase 1
- `packages/electron-app/electron/main/main.ts` - Window close handler
- `packages/electron-app/electron/main/process-manager.ts` - PID file management

### Phase 2
- `packages/server/src/workspaces/manager.ts` - Folder deduplication
- `packages/ui/src/components/session-list.tsx` - Remove "Close Session"
- `packages/ui/src/components/instance-info.tsx` - Add process indicators

### Phase 3
- `packages/server/src/workspaces/runtime.ts` - Workspace PID persistence
- `packages/server/src/index.ts` - Startup cleanup for workspace PIDs
- `packages/ui/src/stores/preferences.ts` - New preferences

### Phase 4
- `packages/ui/src/stores/instances.ts` - Idle tracking
- `packages/server/src/server/routes/health.ts` - New health endpoint

---

## Testing Considerations

1. **macOS-specific testing** - Window close vs quit behavior
2. **Crash simulation** - Force-kill app, verify orphan cleanup on restart
3. **Duplicate folder scenarios** - Open same folder from different paths
4. **Memory monitoring** - Verify RAM is actually freed after fixes
5. **Tauri parity** - Ensure fixes don't break Tauri (which already handles some cases correctly)

---

## Open Questions

1. Should we align Electron behavior exactly with Tauri (stop on window close)?
2. What's the right timeout for idle instance detection?
3. Should duplicate folder blocking be a preference or always-on?
4. Do we need to handle the case where OpenCode process crashes but server stays alive?
