# Task 013: Logs Tab

**Status:** Todo  
**Estimated Time:** 2-3 hours  
**Phase:** 3 - Essential Features  
**Dependencies:** 006 (Instance & Session Tabs)

## Overview

Implement a dedicated "Logs" tab for each instance that displays real-time server logs (stdout/stderr). This provides visibility into what the OpenCode server is doing and helps with debugging.

## Context

Currently, server logs are captured but not displayed anywhere. Users need to see:

- Server startup messages
- Port information
- Error messages
- Debug output
- Any other stdout/stderr from the OpenCode server

The Logs tab should be a special tab that appears alongside session tabs and cannot be closed.

## Requirements

### Functional Requirements

1. **Logs Tab Appearance**
   - Appears in session tabs area (Level 2 tabs)
   - Label: "Logs"
   - Icon: Terminal icon (⚡ or similar)
   - Non-closable (no × button)
   - Always present for each instance
   - Typically positioned at the end of session tabs

2. **Log Display**
   - Shows all stdout/stderr from server process
   - Real-time updates as logs come in
   - Scrollable content
   - Auto-scroll to bottom when new logs arrive
   - Manual scroll up disables auto-scroll
   - Monospace font for log content
   - Timestamps for each log entry

3. **Log Entry Format**
   - Timestamp (HH:MM:SS)
   - Log level indicator (if available)
   - Message content
   - Color coding by level:
     - Info: Default color
     - Error: Red
     - Warning: Yellow
     - Debug: Gray/muted

4. **Log Controls**
   - Clear logs button
   - Scroll to bottom button (when scrolled up)
   - Optional: Filter by log level (post-MVP)
   - Optional: Search in logs (post-MVP)

### Technical Requirements

1. **State Management**
   - Store logs in instance state
   - Structure: `{ timestamp: number, level: string, message: string }[]`
   - Limit log entries to prevent memory issues (e.g., max 1000 entries)
   - Old entries removed when limit reached (FIFO)

2. **IPC Communication**
   - Main process captures process stdout/stderr
   - Send logs to renderer via IPC events
   - Event type: `instance:log`
   - Payload: `{ instanceId: string, entry: LogEntry }`

3. **Rendering**
   - Virtualize log list only if performance issues (not for MVP)
   - Simple list rendering is fine for MVP
   - Each log entry is a separate div
   - Apply styling based on log level

4. **Performance**
   - Don't render logs when tab is not active
   - Lazy render log entries (only visible ones if using virtual scrolling - not needed for MVP)

## Implementation Steps

### Step 1: Update Instance State

Update `src/stores/instances.ts` to include logs:

```typescript
interface LogEntry {
  timestamp: number
  level: "info" | "error" | "warn" | "debug"
  message: string
}

interface Instance {
  id: string
  folder: string
  port: number
  pid: number
  status: InstanceStatus
  client: OpenCodeClient
  eventSource: EventSource | null
  sessions: Map<string, Session>
  activeSessionId: string | null
  logs: LogEntry[] // Add this
}

// Add log management functions
function addLog(instanceId: string, entry: LogEntry) {
  const instance = instances.get(instanceId)
  if (!instance) return

  instance.logs.push(entry)

  // Limit to 1000 entries
  if (instance.logs.length > 1000) {
    instance.logs.shift()
  }
}

function clearLogs(instanceId: string) {
  const instance = instances.get(instanceId)
  if (!instance) return
  instance.logs = []
}
```

### Step 2: Update Main Process Log Capture

Update `electron/main/process-manager.ts` to send logs via IPC:

