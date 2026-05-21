# Feature Traces

End-to-end feature flows with decision branches and mechanism references.

## Permission Flow (with branches)

1. **Server:** Backend emits SSE event `permission.asked` or `permission.updated`
   - Events are pushed through the instance event stream

2. **UI Store:** `packages/ui/src/stores/instances.ts` receives via `serverEvents` handler
   - **Branch:** IF `isPermissionAutoAcceptEnabled(instanceId, sessionId)` is true
     - **Mechanism:** `drainAutoAcceptPermissions()` in `packages/ui/src/stores/permission-auto-accept.ts`
     - **Action:** Automatically calls `Permission.reply()`, skips modal display
     - **File:** `packages/ui/src/stores/permission-auto-accept.ts:drainAutoAcceptPermission()`
   - **Branch:** ELSE (normal flow)
     - **Mechanism:** Permission queued in `permissionQueues` signal
     - **Action:** Display approval modal
     - **File:** `packages/ui/src/components/permission-approval-modal.tsx`

3. **UI Store:** `packages/ui/src/stores/message-v2/bridge.ts` calls `upsertPermissionV2()`
    - Adds permission to message store for display in chat

4. **UI Component:** Modal displays (if not auto-accepted)
    - Shows permission details and allow/deny/once buttons

5. **User Action:** Calls `packages/ui/src/stores/instances.ts:sendPermissionResponse()`
    - Validates permission still pending
    - Prepares reply payload

6. **SDK Call:** `client.permission.reply()` via `packages/ui/src/lib/opencode-api.ts`
    - Wrapped with `requestData()` for error handling

7. **Optimistic Update:** `removePermissionV2()` in bridge
    - Immediately removes from local store
    - UI updates without waiting for server

8. **SSE Confirmation:** Server emits `permission.replied` event
    - **Branch:** IF SSE is connected
      - Bridge reconciles (no-op if already removed optimistically)
    - **Branch:** IF SSE is disconnected during reply
      - **Mechanism:** `serverEvents` reconnection triggers `syncPendingPermissions()` in `packages/ui/src/stores/instances.ts`
      - **Action:** Re-fetches pending permissions, reconciles state
      - If permission was already replied, it disappears from queue

---

## Session Lifecycle (with branches)

1. **UI:** `packages/ui/src/stores/session-api.ts:fetchSessions()` calls `client.session.list()`
   - Uses root worktree client (no worktree slug needed for listing)

2. **Server:** Backend returns session array via API response
   - Includes status, title, parentID, version

3. **UI:** Normalizes with `toClientSession()` → stores in `session-state.ts`
   - Maps SDK types to UI types
   - Preserves existing local state (title, model, status)
   - **Branch:** IF session has `parentID` set
     - **Mechanism:** Child session, no additional fetch
   - **Branch:** IF session has no `parentID` and is expanded
     - **Mechanism:** `fetchSessionChildren()` called recursively
     - **File:** `packages/ui/src/stores/session-api.ts`

4. **SSE:** Server pushes updates via instance event stream
   - **Branch:** IF `message.part.delta` event
     - **Mechanism:** Incremental text update streamed to UI
     - **File:** `packages/ui/src/stores/message-v2/bridge.ts:updateMessagePartDelta()`
   - **Branch:** IF `session.status` changed
     - **Mechanism:** Update session indicator, idle timers, status badges
     - **File:** `packages/ui/src/stores/session-status.ts`
   - **Branch:** IF `message.part.updated` (completed)
     - **Mechanism:** Finalize part content, update tool call state

5. **UI:** Bridge reconciles SSE events with local state
   - Handles optimistic update conflicts
   - Merges server truth with local pending operations

---

## Speech Flow (with branches)

1. **UI:** User enables conversation mode
   - **File:** `packages/ui/src/stores/conversation-speech.ts:setConversationModeEnabled()`
   - **Branch:** IF `isConversationModeAvailable()` returns false
     - **Mechanism:** Show error toast
     - **File:** `packages/ui/src/lib/notifications.tsx:showToastNotification()`
     - **Action:** Abort speech setup, keep existing state
   - **Branch:** IF available
     - **Mechanism:** Sync setting to server, initialize speech queue

