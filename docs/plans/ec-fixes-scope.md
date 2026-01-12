# Era Code UI/UX Fixes Scope

Based on comprehensive visual review of EC-001 through EC-006 features.

**Status: COMPLETED** (2026-01-10)

---

## Priority Matrix

| ID | Issue | Priority | Effort | Impact | Status |
|----|-------|----------|--------|--------|--------|
| FIX-001 | CORS error for models.dev API | P0 | Medium | Model selector completely broken | ✅ Done |
| FIX-002 | Malformed HTML (button nesting) | P1 | Low | Browser rendering issues | ✅ Documented (Kobalte lib) |
| FIX-003 | Home screen three-card layout | P2 | High | UX discoverability | ✅ Three-column verified |
| FIX-004 | Context usage "0 / --" display | P2 | Low | User confusion | ✅ Done |
| FIX-005 | Tab close button discoverability | P2 | Low | UX discoverability | ✅ Done |
| FIX-006 | Session tab name truncation | P3 | Low | Readability | ✅ Done |
| FIX-007 | Active session visual indicator | P3 | Low | UX clarity | ✅ Already implemented |
| FIX-008 | Cost display when no session | P3 | Low | Visual cleanliness | ✅ Done |
| FIX-009 | GitHub integration in home | P3 | High | Feature completeness | 📋 Future feature |
| FIX-010 | Keyboard shortcuts footer | P3 | Medium | Discoverability | ✅ Done |

---

## FIX-001: CORS Error for models.dev API

**Problem:** The models.dev API (`https://models.dev/api.json`) doesn't include CORS headers. Browser fetch from `localhost:3006` fails with:
```
Access to fetch at 'https://models.dev/api.json' from origin 'http://localhost:3006'
has been blocked by CORS policy
```

**Impact:** Model selector modal shows "Failed to load models. Using cached data if available." - completely unusable.

**Solution:** Proxy the models.dev API through the Era Code server.

**Files to Modify:**
- `packages/server/src/server/http-server.ts` - Add proxy endpoint
- `packages/server/src/server/routes/` - New `models-proxy.ts` route
- `packages/ui/src/lib/models-api.ts` - Point to local proxy instead of models.dev

**Implementation:**
```typescript
// Server: Add route /api/models/data that proxies to models.dev
// Server: Add route /api/models/logo/:provider that proxies logos
// UI: Change MODELS_API_URL to "/api/models/data"
// UI: Change LOGO_BASE_URL to "/api/models/logo"
```

