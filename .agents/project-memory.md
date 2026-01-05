# CodeNomad Project Memory
**Created:** 2026-01-05
**Last Updated:** 2026-01-05
**Maintainer:** bizzkoot (bizz_koot@yahoo.com)

---

## Project Overview

**Repository:** bizzkoot/CodeNomad (fork of NeuralNomadsAI/CodeNomad)
**Main Branch:** `dev` (tracks `origin/dev`)
**Technology Stack:**
- **Frontend:** SolidJS (solid-js, @kobalte/core)
- **State Management:** SolidJS stores with Immer (solid-js/store)
- **Desktop Shell:** Electron 39.0.0
- **Backend SDK:** @opencode-ai/sdk 1.1.1 (v2 client)
- **Build System:** Vite (UI) + Electron Builder (Desktop)
- **Type System:** TypeScript (strict mode)
- **Styling:** CSS with CSS variables, component-scoped styles

**Monorepo Structure:**
```
packages/
├── ui/                    # SolidJS frontend application
├── server/                 # Node.js backend CLI
└── electron-app/          # Electron desktop wrapper
```

---

## Architecture Patterns

### Dual Permission System (Critical)

**Legacy Permission Queue** (`packages/ui/src/stores/instances.ts`):
- Global queue of all pending permissions across all sessions
- Functions: `addPermissionToQueue`, `removePermissionFromQueue`, `getPermissionQueue`
- Used by: Global permission banner (`permission-approval-modal.tsx`)
- Signal: `activePermissionId` (Map<instanceId, permissionId>)

**V2 Message Store** (`packages/ui/src/stores/message-v2/instance-store.ts`):
- Per-message/per-part permission tracking
- Functions: `upsertPermission`, `removePermission`, `getPermissionState`
- Used by: Inline permission display (`tool-call.tsx`)
- Structure:
  ```typescript
  {
    queue: PermissionEntry[],
    active: PermissionEntry | null,
    byMessage: {
      [messageKey]: {
        [partKey]: PermissionEntry
      }
    }
  }
  ```

**Synchronization Rule:**
- V2 store updated **ONLY** via SSE events (`handlePermissionReplied`)
- Legacy queue updated by `sendPermissionResponse()` (after API call)
- **Critical**: Never call `removePermissionV2()` from `sendPermissionResponse()` - causes double-removal race condition

### SSE Event Handling

**Event Router** (`packages/ui/src/lib/sse-manager.ts`):
```typescript
switch (event.type) {
  case "permission.updated":
  case "permission.asked":
    handlePermissionUpdated(instanceId, event)
    break
  case "permission.replied":
    handlePermissionReplied(instanceId, event)
    break
}
```

**Permission Event Handlers** (`packages/ui/src/stores/session-events.ts`):
- `handlePermissionUpdated`: Called for `permission.asked` events, adds to both queues
- `handlePermissionReplied`: Called for `permission.replied` events, removes from both queues
- **Important**: Both handlers update BOTH legacy queue and v2 store

### SDK v2 Client Integration

**API Calls:**
```typescript
// Send permission reply
await instance.client.permission.reply({
  requestID: requestId,
  reply: "once" | "always" | "reject"
})
```

**SSE Events:**
- `permission.asked` (new) / `permission.updated` (legacy)
- `permission.replied` with `requestID` property
- Event properties wrapped in `event.properties` object

---

## All Commits by bizzkoot

**Total:** 14 commits on `dev` branch

### Recent Feature Development

#### 1. Permission Notification System (980a8c8) - Issue #4
**Description:** Add global permission notification system
**Files:**
- `packages/ui/src/components/permission-notification-banner.tsx` (NEW)
- `packages/ui/src/components/permission-approval-modal.tsx` (MODIFIED)
- `packages/ui/src/styles/permission-notification.css` (NEW)

**Implementation:**
- Global banner shows when permission approval required
- Toolbar button to open approval modal
- Keyboard shortcuts (Enter=Allow Once, A=Always, D=Deny, Esc=Close)
- Session status tracking with pending permission counts

