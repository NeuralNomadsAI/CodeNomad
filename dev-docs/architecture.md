# Era Code Architecture

## Overview

Era Code is a cross-platform desktop application built with Electron that provides a multi-instance, multi-session interface for interacting with OpenCode servers. Each instance manages its own OpenCode server process and can handle multiple concurrent sessions.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                │
│  - Window management                                    │
│  - Process spawning (opencode serve)                    │
│  - IPC bridge to renderer                               │
│  - File system operations                               │
└────────────────┬────────────────────────────────────────┘
                 │ IPC
┌────────────────┴────────────────────────────────────────┐
│                  Electron Renderer Process              │
│  ┌──────────────────────────────────────────────────┐  │
│  │              SolidJS Application                 │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │  Instance Manager                          │  │  │
│  │  │  - Spawns/kills OpenCode servers           │  │  │
│  │  │  - Manages SDK clients per instance        │  │  │
│  │  │  - Handles port allocation                 │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │  State Management (SolidJS Stores)         │  │  │
│  │  │  - instances[]                             │  │  │
│  │  │  - sessions[] per instance                 │  │  │
│  │  │  - normalized message store per session    │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │  UI Components                             │  │  │
│  │  │  - InstanceTabs                            │  │  │
│  │  │  - SessionTabs                             │  │  │
│  │  │  - MessageSection                        │  │  │
│  │  │  - PromptInput                             │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                 │ HTTP/SSE
┌────────────────┴────────────────────────────────────────┐
│           Multiple OpenCode Server Processes            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Instance 1   │  │ Instance 2   │  │ Instance 3   │  │
│  │ Port: 4096   │  │ Port: 4097   │  │ Port: 4098   │  │
│  │ ~/project-a  │  │ ~/project-a  │  │ ~/api        │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Component Layers

### 1. Main Process Layer (Electron)

**Responsibilities:**

- Create and manage application window
- Spawn OpenCode server processes as child processes
- Parse server stdout to extract port information
- Handle process lifecycle (start, stop, restart)
- Provide IPC handlers for renderer requests
- Manage native OS integrations (file dialogs, menus)

**Key Modules:**

- `main.ts` - Application entry point
- `process-manager.ts` - OpenCode server process spawning
- `ipc-handlers.ts` - IPC communication handlers
- `menu.ts` - Native application menu

### 2. Renderer Process Layer (SolidJS)

**Responsibilities:**

- Render UI components
- Manage application state
- Handle user interactions
- Communicate with OpenCode servers via HTTP/SSE
- Real-time message streaming

**Key Modules:**

- `App.tsx` - Root component
- `stores/` - State management
- `components/` - UI components
- `contexts/` - SolidJS context providers
- `lib/` - Utilities and helpers

### 3. Communication Layer

**HTTP API Communication:**

- SDK client per instance
- RESTful API calls for session/config/file operations
- Error handling and retries

**SSE (Server-Sent Events):**

- One EventSource per instance
- Real-time message updates
- Event type routing
- Reconnection logic

**CLI Proxy Paths:**

- The CLI server terminates all HTTP/SSE traffic and forwards it to the correct OpenCode instance.
- Each `WorkspaceDescriptor` exposes `proxyPath` (e.g., `/workspaces/<id>/instance`), which acts as the base URL for both REST and SSE calls.
- The renderer never touches the random per-instance port directly; it only talks to `window.location.origin + proxyPath` so a single CLI port can front every session.

## Data Flow

### Instance Creation Flow

1. User selects folder via Electron file dialog
2. Main process receives folder path via IPC
3. Main process spawns `opencode serve --port 0`
4. Main process parses stdout for port number
5. Main process sends port + PID back to renderer
6. Renderer creates SDK client for that port
7. Renderer fetches initial session list
8. Renderer displays session picker

### Message Streaming Flow

