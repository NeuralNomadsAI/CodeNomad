# Session Tree UX Analysis

**Date:** 2026-01-11
**Focus:** User experience, not implementation

---

## The User's Perspective

### Who is the user?

A developer using AI to help with coding tasks. They might be:
- **Solo developer** - Working on personal projects, learning
- **Professional** - Using AI as a pair programmer
- **Team lead** - Reviewing AI-generated code
- **Mobile user** - Quick edits or monitoring on the go

### What are they trying to do?

1. **Get coding help** - Ask questions, generate code, fix bugs
2. **Manage context** - Keep related work together
3. **Track progress** - Know what's done, what's in progress
4. **Review AI actions** - Understand what the AI did autonomously

---

## Current Pain Points

### 1. "Where did that session come from?"

**Scenario:** User asks AI to implement a feature. AI spawns a sub-agent to handle a specific part. User sees a new session tab appear but doesn't understand:
- Why it exists
- How it relates to their original request
- Whether they need to do anything with it

**Current UI:** Flat tabs show all sessions equally. No visual hierarchy.

### 2. "Which sessions are actually doing work?"

**Scenario:** User has 5 sessions open. Some are idle, one is actively working, one needs permission. They want to know at a glance.

**Current UI:** Status only visible when you click into a session.

### 3. "I have too many sessions"

**Scenario:** After a long coding session, user has 12 tabs. Half are old, half are related sub-sessions. Overwhelming.

**Current UI:** All sessions shown equally. No grouping, no hiding old work.

### 4. "I deleted the wrong thing"

**Scenario:** User deletes a parent session, not realizing it had child sessions with important context.

**Current UI:** No warning about related sessions.

---

## What Information Actually Matters?

### Critical (Always Show)
| Info | Why It Matters |
|------|----------------|
| Session title | What is this about? |
| Status (Working/Idle) | Is AI doing something? |
| Permission needed | Do I need to act? |

### Important (Show When Relevant)
| Info | Why It Matters |
|------|----------------|
| Has children | This session spawned sub-work |
| Is a child | This came from another session |
| Last activity | Is this stale? |

### Nice to Have (On Demand)
| Info | Why It Matters |
|------|----------------|
| Token usage | Cost awareness |
| Child count | Complexity of task |
| Agent type | What kind of work |

### Probably Not Needed
| Info | Why |
|------|-----|
| Session ID | Technical detail |
| Detailed tree structure | Overwhelming |
| Every child session visible | Clutter |

---

## Key UX Insight

> **Users don't care about tree structure. They care about:**
> 1. What's actively happening?
> 2. What needs my attention?
> 3. How do I get back to my main task?

The tree is a **mental model for developers** building the feature, not necessarily what users need to see.

---

## Alternative Design: Status-First, Not Structure-First

Instead of showing a tree, show **status bubbles**:

```
┌─────────────────────────────────────────────────────────────┐
│ [Implement login ●] [Debug issue] [+]                       │
│        ↓                                                     │
│    "2 tasks running"  ← Click to see children               │
└─────────────────────────────────────────────────────────────┘
```

### When Parent Has Active Children

```
┌───────────────────────────────────────────────────────────────┐
│ [Implement login ●2]  ← Badge shows active child count       │
│                                                               │
│ Click reveals:                                                │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ ● Fix auth bug      Working...                            │ │
│ │ ● Add OAuth         Working...                            │ │
│ │ ○ Main session      Idle                                  │ │
│ └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### When Permission Needed

```
┌───────────────────────────────────────────────────────────────┐
│ [Implement login 🛡️]  ← Shield indicates needs attention      │
│                                                               │
│ Click reveals:                                                │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ 🛡️ Fix auth bug     Needs permission: Run npm install     │ │
│ │    └─ [Allow] [Deny]                                      │ │
│ └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

---

## Simplified Mental Model for Users

### Three States a Session Can Be In

