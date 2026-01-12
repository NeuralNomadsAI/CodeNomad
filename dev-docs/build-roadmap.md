# Era Code Build Roadmap

## Overview

This document outlines the phased approach to building the Era Code desktop application. Each phase builds incrementally on the previous, with clear deliverables and milestones.

**Status:** MVP (Phases 1-3) is complete. Focus now shifts to post-MVP phases starting with multi-instance support and advanced input refinements.

## MVP Scope (Phases 1-3)

The minimum viable product includes:

- Single instance management
- Session selection and creation
- Message display (streaming)
- Basic prompt input (text only)
- Agent/model selection
- Process lifecycle management

**Target: 3-4 weeks for MVP**

---

## Phase 1: Foundation (Week 1)

**Goal:** Running Electron app that can spawn OpenCode servers

### Tasks

1. ✅ **001-project-setup** - Electron + SolidJS + Vite boilerplate
2. ✅ **002-empty-state-ui** - Empty state UI with folder selection
3. ✅ **003-process-manager** - Spawn and manage OpenCode server processes
4. ✅ **004-sdk-integration** - Connect to server via SDK
5. ✅ **005-session-picker-modal** - Select/create session modal

### Deliverables

- App launches successfully
- Can select folder
- Server spawns automatically
- Session picker appears
- Can create/select session

### Success Criteria

- User can launch app → select folder → see session picker
- Server process runs in background
- Sessions fetch from API successfully

---

## Phase 2: Core Chat Interface (Week 2)

**Goal:** Display messages and send basic prompts

### Tasks

6. **006-instance-session-tabs** - Two-level tab navigation
7. **007-message-display** - Render user and assistant messages
8. **008-sse-integration** - Real-time message streaming
9. **009-prompt-input-basic** - Text input with send functionality
10. **010-tool-call-rendering** - Display tool executions inline

### Deliverables

- Tab navigation works
- Messages display correctly
- Real-time updates via SSE
- Can send text messages
- Tool calls show status

### Success Criteria

- User can type message → see response stream in real-time
- Tool executions visible and expandable
- Multiple sessions can be open simultaneously

---

## Phase 3: Essential Features (Week 3)

**Goal:** Feature parity with basic TUI functionality

### Tasks

11. **011-agent-model-selectors** - Dropdown for agent/model switching
12. **012-markdown-rendering** - Proper markdown with code highlighting
13. **013-logs-tab** - View server logs
14. **014-error-handling** - Comprehensive error states and recovery
15. **015-keyboard-shortcuts** - Essential keyboard navigation

### Deliverables

- Can switch agents and models
- Markdown renders beautifully
- Code blocks have syntax highlighting
- Server logs accessible
- Errors handled gracefully
- Cmd/Ctrl+N, K, L shortcuts work

### Success Criteria

- User experience matches TUI quality
- All error cases handled
- Keyboard-first navigation option available

---

## Phase 4: Multi-Instance Support (Week 4)

**Goal:** Work on multiple projects simultaneously

### Tasks

16. **016-instance-tabs** - Instance-level tab management
17. **017-instance-state-persistence** - Remember instances across restarts
18. **018-child-session-handling** - Auto-create tabs for child sessions
19. **019-instance-lifecycle** - Stop, restart, reconnect instances
20. **020-multiple-sdk-clients** - One SDK client per instance

### Deliverables

- Multiple instance tabs
- Persists across app restarts
- Child sessions appear as new tabs
- Can stop individual instances
- All instances work independently

### Success Criteria

- User can work on 3+ projects simultaneously
- App remembers state on restart
- No interference between instances

---

## Phase 5: Advanced Input (Week 5)

**Goal:** Full input capabilities matching TUI

### Tasks

21. **021-slash-commands** - Command palette with autocomplete
22. **022-file-attachments** - @ mention file picker
23. **023-drag-drop-files** - Drag files onto input
24. **024-attachment-chips** - Display and manage attachments
25. **025-input-history** - Up/down arrow message history

### Deliverables

- `/command` autocomplete works
- `@file` picker searches files
- Drag & drop attaches files
- Attachment chips removable
- Previous messages accessible

### Success Criteria

- Input feature parity with TUI
- File context easy to add
- Command discovery intuitive

---

## Phase 6: Polish & UX (Week 6)

**Goal:** Production-ready user experience

### Tasks

