# CodeNomad Workspace Debug Guide

This document explains the workspace deduplication feature added to CodeNomad to fix the "same session appears in multiple projects" bug, plus the debug overlay and monitoring tools built around it.

## The Bug

CodeNomad creates a **workspace** per project folder. Each workspace spawns its own OpenCode process pointing at the shared SQLite database at `~/.local/share/opencode/opencode.db`.

The bug: the frontend would call `createInstance(folder)` on every UI refresh without checking whether a workspace already existed for that folder. The backend would happily create a new workspace every time — same folder, new ID, new OpenCode process. With 74+ duplicate workspaces for `/home/dark/Project/test` and 29+ for `/home/dark/Project/idm` at the time of the fix, the same session appeared in every workspace that targeted its folder, and deleting it from one removed it from the shared DB and all the others.

## The Fix

Two commits on the `dev` branch:

### Backend — `packages/server/src/workspaces/manager.ts`

`WorkspaceManager.create()` now checks for an existing workspace with the same resolved path before generating a new ID. If found, it returns the existing workspace descriptor instead of creating a duplicate.

Key behavior:
- Returns the existing workspace descriptor when path matches (frontend gets the same `workspaceId`)
- Logs a warning with full context (`workspaceId`, `folder`, `totalWorkspaces`, `pathOccurrences`) so duplicate attempts are visible in PM2 logs
- Logs an `ERROR` if `pathOccurrences > 0` but the dedup loop missed them — a tripwire for normalization bugs

### Frontend — `packages/ui/src/stores/instances.ts`

`createInstance(folder)` now fetches the current workspace list from the backend first and reuses any existing workspace whose resolved path matches the folder. Only calls `POST /api/workspaces` when no match is found.

This is the critical half of the fix: after a CodeNomad restart, the backend's in-memory workspace map starts empty. Without this frontend check, the UI would spawn a fresh workspace for each open project tab on rehydrate — defeating the backend dedup entirely.

## Endpoints

### `GET /api/workspaces`
Returns the full list of active workspaces.

### `GET /api/workspaces/stats` (new)
Returns workspace counts grouped by path. Useful for spotting path duplication at a glance:

```json
{
  "total": 5,
  "byPath": {
    "/home/dark/Project/test": 1,
    "/home/dark/Project/idm": 1,
    "/home/dark/Project/codenomad": 1,
    "/home/dark/Project/clientssh": 1,
    "/home/dark/Project/memory-system": 1
  }
}
```

If any value in `byPath` is greater than 1, the bug is back.

## Debug Overlay (in-browser)

A keyboard-toggleable overlay that shows the live state of CodeNomad's session/instances stores from the renderer.

**Toggle:** `Ctrl+Shift+D` globally from any view.

**What it shows:**
- All active instances (workspace IDs + folders)
- Sessions stored under each instance map (id, title, directory, parent)
- The currently active instance ID
- Per-session and per-instance copy-to-clipboard buttons
- A "Share" button that copies the full state as JSON for issue reports
- Minimize/Close controls
- A keyboard shortcut reminder input

**Files:**
- `packages/ui/src/components/debug-session-overlay.tsx` — the overlay component
- `packages/ui/src/App.tsx` — mounts the overlay at the app root

**Visual reference for confirming the bug visually:**
Open the overlay while in `/test` and `/idm`. If you see the same session ID listed under two different instance rows, the dedup is failing. After the fix, each session ID only appears under one instance row.

## Real-Time Monitor Script

`scripts/monitor-workspaces.sh` tails the PM2 out log and color-codes workspace activity as it happens.

```bash
./scripts/monitor-workspaces.sh
```

Output colors:
- **Cyan** — `Workspace create requested` (someone called `createInstance`)
- **Yellow** — `Reusing existing workspace` (dedup hit — good)
- **Green** — `Creating new workspace` (new workspace spawned)
- **Red** — `dedup_missed` (BUG: occurrences existed but loop missed them)

A healthy run shows mostly cyan requests with yellow dedup hits and no reds. Greens should be rare — only when first opening a project.

## Log Format

All workspace events are emitted by the backend's pino logger at the `info` level (or `error` for `dedup_missed`). Each line includes an `action` discriminator field:

```
[INFO] [workspace] action="create_request" folder="/home/dark/Project/test" totalWorkspaces=3 pathOccurrences=1
[INFO] [workspace] action="reused" workspaceId="mr0x443w" folder="/home/dark/Project/test" totalWorkspaces=3 pathOccurrences=1
[INFO] [workspace] action="created" workspaceId="mr0y7z9a" folder="/home/dark/Project/memory-system" totalWorkspaces=4
```

## How to Verify the Fix

1. **Check no duplicates after a reload** — In the overlay, each session should appear under exactly one instance.
2. **Check workspace stats** — `curl -k https://localhost:9898/api/workspaces/stats -u codenomad:<password>` should show `byPath` values all equal to 1.
3. **Run the monitor script** — Open a project you haven't touched in a while. You should see a yellow "reused" line, not a green "created" line.
4. **Delete test for regression** — Create a session in `/test`, switch to `/idm`, confirm it does NOT appear there, delete it, confirm it does NOT delete from `/idm`.

## Files Touched

| File | Change |
|---|---|
| `packages/server/src/workspaces/manager.ts` | Dedup loop, structured logging, `getStats()` |
| `packages/server/src/server/routes/workspaces.ts` | New `/api/workspaces/stats` endpoint |
| `packages/ui/src/stores/instances.ts` | `createInstance` checks existing workspaces first |
| `packages/ui/src/components/debug-session-overlay.tsx` | New overlay component |
| `packages/ui/src/App.tsx` | Mounts the debug overlay |
| `scripts/monitor-workspaces.sh` | Real-time log monitor |

## Future Improvements

- **Persist workspace-to-folder mappings** — survives restarts without the frontend re-query dance
- **Auto-cleanup of stopped workspaces** — currently they linger in the in-memory map
- **Prometheus-style metrics** — `pathOccurrences` histogram for dedup hit rate over time