# AGENT NOTES

## Build & Test Commands

### Development
- `npm run dev` - Start Electron app dev server (default)
- `npm run dev:electron` - Start Electron with logging
- `npm run dev:tauri` - Start Tauri dev server
- `npm run dev --workspace @neuralnomads/codenomad` - Start CLI server with UI dev proxy

### Building
- `npm run build` - Build Electron app (builds all dependencies)
- `npm run build:ui` - Build UI only
- `npm run build:tauri` - Build Tauri app
- `npm run build:mac-x64` - Build macOS x64 Electron binary
- `npm run build:mac-arm64` - Build macOS for ARMx64
- `npm run build:binaries` - Build all platform binaries (requires cross-compilation setup)

**Local builds are macOS-only**. For other platforms, use CI/CD or set up cross-compilation.

### Type Checking
- `npm run typecheck` - Typecheck all packages (UI + Electron)
- `npm run typecheck --workspace @codenomad/ui` - Typecheck UI only
- `npm run typecheck --workspace @neuralnomads/codenomad` - Typecheck server only

### Testing
Tests use Node.js built-in `node:test` framework. No test runner in package.json—run tests directly:
- `node --test packages/server/src/filesystem/__tests__/*.test.ts` - Run all server tests
- `node --test packages/server/src/filesystem/__tests__/search-cache.test.ts` - Run single test file

## Code Style Guidelines

### TypeScript Configuration
- **Strict mode enabled** across all packages
- **Target**: ES2020
- **Module**: ESNext (bundler/moduleResolution per package)
- **No explicit `any` types** - use `unknown` or proper interfaces
- **No `// @ts-ignore`** - fix type errors properly

### Import Organization
**UI (SolidJS)**:
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

**Server**:
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

### Naming Conventions
- **Components**: PascalCase (e.g., `InstanceShell`, `FolderSelectionView`)
- **Functions**: camelCase (e.g., `handleSelectFolder`, `createInstance`)
- **Constants**: SCREAMING_SNAKE_CASE (e.g., `STARTUP_STABILITY_DELAY_MS`)
- **Interfaces**: PascalCase with `I` prefix for simple types, no prefix for domain models
- **Types**: PascalCase (e.g., `SessionInfo`, `WorkspaceDescriptor`)
- **Private members**: `private readonly` or `private` prefix underscore (`_buffer`)
- **Signals/Stores**: camelCase (e.g., `instances`, `activeInstanceId`)
- **Event types**: PascalCase suffix `Event` (e.g., `MessageUpdateEvent`)

### Error Handling
**Server**:
- Use structured logging with `logger.error({ err: error, context }, "message")`
- Always wrap errors in try/catch in async functions
- Re-throw with context: `throw new Error(`Failed to create workspace: ${error.message}`)`
- Validate input early and throw descriptive errors
- Use `InvalidArgumentError` for CLI argument validation

**UI**:
- Use `try/catch` for async operations with user-facing errors
- Log errors with `log.error("Failed to...", error)` using debug namespaces
- Show user-friendly error messages via dialogs or toasts
- Type error parameter: `async function handleError(error: unknown)`
- Format error messages with fallback: `const msg = error instanceof Error ? error.message : "Unknown error"`

### Type Usage Patterns
- **Prefer interfaces** for object shapes, **type aliases** for unions/primitives
- **Use discriminated unions** for event types (e.g., `{ type: "instance.event"; ... }`)
- **Extract types** from imported packages with `import type { ... }`
- **Type guards** for runtime validation: `isSessionLoading(obj)`
- **Return types** explicitly on exported public functions
- **Signal types**: `Accessor<T>` for read, `Setter<T>` for write (SolidJS)

### Styling Guidelines (CSS/Tailwind)
- **Reuse existing tokens**: Check `src/styles/tokens.css` before adding CSS variables
- **File organization**:
  - `src/styles/components/` - reusable UI patterns (buttons, selectors)
  - `src/styles/messaging/` - message and conversation styles
  - `src/styles/panels/` - sidebar and panel layouts
  - Aggregate files (`controls.css`, `messaging.css`) should only `@import` subfiles
- **Prefer small files** (~150 lines max), split by feature when larger
- **Place component styles** beside their peers: `src/styles/messaging/new-part.css`
- **Import from aggregators**: `@import "../messaging/..."` from the correct parent file
- **Avoid class duplication**: Co-locate reusable utilities under `components/`

### Coding Principles
- **KISS**: Keep modules narrowly scoped, limit public APIs
- **DRY**: Share helpers via dedicated modules, don't copy-paste
- **Single Responsibility**: Split large files when concerns diverge (state, actions, API, events)
- **Composability**: Prefer signals, hooks, utilities over deep inheritance
- **Adapter Pattern**: Isolate platform integrations (SSE, IPC, SDK) in thin adapters with typed events
- **No globals**: Use SolidJS stores and contexts instead of global state

### Tooling Preferences
- Use `edit` tool for modifying existing files
- Use `write` tool only for new files
- Always run `typecheck` after TypeScript changes
- No explicit linting config configured—follow TypeScript strict mode rules
- Format code consistently (2 spaces indentation, no trailing whitespace)

### Testing Patterns
- Use Node.js built-in `node:test` framework
- Import: `import assert from "node:assert/strict"` and `import { describe, it, beforeEach } from "node:test"`
- Structure: `describe("feature name", () => { beforeEach(...); it("should...", () => { ... }) })`
- Use `assert.ok()`, `assert.equal()`, `assert.deepStrictEqual()` for assertions
- Test files: `__tests__/*.test.ts` placed alongside modules
- No mocking utilities standard—use simple test doubles when needed

### Documentation
- Add comments above complex logic only, not obvious code
- Document exported functions with JSDoc for public APIs
- Update this file when adding new patterns or conventions
