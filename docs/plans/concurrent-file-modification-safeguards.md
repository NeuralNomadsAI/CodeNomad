# Server-Side Concurrent File Modification Safeguards

## Problem Statement

When multiple sessions in a single project attempt to modify the same file simultaneously, data loss or corruption can occur. Currently, the server has **no concurrency safeguards** - all file writes are direct `fs.writeFileSync()` calls without locking, queuing, or conflict detection.

### Vulnerable Files Identified

| File Pattern | Location | Risk Level |
|-------------|----------|------------|
| `.era/memory/directives.md` | Project root | High - User-edited directives |
| `.era/governance.local.yaml` | Project root | High - Override settings |
| `.era/mcp.json` | Project root | Medium - MCP configuration |
| Instance JSON files | Server data dir | Medium - Session state |
| `ConfigStore` files | Server data dir | Low - Global config |

### Current Vulnerable Code Paths

1. **Era Routes** (`packages/server/src/server/routes/era.ts`)
   - `PUT /api/era/directives` - Direct `fs.writeFileSync()`
   - `PUT /api/era/constitution` - Direct `fs.writeFileSync()`
   - `PUT /api/era/governance` - Direct `fs.writeFileSync()`

2. **Instance Store** (`packages/server/src/server/instance-store.ts`)
   - `InstanceStore.write()` - No locking mechanism

3. **Proxy Pass-through** - Raw forwarding without queuing

---

## Recommended Architecture: Layered Safeguards

### Layer 1: File Lock Manager (Primary)

A centralized lock manager that serializes writes to the same file path.

```
┌─────────────────────────────────────────────────────────┐
│                    FileLockManager                       │
├─────────────────────────────────────────────────────────┤
│  locks: Map<string, AsyncMutex>                         │
│  pending: Map<string, { sessionId, timestamp }>         │
├─────────────────────────────────────────────────────────┤
│  acquireLock(path, sessionId, timeout): Promise<Lock>   │
│  releaseLock(path, sessionId): void                     │
│  isLocked(path): boolean                                │
│  getLockHolder(path): string | null                     │
└─────────────────────────────────────────────────────────┘
```

### Layer 2: Content Hash Verification

Track file content hashes to detect external modifications.

```
┌─────────────────────────────────────────────────────────┐
│                  ContentHashTracker                      │
├─────────────────────────────────────────────────────────┤
│  hashes: Map<string, { hash, timestamp, sessionId }>    │
├─────────────────────────────────────────────────────────┤
│  recordHash(path, content, sessionId): void             │
│  verifyHash(path, expectedHash): boolean                │
│  getCurrentHash(path): string | null                    │
│  detectConflict(path, incomingHash): ConflictInfo       │
└─────────────────────────────────────────────────────────┘
```

### Layer 3: Conflict Resolution Strategy

Configurable resolution when conflicts are detected.

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| `fail-fast` | Reject write, return error | Default for user files |
| `queue` | Serialize writes, apply in order | Background operations |
| `last-write-wins` | Accept latest write | Low-priority files |
| `merge` | Attempt 3-way merge | Text files with Git |

---

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Create FileLockManager

**File**: `packages/server/src/server/file-lock-manager.ts`