#### 2. Folder Tree Browser with Markdown Preview (2023a68) - Issue #3
**Description:** Add folder tree browser with markdown preview
**Files:**
- `packages/ui/src/components/folder-tree-browser.tsx` (NEW)
- `packages/ui/src/components/folder-tree-node.tsx` (NEW)
- `packages/ui/src/components/markdown-preview-icon.tsx` (NEW)
- `packages/ui/src/components/markdown-preview-modal.tsx` (NEW)
- `packages/ui/src/utils/file-path-validator.ts` (NEW)
- `packages/ui/src/utils/markdown-file-detector.ts` (NEW)
- `packages/ui/src/hooks/use-markdown-preview.ts` (NEW)
- `packages/ui/src/styles/folder-tree-browser.css` (NEW)
- `packages/ui/src/styles/markdown-preview.css` (NEW)

**Implementation:**
- Tree view of workspace directory with expand/collapse
- Click file to preview markdown content
- Auto-detect markdown files by extension
- Escape hatch to open in external editor

#### 3. Command Suggestions (afe1841, 2cc3332, 65b5dfe, 126797c)
**Description:** Add command suggestions with shell mode integration
**Files:**
- `packages/ui/src/components/command-suggestions.tsx` (NEW)
- `packages/ui/src/components/command-suggestion-item.tsx` (NEW)
- `packages/ui/src/utils/command-filter.ts` (NEW)
- `packages/ui/src/stores/commands.ts` (MODIFIED)
- `packages/ui/src/styles/command-suggestions.css` (NEW)

**Implementation:**
- `/` triggers command suggestions when not at message start
- Fuzzy search across command palette
- Keyboard navigation (Arrow keys, Enter to select)
- Debug logging for troubleshooting

### Recent Bug Fixes

#### 4. Clipboard Functionality (f3a51c3)
**Description:** Fix clipboard functionality in web browsers
**Files:**
- `packages/ui/src/lib/clipboard.ts` (NEW)
- `packages/ui/src/components/code-block-inline.tsx` (MODIFIED)

**Root Cause:** Web browsers require Clipboard API with secure context
**Solution:**
```typescript
// Modern Clipboard API
await navigator.clipboard.writeText(text)

// Fallback for older browsers
const textArea = document.createElement('textarea')
textArea.value = text
document.body.appendChild(textArea)
textArea.select()
document.execCommand('copy')
```

#### 5. Web Browser UI Improvements (bfb5d4b, ddd58bb, 409f160, 80175fb)
**Description:** Fix permission modal styling and web browser visibility
**Files:**
- `packages/ui/src/components/permission-approval-modal.tsx`
- Various UI components

**Issues Fixed:**
- Permission modal not visible on web browsers
- Footer covered by content in folder tree browser
- Toolbar buttons not visible on mobile portrait layout
- CSS conflicts causing overlapping elements

---

## Recent Issues & Solutions

### Issue #1: Permission System Not Working After Upstream Merge

**Date:** 2026-01-05
**Severity:** HIGH - Core functionality broken
**Affected Branch:** `merge/trueupstream-dev-2026-01-05`

**Symptoms:**
- Clicking "Allow Once" in banner causes banner to disappear
- Inline permission still shows "Waiting for earlier permission responses"
- Agent never receives permission confirmation
- Permission workflow completely broken

**Root Cause:**
Double-removal race condition introduced in failed fix attempt (commit 6f34318).

**Execution Flow (BROKEN):**
```
User clicks "Allow Once"
    ↓
sendPermissionResponse() → API call succeeds
    ↓
removePermissionFromQueue() → Legacy queue updated ✅
removePermissionV2() ← First removal from v2 store
    ↓
Server sends SSE "permission.replied" event
    ↓
handlePermissionReplied() → removePermissionV2() ← Second removal!
    ↓
V2 store state corrupted ❌
```

**Solution Implemented (commit e641216):**
1. **Removed** `removePermissionV2()` call from `sendPermissionResponse()`
2. **Restored** upstream SDK v2 design: v2 store updated ONLY via SSE events
3. **Added** comprehensive diagnostic logging to permission functions

