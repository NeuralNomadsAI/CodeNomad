# Markdown File Preview Component Specification

## Component: MarkdownPreviewIcon

Small book icon button displayed on message blocks that contain markdown file references.

### Props Interface

```typescript
interface MarkdownPreviewIconProps {
  // Path to the markdown file (validated)
  filePath: string

  // Callback when icon is clicked to open preview
  onOpenPreview: (filePath: string) => void

  // Optional CSS class for positioning
  className?: string

  // Tooltip text (optional, defaults to filename)
  tooltip?: string

  // Icon size in pixels (default: 18)
  size?: number
}
```

### Rendering

- **Icon**: Book/document icon from lucide-solid
- **Size**: 16-20px (small, non-intrusive)
- **Position**: Top-right corner of message block header
- **Tooltip**: Filename or "Preview markdown" on hover
- **Cursor**: Pointer on hover, visual feedback

### Behavior

- **Hover**: Show tooltip, icon color darkens/lightens
- **Click**: Call `onOpenPreview(filePath)` 
- **No text label**: Icon only (space efficiency)
- **Accessibility**: ARIA label + role="button"

### Example Usage

```tsx
<MarkdownPreviewIcon
  filePath="docs/guide.md"
  onOpenPreview={(path) => openPreviewModal(path)}
  tooltip="Preview documentation"
/>
```

---

## Component: MarkdownPreviewModal

Full-screen modal dialog displaying markdown file preview with GitHub-style rendering.

### Props Interface

```typescript
interface MarkdownPreviewModalProps {
  // Whether modal is open/visible
  isOpen: boolean

  // Path to markdown file being previewed
  filePath: string

  // Markdown content (pre-fetched or null if loading)
  content?: string | null

  // True if content is being fetched
  isLoading?: boolean

  // Error message if fetch failed
  error?: string | null

  // Callback when modal closes (ESC, X button, click outside)
  onClose: () => void

  // Whether to use dark theme (optional, can auto-detect)
  isDarkMode?: boolean
}
```

### Layout

```
┌─────────────────────────────────────┐
│  docs/guide.md        [X] [>>]      │  Header: title + close btn + expand btn
├─────────────────────────────────────┤
│                                     │
│  # Getting Started Guide            │
│                                     │  Content area:
│  Welcome to the guide!              │  - Uses <Markdown> component
│                                     │  - GitHub markdown CSS styling
│  ### Prerequisites                  │  - Syntax highlighting via shiki
│  - Node.js 18+                      │  - Scrollable if content large
│  - npm or yarn                      │
│                                     │
│  ### Step 1: Setup                  │
│  ...                                │
├─────────────────────────────────────┤
│  Powered by GitHub Markdown CSS     │  Footer: Attribution
└─────────────────────────────────────┘
```

### States

#### Loading State
```
┌─────────────────────────────────────┐
│  docs/guide.md        [X]           │
├─────────────────────────────────────┤
│                                     │
│           ⟳ Loading preview...      │
│                                     │
└─────────────────────────────────────┘
```

#### Error State
```
┌─────────────────────────────────────┐
│  docs/guide.md        [X]           │
├─────────────────────────────────────┤
│                                     │
│  ⚠ Error: File not found            │
│                                     │
│  The file 'docs/guide.md' could     │
│  not be found or accessed.          │
│                                     │
└─────────────────────────────────────┘
```

#### Success State
- Render markdown via existing `<Markdown>` component
- Apply GitHub markdown CSS
- Theme respects dark/light mode

### Behavior

#### Modal Controls
- **X Button** (top-right): Close modal
- **Expand Button**: Open in separate window (future)
- **ESC key**: Close modal
- **Click outside**: Close modal (if clickable area detected)

#### Content Area
- **Scrollable**: If content > 600px height
- **Responsive**: Adapts to window size
- **Max-width**: 900px (readability)
- **Padding**: 24px (breathing room)

#### Keyboard
- **Escape**: Close
- **Ctrl+W** or **Cmd+W**: Close (optional)

#### Mouse
- Click X button: Close
- Click outside content area: Close
- Scroll: Navigate content

### Example Usage

```tsx
const [previewFile, setPreviewFile] = createSignal<string | null>(null)
const preview = useMarkdownPreview()

const openPreview = async (filePath: string) => {
  setPreviewFile(filePath)
  await preview.fetch(filePath)
}

<MarkdownPreviewModal
  isOpen={previewFile() !== null}
  filePath={previewFile() || ""}
  content={preview.content()}
  isLoading={preview.isLoading()}
  error={preview.error()}
  onClose={() => {
    setPreviewFile(null)
    preview.clearCurrent()
  }}
  isDarkMode={isDarkMode()}
/>
```

---

## Component: MessageBlockMarkdownSupport

Integration layer that detects markdown files and renders preview icons on message blocks.

### Props Interface

```typescript
interface MessageBlockMarkdownSupportProps {
  // Message content/text
  messageText: string

  // Callback to open preview modal
  onOpenPreview: (filePath: string) => void

  // Optional CSS class for icon container
  iconContainerClass?: string
}
```

