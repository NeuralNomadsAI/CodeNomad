# API Specification for Markdown Preview

## Server Endpoint (Future - MVP uses mock data)

### Get File Preview Content

**Endpoint**: `GET /api/files/preview`

**Parameters**:
```
?path={encodedFilePath}
```

**Example**:
```
GET /api/files/preview?path=docs%2Fguide.md
```

**Success Response** (200 OK):
```json
{
  "success": true,
  "path": "docs/guide.md",
  "content": "# Guide Content\n\n...",
  "size": 1234,
  "lastModified": "2024-01-04T12:00:00Z"
}
```

**Error Response** (404 Not Found):
```json
{
  "success": false,
  "error": "File not found",
  "path": "docs/nonexistent.md"
}
```

**Error Response** (403 Forbidden):
```json
{
  "success": false,
  "error": "Access denied",
  "path": "../../../etc/passwd.md"
}
```

**Error Response** (400 Bad Request):
```json
{
  "success": false,
  "error": "Invalid path format",
  "path": ""
}
```

### Security Considerations

1. **Path Validation**: Server must validate paths (no `..`, no absolute paths)
2. **File Boundaries**: Only serve files within workspace directory
3. **File Type**: Only serve `.md` files
4. **Size Limit**: Enforce maximum file size (e.g., 1MB)
5. **Access Control**: Respect instance/workspace permissions

---

## Client-Side API (useMarkdownPreview Hook)

### Hook Signature

```typescript
export function useMarkdownPreview(): {
  content: Accessor<string | null>
  isLoading: Accessor<boolean>
  error: Accessor<string | null>
  lastFilePath: Accessor<string | null>
  fetch: (filePath: string) => Promise<void>
  clear: () => void
  clearCurrent: () => void
}
```

### Usage Pattern

```typescript
import { useMarkdownPreview } from "../lib/hooks/use-markdown-preview"

export default function MyComponent() {
  const preview = useMarkdownPreview()

  const handleOpenPreview = async (filePath: string) => {
    await preview.fetch(filePath)
    setModalOpen(true)
  }

  return (
    <>
      <button onClick={() => handleOpenPreview("docs/guide.md")}>
        Open Preview
      </button>

      <Show when={preview.isLoading()}>
        <LoadingSpinner />
      </Show>

      <Show when={preview.error()}>
        <ErrorMessage message={preview.error()!} />
      </Show>

      <Show when={preview.content()}>
        <div class="markdown-content">
          {preview.content()}
        </div>
      </Show>
    </>
  )
}
```

### Error Handling

Hook returns user-friendly error messages:

```typescript
// Invalid path
error() === "Path cannot contain directory traversal (..) sequences"

// Fetch failed
error() === "Failed to fetch markdown file: 404 Not Found"

// File not found (from server)
error() === "File not found: docs/missing.md"

// Access denied
error() === "Access denied: Cannot access files outside workspace"
```

---

## Integration with Markdown Component

The hook content feeds into existing `<Markdown>` component:

```typescript
import Markdown from "./markdown"
import { useMarkdownPreview } from "../lib/hooks/use-markdown-preview"

export default function MarkdownPreviewModal(props) {
  const preview = useMarkdownPreview()

  createEffect(() => {
    if (props.filePath && props.isOpen) {
      preview.fetch(props.filePath)
    }
  })

  return (
    <Dialog open={props.isOpen} onOpenChange={props.onClose}>
      <Show when={preview.isLoading()}>
        <div>Loading...</div>
      </Show>

      <Show when={preview.content()}>
        <Markdown content={preview.content()!} />
      </Show>

      <Show when={preview.error()}>
        <ErrorBox message={preview.error()!} />
      </Show>
    </Dialog>
  )
}
```

---

## Utility Functions API

### File Detection

```typescript
import { detectMarkdownFiles } from "../lib/markdown-file-detector"

const text = "See docs/guide.md and README.md for details"
const matches = detectMarkdownFiles(text)
// Returns: [
//   { filePath: "docs/guide.md", start: 4, end: 17 },
//   { filePath: "README.md", start: 22, end: 30 }
// ]
```

### Path Validation

```typescript
import { 
  isValidMarkdownPath, 
  sanitizeMarkdownPath, 
  validateMarkdownPath 
} from "../lib/file-path-validator"

// Simple validation
isValidMarkdownPath("docs/guide.md") // true
isValidMarkdownPath("../../../etc/passwd.md") // false

// Sanitization
sanitizeMarkdownPath("  path/to/ file .md  ") 
// Returns: "path/to/file.md"

// Detailed validation
const result = validateMarkdownPath("../malicious.md")
// Returns: {
//   filePath: "../malicious.md",
//   isValid: false,
//   sanitized: "",
//   error: "Path cannot contain directory traversal (..) sequences"
// }
```

### Filter Commands

```typescript
import { 
  filterCommands, 
  highlightMatch 
} from "../lib/command-filter"

const commands = [
  { name: "analyze", description: "Analyze code", ... },
  { name: "refactor", description: "Refactor code", ... }
]

// Filter by query
const results = filterCommands("ana", commands)
// Returns: [{ name: "analyze", ... }]

// Highlight matches in text
const segments = highlightMatch("analyze code", "ana")
// Returns: [
//   { text: "ana", isMatch: true },
//   { text: "lyze code", isMatch: false }
// ]
```