| State | Visual | Meaning |
|-------|--------|---------|
| **Idle** | ○ (hollow) | Nothing happening |
| **Working** | ● (solid, pulsing) | AI is doing something |
| **Needs Me** | 🛡️ (shield) | I need to approve something |

### Two Levels of Sessions

| Level | Visual | Meaning |
|-------|--------|---------|
| **My Sessions** | Full tab | I started this conversation |
| **AI Sub-tasks** | Badge/dropdown | AI created this to help |

---

## Recommended Approach: Progressive Disclosure

### Level 1: Tab Bar (Always Visible)

```
[💬 Login ●2] [💬 Debug ○] [+]
```

- Show parent sessions only
- Badge with count if has active children
- Status indicator (●/○/🛡️) on tab

### Level 2: Hover/Click Dropdown (On Demand)

```
┌─────────────────────────────────────────┐
│ Login Feature                           │
│ ─────────────────────────────────────── │
│ ● Fix auth bug          Working...      │
│ ● Add OAuth             Working...      │
│ ─────────────────────────────────────── │
│ ○ Main conversation     Idle            │
│                                         │
│ [View All] [Collapse Finished]          │
└─────────────────────────────────────────┘
```

### Level 3: Full Session View (When Selected)

Show the chat for selected session (parent or child).

---

## Mobile Considerations

On mobile, horizontal tabs don't work well. Consider:

### Option A: Single Active Session + Switcher

```
┌─────────────────────────────────────────┐
│ ☰  Login Feature ●2                  ⚙️ │
├─────────────────────────────────────────┤
│                                         │
│         Chat content here               │
│                                         │
└─────────────────────────────────────────┘

Tap ☰ to show session list
```

### Option B: Swipe Navigation

```
     ← Login Feature →     (swipe to change)
          ●2

┌─────────────────────────────────────────┐
│                                         │
│         Chat content here               │
│                                         │
└─────────────────────────────────────────┘
```

---

## What We Should Build

### Must Have (Core Value)
1. **Status badge on parent tabs** - See at-a-glance if children are working
2. **Permission indicator** - Know when action needed
3. **Dropdown to see children** - Access without clutter
4. **Click child to view** - Navigate to sub-sessions

### Should Have (Better Experience)
5. **Auto-collapse finished** - Hide completed sub-tasks
6. **Delete warning** - Alert when deleting has children
7. **Active child highlight** - Which child is actually busy

### Could Have (Nice Polish)
8. **Swipe gestures on mobile**
9. **Keyboard shortcuts for navigation**
10. **Collapse all / Expand all**

### Won't Have (Avoid Complexity)
- Full tree visualization (VS Code-style)
- Drag-and-drop reordering
- Manual session grouping
- Nested children (children of children)

---

## Revised Implementation Scope

Based on this analysis, we need less than originally scoped:

### Backend: Keep It Simple
| Need | Don't Need |
|------|------------|
| `getChildSessions()` ✅ Already have | Complex thread sorting |
| Session `status` field | Indicator count caching |
| `parentId` relationship ✅ Already have | Visible session navigation |

### UI: Focus on Parent Tabs
| Need | Don't Need |
|------|------------|
| Badge showing child count + status | Full tree view |
| Dropdown showing children | Sidebar session list |
| Click to navigate to child | Keyboard tree navigation |
| Status indicator on tabs | Expand/collapse state persistence |

---

## Next Steps

1. **Add status to Session type** (still needed)
2. **Add status fetching** (still needed)
3. **Skip**: Complex expansion state, indicator caching, visible IDs
4. **Build UI**: Badge + dropdown pattern instead of tree

---

## Questions for You

1. **Badge vs. Chevron**: Show child count badge, or expandable chevron?
2. **Mobile priority**: How important is mobile experience for v1?
3. **Permission UX**: Inline in dropdown, or separate notification?

---

*Document created: 2026-01-11*