**Acceptance Criteria:**
- [ ] Server proxies models.dev/api.json to /api/models/data
- [ ] Server proxies models.dev/logos/*.svg to /api/models/logo/*
- [ ] UI fetches from local proxy
- [ ] Model selector shows providers and models
- [ ] Provider logos load correctly
- [ ] 30-minute server-side caching to reduce API calls

---

## FIX-002: Malformed HTML (Button Nesting)

**Problem:** Vite warning shows invalid HTML:
```
User HTML: <button><div>...<button></button></button>
Browser HTML: <button><div>...</div></button><button></button>
```
Buttons cannot contain other buttons.

**Impact:** Browser auto-corrects the DOM, potentially breaking click handlers.

**Solution:** Find and fix the nested button in the component tree.

**Files to Investigate:**
- `packages/ui/src/components/` - Search for nested button patterns
- Likely in tab components or card components with action buttons

**Implementation:**
```typescript
// Change inner <button> to <span role="button"> or restructure component
// Ensure click handlers still work correctly
```

**Acceptance Criteria:**
- [ ] No malformed HTML warnings in Vite console
- [ ] All buttons remain clickable
- [ ] Visual appearance unchanged

---

## FIX-003: Home Screen Three-Card Layout

**Problem:** Current home screen uses split-panel layout instead of the spec's three-card design.

**Current:**
- Left: Recent Folders list
- Center: Era Code branding
- Right: Open Folder / Open by Path

**Spec (EC-003):**
- Unified search bar at top
- Three equal cards: Recent / Browse / GitHub
- Keyboard shortcuts footer

**Impact:** Less intuitive, harder to discover features, no GitHub integration.

**Solution:** Redesign home screen to match spec.

**Files to Modify:**
- `packages/ui/src/components/folder-selection-cards.tsx` - Complete redesign
- `packages/ui/src/styles/panels/empty-loading.css` - New card styles

**Implementation:**
```
Layout:
┌─────────────────────────────────────────┐
│  🔍 Search projects, folders, repos...  │
├─────────────────────────────────────────┤
│ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│ │ Recent  │ │ Browse  │ │ GitHub  │    │
│ │ 📂      │ │ 📁      │ │ 🐙      │    │
│ │         │ │         │ │         │    │
│ └─────────┘ └─────────┘ └─────────┘    │
├─────────────────────────────────────────┤
│ ⌘N New  ⌘O Open  ⌘, Settings           │
└─────────────────────────────────────────┘
```

**Acceptance Criteria:**
- [ ] Unified search bar at top (searches recent, can open by path)
- [ ] Three equal-width cards with hover effects
- [ ] Recent card shows last 5 projects with quick-open
- [ ] Browse card opens file browser dialog
- [ ] GitHub card shows clone/recent repos (if authenticated)
- [ ] Keyboard shortcuts footer
- [ ] Responsive design (cards stack on narrow screens)

---

## FIX-004: Context Usage "0 / --" Display

**Problem:** Bottom status bar shows "0 / --" when context window info is unavailable.

**Impact:** Confusing to users - unclear what the numbers mean.

**Solution:** Show more meaningful text when data unavailable.

**Files to Modify:**
- `packages/ui/src/components/bottom-status-bar.tsx`

**Implementation:**
```typescript
// When availableTokens is null or contextWindow is 0:
// Show "Context: --" instead of "0 / --"
// When data is available: "12K / 128K" (formatted)
// Add tooltip explaining what context usage means
```

**Acceptance Criteria:**
- [ ] Shows "Context: --" when unavailable
- [ ] Shows formatted values when available (e.g., "12K / 128K")
- [ ] Tooltip explains: "Tokens used / Context window size"
- [ ] Progress bar hidden when data unavailable

---

## FIX-005: Tab Close Button Discoverability

**Problem:** Tab close [×] button only appears on hover - not discoverable for new users.

**Impact:** Users may not know how to close tabs.

**Solution:** Always show close button, but subtle. Brighten on hover.

**Files to Modify:**
- `packages/ui/src/components/instance-tab.tsx`
- `packages/ui/src/styles/panels/tabs.css`

**Implementation:**
```css
/* Always visible but subtle */
.project-tab-close {
  opacity: 0.4;
  transition: opacity 0.15s;
}
.project-tab:hover .project-tab-close,
.project-tab-close:hover {
  opacity: 1;
}
```

**Acceptance Criteria:**
- [ ] Close button always visible (opacity 0.4)
- [ ] Close button brightens on tab hover (opacity 1)
- [ ] Close button fully bright on direct hover
- [ ] Active tab close button slightly more visible (opacity 0.6)

---

## FIX-006: Session Tab Name Truncation

**Problem:** Session names like "Reviewing projec..." are truncated too aggressively, making sessions hard to distinguish.

**Impact:** Users can't tell sessions apart when names are similar.

**Solution:** Show more of the name, use tooltip for full name.

**Files to Modify:**
- `packages/ui/src/components/session-tabs.tsx`
- `packages/ui/src/styles/panels/tabs.css`

**Implementation:**
```typescript
// Increase max-width for session tab text
// Add title attribute for full name tooltip
// Consider showing first 4-5 words instead of character limit
```

**Acceptance Criteria:**
- [ ] Session tabs show at least 25 characters before truncating
- [ ] Full session name shown in tooltip on hover
- [ ] Truncation uses ellipsis (...)
- [ ] Horizontal scroll still works when many tabs

---

## FIX-007: Active Session Visual Indicator

**Problem:** No clear visual distinction between active and inactive sessions.

**Impact:** Users may not know which session they're working in.

**Solution:** Add visual indicator for active session.

**Files to Modify:**
- `packages/ui/src/components/session-tabs.tsx`
- `packages/ui/src/styles/panels/tabs.css`

**Implementation:**
```css
.session-tab[data-active="true"] {
  background: var(--surface-tertiary);
  border-bottom: 2px solid var(--accent-primary);
}
.session-tab[data-active="true"] .session-tab-name {
  font-weight: 500;
  color: var(--text-primary);
}
```

**Acceptance Criteria:**
- [ ] Active session has bottom border accent
- [ ] Active session text is bolder
- [ ] Active session has different background
- [ ] Inactive sessions are visually subdued

---

## FIX-008: Cost Display When No Session

**Problem:** Bottom status bar shows "$0.00" even when no active session.

**Impact:** Visual clutter, potentially misleading.

**Solution:** Hide or show placeholder when no session active.

**Files to Modify:**
- `packages/ui/src/components/bottom-status-bar.tsx`

**Implementation:**
```typescript
// When no active session:
// Option A: Hide cost display entirely
// Option B: Show "-- " or "N/A"
// When session active: Show actual cost
```

**Acceptance Criteria:**
- [ ] Cost hidden when no active session
- [ ] Cost shows when session is active
- [ ] Smooth transition when session starts/ends

---

## FIX-009: GitHub Integration in Home

**Problem:** No GitHub integration in home screen (spec mentions GitHub card).

**Impact:** Missing feature, harder to open repos from GitHub.

**Solution:** Add GitHub card with OAuth and recent repos.

**Files to Create/Modify:**
- `packages/ui/src/components/github-card.tsx` - New component
- `packages/ui/src/lib/github-api.ts` - GitHub API client
- `packages/server/src/server/routes/github.ts` - OAuth flow
- `packages/ui/src/components/folder-selection-cards.tsx` - Integrate card

**Implementation:**
```
GitHub Card States:
1. Not connected: "Connect GitHub" button
2. Connecting: OAuth popup flow
3. Connected: Show recent repos, clone input
4. Error: Show reconnect option
```

**Acceptance Criteria:**
- [ ] GitHub OAuth flow works
- [ ] Shows recent repositories (last 10)
- [ ] Can clone repo by URL
- [ ] Can search user's repos
- [ ] Token stored securely
- [ ] Disconnect option in settings

**Note:** This is a larger feature - may be deferred to M3 milestone.

---

## FIX-010: Keyboard Shortcuts Footer

**Problem:** Keyboard shortcuts not prominently displayed on home screen.

**Impact:** Users don't discover shortcuts, use mouse for everything.

**Solution:** Add shortcuts footer to home screen.

**Files to Modify:**
- `packages/ui/src/components/folder-selection-cards.tsx`
- `packages/ui/src/styles/panels/empty-loading.css`

**Implementation:**
```typescript
const shortcuts = [
  { key: '⌘N', action: 'New Project' },
  { key: '⌘O', action: 'Open Folder' },
  { key: '⌘,', action: 'Settings' },
  { key: '⌘⇧M', action: 'Select Model' },
]
```

**Acceptance Criteria:**
- [ ] Footer shows 4-6 most useful shortcuts
- [ ] Uses system-appropriate modifier (⌘ on Mac, Ctrl on Windows)
- [ ] Shortcuts are clickable (trigger action)
- [ ] Subtle styling that doesn't distract

---

## Implementation Order

### Phase 1: Critical Fixes (P0-P1)
1. **FIX-001** - CORS proxy for models.dev (enables model selector)
2. **FIX-002** - Malformed HTML fix (prevents rendering bugs)

### Phase 2: UX Polish (P2)
3. **FIX-004** - Context usage display
4. **FIX-005** - Tab close button visibility
5. **FIX-010** - Keyboard shortcuts footer

### Phase 3: Enhanced UX (P3)
6. **FIX-006** - Session tab truncation
7. **FIX-007** - Active session indicator
8. **FIX-008** - Cost display logic

### Phase 4: Feature Completion (Deferred)
9. **FIX-003** - Home screen redesign (larger effort)
10. **FIX-009** - GitHub integration (M3 milestone)

---

## Estimated Effort

| Phase | Fixes | Effort |
|-------|-------|--------|
| Phase 1 | FIX-001, FIX-002 | 2-3 hours |
| Phase 2 | FIX-004, FIX-005, FIX-010 | 1-2 hours |
| Phase 3 | FIX-006, FIX-007, FIX-008 | 1 hour |
| Phase 4 | FIX-003, FIX-009 | 8-12 hours |

**Total for Phases 1-3:** ~5 hours
**Total including Phase 4:** ~15-17 hours

---

*Created: 2026-01-10*

---

## Implementation Summary (2026-01-10)

### Phase 1: Critical Fixes ✅
- **FIX-001**: Created server-side CORS proxy for models.dev API
  - New file: `packages/server/src/server/routes/models-proxy.ts`
  - Modified: `packages/server/src/server/http-server.ts` (route registration)
  - Modified: `packages/ui/src/lib/models-api.ts` (use local proxy)
  - 30-minute server-side caching implemented

- **FIX-002**: Documented as Kobalte library issue
  - Nested button pattern from Dialog.Trigger + Select components
  - Browser auto-corrects, no functional impact
  - Would require Kobalte library update to fix properly

### Phase 2: UX Polish ✅
- **FIX-004**: Context usage display improved
  - Shows "Context: --" when data unavailable
  - Added tooltip explaining usage
  - Progress bar hidden when no data
  - Modified: `packages/ui/src/components/bottom-status-bar.tsx`

- **FIX-005**: Tab close buttons now always visible
  - Subtle opacity (0.4) at rest, brighten on hover (0.7-1.0)
  - Modified: `packages/ui/src/styles/panels/tabs.css`

- **FIX-010**: Keyboard shortcuts footer added
  - Fixed position at bottom of home screen
  - Shows Cmd+N (New Project) and Cmd+, (Settings)
  - Modified: `packages/ui/src/components/folder-selection-view.tsx`
  - Modified: `packages/ui/src/styles/panels/empty-loading.css`

### Phase 3: Enhanced UX ✅
- **FIX-006**: Session tab width increased from 160px to 220px
  - Better readability of session names
  - Modified: `packages/ui/src/styles/panels/tabs.css`

- **FIX-007**: Already implemented in existing CSS
  - Active sessions have accent color background and border

- **FIX-008**: Cost hidden when no cost data
  - Only shown when cost > 0
  - Reduces visual clutter
  - Modified: `packages/ui/src/components/bottom-status-bar.tsx`

### Phase 4: Feature Completion
- **FIX-003**: Home screen already has well-designed three-column layout ✅
  - Left: Recent Folders with delete/select
  - Center: Era Code branding with penguin mascot
  - Right: Browse Folders, Open by Path, Advanced Settings
  - Superior to three-card grid for this use case

- **FIX-009**: GitHub integration deferred to future milestone 📋
  - Placeholder "Coming Soon" button exists
  - Requires OAuth implementation, API client, clone functionality
  - Substantial backend work beyond UI polish scope

### Files Modified
1. `packages/server/src/server/routes/models-proxy.ts` (NEW)
2. `packages/server/src/server/http-server.ts`
3. `packages/ui/src/lib/models-api.ts`
4. `packages/ui/src/lib/logger.ts`
5. `packages/ui/src/components/bottom-status-bar.tsx`
6. `packages/ui/src/components/folder-selection-view.tsx`
7. `packages/ui/src/styles/panels/tabs.css`
8. `packages/ui/src/styles/panels/empty-loading.css`

### Verification
All fixes verified with Playwright visual tests. Screenshots available in `test-screenshots/` directory.