```typescript
import { Mutex } from 'async-mutex'

interface LockInfo {
  sessionId: string
  timestamp: number
  mutex: Mutex
}

interface AcquiredLock {
  path: string
  sessionId: string
  release: () => void
}

class FileLockManager {
  private locks = new Map<string, LockInfo>()
  private static instance: FileLockManager

  static getInstance(): FileLockManager {
    if (!FileLockManager.instance) {
      FileLockManager.instance = new FileLockManager()
    }
    return FileLockManager.instance
  }

  async acquireLock(
    path: string,
    sessionId: string,
    timeoutMs = 5000
  ): Promise<AcquiredLock> {
    const normalizedPath = this.normalizePath(path)

    if (!this.locks.has(normalizedPath)) {
      this.locks.set(normalizedPath, {
        sessionId: '',
        timestamp: 0,
        mutex: new Mutex()
      })
    }

    const lockInfo = this.locks.get(normalizedPath)!

    // Acquire mutex with timeout
    const release = await Promise.race([
      lockInfo.mutex.acquire(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Lock timeout for ${path}`)), timeoutMs)
      )
    ])

    lockInfo.sessionId = sessionId
    lockInfo.timestamp = Date.now()

    return {
      path: normalizedPath,
      sessionId,
      release: () => {
        lockInfo.sessionId = ''
        release()
      }
    }
  }

  isLocked(path: string): boolean {
    const normalizedPath = this.normalizePath(path)
    const lockInfo = this.locks.get(normalizedPath)
    return lockInfo?.mutex.isLocked() ?? false
  }

  getLockHolder(path: string): string | null {
    const normalizedPath = this.normalizePath(path)
    const lockInfo = this.locks.get(normalizedPath)
    if (lockInfo?.mutex.isLocked()) {
      return lockInfo.sessionId
    }
    return null
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/').toLowerCase()
  }
}

export const fileLockManager = FileLockManager.getInstance()
```

#### 1.2 Create ContentHashTracker

**File**: `packages/server/src/server/content-hash-tracker.ts`

```typescript
import { createHash } from 'crypto'
import * as fs from 'fs'

interface HashRecord {
  hash: string
  timestamp: number
  sessionId: string
}

interface ConflictInfo {
  hasConflict: boolean
  currentHash: string | null
  expectedHash: string
  lastModifiedBy: string | null
  lastModifiedAt: number | null
}

class ContentHashTracker {
  private hashes = new Map<string, HashRecord>()
  private static instance: ContentHashTracker

  static getInstance(): ContentHashTracker {
    if (!ContentHashTracker.instance) {
      ContentHashTracker.instance = new ContentHashTracker()
    }
    return ContentHashTracker.instance
  }

  computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  recordHash(path: string, content: string, sessionId: string): void {
    const normalizedPath = this.normalizePath(path)
    this.hashes.set(normalizedPath, {
      hash: this.computeHash(content),
      timestamp: Date.now(),
      sessionId
    })
  }

  getCurrentHash(path: string): string | null {
    const normalizedPath = this.normalizePath(path)
    return this.hashes.get(normalizedPath)?.hash ?? null
  }

  detectConflict(path: string, expectedHash: string): ConflictInfo {
    const normalizedPath = this.normalizePath(path)
    const record = this.hashes.get(normalizedPath)

    // If no record exists, read from disk
    if (!record) {
      try {
        const content = fs.readFileSync(path, 'utf-8')
        const diskHash = this.computeHash(content)
        return {
          hasConflict: diskHash !== expectedHash,
          currentHash: diskHash,
          expectedHash,
          lastModifiedBy: null,
          lastModifiedAt: null
        }
      } catch {
        // File doesn't exist, no conflict
        return {
          hasConflict: false,
          currentHash: null,
          expectedHash,
          lastModifiedBy: null,
          lastModifiedAt: null
        }
      }
    }

    return {
      hasConflict: record.hash !== expectedHash,
      currentHash: record.hash,
      expectedHash,
      lastModifiedBy: record.sessionId,
      lastModifiedAt: record.timestamp
    }
  }

  invalidate(path: string): void {
    const normalizedPath = this.normalizePath(path)
    this.hashes.delete(normalizedPath)
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/').toLowerCase()
  }
}

export const contentHashTracker = ContentHashTracker.getInstance()
```

#### 1.3 Create SafeFileWriter

**File**: `packages/server/src/server/safe-file-writer.ts`

```typescript
import * as fs from 'fs'
import * as path from 'path'
import { fileLockManager } from './file-lock-manager'
import { contentHashTracker } from './content-hash-tracker'

export type ConflictResolution = 'fail-fast' | 'queue' | 'last-write-wins'

export interface WriteOptions {
  sessionId: string
  expectedHash?: string
  resolution?: ConflictResolution
  timeoutMs?: number
}

