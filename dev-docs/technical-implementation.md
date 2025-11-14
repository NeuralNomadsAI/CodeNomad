# Technical Implementation Details

## Technology Stack

### Core Technologies

- **Electron** v28+ - Desktop application wrapper
- **SolidJS** v1.8+ - Reactive UI framework
- **TypeScript** v5.3+ - Type-safe development
- **Vite** v5+ - Fast build tool and dev server

### UI & Styling

- **TailwindCSS** v4+ - Utility-first styling
- **Kobalte** - Accessible UI primitives for SolidJS
- **Shiki** - Syntax highlighting for code blocks
- **Marked** - Markdown parsing
- **Lucide** - Icon library

### Communication

- **OpenCode SDK** (@opencode-ai/sdk) - API client
- **EventSource API** - Server-sent events
- **Node Child Process** - Process management

### Development Tools

- **electron-vite** - Electron + Vite integration
- **electron-builder** - Application packaging
- **ESLint** - Code linting
- **Prettier** - Code formatting

## Project Structure

```
packages/opencode-client/
├── electron/
│   ├── main/
│   │   ├── main.ts                 # Electron main entry
│   │   ├── window.ts               # Window management
│   │   ├── process-manager.ts      # OpenCode server spawning
│   │   ├── ipc.ts                  # IPC handlers
│   │   └── menu.ts                 # Application menu
│   ├── preload/
│   │   └── index.ts                # Preload script (IPC bridge)
│   └── resources/
│       └── icon.png                # Application icon
├── src/
│   ├── components/
│   │   ├── instance-tabs.tsx       # Level 1 tabs
│   │   ├── session-tabs.tsx        # Level 2 tabs
│   │   ├── message-stream.tsx      # Messages display
│   │   ├── message-item.tsx        # Single message
│   │   ├── tool-call.tsx           # Tool execution display
│   │   ├── prompt-input.tsx        # Input with attachments
│   │   ├── agent-selector.tsx      # Agent dropdown
│   │   ├── model-selector.tsx      # Model dropdown
│   │   ├── session-picker.tsx      # Startup modal
│   │   ├── logs-view.tsx           # Server logs
│   │   └── empty-state.tsx         # No instances view
│   ├── stores/
│   │   ├── instances.ts            # Instance state
│   │   ├── sessions.ts             # Session state per instance
│   │   └── ui.ts                   # UI state (active tabs, etc)
│   ├── lib/
│   │   ├── sdk-manager.ts          # SDK client management
│   │   ├── sse-manager.ts          # SSE connection handling
│   │   ├── port-finder.ts          # Find available ports
│   │   └── markdown.ts             # Markdown rendering utils
│   ├── hooks/
│   │   ├── use-instance.ts         # Instance operations
│   │   ├── use-session.ts          # Session operations
│   │   └── use-messages.ts         # Message operations
│   ├── types/
│   │   ├── instance.ts             # Instance types
│   │   ├── session.ts              # Session types
│   │   └── message.ts              # Message types
│   ├── App.tsx                     # Root component
│   ├── main.tsx                    # Renderer entry
│   └── index.css                   # Global styles
├── docs/                           # Documentation
├── tasks/                          # Task tracking
├── package.json
├── tsconfig.json
├── electron.vite.config.ts
├── tailwind.config.js
└── README.md
```

## State Management

### Instance Store

```typescript
interface InstanceState {
  instances: Map<string, Instance>
  activeInstanceId: string | null

  // Actions
  createInstance(folder: string): Promise<void>
  removeInstance(id: string): Promise<void>
  setActiveInstance(id: string): void
}

interface Instance {
  id: string // UUID
  folder: string // Absolute path
  port: number // Server port
  pid: number // Process ID
  status: InstanceStatus
  client: OpenCodeClient // SDK client
  eventSource: EventSource | null // SSE connection
  sessions: Map<string, Session>
  activeSessionId: string | null
  logs: LogEntry[]
}

type InstanceStatus =
  | "starting" // Server spawning
  | "ready" // Server connected
  | "error" // Failed to start
  | "stopped" // Server killed

interface LogEntry {
  timestamp: number
  level: "info" | "error" | "warn"
  message: string
}
```

### Session Store

```typescript
interface SessionState {
  // Per instance
  getSessions(instanceId: string): Session[]
  getActiveSession(instanceId: string): Session | null

  // Actions
  createSession(instanceId: string, agent: string): Promise<Session>
  deleteSession(instanceId: string, sessionId: string): Promise<void>
  setActiveSession(instanceId: string, sessionId: string): void
  updateSession(instanceId: string, sessionId: string, updates: Partial<Session>): void
}

interface Session {
  id: string
  instanceId: string
  title: string
  parentId: string | null
  agent: string
  model: {
    providerId: string
    modelId: string
  }
  messages: Message[]
  status: SessionStatus
  createdAt: number
  updatedAt: number
}

type SessionStatus =
  | "idle" // No activity
  | "streaming" // Assistant responding
  | "error" // Error occurred
```

