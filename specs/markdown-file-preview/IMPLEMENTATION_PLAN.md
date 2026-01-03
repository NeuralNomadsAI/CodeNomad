# Markdown File Preview Feature - Implementation Plan

## Feature Overview
Enable users to preview `.md` files mentioned in chat history. When detected, a book icon appears on message blocks (positioned carefully to avoid obscuring content). Clicking opens a popup modal with GitHub-style markdown rendering that works in both Electron and web browser (Remote Handover streaming).

## Success Criteria
- ✅ Detect .md file paths in chat messages (validation via regex)
- ✅ Display discoverable preview icon on message blocks
- ✅ Icon positioned to not block existing content (smart placement)
- ✅ Popup modal with markdown preview renders correctly
- ✅ Light/dark theme support for markdown
- ✅ Modal closure via ESC, X button, or click outside
- ✅ Works in Electron and web browser
- ✅ Streams properly to Remote Handover web clients
- ✅ Large files handled gracefully (no performance degradation)
- ✅ Follows CodeNomad design tokens and spacing

## Technical Approach

### File Detection Strategy
```
Parse message text → 
Regex match for .md file patterns → 
Validate path format (optional: check existence) → 
Mark file locations in message → 
Render preview icon at message header
```

### Regex Pattern Strategy
- Basic: `/\b[\w\-./]+\.md\b/g` (files with .md extension)
- Enhanced: `/(?:file|path|doc):\s*([^\s]+\.md)/gi` (context-aware detection)
- Validation: Ensure path doesn't contain invalid characters, reasonable length

### Data Flow for Preview
```
User clicks preview icon → 
Fetch markdown content from server (endpoint TBD) → 
Render in modal with marked + shiki → 
Apply GitHub markdown CSS + theme → 
Modal closes on ESC or X button
```

### Reusable Patterns
- **Markdown component** (`components/markdown.tsx`) - PROVEN RENDERER
- **Markdown engine** (`lib/markdown.ts`) - CACHING, THEME-AWARE
- **Kobalte Dialog** (used in `advanced-settings-modal.tsx`) - MODAL PATTERN
- **Message block structure** (`message-block.tsx`) - REFERENCE FOR ICON PLACEMENT
- **Theme system** (light/dark via CSS variables) - EXISTING

### New Components
- `MarkdownPreviewIcon.tsx` - Book icon button on message header
- `MarkdownPreviewModal.tsx` - Full-screen modal with preview
- `useMarkdownPreview.ts` - Hook for fetching/caching preview content
- Styling: `markdown-preview.css`

### Server API Gap
**Known Issue**: Need endpoint to serve raw markdown file content

**Workaround Options**:
1. Use existing file API if available (`GET /files/{path}`)
2. Create new endpoint (`GET /api/files/preview?path={path}`)
3. Stream from message context (if file already in message)

**For MVP**: Mock with file content from message block (if embedded) or show "File not accessible" gracefully

## Task Breakdown

### Phase 1: File Detection & Validation (Tasks 1-1 to 1-3)
**Parallel** ⚡

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 1.1 | Create markdown file detection regex | 30m | `lib/markdown-file-detector.ts` - export detectMarkdownFiles(text) |
| 1.2 | Create file path validator | 30m | `lib/file-path-validator.ts` - whitelist safe characters, format |
| 1.3 | Create hook for fetching markdown content | 1h | `lib/hooks/use-markdown-preview.ts` - fetch with error handling |

### Phase 2: UI Components (Tasks 2-1 to 2-4)
**Sequential**: 2.1 → 2.2 → 2.3 → 2.4

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 2.1 | Create MarkdownPreviewIcon component | 45m | `components/markdown-preview-icon.tsx` - book icon, tooltip |
| 2.2 | Create MarkdownPreviewModal component | 1.5h | `components/markdown-preview-modal.tsx` - Kobalte Dialog wrapper |
| 2.3 | Integrate markdown rendering into modal | 1h | Use existing `Markdown` component, handle theme switching |
| 2.4 | Create component styling (icon, modal, padding) | 1h | `styles/messaging/markdown-preview.css` |

### Phase 3: Message Block Integration (Tasks 3-1 to 3-3)
**Sequential**: 3.1 → 3.2 → 3.3

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 3.1 | Detect markdown files in message-block.tsx | 1h | Call detectMarkdownFiles(), store results in component state |
| 3.2 | Render MarkdownPreviewIcon on message header | 45m | Conditional render icon, position carefully |
| 3.3 | Wire click handler to open modal with selected file | 45m | Pass file path to modal, trigger fetch + render |

### Phase 4: Remote Handover Support (Tasks 4-1 to 4-2)
**Sequential**: 4.1 → 4.2

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 4.1 | Ensure modal state syncs to Remote Handover stream | 1h | Verify modal open/close events propagate via IPC/WebSocket |
| 4.2 | Test modal rendering in web browser client | 1h | Verify Kobalte Dialog works in browser, styling correct |