**Execution Flow (FIXED):**
```
User clicks "Allow Once"
    ↓
sendPermissionResponse() → API call succeeds
    ↓
removePermissionFromQueue() → Legacy queue updated
    ↓
Banner disappears ✅
    ↓
Server sends SSE "permission.replied" event
    ↓
handlePermissionReplied() → removePermissionFromQueue() (no-op)
                       → removePermissionV2() → V2 store updated
    ↓
Inline permission updates ✅
    ↓
Agent proceeds with operation ✅
```

**Files Modified:**
- `packages/ui/src/stores/instances.ts` (-1 line, +1 log)
- `packages/ui/src/stores/message-v2/instance-store.ts` (+18 log lines)
- `packages/ui/src/stores/session-events.ts` (+3 log lines)
- `.agents/permission-banner-debug-2026-01-05.md` (resolution documented)

**Validation:**
- ✅ TypeScript: 0 errors
- ✅ Build: macOS ARM64 successful (131MB)
- ✅ Manual testing: Permission system fully functional
- ✅ Banner and inline permissions working correctly

**Key Insights:**
- Upstream SDK v2 design is correct and should be followed
- Single source of truth for v2 store: SSE events only
- API layer handles communication, event layer handles state updates
- Separation of concerns prevents race conditions
- Diagnostic logging essential for debugging state synchronization issues

---

## Codebase Patterns

### Import Organization

**SolidJS Components:**
```typescript
// 1. SolidJS primitives first
import { Component, createSignal, createEffect } from "solid-js"

// 2. Third-party libraries
import { Dialog } from "@kobalte/core"
import { ChevronDown } from "lucide-solid"

// 3. Internal components (alphabetical)
import AlertDialog from "./components/alert-dialog"
import InstanceTabs from "./components/instance-tabs"

// 4. Contexts, hooks, utilities
import { useTheme } from "./lib/theme"
import { useCommands } from "./lib/hooks/use-commands"

// 5. Stores
import { instances, activeInstanceId } from "./stores/instances"
import { getSessions } from "./stores/sessions"

// 6. Types
import type { Instance } from "./types/instance"
```

**Server/Backend Code:**
```typescript
// 1. Node.js built-ins
import path from "path"
import { spawnSync } from "child_process"

// 2. Third-party dependencies
import { Command } from "commander"
import pino from "pino"

// 3. Internal modules (relative paths, alphabetical)
import { EventBus } from "./events/bus"
import { WorkspaceManager } from "./workspaces/manager"
import type { WorkspaceDescriptor } from "./api-types"
```

### Error Handling

**Server:**
- Use structured logging with `logger.error({ err: error, context }, "message")`
- Always wrap errors in try/catch in async functions
- Re-throw with context: `throw new Error(\`Failed to create workspace: ${error.message}\`)`
- Use `InvalidArgumentError` for CLI argument validation

**UI:**
- Use `try/catch` for async operations with user-facing errors
- Log errors with `log.error("Failed to...", error)` using debug namespaces
- Show user-friendly error messages via dialogs or toasts
- Type error parameter: `async function handleError(error: unknown)`
- Format error messages with fallback: `const msg = error instanceof Error ? error.message : "Unknown error"`

### Type Safety Patterns

- Prefer interfaces for object shapes, type aliases for unions/primitives
- Use discriminated unions for event types: `{ type: "instance.event"; ... }`
- Extract types from imported packages with `import type { ... }`
- Type guards for runtime validation: `isSessionLoading(obj)`
- Return types explicitly on exported public functions
- Signal types: `Accessor<T>` for read, `Setter<T>` for write (SolidJS)

### Styling Guidelines

**Reuse existing tokens:** Check `src/styles/tokens.css` before adding CSS variables
**File organization:**
- `src/styles/components/` - reusable UI patterns (buttons, selectors)
- `src/styles/messaging/` - message and conversation styles
- `src/styles/panels/` - sidebar and panel layouts
- Aggregate files should only `@import` subfiles
- Prefer small files (~150 lines max)
- Place component styles beside their peers

### SolidJS Reactivity Patterns

**State Management:**
```typescript
// Create reactive store with Immer
const [state, setState] = createStore<State>(initialState)

// Batch updates
setState(
  "key",
  produce((draft) => {
    draft.array = draft.array.filter(...)
    draft.object = { ...draft.object, newProp: value }
  })
)

// Access state
const value = () => store().key

// Update state
setState("key", (current) => ({ ...current, updatedProp: newValue }))
```