### UI Store

```typescript
interface UIState {
  // Tab state
  instanceTabOrder: string[]
  sessionTabOrder: Map<string, string[]> // instanceId -> sessionIds

  // Modal state
  showSessionPicker: string | null // instanceId or null
  showSettings: boolean

  // Actions
  reorderInstanceTabs(newOrder: string[]): void
  reorderSessionTabs(instanceId: string, newOrder: string[]): void
  openSessionPicker(instanceId: string): void
  closeSessionPicker(): void
}
```

## Process Management

### Server Spawning

**Strategy:** Spawn with port 0 (random), parse stdout for actual port

```typescript
interface ProcessManager {
  spawn(folder: string): Promise<ProcessInfo>
  kill(pid: number): Promise<void>
  restart(pid: number, folder: string): Promise<ProcessInfo>
}

interface ProcessInfo {
  pid: number
  port: number
  stdout: Readable
  stderr: Readable
}

// Implementation approach:
// 1. Check if opencode binary exists
// 2. Spawn: spawn('opencode', ['serve', '--port', '0'], { cwd: folder })
// 3. Listen to stdout
// 4. Parse line matching: "Server listening on port 4096"
// 5. Resolve promise with port
// 6. Timeout after 10 seconds
```

### Port Parsing

```typescript
// Expected output from opencode serve:
// > Starting OpenCode server...
// > Server listening on port 4096
// > API available at http://localhost:4096

function parsePort(output: string): number | null {
  const match = output.match(/port (\d+)/)
  return match ? parseInt(match[1], 10) : null
}
```

### Error Handling

**Server fails to start:**

- Parse stderr for error message
- Display in instance tab with retry button
- Common errors: Port in use, permission denied, binary not found

**Server crashes after start:**

- Detect via process 'exit' event
- Attempt auto-restart once
- If restart fails, show error state
- Preserve session data for manual restart

## Communication Layer

### SDK Client Management

```typescript
interface SDKManager {
  createClient(port: number): OpenCodeClient
  destroyClient(port: number): void
  getClient(port: number): OpenCodeClient | null
}

// One client per instance
// Client lifecycle tied to instance lifecycle
```

### SSE Event Handling

```typescript
interface SSEManager {
  connect(instanceId: string, port: number): void
  disconnect(instanceId: string): void

  // Event routing
  onMessageUpdate(handler: (instanceId: string, event: MessageUpdateEvent) => void): void
  onSessionUpdate(handler: (instanceId: string, event: SessionUpdateEvent) => void): void
  onError(handler: (instanceId: string, error: Error) => void): void
}

// Event flow:
// 1. EventSource connects to /event endpoint
// 2. Events arrive as JSON
// 3. Route to correct instance store
// 4. Update reactive state
// 5. UI auto-updates via signals
```

### Reconnection Logic

```typescript
// SSE disconnects:
// - Network issue
// - Server restart
// - Tab sleep (browser optimization)

class SSEConnection {
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000 // Start with 1s

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emitError(new Error("Max reconnection attempts reached"))
      return
    }

    setTimeout(() => {
      this.connect()
      this.reconnectAttempts++
      this.reconnectDelay *= 2 // Exponential backoff
    }, this.reconnectDelay)
  }
}
```

## Message Rendering

### Markdown Processing

```typescript
// Use Marked + Shiki for syntax highlighting
import { marked } from "marked"
import { markedHighlight } from "marked-highlight"
import { getHighlighter } from "shiki"

const highlighter = await getHighlighter({
  themes: ["github-dark", "github-light"],
  langs: ["typescript", "javascript", "python", "bash", "json"],
})

marked.use(
  markedHighlight({
    highlight(code, lang) {
      return highlighter.codeToHtml(code, {
        lang,
        theme: isDark ? "github-dark" : "github-light",
      })
    },
  }),
)
```

### Tool Call Rendering

```typescript
interface ToolCallComponent {
  tool: string // "bash", "edit", "read"
  input: any // Tool-specific input
  output?: any // Tool-specific output
  status: "pending" | "running" | "success" | "error"
  expanded: boolean // Collapse state
}

// Render logic:
// - Default: Collapsed, show summary
// - Click: Toggle expanded state
// - Running: Show spinner
// - Complete: Show checkmark
// - Error: Show error icon + message
```

### Streaming Updates

```typescript
// Messages stream in via SSE
// Update strategy: Replace existing message parts

function handleMessagePartUpdate(event: MessagePartEvent) {
  const session = getSession(event.sessionId)
  const message = session.messages.find((m) => m.id === event.messageId)

  if (!message) {
    // New message
    session.messages.push(createMessage(event))
  } else {
    // Update existing
    const partIndex = message.parts.findIndex((p) => p.id === event.partId)
    if (partIndex === -1) {
      message.parts.push(event.part)
    } else {
      message.parts[partIndex] = event.part
    }
  }

  // SolidJS reactivity triggers re-render
}
```