### Behavior

1. **Detection**: Calls `detectMarkdownFiles(messageText)`
2. **Validation**: Filters results via `isValidMarkdownPath()`
3. **Rendering**: Creates `MarkdownPreviewIcon` for each valid file
4. **Position**: Icons placed in message header (top-right area)

### Example Usage

```tsx
// Inside MessageBlock component
const messageText = () => props.message.text

<div class="message-header">
  <MessageBlockMarkdownSupport
    messageText={messageText()}
    onOpenPreview={(path) => openPreviewModal(path)}
  />
  {/* existing header content */}
</div>
```

---

## CSS Classes & Styling

### Modal Styling
```css
.markdown-preview-modal
  .markdown-preview-modal-header
    .markdown-preview-modal-title
    .markdown-preview-modal-close-btn
  .markdown-preview-modal-content
    .markdown-preview-loading
    .markdown-preview-error
    .markdown-preview-rendered
  .markdown-preview-modal-footer

.markdown-preview-icon
  .markdown-preview-icon-button
    &:hover
    &:active

.markdown-preview-icons
  .markdown-preview-icons-container
```

### Theme Integration

**Dark Mode:**
- Background: `var(--bg-elevated)` or similar
- Text: `var(--text-primary)`
- Border: `var(--border-subtle)`
- Markdown CSS: GitHub markdown dark theme

**Light Mode:**
- Background: `var(--bg-base)`
- Text: `var(--text-primary)`
- Border: `var(--border-default)`
- Markdown CSS: GitHub markdown light theme

---

## Integration Points

### In MessageBlock.tsx

1. **Import**: 
   ```typescript
   import { detectMarkdownFiles, isValidMarkdownPath } from "../lib/markdown-file-detector"
   import MarkdownPreviewIcon from "./markdown-preview-icon"
   ```

2. **In render**:
   ```tsx
   const messageFiles = () => detectMarkdownFiles(props.message.text)
   const validFiles = () => messageFiles().filter(f => isValidMarkdownPath(f.filePath))

   <div class="message-header">
     <div class="message-header-actions">
       {/* existing action buttons */}
       <Show when={validFiles().length > 0}>
         <For each={validFiles()}>
           {(file) => (
             <MarkdownPreviewIcon
               filePath={file.filePath}
               onOpenPreview={handleOpenPreview}
             />
           )}
         </For>
       </Show>
     </div>
   </div>
   ```

### In App.tsx or SessionContainer.tsx

1. **State management**:
   ```typescript
   const [previewFile, setPreviewFile] = createSignal<string | null>(null)
   const preview = useMarkdownPreview()

   const handleOpenPreview = async (filePath: string) => {
     setPreviewFile(filePath)
     await preview.fetch(filePath)
   }
   ```

2. **Render modal**:
   ```tsx
   <MarkdownPreviewModal
     isOpen={previewFile() !== null}
     filePath={previewFile() || ""}
     content={preview.content()}
     isLoading={preview.isLoading()}
     error={preview.error()}
     onClose={() => {
       setPreviewFile(null)
       preview.clearCurrent()
     }}
   />
   ```

---

## Remote Handover Support

### IPC Events (Electron)

The modal state must propagate via Electron IPC for Remote Handover:

```typescript
// When modal opens
ipc.send("markdown-preview:open", { filePath, content })

// When modal closes
ipc.send("markdown-preview:close")
```

### WebSocket Streaming (Browser)

For web browser clients accessing Remote Handover:
- Modal open/close events stream via WebSocket
- Content fetches use API endpoint
- Styling syncs via CSS variables

---

## Accessibility

- Modal is properly focused when opened
- Focus returns to trigger element on close
- ARIA labels on all buttons
- Keyboard navigation (ESC to close)
- Screen reader announces file being previewed
- Sufficient color contrast for markdown rendering

---

## Performance Considerations

### File Size Handling
- Maximum 500KB file preview (truncate with indicator)
- Large files show lazy-load message
- Cache keeps last 5 files in memory

### Rendering Optimization
- Use `createMemo()` for filtered file list
- Debounce modal open if fetching takes time
- Lazy-load Markdown component if needed

### Memory
- Clear cache when app closes
- Limit concurrent preview fetches to 1

---

## Testing Strategy

### Unit Tests
- `detectMarkdownFiles()` finds all patterns correctly
- `isValidMarkdownPath()` rejects malicious paths
- `MarkdownPreviewIcon` renders correctly
- `useMarkdownPreview()` hook fetches and caches

### Integration Tests
- Icons appear on messages with .md files
- Clicking icon opens modal
- Modal closes on ESC/X/outside click
- Content renders correctly in modal
- Works in Electron
- Works in web browser (Remote Handover)

### Visual Tests
- Icon position doesn't block message content
- Modal doesn't obscure chat
- Theme colors correct (dark/light)
- No layout shifts or overflow

### Performance Tests
- Large files handled gracefully
- No memory leaks on repeated open/close
- Cache works as expected