export interface WriteResult {
  success: boolean
  newHash: string
  error?: string
  conflictInfo?: {
    currentHash: string
    lastModifiedBy: string | null
    lastModifiedAt: number | null
  }
}

export async function safeWriteFile(
  filePath: string,
  content: string,
  options: WriteOptions
): Promise<WriteResult> {
  const {
    sessionId,
    expectedHash,
    resolution = 'fail-fast',
    timeoutMs = 5000
  } = options

  let lock
  try {
    // Acquire lock
    lock = await fileLockManager.acquireLock(filePath, sessionId, timeoutMs)

    // Check for conflicts if expectedHash provided
    if (expectedHash) {
      const conflict = contentHashTracker.detectConflict(filePath, expectedHash)

      if (conflict.hasConflict) {
        if (resolution === 'fail-fast') {
          return {
            success: false,
            newHash: conflict.currentHash || '',
            error: 'File was modified by another session',
            conflictInfo: {
              currentHash: conflict.currentHash || '',
              lastModifiedBy: conflict.lastModifiedBy,
              lastModifiedAt: conflict.lastModifiedAt
            }
          }
        }
        // For 'last-write-wins', continue with write
        // For 'queue', the lock already serializes writes
      }
    }

    // Ensure directory exists
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // Write file
    fs.writeFileSync(filePath, content, 'utf-8')

    // Record new hash
    const newHash = contentHashTracker.computeHash(content)
    contentHashTracker.recordHash(filePath, content, sessionId)

    return {
      success: true,
      newHash
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      newHash: '',
      error: message
    }
  } finally {
    lock?.release()
  }
}

export async function safeReadFile(
  filePath: string,
  sessionId: string
): Promise<{ content: string; hash: string } | null> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const hash = contentHashTracker.computeHash(content)
    contentHashTracker.recordHash(filePath, content, sessionId)
    return { content, hash }
  } catch {
    return null
  }
}
```

### Phase 2: Route Integration

#### 2.1 Update Era Routes

**File**: `packages/server/src/server/routes/era.ts`

Add hash tracking to read operations and safe writes to mutations:

```typescript
import { safeWriteFile, safeReadFile } from '../safe-file-writer'

// In GET /api/era/directives handler:
const result = await safeReadFile(directivesPath, sessionId || 'anonymous')
if (result) {
  return reply.send({
    success: true,
    content: result.content,
    hash: result.hash,  // NEW: Return hash for conflict detection
    path: directivesPath,
    exists: true
  })
}

// In PUT /api/era/directives handler:
const { folder, type, content, expectedHash } = request.body

const writeResult = await safeWriteFile(directivesPath, content, {
  sessionId: sessionId || 'anonymous',
  expectedHash,
  resolution: 'fail-fast'
})

if (!writeResult.success) {
  return reply.status(409).send({
    success: false,
    error: writeResult.error,
    conflictInfo: writeResult.conflictInfo
  })
}

return reply.send({
  success: true,
  path: directivesPath,
  hash: writeResult.newHash  // NEW: Return new hash
})
```

#### 2.2 API Response Schema Updates

Add hash fields to API responses:

```typescript
// Read response
interface DirectivesReadResponse {
  success: boolean
  content: string
  path: string
  exists: boolean
  hash: string  // NEW
}

// Write response
interface DirectivesWriteResponse {
  success: boolean
  path: string
  hash: string  // NEW
  error?: string
  conflictInfo?: {
    currentHash: string
    lastModifiedBy: string | null
    lastModifiedAt: number | null
  }
}
```

### Phase 3: Frontend Integration

#### 3.1 Update era-directives.ts Store

Track content hashes and handle conflicts:

```typescript
interface DirectivesFile {
  content: string
  path: string
  exists: boolean
  hash: string  // NEW: Track content hash
}