```typescript
import { BrowserWindow } from "electron"

function spawn(folder: string, mainWindow: BrowserWindow): Promise<ProcessInfo> {
  const proc = spawn("opencode", ["serve", "--port", "0"], {
    cwd: folder,
    stdio: ["ignore", "pipe", "pipe"],
  })

  const instanceId = generateId()

  // Capture stdout
  proc.stdout?.on("data", (data) => {
    const message = data.toString()

    // Send to renderer
    mainWindow.webContents.send("instance:log", {
      instanceId,
      entry: {
        timestamp: Date.now(),
        level: "info",
        message: message.trim(),
      },
    })

    // Parse port if present
    const port = parsePort(message)
    if (port) {
      // ... existing port handling
    }
  })

  // Capture stderr
  proc.stderr?.on("data", (data) => {
    const message = data.toString()

    mainWindow.webContents.send("instance:log", {
      instanceId,
      entry: {
        timestamp: Date.now(),
        level: "error",
        message: message.trim(),
      },
    })
  })

  // ... rest of spawn logic
}
```

### Step 3: Update Preload Script

Add IPC handler in `electron/preload/index.ts`:

```typescript
contextBridge.exposeInMainWorld("electronAPI", {
  // ... existing methods

  onInstanceLog: (callback: (data: { instanceId: string; entry: LogEntry }) => void) => {
    ipcRenderer.on("instance:log", (_, data) => callback(data))
  },
})
```

### Step 4: Create Logs Component

Create `src/components/logs-view.tsx`:

```typescript
import { For, createSignal, createEffect, onMount } from 'solid-js'
import { useInstances } from '../stores/instances'

interface LogsViewProps {
  instanceId: string
}

export function LogsView(props: LogsViewProps) {
  let scrollRef: HTMLDivElement | undefined
  const [autoScroll, setAutoScroll] = createSignal(true)
  const instances = useInstances()

  const instance = () => instances().get(props.instanceId)
  const logs = () => instance()?.logs ?? []

  // Auto-scroll to bottom when new logs arrive
  createEffect(() => {
    if (autoScroll() && scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight
    }
  })

  // Handle manual scroll
  const handleScroll = () => {
    if (!scrollRef) return

    const isAtBottom =
      scrollRef.scrollHeight - scrollRef.scrollTop <= scrollRef.clientHeight + 50

    setAutoScroll(isAtBottom)
  }

  const scrollToBottom = () => {
    if (scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight
      setAutoScroll(true)
    }
  }

  const clearLogs = () => {
    // Call store method to clear logs
    instances.clearLogs(props.instanceId)
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-600 dark:text-red-400'
      case 'warn': return 'text-yellow-600 dark:text-yellow-400'
      case 'debug': return 'text-gray-500 dark:text-gray-500'
      default: return 'text-gray-900 dark:text-gray-100'
    }
  }

  return (
    <div class="flex flex-col h-full">
      {/* Header with controls */}
      <div class="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
          Server Logs
        </h3>
        <div class="flex gap-2">
          <button
            onClick={clearLogs}
            class="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Logs container */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        class="flex-1 overflow-y-auto p-4 bg-gray-50 dark:bg-gray-900 font-mono text-xs"
      >
        {logs().length === 0 ? (
          <div class="text-gray-500 dark:text-gray-500 text-center py-8">
            Waiting for server output...
          </div>
        ) : (
          <For each={logs()}>
            {(entry) => (
              <div class="flex gap-2 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800">
                <span class="text-gray-500 dark:text-gray-500 select-none">
                  {formatTime(entry.timestamp)}
                </span>
                <span class={getLevelColor(entry.level)}>
                  {entry.message}
                </span>
              </div>
            )}
          </For>
        )}
      </div>

      {/* Scroll to bottom button */}
      {!autoScroll() && (
        <button
          onClick={scrollToBottom}
          class="absolute bottom-4 right-4 px-3 py-2 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700"
        >
          ↓ Scroll to bottom
        </button>
      )}
    </div>
  )
}
```

### Step 5: Update Session Tabs Component

Update `src/components/session-tabs.tsx` to include Logs tab:

```typescript
import { LogsView } from './logs-view'

export function SessionTabs(props: { instanceId: string }) {
  const sessions = () => getSessionsForInstance(props.instanceId)
  const activeSession = () => getActiveSession(props.instanceId)
  const [activeTab, setActiveTab] = createSignal<string | 'logs'>(/* ... */)

  return (
    <div class="flex flex-col h-full">
      {/* Tab headers */}
      <div class="flex items-center border-b border-gray-200 dark:border-gray-700">
        {/* Session tabs */}
        <For each={sessions()}>
          {(session) => (
            <button
              onClick={() => setActiveTab(session.id)}
              class={/* ... */}
            >
              {session.title || 'Untitled'}
            </button>
          )}
        </For>

        {/* Logs tab */}
        <button
          onClick={() => setActiveTab('logs')}
          class={`px-4 py-2 text-sm ${
            activeTab() === 'logs'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-gray-600 dark:text-gray-400'
          }`}
        >
          ⚡ Logs
        </button>

        {/* New session button */}
        <button class="px-3 py-2 text-gray-500 hover:text-gray-700">
          +
        </button>
      </div>

      {/* Tab content */}
      <div class="flex-1 overflow-hidden">
        {activeTab() === 'logs' ? (
          <LogsView instanceId={props.instanceId} />
        ) : (
          <SessionView sessionId={activeTab()} />
        )}
      </div>
    </div>
  )
}
```

### Step 6: Setup IPC Listener

In `src/App.tsx` or wherever instances are initialized:

```typescript
import { onMount } from "solid-js"

onMount(() => {
  // Listen for log events from main process
  window.electronAPI.onInstanceLog((data) => {
    const { instanceId, entry } = data
    instances.addLog(instanceId, entry)
  })
})
```

### Step 7: Add Initial Server Logs

When instance starts, add a startup log:

```typescript
function createInstance(folder: string) {
  const instanceId = generateId()

  // Add initial log
  instances.addLog(instanceId, {
    timestamp: Date.now(),
    level: "info",
    message: `Starting OpenCode server for ${folder}...`,
  })

  // ... spawn server
}
```

### Step 8: Test Logs Display

1. Start an instance
2. Switch to Logs tab
3. Verify startup messages appear
4. Verify real-time updates
5. Test auto-scroll behavior
6. Test clear button
7. Test manual scroll disables auto-scroll
8. Test scroll to bottom button

## Acceptance Criteria

- [ ] Logs tab appears for each instance
- [ ] Logs tab has terminal icon
- [ ] Logs tab cannot be closed
- [ ] Server stdout displays in real-time
- [ ] Server stderr displays in real-time
- [ ] Logs have timestamps
- [ ] Error logs are red
- [ ] Warning logs are yellow
- [ ] Auto-scroll works when at bottom
- [ ] Manual scroll disables auto-scroll
- [ ] Scroll to bottom button appears when scrolled up
- [ ] Clear button removes all logs
- [ ] Logs are limited to 1000 entries
- [ ] Monospace font used for log content
- [ ] Empty state shows when no logs

## Testing Checklist

- [ ] Test with normal server startup
- [ ] Test with server errors (e.g., port in use)
- [ ] Test with rapid log output (stress test)
- [ ] Test switching between session and logs tab
- [ ] Test clearing logs
- [ ] Test auto-scroll with new logs
- [ ] Test manual scroll behavior
- [ ] Test logs persist when switching instances
- [ ] Test logs cleared when instance closes
- [ ] Test very long log messages (wrapping)

## Notes

- For MVP, don't implement log filtering or search
- Keep log entry limit reasonable (1000 entries)
- Don't virtualize unless performance issues
- Consider adding log levels based on OpenCode server output format
- May need to parse ANSI color codes if server uses them

## Future Enhancements (Post-MVP)

- Filter logs by level (info, error, warn, debug)
- Search within logs
- Export logs to file
- Copy log entry on click
- Follow mode toggle (auto-scroll on/off)
- Parse and highlight errors/stack traces
- ANSI color code support
- Log level indicators with icons
- Timestamps toggle
- Word wrap toggle
