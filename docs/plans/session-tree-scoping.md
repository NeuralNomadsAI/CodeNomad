# Session Tree Integration Scoping

**Date:** 2026-01-11
**Status:** Scoping (No code changes)

---

## Executive Summary

CodeNomad v0.6.0 introduces threaded sessions (parent-child hierarchy) displayed in a sidebar tree. Our ERA Code fork uses a browser-style horizontal tab UI. This document analyzes the integration path, risks, and recommends a visual approach that works for both desktop and mobile.

---

## Current State Comparison

### Our Implementation (ERA Code)

**UI Pattern:** Browser-style horizontal tabs
```
┌─────────────────────────────────────────────────────────────┐
│ [Project Tabs]                                    [⚙️]      │
├─────────────────────────────────────────────────────────────┤
│ [💬 Login Feature] [💬 Debug issue] [💬 New...] [+]        │  ← Session tabs
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    Chat Area                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Horizontal scrollable session tabs
- Shows only parent sessions (filters out children)
- Simple left/right scroll arrows for overflow
- Active tab highlighted with bottom border
- Close button on hover (X)
- Status indicator via background color (working/compacting)

**Backend Support Already Present:**
- `parentId` field on sessions ✅
- `forkSession()` API function ✅
- `getChildSessions()` and `getSessionFamily()` functions ✅
- `getParentSessions()` filter ✅
- Session deletion with nearby-session selection ✅

### CodeNomad v0.6.0 Implementation

**UI Pattern:** Vertical sidebar tree
```
┌──────────────────────┬───────────────────────────────────────┐
│ Sessions         [+] │                                       │
├──────────────────────┤                                       │
│                      │                                       │
│ 👤 Login Feature  ▼  │                                       │
│   ├─🤖 Fix auth bug  │           Chat Area                   │
│   └─🤖 Add OAuth     │                                       │
│                      │                                       │
│ 👤 Debug issue       │                                       │
│                      │                                       │
├──────────────────────┤                                       │
│ [+ New Session]      │                                       │
└──────────────────────┴───────────────────────────────────────┘
```

**Features:**
- Vertical collapsible tree in sidebar
- Parent/child relationship visualized with tree lines
- User icon (👤) for parent, Bot icon (🤖) for forks
- Expand/collapse chevrons per parent
- Rich status badges (Idle/Working/Compacting/Permission)
- Keyboard navigation through visible list
- Active session auto-expands parent

---

## Backend Comparison

### What We Already Have

| Capability | Status | Location |
|------------|--------|----------|
| Session `parentId` field | ✅ Ready | `types/session.ts`, API responses |
| Fork session API | ✅ Ready | `session-api.ts:forkSession()` |
| Get child sessions | ✅ Ready | `session-state.ts:getChildSessions()` |
| Get session family | ✅ Ready | `session-state.ts:getSessionFamily()` |
| Filter parent sessions | ✅ Ready | `session-state.ts:getParentSessions()` |
| Delete with nearby selection | ✅ Ready | `session-api.ts:deleteSession()` |

### What v0.6.0 Adds

| Capability | Status | Files Affected |
|------------|--------|----------------|
| Thread expansion state | ❌ Missing | `session-state.ts` |
| Thread sorting (latestUpdated) | ❌ Missing | `session-state.ts` |
| Visible session navigation | ❌ Missing | `session-state.ts` |
| Session indicator counts | ❌ Missing | `session-state.ts` |
| Tree-aware keyboard nav | ❌ Missing | `session-list.tsx` |

### v0.6.0 State Additions

```typescript
// New types in session-state.ts
interface SessionThread {
  parent: Session
  children: Session[]
  latestUpdated: number  // Max of parent and children update times
}

// New signals
const expandedThreads = createSignal<Map<string, Set<string>>>(new Map())