1. User submits prompt in active session
2. Renderer POSTs to `/session/:id/message`
3. SSE connection receives `MessageUpdated` events
4. Events are routed to correct instance → session
5. Message state updates trigger UI re-render
6. Messages display with auto-scroll

### Child Session Creation Flow

1. OpenCode server creates child session
2. SSE emits `SessionUpdated` event with `parentId`
3. Renderer adds session to instance's session list
4. New session tab appears automatically
5. Optional: Auto-switch to new tab

## State Management

### Instance State

```
instances: Map<instanceId, {
  id: string
  folder: string
  port: number
  pid: number
  proxyPath: string // `/workspaces/:id/instance`
  status: 'starting' | 'ready' | 'error' | 'stopped'
  client: OpenCodeClient
  eventSource: EventSource
  sessions: Map<sessionId, Session>
  activeSessionId: string | null
  logs: string[]
}>
```

### Session State

```
Session: {
  id: string
  title: string
  parentId: string | null
  messages: Message[]
  agent: string
  model: { providerId: string, modelId: string }
  status: 'idle' | 'streaming' | 'error'
}
```

### Message State

```
Message: {
  id: string
  sessionId: string
  type: 'user' | 'assistant'
  parts: Part[]
  timestamp: number
  status: 'sending' | 'sent' | 'streaming' | 'complete' | 'error'
}
```

## Tab Hierarchy

### Level 1: Instance Tabs

Each tab represents one OpenCode server instance:

- Label: Folder name (with counter if duplicate)
- Icon: Folder icon
- Close button: Stops server and closes tab
- "+" button: Opens folder picker for new instance

### Level 2: Session Tabs

Each instance has multiple session tabs:

- Main session tab (always present)
- Child session tabs (auto-created)
- Logs tab (shows server output)
- "+" button: Creates new session

### Tab Behavior

**Instance Tab Switching:**

- Preserves session tabs
- Switches active SDK client
- Updates SSE event routing

**Session Tab Switching:**

- Loads messages for that session
- Updates agent/model controls
- Preserves scroll position

## Technology Stack

### Core

- **Electron** - Desktop wrapper
- **SolidJS** - Reactive UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool

### UI

- **TailwindCSS** - Styling
- **Kobalte** - Accessible UI primitives
- **Shiki** - Code syntax highlighting
- **Marked** - Markdown parsing

### Communication

- **OpenCode SDK** - API client
- **EventSource** - SSE streaming
- **Node Child Process** - Process spawning

## Error Handling

### Process Errors

- Server fails to start → Show error in instance tab
- Server crashes → Attempt auto-restart once
- Port already in use → Find next available port

### Network Errors

- API call fails → Show inline error, allow retry
- SSE disconnects → Auto-reconnect with backoff
- Timeout → Show timeout error, allow manual retry

### User Errors

- Invalid folder selection → Show error dialog
- Permission denied → Show actionable error message
- Out of memory → Graceful degradation message

## Performance Considerations

**Note: Performance optimization is NOT a focus for MVP. These are future considerations.**

### Message Rendering (Post-MVP)

- Start with simple list rendering - no virtual scrolling
- No message limits initially
- Only optimize if users report issues
- Virtual scrolling can be added in Phase 8 if needed

### State Updates

- SolidJS fine-grained reactivity handles most cases
- No special optimizations needed for MVP
- Batching/debouncing can be added later if needed

### Memory Management (Post-MVP)

- No memory management in MVP
- Let browser/OS handle it
- Add limits only if problems arise in testing

## Security Considerations

- No remote code execution
- Server spawned with user permissions
- No eval() or dangerous innerHTML
- Sanitize markdown rendering
- Validate all IPC messages
- HTTPS only for external requests

## Extensibility Points

### Plugin System (Future)

- Custom slash commands
- Custom message renderers
- Theme extensions
- Keybinding customization

### Configuration (Future)

- Per-instance settings
- Global preferences
- Workspace-specific configs
- Import/export settings
