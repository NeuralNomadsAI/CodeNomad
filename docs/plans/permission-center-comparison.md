# Permission Center: Era Code vs CodeNomad v0.6.0 Comparison

**Analysis Date:** 2026-01-11

---

## Executive Summary

Era Code (our fork) already has **substantial permission infrastructure** that handles the core functionality. CodeNomad v0.6.0 adds a **centralized Permission Center modal** with enhanced UX features. The gap is primarily in UI presentation rather than core functionality.

---

## Current Era Code Implementation

### Backend/State Management ✅ Complete

| Component | File | Status |
|-----------|------|--------|
| Permission queue per instance | `stores/instances.ts` | ✅ Implemented |
| Permission SSE event handling | `stores/session-events.ts` | ✅ Implemented |
| Add/remove from queue | `stores/instances.ts` | ✅ Implemented |
| Session pending counts | `stores/instances.ts` | ✅ Implemented |
| Send permission response | `stores/instances.ts` | ✅ Implemented |
| Permission types | `types/message.ts` | ✅ Implemented |

**Key functions already implemented:**
```typescript
// stores/instances.ts
- permissionQueues signal
- activePermissionId signal
- getPermissionQueue(instanceId)
- getPermissionQueueLength(instanceId)
- addPermissionToQueue(instanceId, permission)
- removePermissionFromQueue(instanceId, permissionId)
- sendPermissionResponse(instanceId, sessionId, permissionId, response)
- incrementSessionPendingCount / decrementSessionPendingCount
```

### UI Implementation ✅ Partial

| Component | File | Status |
|-----------|------|--------|
| Inline permission display | `tool-call.tsx` | ✅ Implemented |
| Permission action buttons | `tool-call.tsx` | ✅ Implemented |
| Keyboard shortcuts (Y/A/N) | `tool-call.tsx` | ✅ Implemented |
| Session status indicator | `session-layout.css` | ✅ Implemented |
| Permission CSS styling | `tool-call.css` | ✅ Implemented |
| Status color tokens | `tokens.css` | ✅ Implemented |

**Current UX Flow:**
1. Permission-blocked tool calls show inline in the timeline
2. User sees permission request with title, type, and diff preview
3. User can approve (Once/Always) or Reject using buttons or keyboard shortcuts
4. Session status shows "permission" state with warning color

---

## CodeNomad v0.6.0 Additions

### New Files

| File | Purpose | Priority |
|------|---------|----------|
| `permission-approval-modal.tsx` | Centralized modal UI | High |
| `permission-notification-banner.tsx` | Header badge indicator | High |
| `permission-notification.css` | Banner styling | Medium |
| `types/permission.ts` | Dedicated permission types | Low |

### Permission Approval Modal Features

**v0.6.0 Modal includes:**
1. **Centralized view** - All pending permissions in one modal
2. **Queue navigation** - "X of Y" counter with next/prev buttons
3. **"Go to Session"** - Jump to the associated session
4. **"Load Session"** - Fetch session data for context
5. **Auto-close** - Modal closes when queue empties
6. **Small screen optimization** - Better mobile/tablet layout
7. **Reuses tool-call view** - Unified styling with timeline

**Modal UI Structure:**
```
┌─────────────────────────────────────────────────────────┐
│ Permissions                              [5] [X]        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ file:write                          [Active]    │   │
│  │ Write to /src/App.tsx                           │   │
│  │ ┌───────────────────────────────────────────┐   │   │
│  │ │ (diff preview shown here)                 │   │   │
│  │ └───────────────────────────────────────────┘   │   │
│  │                                                 │   │
│  │ [Allow Once]  [Allow Always]  [Reject]          │   │
│  │                                                 │   │
│  │ [Go to Session]                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ bash:execute                                    │   │
│  │ Run: npm install lodash                         │   │
│  │ (Queued - waiting for earlier permissions)      │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                    ◀  1 of 5  ▶                         │
└─────────────────────────────────────────────────────────┘
```

### Permission Notification Banner

**v0.6.0 Banner features:**
1. **Persistent indicator** - Shows in header when permissions pending
2. **Count badge** - "X permissions pending approval"
3. **Click to open** - Opens the Permission Modal
4. **Shield icon** - Visual indicator from lucide-solid