// New functions
function toggleThreadExpansion(instanceId: string, parentId: string): void
function isThreadExpanded(instanceId: string, parentId: string): boolean
function getVisibleSessions(instanceId: string): Session[]
function getSessionThreads(instanceId: string): SessionThread[]
```

---

## Risk Assessment

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| `session-state.ts` conflicts | Many functions touched | Careful 3-way merge, test extensively |
| Navigation logic changes | May break existing flows | Keep our tab nav alongside new tree nav |
| CSS restructuring | Visual regressions | Create new CSS files, don't modify existing |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| State signal additions | Memory/reactivity impact | Profile before/after |
| Keyboard nav complexity | Accessibility concerns | Test with screen readers |
| Mobile sidebar usability | Touch targets too small | Responsive breakpoints |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| New type additions | TypeScript changes | Additive, won't break existing |
| New CSS files | Bundle size | Minimal impact |

---

## UX Benefits Analysis

### For Power Users (Desktop)
| Benefit | Value |
|---------|-------|
| Visual hierarchy of AI-spawned forks | **High** - Understand what agent did |
| Collapse completed threads | **High** - Reduce clutter |
| Quick navigation with keyboard | **Medium** - Speed |
| Status at-a-glance for all sessions | **Medium** - Awareness |

### For Mobile Users
| Benefit | Value |
|---------|-------|
| Collapsible trees save space | **High** - Limited screen real estate |
| Touch-friendly expand/collapse | **Medium** - Better than scrolling |
| Status visibility | **High** - Know what's running |

### Current Pain Points Solved
1. **Invisible forks**: Users don't know agent spawned child sessions
2. **Session overload**: Too many tabs with no grouping
3. **Status confusion**: Hard to see which sessions are working
4. **Context loss**: Deleting session loses related children

---

## Visual Integration Options

### Option A: Hybrid Tabs + Dropdown Tree

Keep browser-style tabs for parents, show children in dropdown on click.

```
┌─────────────────────────────────────────────────────────────┐
│ [Project Tabs]                                              │
├─────────────────────────────────────────────────────────────┤
│ [💬 Login ▼] [💬 Debug] [+]                                 │
│  ┌────────────────────┐                                     │
│  │ 🤖 Fix auth    ●   │  ← Dropdown shows children          │
│  │ 🤖 Add OAuth   ○   │                                     │
│  └────────────────────┘                                     │
└─────────────────────────────────────────────────────────────┘
```

**Pros:**
- Minimal layout change
- Familiar browser pattern
- Works well on mobile (tap to expand)
- Fast access to parent sessions

**Cons:**
- Hidden children (require click to see)
- Limited space for child info
- Doesn't match v0.6.0's always-visible tree

### Option B: Collapsible Sidebar (Like v0.6.0)

Add a resizable sidebar showing session tree.

```
Desktop:
┌────────────────────┬────────────────────────────────────────┐
│ Sessions       [+] │ [Project Tabs]                         │
├────────────────────┤────────────────────────────────────────│
│ 👤 Login       ▼   │                                        │
│   ├─🤖 Fix auth    │        Chat Area                       │
│   └─🤖 OAuth       │                                        │
│ 👤 Debug           │                                        │
├────────────────────┤                                        │
│ [+ New Session]    │                                        │
└────────────────────┴────────────────────────────────────────┘