**Components:**
```typescript
// Create memoized values
const memo = createMemo(() => derivedValue())

// Create derived signals
const [value, setValue] = createSignal(initialValue)

// Effects
createEffect(() => {
  // React to signal changes
  const currentValue = someSignal()
})

// Cleanup
onCleanup(() => {
  // Clean up subscriptions, timers, etc.
})
```

### Testing Patterns

**Framework:** Node.js built-in `node:test`
**Imports:**
```typescript
import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"
```

**Structure:**
```typescript
describe("feature name", () => {
  beforeEach(() => {
    // Setup before each test
  })

  it("should do something", () => {
    // Test implementation
    assert.ok(condition)
    assert.equal(actual, expected)
    assert.deepStrictEqual(actual, expected)
  })
})
```

**Test Files:** Placed alongside modules as `__tests__/*.test.ts`

---

## Key Files Reference

### Permission System
- `packages/ui/src/stores/instances.ts` - Legacy permission queue
- `packages/ui/src/stores/message-v2/instance-store.ts` - V2 permission store
- `packages/ui/src/stores/message-v2/bridge.ts` - Bridge between systems
- `packages/ui/src/stores/session-events.ts` - SSE event handlers
- `packages/ui/src/components/permission-approval-modal.tsx` - Global banner modal
- `packages/ui/src/components/tool-call.tsx` - Inline permission display
- `packages/ui/src/types/permission.ts` - Permission type helpers

### UI Components
- `packages/ui/src/components/folder-tree-browser.tsx` - Folder tree with file navigation
- `packages/ui/src/components/markdown-preview-modal.tsx` - Markdown content previewer
- `packages/ui/src/components/command-suggestions.tsx` - Command palette with suggestions
- `packages/ui/src/components/permission-notification-banner.tsx` - Permission status indicator
- `packages/ui/src/components/command-palette.tsx` - Global command palette
- `packages/ui/src/components/session-view.tsx` - Main chat interface

### Build & Configuration
- `package.json` - Workspace configuration
- `packages/ui/package.json` - UI dependencies
- `packages/server/package.json` - Server dependencies
- `packages/electron-app/package.json` - Electron wrapper config
- `tsconfig.json` - TypeScript compilation settings

---

## Development Workflow

### Build Commands
- `npm run dev` - Start Electron app dev server
- `npm run build` - Build Electron app (all dependencies)
- `npm run build:ui` - Build UI only
- `npm run build:mac-arm64` - Build macOS ARM64 binary
- `npm run typecheck` - Typecheck all packages

### Git Workflow
- Feature development on feature branches
- Merge upstream changes to dedicated merge branch (e.g., `merge/trueupstream-dev-2026-01-05`)
- Test thoroughly on merge branch before merging to `dev`
- `dev` branch always tracks `origin/dev`

### Branches
- `dev` - Main development branch (local)
- `origin/dev` - Main development branch (remote)
- `merge/trueupstream-dev-2026-01-05` - Merge branch for upstream integration
- `main` - Stable production branch

---

## Future Work

### Planned Enhancements
- [ ] Multi-platform build support (Windows, Linux)
- [ ] Performance optimization for large message histories
- [ ] Advanced permission management (allow all, reject all)
- [ ] Enhanced keyboard shortcuts throughout UI
- [ ] Theme customization options

### Known Technical Debt
- [ ] Consolidate duplicate permission tracking (legacy + v2)
- [ ] Improve test coverage (currently minimal)
- [ ] Add automated UI testing (Playwright or similar)
- [ ] Standardize error reporting and user feedback
- [ ] Optimize bundle size (main bundle ~2MB)

---

## Contact & Support

**Primary Developer:** bizzkoot (bizz_koot@yahoo.com)
**Upstream Repository:** https://github.com/NeuralNomadsAI/CodeNomad
**Fork Repository:** https://github.com/bizzkoot/CodeNomad
**Documentation:** `.agents/` directory for issue investigations and memos

---

*This document is a living reference for CodeNomad development. Update as new features, bugs, and insights are discovered.*