26. **026-message-actions** - Copy, edit, regenerate messages
27. **027-search-in-session** - Find text in conversation
28. **028-session-management** - Rename, share, export sessions
29. **029-settings-ui** - Preferences and configuration
30. **030-native-menus** - Platform-native menu bar

### Deliverables

- Message context menus
- Search within conversation
- Session CRUD operations
- Settings dialog
- Native File/Edit/View menus

### Success Criteria

- Feels polished and professional
- All common actions accessible
- Settings discoverable

---

## Phase 7: System Integration (Week 7)

**Goal:** Native desktop app features

### Tasks

31. **031-system-tray** - Background running with tray icon
32. **032-notifications** - Desktop notifications for events
33. **033-auto-updater** - In-app update mechanism
34. **034-crash-reporting** - Error reporting and recovery
35. **035-performance-profiling** - Optimize rendering and memory

### Deliverables

- Runs in background
- Notifications for session activity
- Auto-updates on launch
- Crash logs captured
- Smooth performance with large sessions

### Success Criteria

- App feels native to platform
- Updates seamlessly
- Crashes don't lose data

---

## Phase 8: Advanced Features (Week 8+)

**Goal:** Beyond MVP, power user features

### Tasks

36. **036-virtual-scrolling** - Handle 1000+ message sessions
37. **037-message-search-advanced** - Full-text search across sessions
38. **038-workspace-management** - Save/load workspace configurations
39. **039-theme-customization** - Custom themes and UI tweaks
40. **040-plugin-system** - Extension API for custom tools

### Deliverables

- Virtual scrolling for performance
- Cross-session search
- Workspace persistence
- Theme editor
- Plugin loader

### Success Criteria

- Handles massive sessions (5000+ messages)
- Can search entire project history
- Fully customizable

---

## Parallel Tracks

Some tasks can be worked on independently:

### Design Track

- Visual design refinements
- Icon creation
- Brand assets
- Marketing materials

### Documentation Track

- User guide
- Keyboard shortcuts reference
- Troubleshooting docs
- Video tutorials

### Infrastructure Track

- CI/CD pipeline
- Automated testing
- Release automation
- Analytics integration

---

## Release Strategy

### Alpha (After Phase 3)

- Internal testing only
- Frequent bugs expected
- Rapid iteration

### Beta (After Phase 6)

- Public beta program
- Feature complete
- Bug fixes and polish

### v1.0 (After Phase 7)

- Public release
- Stable and reliable
- Production-ready

### v1.x (Phase 8+)

- Regular feature updates
- Community-driven priorities
- Plugin ecosystem

---

## Success Metrics

### MVP Success

- 10 internal users daily
- Can complete full coding session
- <5 critical bugs

### Beta Success

- 100+ external users
- NPS >50
- <10 bugs per week

### v1.0 Success

- 1000+ users
- <1% crash rate
- Feature requests > bug reports

---

## Risk Mitigation

### Technical Risks

- **Process management complexity**
  - Mitigation: Extensive testing, graceful degradation
- **SSE connection stability**
  - Mitigation: Robust reconnection logic, offline mode
- **Performance with large sessions**
  - Mitigation: NOT a concern for MVP - defer to Phase 8
  - Accept slower performance initially, optimize later based on user feedback

### Product Risks

- **Feature creep**
  - Mitigation: Strict MVP scope, user feedback prioritization
- **Over-optimization too early**
  - Mitigation: Focus on functionality first, optimize in Phase 8
  - Avoid premature performance optimization
- **Platform inconsistencies**
  - Mitigation: Test on all platforms regularly

---

## Dependencies

### External

- OpenCode CLI availability
- OpenCode SDK stability
- Electron framework updates

### Internal

- Design assets
- Documentation
- Testing resources

---

## Milestone Checklist

### Pre-Alpha

- [ ] All Phase 1 tasks complete
- [ ] Can create instance and session
- [ ] Internal demo successful

### Alpha

- [ ] All Phase 2-3 tasks complete
- [ ] MVP feature complete
- [ ] 5+ internal users testing

### Beta

- [ ] All Phase 4-6 tasks complete
- [ ] Multi-instance stable
- [ ] 50+ external testers

### v1.0

- [ ] All Phase 7 tasks complete
- [ ] Documentation complete
- [ ] <5 known bugs
- [ ] Ready for public release