export async function saveDirectives(
  folder: string,
  type: "project" | "global",
  content: string
): Promise<{ success: boolean; error?: string; conflictInfo?: ConflictInfo }> {
  const currentFile = type === 'project'
    ? projectDirectives()
    : globalDirectives()

  const response = await fetch(apiUrl("/api/era/directives"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      folder,
      type,
      content,
      expectedHash: currentFile?.hash  // NEW: Send expected hash
    }),
  })

  const data = await response.json()

  if (!data.success && data.conflictInfo) {
    // Handle conflict - show user dialog
    return {
      success: false,
      error: 'File was modified by another session',
      conflictInfo: data.conflictInfo
    }
  }

  // Update local hash on success
  if (data.success) {
    // Update state with new hash
  }

  return data
}
```

#### 3.2 Conflict Resolution UI

Create a conflict resolution modal:

```typescript
interface ConflictModalProps {
  open: boolean
  filePath: string
  localContent: string
  serverContent: string
  onResolve: (resolution: 'keep-local' | 'keep-server' | 'merge') => void
  onCancel: () => void
}
```

---

## Phase 4: Advanced Features (Future)

### 4.1 Git-Based Conflict Detection

For projects with Git, leverage it for three-way merges:

```typescript
import { simpleGit } from 'simple-git'

async function attemptGitMerge(
  filePath: string,
  localContent: string,
  serverContent: string,
  baseContent: string
): Promise<{ merged: string; hasConflicts: boolean }> {
  // Use git merge-file for three-way merge
}
```

### 4.2 Real-Time Lock Status (WebSocket)

Broadcast lock status to connected clients:

```typescript
// Server broadcasts when lock acquired/released
wss.broadcast({
  type: 'file-lock-change',
  path: filePath,
  locked: true,
  holder: sessionId
})

// Clients show lock indicator in UI
```

### 4.3 Session Isolation (Git Worktrees)

For heavy editing scenarios, create isolated worktrees:

```typescript
// Each session gets its own worktree
git worktree add .sessions/${sessionId} HEAD
```

---

## Testing Plan

### Unit Tests

1. **FileLockManager**
   - Concurrent lock acquisition serializes correctly
   - Lock timeout works
   - Lock release allows next acquisition

2. **ContentHashTracker**
   - Hash computation is deterministic
   - Conflict detection works correctly
   - Invalidation clears state

3. **SafeFileWriter**
   - Basic write succeeds
   - Conflict detection fails on mismatch
   - Last-write-wins ignores conflicts

### Integration Tests

1. **Concurrent Write Simulation**
   - Two sessions write same file simultaneously
   - First write succeeds, second gets conflict error
   - After refresh, second session sees first's changes

2. **Race Condition Testing**
   - Rapid successive writes serialize correctly
   - No data corruption under load

### E2E Tests

1. **Multi-Tab Scenario**
   - Open same project in two browser tabs
   - Edit directives in both
   - First save succeeds, second shows conflict modal

---

## Migration Strategy

### Step 1: Add Infrastructure (Non-Breaking)
- Add FileLockManager, ContentHashTracker, SafeFileWriter
- No existing behavior changes

### Step 2: Add Hash to Responses
- Include `hash` field in read responses
- Frontend ignores if not using yet

### Step 3: Enable Conflict Detection
- Frontend sends `expectedHash` on writes
- Server validates and returns conflicts

### Step 4: Add Conflict UI
- Show conflict modal when 409 returned
- Allow user to choose resolution

---

## Dependencies

```json
{
  "dependencies": {
    "async-mutex": "^0.4.0"
  }
}
```

---

## Rollout Checklist

- [ ] Install async-mutex dependency
- [ ] Create FileLockManager
- [ ] Create ContentHashTracker
- [ ] Create SafeFileWriter
- [ ] Update Era routes to use SafeFileWriter
- [ ] Add hash to read responses
- [ ] Update frontend store to track hashes
- [ ] Add expectedHash to write requests
- [ ] Create conflict resolution modal
- [ ] Add unit tests
- [ ] Add integration tests
- [ ] Add E2E tests
- [ ] Documentation update

---

## Success Metrics

1. **Zero data loss** from concurrent edits
2. **Clear user feedback** when conflicts occur
3. **< 50ms overhead** for lock acquisition
4. **No deadlocks** under any scenario