### Phase 5: Edge Cases & Performance (Tasks 5-1 to 5-3)
**Parallel** ⚡

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 5.1 | Handle large file preview (lazy load, truncation) | 1h | Implement file size check, truncate if > 500KB |
| 5.2 | Handle file not found errors gracefully | 45m | Show "File not accessible" message in modal |
| 5.3 | Cache preview content (avoid re-fetching) | 45m | Implement simple in-memory cache with LRU eviction |

### Phase 6: Polish & Testing (Tasks 6-1 to 6-4)
**Parallel** ⚡

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 6.1 | Test in Electron (file fetching, rendering) | 1h | Verify file paths resolve correctly, preview renders |
| 6.2 | Test in web browser (Remote Handover) | 1h | Verify modal displays, file access via API |
| 6.3 | Theme testing (light/dark mode consistency) | 45m | Ensure markdown preview colors match chat theme |
| 6.4 | Icon positioning refinement (no content overlap) | 45m | Test on various message types/lengths, adjust placement |

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| False positive file detection | Whitelist .md extension only, validate path format (alphanumeric + -/./_) |
| Large file performance | Implement 500KB size limit, truncate with "..." indicator |
| Server API gap | Use mock data for MVP, create endpoint later (POST /api/files/preview) |
| Theme mismatch | Use existing Markdown component (theme-aware) + github-markdown-css override |
| File not accessible in browser | Show user-friendly error: "This file is only accessible in Electron" or "File not found" |
| Icon blocking content | Position in message header (top-right corner), use small size (16-20px) |
| Modal z-axis conflicts | Use Kobalte Dialog (auto-manages stacking context) |
| Remote Handover sync issues | Test IPC events for modal open/close, verify WebSocket streaming |

## Component Props & Interfaces

### MarkdownPreviewIcon Props
```typescript
interface MarkdownPreviewIconProps {
  filePath: string
  onOpenPreview: (filePath: string) => void
}
```

### MarkdownPreviewModal Props
```typescript
interface MarkdownPreviewModalProps {
  isOpen: boolean
  filePath: string
  content?: string
  isLoading?: boolean
  error?: string
  onClose: () => void
  isDarkMode?: boolean
}
```

### useMarkdownPreview Hook
```typescript
interface UseMarkdownPreviewResult {
  content: Accessor<string | null>
  isLoading: Accessor<boolean>
  error: Accessor<string | null>
  fetch: (filePath: string) => Promise<void>
  clear: () => void
}
```

## Files to Create

```
specs/markdown-file-preview/
├── IMPLEMENTATION_PLAN.md (this file)
├── COMPONENT_SPEC.md
├── API_SPEC.md
├── TESTING_STRATEGY.md
├── markdown-file-detector.ts (utility)
├── file-path-validator.ts (utility)
└── markdown-preview-modal.tsx (example component)
```

## Integration Points

1. **Message Block** (`components/message-block.tsx`):
   - Call `detectMarkdownFiles()` on message text
   - Render `<MarkdownPreviewIcon>` on header conditionally
   - Pass file paths to icon component

2. **Markdown Component** (`components/markdown.tsx`):
   - Already supports theme switching
   - Reuse in modal (no changes needed)

3. **Styling** (aggregate files):
   - Import `markdown-preview.css` into `styles/messaging.css`
   - Use existing theme CSS variables

4. **Server** (potential future):
   - Create `GET /api/files/preview?path={path}` endpoint
   - Return raw markdown content
   - Add access control (only files in workspace)

## Success Verification Checklist

- [ ] Markdown files in messages detected via regex
- [ ] Book icon displays on messages with .md files
- [ ] Icon positioned top-right, doesn't block content
- [ ] Clicking icon opens modal with preview
- [ ] Markdown renders with GitHub styling
- [ ] Light/dark theme correctly applied
- [ ] Modal closes on ESC key
- [ ] Modal closes on X button
- [ ] Modal closes on outside click
- [ ] Large files truncated gracefully
- [ ] File not found shows error message
- [ ] Works in Electron
- [ ] Works in web browser
- [ ] Streams properly to Remote Handover clients
- [ ] No performance degradation on large chats

## Estimated Total Time
- **Planning**: 1.5h (design + architecture)
- **Detection & Validation**: 2h (regex, validators, hooks)
- **UI Components**: 5-6h (icon, modal, styling, rendering)
- **Integration**: 3h (message block wiring, server API handling)
- **Remote Handover**: 2h (IPC/WebSocket testing)
- **Edge Cases & Performance**: 2-3h (caching, truncation, error handling)
- **Testing & Polish**: 3h (Electron, browser, theme, positioning)
- **Total: 18-22 hours**

## Notes
- Reuse existing Markdown component (proven, caching, theme-aware)
- No new markdown rendering dependencies (all present)
- Server API is future work (MVP uses mock/embedded content)
- Prioritize file detection accuracy to avoid false positives
- Test Remote Handover streaming carefully (IPC event propagation)
- Consider future enhancement: drag-and-drop preview panel into separate window