---

## Environment Variables (Future)

When implementing real server API:

```env
# .env or instance config
CODENOMAD_API_BASE_URL=http://localhost:3000
CODENOMAD_FILES_PREVIEW_ENDPOINT=/api/files/preview
CODENOMAD_FILES_MAX_SIZE_MB=5
```

---

## Type Definitions

### Command-Related Types

```typescript
// From @opencode-ai/sdk
export type Command = {
  name: string
  description?: string
  agent?: string
  model?: string
  template: string
  subtask?: boolean
}
```

### Markdown-Related Types

```typescript
// File detection
export interface MarkdownFileMatch {
  filePath: string
  start: number
  end: number
}

// Path validation
export interface MarkdownFileValidationResult {
  filePath: string
  isValid: boolean
  sanitized: string
  error?: string
  message?: string
}

// File info
export interface MarkdownFileInfo {
  filePath: string
  isValid: boolean
  sanitized: string
  error?: string
}

// Preview response
export interface MarkdownPreviewResponse {
  success: boolean
  path?: string
  content?: string
  size?: number
  lastModified?: string
  error?: string
}
```

---

## MVP Limitations

Current implementation (Phase 1):

1. ❌ No real server API (uses mock data)
2. ❌ No file size validation
3. ❌ No access control (all files accessible in mock)
4. ❌ No file modification detection
5. ✅ Path validation works (prevents traversal attacks)
6. ✅ Caching works (LRU, last 5 files)
7. ✅ Hook state management works
8. ✅ All utilities tested

### Mock Data Files
```typescript
// Available for preview in MVP:
- README.md
- docs/guide.md
- docs/api.md
```

### Upgrade Path

To implement real server API:

1. Create endpoint in `packages/server/src/routes/files.ts`
2. Add route handler for `GET /api/files/preview`
3. Replace mock implementation in `fetchMarkdownContent()`
4. Add file size checks and validation
5. Integrate with workspace permissions
6. Add caching at server level

---

## Caching Strategy

### Client-Side Cache

```typescript
// LRU cache in useMarkdownPreview hook
// Keeps last 5 files in memory
// Auto-evicts oldest when limit reached

const cache = new Map<string, string>()
const MAX_CACHE_SIZE = 5

// When fetching:
if (cache.has(filePath)) {
  return cache.get(filePath)  // Cache hit
}

// After fetch:
if (cache.size >= MAX_CACHE_SIZE) {
  const oldest = cache.keys().next().value
  cache.delete(oldest)
}
cache.set(filePath, content)
```

### Cache Invalidation

```typescript
// Clear all cache
preview.clear()

// Clear only current content (keep cache)
preview.clearCurrent()

// Cache invalidated when:
// - Component unmounts
// - User closes app
// - Error occurs (re-fetch on retry)
```

---

## Error Scenarios

### Invalid Path

```
Input: "../../../etc/passwd.md"
Validation: Fails (contains ..)
Error Message: "Path cannot contain directory traversal (..) sequences"
Action: Don't attempt to fetch
```

### File Not Found

```
Input: "nonexistent/file.md" (valid format)
Fetch: Attempted (passes validation)
Server: Returns 404
Error Message: "File not found: nonexistent/file.md"
Action: Show error in modal
```

### Access Denied

```
Input: "../../other-workspace/file.md" (fails validation first)
OR: valid path outside workspace (server rejects)
Server: Returns 403
Error Message: "Access denied: Cannot access files outside workspace"
Action: Show error in modal
```

### Network Error

```
Fetch: Network timeout or connection error
Error Message: "Failed to fetch markdown file: [network error]"
Action: Show error, allow retry
```

### Large File

```
Input: "large-document.md" (2MB)
Fetch: Succeeds
Size Check: Fails (> 500KB)
Truncation: Show first 500KB + "..."
Message: "File truncated (2.0MB, showing first 500KB)"
```

---

## Performance Targets

- ✅ Command filtering: < 10ms for 100 commands
- ✅ Markdown detection: < 5ms for 10KB text
- ✅ Path validation: < 1ms per path
- ✅ File fetch: Network dependent (mock: instant)
- ✅ Markdown rendering: Existing component (proven fast)
- ✅ Modal open: < 500ms total (fetch + render)

---

## Browser/Electron Compatibility

### Electron
- ✅ File system access via IPC
- ✅ Mock API sufficient for MVP
- ✅ Real API uses existing IPC patterns

### Web Browser
- ✅ Mock API returns data directly
- ✅ Real API uses `fetch()` to server endpoint
- ✅ CORS handled by server
- ✅ Works with Remote Handover WebSocket

---

## Future Enhancements

1. **Real Server API** - File preview endpoint
2. **File Watching** - Detect changes, refresh preview
3. **Syntax Highlighting** - Already via shiki
4. **Table of Contents** - Auto-generated from headers
5. **Search in Preview** - Find text within file
6. **Export Preview** - Save as PDF
7. **Split View** - Preview in separate window
8. **File Diff** - Show changes from workspace version