2. **Server:** `packages/server/src/server/routes/speech.ts` exposes capabilities
   - Returns available TTS/STT providers and models
   - **File:** `packages/server/src/speech/service.ts:getSpeechCapabilities()`

3. **Provider:** `packages/server/src/speech/providers/openai-compatible.ts` synthesizes audio
   - Converts text to audio bytes
   - **Branch:** IF provider returns error
     - **Mechanism:** Return error status to UI
     - **File:** `packages/ui/src/components/speech-action-button.tsx`
     - **Action:** Display error state, allow retry
   - **Branch:** IF successful
     - **Mechanism:** Stream audio data to client

4. **UI:** `packages/ui/src/lib/hooks/use-speech.ts` streams audio playback
   - Creates MediaSource for streaming playback
   - Appends audio chunks to source buffer
   - **Branch:** IF user interrupts (clicks stop or sends new message)
     - **Mechanism:** Stop playback, clear queue
     - **File:** `packages/ui/src/stores/conversation-speech.ts`
     - **Action:** Abort current playback, discard pending chunks
   - **Branch:** IF audio completes naturally
     - **Mechanism:** Mark playback complete, process next queue item

---

## Background Process Flow (with branches)

1. **Plugin:** `packages/opencode-plugin/plugin/lib/background-process.ts` creates agent tools
   - Defines `run_background_process`, `list_background_processes`, `stop_background_process`
   - Validates commands stay within workspace base directory

2. **Server:** `packages/server/src/background-processes/manager.ts` spawns process
   - Uses `spawn` with shell command
   - Captures stdout/stderr to log files
   - **Branch:** IF spawn fails (command not found, permission denied)
     - **Mechanism:** Emit error event, update process status to "error"
     - **File:** `packages/server/src/background-processes/manager.ts`
     - **Action:** Notify client of failure, keep process record with error state
   - **Branch:** IF spawn succeeds
     - **Mechanism:** Track PID, stream output, update index

3. **UI:** `packages/ui/src/stores/background-processes.ts` polls/listens
   - Fetches process list periodically
   - Subscribes to SSE events for process updates
   - **Branch:** IF process completes AND `notify=true` was set
     - **Mechanism:** Show completion notification
     - **File:** `packages/ui/src/lib/notifications.tsx`
     - **Action:** Toast notification with process title and exit code
   - **Branch:** IF process errors
     - **Mechanism:** Update UI with error status, allow viewing logs

4. **UI:** `packages/ui/src/components/background-process-output-dialog.tsx` displays stream
   - Opens dialog showing real-time output
   - Uses ANSI renderer for colored terminal output
   - **Branch:** IF user clicks "Stop"
     - **Mechanism:** Call `stop_background_process` tool
     - **Action:** Send SIGTERM, then SIGKILL if needed

---

## Git Clone Flow (with branches)

1. **UI:** User initiates clone from UI or command
   - **File:** `packages/ui/src/components/folder-selection-view.tsx` or command palette

2. **Server:** `packages/server/src/server/routes/workspaces.ts` receives request
   - Validates `repositoryUrl` and `destinationPath`
   - **File:** `packages/server/src/workspaces/git-clone.ts:cloneGitRepository()`

3. **Validation:** `packages/server/src/workspaces/git-clone.ts`
   - **Branch:** IF destination is filesystem root or home folder
     - **Mechanism:** Throw `GitCloneError` with 400 status
     - **Action:** Return error to client
   - **Branch:** IF destination exists and not empty (and cleanup=false)
     - **Mechanism:** Throw `GitCloneError` with 409 status
     - **Action:** Return error, suggest cleanup or different path
   - **Branch:** IF validation passes
     - **Mechanism:** Proceed to clone

4. **Clone Execution:**
   - **Branch:** IF destination exists and cleanup=true
     - **Mechanism:** `replaceDestinationAfterSuccessfulClone()`
     - **Action:** Clone to temp path, swap directories, delete old
     - **File:** `packages/server/src/workspaces/git-clone.ts`
   - **Branch:** IF destination doesn't exist or is empty
     - **Mechanism:** `runGitClone()` direct to destination
     - **Action:** Standard `git clone` execution

5. **Result:** Return `{ path: destinationPath }` on success
   - Workspace manager picks up new folder
   - UI navigates to new workspace