**Banner UI:**
```
┌──────────────────────────────────────────────────────────┐
│ Project Tabs                      [🛡️ 3] [⚙️]           │
└──────────────────────────────────────────────────────────┘
                                      ↑
                                      Permission badge
                                      (click opens modal)
```

---

## Gap Analysis

### What We're Missing

| Feature | Impact | Effort |
|---------|--------|--------|
| Permission Approval Modal | High - Better UX for multi-permission flows | Medium |
| Permission Notification Banner | Medium - Visibility across app | Low |
| Queue navigation (prev/next) | Medium - Faster approval workflow | Low |
| "Go to Session" button | Low - Convenience feature | Low |
| Auto-close on empty queue | Low - Polish | Low |

### What We Already Have (v0.6.0 doesn't)

| Feature | Notes |
|---------|-------|
| Inline timeline display | v0.6.0 also has this, but we may have different styling |
| Keyboard shortcuts in timeline | Y/A/N shortcuts for quick approval |

---

## Integration Recommendation

### Option A: Minimal Integration (2-3 hours)

Add just the **Permission Notification Banner** to provide visibility:

1. Create `permission-notification-banner.tsx`
2. Add to `InstanceTabs` or header area
3. Wire up click to scroll to/highlight active permission in timeline

**Pros:** Quick, low risk, maintains current inline UX
**Cons:** No centralized view for multiple permissions

### Option B: Full Permission Center (4-6 hours)

Add both **Modal** and **Banner**:

1. Copy `permission-approval-modal.tsx` from v0.6.0
2. Copy `permission-notification-banner.tsx` from v0.6.0
3. Adapt to our existing permission queue state (already compatible)
4. Add to `App.tsx` or `InstanceShell`
5. Add CSS from `permission-notification.css`

**Pros:** Complete parity with v0.6.0, better UX for heavy permission flows
**Cons:** More code, potential styling conflicts

### Option C: Enhanced Inline (1-2 hours)

Improve current inline display without modal:

1. Add permission badge to session tab
2. Add permission count to status bar
3. Improve keyboard navigation between permissions

**Pros:** Minimal changes, keeps focus on timeline
**Cons:** Doesn't help when user is in a different session

---

## Files to Copy from v0.6.0 (if integrating)

```bash
# New components
packages/ui/src/components/permission-approval-modal.tsx
packages/ui/src/components/permission-notification-banner.tsx

# New styles
packages/ui/src/styles/components/permission-notification.css

# Optional - dedicated types file
packages/ui/src/types/permission.ts
```

## Files to Modify

```bash
# Add modal and banner integration
packages/ui/src/App.tsx
packages/ui/src/components/instance/instance-shell2.tsx
packages/ui/src/components/instance-tabs.tsx  # for banner

# CSS imports
packages/ui/src/styles/panels.css  # or components.css
```

---

## Backend Comparison

### Server-side Permission Handling

| Aspect | Era Code | v0.6.0 |
|--------|----------|--------|
| Permission events via SSE | ✅ | ✅ |
| Permission response API | ✅ | ✅ |
| Permission types from SDK | ✅ | ✅ |

**No backend changes required** - our server already handles permissions identically to v0.6.0. The permission flow is:

1. OpenCode (CLI) requests permission → SSE event to UI
2. UI displays permission and collects response
3. UI sends response via `client.postSessionIdPermissionsPermissionId()`
4. OpenCode continues or aborts based on response

---

## Conclusion

**Backend:** ✅ Complete parity with v0.6.0
**UI State Management:** ✅ Complete parity with v0.6.0
**UI Presentation:** 🟡 Missing centralized modal and header badge

The Permission Center modal from v0.6.0 is a **UX enhancement** rather than a functional requirement. Our current inline permission display in the timeline works correctly for single-permission flows. The modal becomes valuable when:

1. User has multiple pending permissions across sessions
2. User is working in a different session than where permission is needed
3. User wants a centralized "inbox" view of all permissions

**Recommended next step:** Implement Option A (banner only) first for quick visibility, then evaluate if full modal is needed based on user feedback.

---

*Document created: 2026-01-11*
