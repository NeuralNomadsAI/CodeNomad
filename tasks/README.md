# Task Management

This directory contains the task breakdown for building Era Code.

## Structure

- `todo/` - Tasks waiting to be worked on
- `done/` - Completed tasks (moved from todo/)

## Task Naming Convention

Tasks are numbered sequentially with a descriptive name:

```
001-project-setup.md
002-empty-state-ui.md
003-process-manager.md
...
```

## Task Format

Each task file contains:

1. **Goal** - What this task achieves
2. **Prerequisites** - What must be done first
3. **Acceptance Criteria** - Checklist of requirements
4. **Steps** - Detailed implementation guide
5. **Testing Checklist** - How to verify completion
6. **Dependencies** - What blocks/is blocked by this task
7. **Estimated Time** - Rough time estimate
8. **Notes** - Additional context

## Workflow

### Starting a Task

1. Read the task file thoroughly
2. Ensure prerequisites are met
3. Check dependencies are complete
4. Create a feature branch: `feature/task-XXX-name`

### Working on a Task

1. Follow steps in order
2. Check off acceptance criteria as you complete them
3. Run tests frequently
4. Commit regularly with descriptive messages

### Completing a Task

1. Verify all acceptance criteria met
2. Run full testing checklist
3. Update task file with any notes/changes
4. Move task from `todo/` to `done/`
5. Create PR for review

## Current Tasks

### Phase 1: Foundation (Tasks 001-005)

- [x] 001 - Project Setup
- [x] 002 - Empty State UI
- [x] 003 - Process Manager
- [x] 004 - SDK Integration
- [x] 005 - Session Picker Modal

### Phase 2: Core Chat (Tasks 006-010)

- [x] 006 - Instance & Session Tabs
- [x] 007 - Message Display
- [x] 008 - SSE Integration
- [x] 009 - Prompt Input (Basic)
- [x] 010 - Tool Call Rendering

### Phase 3: Essential Features (Tasks 011-015)

- [x] 011 - Agent/Model Selectors
- [x] 012 - Markdown Rendering
- [x] 013 - Logs Tab
- [ ] 014 - Error Handling
- [ ] 015 - Keyboard Shortcuts

### Phase 4: Multi-Instance (Tasks 016-020)

- [ ] 016 - Instance Tabs
- [ ] 017 - Instance Persistence
- [ ] 018 - Child Session Handling
- [ ] 019 - Instance Lifecycle
- [ ] 020 - Multiple SDK Clients

### Phase 5: Advanced Input (Tasks 021-025)

- [ ] 021 - Slash Commands
- [ ] 022 - File Attachments
- [ ] 023 - Drag & Drop
- [ ] 024 - Attachment Chips
- [ ] 025 - Input History

### Phase 6: Polish (Tasks 026-030)

- [ ] 026 - Message Actions
- [ ] 027 - Search in Session
- [ ] 028 - Session Management
- [ ] 029 - Settings UI
- [ ] 030 - Native Menus

### Phase 7: System Integration (Tasks 031-035)

- [ ] 031 - System Tray
- [ ] 032 - Notifications
- [ ] 033 - Auto-updater
- [ ] 034 - Crash Reporting
- [ ] 035 - Performance Profiling

### Phase 8: Advanced (Tasks 036-040)

- [ ] 036 - Virtual Scrolling
- [ ] 037 - Advanced Search
- [ ] 038 - Workspace Management
- [ ] 039 - Theme Customization
- [ ] 040 - Plugin System

## Priority Levels

Tasks are prioritized as follows:

- **P0 (MVP)**: Must have for first release (Tasks 001-015)
- **P1 (Beta)**: Important for beta (Tasks 016-030)
- **P2 (v1.0)**: Should have for v1.0 (Tasks 031-035)
- **P3 (Future)**: Nice to have (Tasks 036-040)

## Dependencies Graph

```
001 (Setup)
 ├─ 002 (Empty State)
 │   └─ 003 (Process Manager)
 │       └─ 004 (SDK Integration)
 │           └─ 005 (Session Picker)
 │               ├─ 006 (Tabs)
 │               │   └─ 007 (Messages)
 │               │       └─ 008 (SSE)
 │               │           └─ 009 (Input)
 │               │               └─ 010 (Tool Calls)
 │               │                   └─ 011-015 (Essential Features)
 │               │                       └─ 016-020 (Multi-Instance)
 │               │                           └─ 021-025 (Advanced Input)
 │               │                               └─ 026-030 (Polish)
 │               │                                   └─ 031-035 (System)
 │               │                                       └─ 036-040 (Advanced)
```

## Tips

- **Don't skip steps** - They're ordered for a reason
- **Test as you go** - Don't wait until the end
- **Keep tasks small** - Break down if >1 day of work
- **Document issues** - Note any blockers or problems
- **Ask questions** - If unclear, ask before proceeding

## Tracking Progress

Update this file as tasks complete:

- Change `[ ]` to `[x]` in the task list
- Move completed task files to `done/`
- Update build roadmap doc

## Getting Help

If stuck on a task:

1. Review prerequisites and dependencies
2. Check related documentation in `docs/`
3. Review similar patterns in existing code
4. Ask for clarification on unclear requirements