## Performance Considerations

**MVP Approach: Don't optimize prematurely**

### Message Rendering (MVP)

**Simple approach - no optimization:**

```typescript
// Render all messages - no virtual scrolling, no limits
<For each={messages()}>
  {(message) => <MessageItem message={message} />}
</For>

// SolidJS will handle reactivity efficiently
// Only optimize if users report issues
```

### State Update Batching

**Not needed for MVP:**

- SolidJS reactivity is efficient enough
- SSE updates will just trigger normal re-renders
- Add batching only if performance issues arise

### Memory Management

**Not needed for MVP:**

- No message limits
- No pruning
- No lazy loading
- Let users create as many messages as they want
- Optimize later if problems occur

**When to add optimizations (post-MVP):**

- Users report slowness with large sessions
- Measurable performance degradation
- Memory usage becomes problematic
- See Phase 8 tasks for virtual scrolling and optimization

## IPC Communication

### Main Process → Renderer

```typescript
// Events sent from main to renderer
type MainToRenderer = {
  "instance:started": { id: string; port: number; pid: number }
  "instance:error": { id: string; error: string }
  "instance:stopped": { id: string }
  "instance:log": { id: string; entry: LogEntry }
}
```

### Renderer → Main Process

```typescript
// Commands sent from renderer to main
type RendererToMain = {
  "folder:select": () => Promise<string | null>
  "instance:create": (folder: string) => Promise<{ port: number; pid: number }>
  "instance:stop": (pid: number) => Promise<void>
  "app:quit": () => void
}
```

### Preload Script (Bridge)

```typescript
// Expose safe IPC methods to renderer
contextBridge.exposeInMainWorld("electronAPI", {
  selectFolder: () => ipcRenderer.invoke("folder:select"),
  createInstance: (folder: string) => ipcRenderer.invoke("instance:create", folder),
  stopInstance: (pid: number) => ipcRenderer.invoke("instance:stop", pid),
  onInstanceStarted: (callback) => ipcRenderer.on("instance:started", callback),
  onInstanceError: (callback) => ipcRenderer.on("instance:error", callback),
})
```

## Error Handling Strategy

### Network Errors

```typescript
// HTTP request fails
try {
  const response = await client.session.list()
} catch (error) {
  if (error.code === "ECONNREFUSED") {
    // Server not responding
    showError("Cannot connect to server. Is it running?")
  } else if (error.code === "ETIMEDOUT") {
    // Request timeout
    showError("Request timed out. Retry?", { retry: true })
  } else {
    // Unknown error
    showError(error.message)
  }
}
```

### SSE Errors

```typescript
eventSource.onerror = (error) => {
  // Connection lost
  if (eventSource.readyState === EventSource.CLOSED) {
    // Attempt reconnect
    reconnectSSE()
  }
}
```

### User Input Errors

```typescript
// Validate before sending
function validatePrompt(text: string): string | null {
  if (!text.trim()) {
    return "Message cannot be empty"
  }
  if (text.length > 10000) {
    return "Message too long (max 10000 characters)"
  }
  return null
}
```

## Security Measures

### IPC Security

- Use `contextIsolation: true`
- Whitelist allowed IPC channels
- Validate all data from renderer
- No `nodeIntegration` in renderer

### Process Security

- Spawn OpenCode with user permissions only
- No shell execution of user input
- Sanitize file paths

### Content Security

- Sanitize markdown before rendering
- Use DOMPurify for HTML sanitization
- No `dangerouslySetInnerHTML` without sanitization
- CSP headers in renderer

## Testing Strategy (Future)

### Unit Tests

- State management logic
- Utility functions
- Message parsing

### Integration Tests

- Process spawning
- SDK client operations
- SSE event handling

### E2E Tests

- Complete user flows
- Multi-instance scenarios
- Error recovery

## Build & Packaging

### Development

```bash
npm run dev          # Start Electron + Vite dev server
npm run dev:main     # Main process only
npm run dev:renderer # Renderer only
```

### Production

```bash
npm run build        # Build all
npm run build:main   # Build main process
npm run build:renderer # Build renderer
npm run package      # Create distributable
```

### Distribution

- macOS: DMG + auto-update
- Windows: NSIS installer + auto-update
- Linux: AppImage + deb/rpm

## Configuration Files

### electron.vite.config.ts

```typescript
import { defineConfig } from "electron-vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
  renderer: {
    plugins: [solid()],
    resolve: {
      alias: {
        "@": "/src",
      },
    },
  },
})
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM"],
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```
