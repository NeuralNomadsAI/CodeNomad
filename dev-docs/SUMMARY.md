# CodeNomad - Project Summary

## Current Status

We have completed the MVP milestones (Phases 1-3) and are now operating in post-MVP mode. Future work prioritizes multi-instance support, advanced input polish, and system integrations outlined in later phases.

## What We've Created

A comprehensive specification and task breakdown for building the CodeNomad desktop application.

## Directory Structure

```text
packages/server/      Fastify control API and shared OpenCode service
packages/ui/          SolidJS UI and native Promise clients
packages/electron-app Electron host
packages/tauri-app/   Tauri host
dev-docs/             Development documentation
tasks/                Task tracking
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
- `Service.ensure` and location lifecycle
- Native Promise client management
- Message rendering implementation
- Build and packaging config

### 4. Build Roadmap (build-roadmap.md)

**What it covers:**

- 8 development phases
- Task dependencies
- Timeline estimates
- Success criteria per phase
- Risk mitigation
- Release strategy

**Phases:**

1. **Foundation** (Week 1) - Project setup, process management
2. **Core Chat** (Week 2) - Message display, SSE streaming
3. **Essential Features** (Week 3) - Markdown, agents, errors
4. **Multi-Instance** (Week 4) - Multiple projects support
5. **Advanced Input** (Week 5) - Commands, file attachments
6. **Polish** (Week 6) - UX refinements, settings
7. **System Integration** (Week 7) - Native features
8. **Advanced** (Week 8+) - Performance, plugins

## Task Breakdown

### Current Tasks (Phase 1)

**001 - Project Setup** (2-3 hours)

- Set up Electron + SolidJS + Vite
- Configure TypeScript, TailwindCSS
- Create basic project structure
- Verify build pipeline works

**002 - Empty State UI** (2-3 hours)

- Create empty state component
- Implement folder selection dialog
- Add keyboard shortcuts
- Style and test responsiveness

**003 - Shared Service Manager** (4-5 hours)

- Discover or start one OpenCode service with `Service.ensure`
- Validate workspace locations/directories
- Stop only the shared endpoint CodeNomad owns
- Handle errors and timeouts
- Auto-cleanup on app quit

**004 - Native Client Integration** (3-4 hours)

- Create native clients through the CodeNomad proxy
- Fetch sessions, agents, models
- Implement session CRUD operations
- Add error handling and retries

**005 - Session Picker Modal** (3-4 hours)

- Build modal with session list
- Agent selector for new sessions
- Keyboard navigation
- Loading and error states

**Total Phase 1 time: ~15-20 hours (2-3 weeks part-time)**

## Key Design Decisions

### 1. Two-Level Tabs

- **Level 1**: Instance tabs (one per project folder)
- **Level 2**: Session tabs (multiple per instance)
- Allows working on multiple projects with multiple conversations each

### 2. Shared Service Management

- CodeNomad server discovers or starts one service with `Service.ensure`
- Workspace folders become validated native locations
- UI traffic stays behind the CodeNomad proxy
- Shutdown stops only the endpoint CodeNomad owns

### 3. One Shared Service, Location-Scoped Clients

- One `Service.ensure` endpoint serves all workspace locations
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

### For Each Task:

1. Read task file completely
2. Review related documentation
3. Follow steps in order
4. Check off acceptance criteria
5. Test thoroughly
6. Move to done/ when complete

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

## Next Steps

### To Start Building:

1. **Read all documentation**
   - Understand architecture
   - Review UI specifications
   - Study technical approach

2. **Start with Task 001**
   - Set up project structure
   - Install dependencies
   - Verify build works

3. **Follow sequential order**
   - Each task builds on previous
   - Don't skip ahead
   - Dependencies matter

4. **Track progress**
   - Update task checkboxes
   - Move completed tasks to done/
   - Update roadmap as you go

### When You Hit Issues:

1. Review task prerequisites
2. Check documentation for clarification
3. Look at related specs
4. Ask questions on unclear requirements
5. Document blockers and solutions

## Success Metrics

### MVP (After Task 015)

- Can select folder → spawn server → chat
- Messages stream in real-time
- Can switch agents and models
- Tool executions visible
- Basic error handling works
- **Performance is NOT a concern** - focus on functionality

### Beta (After Task 030)

- Multi-instance support
- Advanced input (files, commands)
- Polished UX
- Settings and preferences
- Native menus

### v1.0 (After Task 035)

- System tray integration
- Auto-updates
- Crash reporting
- Production-ready stability

## Useful References

### Within This Project:

- `README.md` - Project overview and getting started
- `docs/architecture.md` - System design
- `docs/user-interface.md` - UI specifications
- `docs/technical-implementation.md` - Implementation details
- `tasks/README.md` - Task workflow guide

### External:

- OpenCode server API: https://opencode.ai/docs/server/
- Electron docs: https://electronjs.org/docs
- SolidJS docs: https://solidjs.com
- Kobalte UI: https://kobalte.dev

## Current OpenCode Baseline

- Native client: `@opencode-ai/client@0.0.0-next-17288`
- Service: one shared `Service.ensure`
- Workspaces: native locations/directories
- Shell and instructions: native session APIs
- Git mutations and Yolo: CodeNomad-owned

## Estimated Timeline

**Conservative estimate (part-time, ~15 hours/week):**

- Phase 1 (MVP Foundation): 2-3 weeks
- Phase 2 (Core Chat): 2 weeks
- Phase 3 (Essential): 2 weeks
- **MVP Complete: 6-7 weeks**

**Aggressive estimate (full-time, ~40 hours/week):**

- Phase 1: 1 week
- Phase 2: 1 week
- Phase 3: 1 week
- **MVP Complete: 3 weeks**

Add 2-4 weeks for testing, bug fixes, and polish before alpha release.

## This is a Living Document

As you build:

- Update estimates based on actual time
- Add new tasks as needed
- Refine specifications
- Document learnings
- Track blockers and solutions

Good luck! 🚀