Mobile (sidebar collapsed by default):
┌─────────────────────────────────────────────────────────────┐
│ [☰] Login Feature                              [⚙️]         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    Chat Area                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Mobile (sidebar open as overlay):
┌────────────────────┬────────────────────────────────────────┐
│ Sessions       [×] │                                        │
│                    │        (dimmed)                        │
│ 👤 Login       ▼   │                                        │
│   ├─🤖 Fix auth    │                                        │
│   └─🤖 OAuth       │                                        │
└────────────────────┴────────────────────────────────────────┘
```

**Pros:**
- Full visibility of session tree
- Matches v0.6.0 (easier merge)
- Rich status display
- Keyboard navigation friendly

**Cons:**
- Takes horizontal space on desktop
- Requires overlay pattern on mobile
- More complex responsive behavior
- Different paradigm from browser tabs

### Option C: Horizontal Tabs with Inline Children (Recommended)

Expand children inline under the tab bar when a parent is selected.

```
Desktop/Tablet:
┌─────────────────────────────────────────────────────────────┐
│ [Project Tabs]                                    [⚙️]      │
├─────────────────────────────────────────────────────────────┤
│ [👤 Login Feature ▼] [👤 Debug issue] [+]                   │
│  ├─[🤖 Fix auth bug  ●]  ├─[🤖 Add OAuth  ○]               │  ← Inline children
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    Chat Area                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Mobile (stacked):
┌─────────────────────────────────────────────────────────────┐
│ [👤 Login Feature                              ▼]           │
├─────────────────────────────────────────────────────────────┤
│  [🤖 Fix auth ●] [🤖 OAuth ○]                               │
├─────────────────────────────────────────────────────────────┤
│                    Chat Area                                │
└─────────────────────────────────────────────────────────────┘
```

**Pros:**
- Keeps browser-style horizontal tabs
- Children visible without sidebar
- Natural expansion pattern
- Works on desktop and mobile
- Minimal layout disruption

**Cons:**
- Uses vertical space when expanded
- May get crowded with many children
- Novel pattern (not standard browser or tree)

---

## Recommended Approach: Option C with Fallback

### Phase 1: Core Backend Integration
1. Add `expandedThreads` signal to `session-state.ts`
2. Add `getSessionThreads()` and sorting by `latestUpdated`
3. Add `toggleThreadExpansion()` and `isThreadExpanded()`
4. Keep existing `session-tabs.tsx` working

### Phase 2: Enhanced Session Tabs
1. Add expand/collapse chevron to parent tabs
2. Show child tabs inline below parent when expanded
3. Add status indicators (●○) to all tabs
4. Add tree-line connectors for visual hierarchy

### Phase 3: Mobile Optimization
1. Stack view on narrow screens
2. Parent as full-width button with dropdown
3. Children as horizontally scrollable pills
4. Swipe gestures for navigation

### Phase 4: Optional Sidebar
1. Add collapsible sidebar for power users
2. Keyboard shortcut to toggle (Cmd+B)
3. Remember sidebar state in preferences
4. Overlay mode on mobile

---

## Estimated Effort

| Phase | Effort | Risk |
|-------|--------|------|
| Phase 1: Backend | 2-3 hours | Low |
| Phase 2: Enhanced Tabs | 4-6 hours | Medium |
| Phase 3: Mobile | 3-4 hours | Medium |
| Phase 4: Sidebar | 4-6 hours | Low |
| **Total** | **13-19 hours** | |

---

## Key Decisions Needed

1. **Which visual pattern?**
   - Option A: Dropdown children
   - Option B: Sidebar tree (like v0.6.0)
   - Option C: Inline horizontal children (recommended)

2. **Mobile approach?**
   - Full sidebar overlay
   - Stacked horizontal tabs
   - Hybrid (depends on screen size)

3. **Keep existing tabs during transition?**
   - Yes, feature flag new UI
   - No, replace entirely

4. **Keyboard navigation scope?**
   - Just visible sessions
   - Full tree with expand shortcuts

---

## Files to Modify

### Backend (Phase 1)
- `stores/session-state.ts` - Add thread state management
- `stores/sessions.ts` - Export new functions
- `types/session.ts` - Add thread-related types if needed

### UI (Phase 2-3)
- `components/session-tabs.tsx` - Major enhancement
- `styles/panels/tabs.css` - Add tree-line styles, status indicators
- New: `components/session-tree-line.tsx` - Reusable connector

### Sidebar (Phase 4)
- New: `components/session-sidebar.tsx` - Full tree sidebar
- New: `styles/panels/session-sidebar.css`
- `App.tsx` - Sidebar toggle state

---

*Document created: 2026-01-11*
