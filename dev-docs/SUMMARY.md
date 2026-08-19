# CodeNomad - Project Summary

## Current Status

The MVP and multi-instance milestones are complete. Current architecture and implementation details live in the documents indexed below.

## What We've Created

Development documentation for the CodeNomad desktop application.

## Directory Structure

```text
packages/server/      Fastify control API and shared OpenCode service
packages/ui/          SolidJS UI and native Promise clients
packages/electron-app Electron host
packages/tauri-app/   Tauri host
dev-docs/             Development documentation
```

## Documentation Overview

### 1. Architecture (architecture.md)

**What it covers:**

- High-level system design
- Component layers (Main process, Renderer, Communication)
- State management approach
- Tab hierarchy (Instance tabs → Session tabs)
- Data flow for key operations
- Technology stack decisions
- Security considerations

**Key sections:**

- Component architecture diagram
- Instance/Session state structures
- Communication patterns (HTTP, SSE)
- Error handling strategies
- Performance considerations

### 2. User Interface (user-interface.md)

**What it covers:**

- Complete UI layout specifications
- Visual design for every component
- Interaction patterns
- Keyboard shortcuts
- Accessibility requirements
- Empty states and error states
- Modal designs

**Key sections:**

- Detailed layout wireframes (ASCII art)
- Component-by-component specifications
- Message rendering formats
- Control bar designs
- Modal/overlay specifications
- Color schemes and typography

### 3. Technical Implementation (technical-implementation.md)

**What it covers:**

- Technology stack details
- Project file structure
- State management patterns
- Shared OpenCode service and location ownership
- Native `@opencode-ai/client` integration
- `/api/events` multiplexing
- IPC communication
- Error handling strategies
- Performance optimizations

**Key sections:**

- Complete project structure
- TypeScript interfaces
- Hardened shared-service proof and location lifecycle
- Native Promise client management
- Message rendering implementation
- Build and packaging config

## Key Design Decisions

### 1. Two-Level Tabs

- **Level 1**: Instance tabs (one per project folder)
- **Level 2**: Session tabs (multiple per instance)
- Allows working on multiple projects with multiple conversations each

### 2. Shared Service Management

- CodeNomad server discovers or launches one service through its hardened lifecycle; proven host shutdown delegates to native `Service.stop`, while WSL uses native authenticated health stop
- Workspace folders become validated native locations
- UI traffic stays behind the CodeNomad proxy
- Shutdown transfers proof to a live peer or stops only the exact proven daemon when no peer remains

### 3. One Shared Service, Location-Scoped Clients

- One proven shared endpoint serves all workspace locations
- UI clients route through `/workspaces/:id/instance/api/*`
- Server-side directory and session ownership prevents cross-contamination

### 4. SolidJS for Reactivity

- Fine-grained reactivity for SSE updates
- No re-render cascades
- Better performance for real-time updates
- Smaller bundle size than React

### 5. No Virtual Scrolling or Performance Optimization in MVP

- Start with simple list rendering
- Don't optimize for large sessions initially
- Focus on functionality, not performance
- Add optimizations in post-MVP phases if needed
- Reduces initial complexity and speeds up development

### 6. Messages and Tool Calls Inline

- All activity shows in main message stream
- Tool calls expandable/collapsible
- File changes visible inline
- Single timeline view

## Implementation Guidelines

### Code Standards:

- TypeScript for everything
- No `any` types
- Descriptive variable names
- Comments for complex logic
- Error handling on all async operations
- Loading states for all network calls

### Testing Approach:

- Manual testing at each step
- Test on minimum window size (800x600)
- Test error cases
- Test edge cases (long text, special chars)
- Keyboard navigation verification

## Useful References

### Within This Project:

- `README.md` - Project overview and getting started
- `dev-docs/architecture.md` - System design
- `dev-docs/user-interface.md` - UI specifications
- `dev-docs/technical-implementation.md` - Implementation details

### External:

- OpenCode server API: https://opencode.ai/docs/server/
- Electron docs: https://electronjs.org/docs
- SolidJS docs: https://solidjs.com
- Kobalte UI: https://kobalte.dev

## Current OpenCode Baseline

- Experimental protocol client: server and UI use the same reviewed version; the runtime `opencode2` CLI is independently updated and checked through service/API compatibility, not an exact version gate
- Service: one shared endpoint managed by CodeNomad's lease-locked process-proof lifecycle
- Workspaces: native locations/directories
- Database: V2 always uses `~/.local/share/opencode2/opencode.db`, separate from V1
- Events: volatile native stream with authoritative reconnect reconciliation
- Proxy: explicit method/path allowlist; upstream additions are not automatic
- Shell mode and instructions: native session APIs, separate from background Shell and PTY management
- Background Shells: location-scoped native `shell.*` entries in Status, refreshed on Shell events/reconnect with metadata and ownership-checked removal; output uses native cursor pagination
- PTYs: separate native interactive terminals, not background-process records
- Legacy plugin/background processes: `packages/opencode-plugin` and server plugin/background-process paths remain deleted
- Git mutations and Yolo: CodeNomad-owned
