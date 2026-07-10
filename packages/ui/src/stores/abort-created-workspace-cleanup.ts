interface CreatedWorkspace {
  id: string
  requestId?: string
}

interface CleanupEntry<T> {
  workspace: T
  completion: Promise<void>
  resolve: () => void
  retainTombstone: boolean
}

interface AbortCreatedWorkspaceCleanupOptions<T> {
  deleteWorkspace: (workspaceId: string) => Promise<void>
  restoreWorkspace: (workspace: T) => void
  retryDelaysMs?: readonly number[]
  wait?: (delayMs: number) => Promise<void>
  onPermanentFailure?: (workspace: T, error: unknown) => void
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

export class AbortCreatedWorkspaceCleanup<T extends CreatedWorkspace> {
  private readonly tracked = new Map<string, T>()
  private readonly pending = new Map<string, CleanupEntry<T>>()
  private readonly pendingRequestIds = new Set<string>()
  private readonly tombstones = new Set<string>()
  private readonly retryDelaysMs: readonly number[]
  private readonly wait: (delayMs: number) => Promise<void>

  constructor(private readonly options: AbortCreatedWorkspaceCleanupOptions<T>) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.wait = options.wait ?? waitForDelay
  }

  track(workspace: T): void {
    if (!this.pending.has(workspace.id) && !this.tombstones.has(workspace.id)) {
      this.tracked.set(workspace.id, workspace)
    }
  }

  beginRequest(requestId: string): void {
    this.pendingRequestIds.add(requestId)
  }

  finishRequest(requestId: string): void {
    this.pendingRequestIds.delete(requestId)
  }

  trackPendingRequest(workspace: T): boolean {
    if (!workspace.requestId || !this.pendingRequestIds.has(workspace.requestId)) return false
    this.track(workspace)
    return true
  }

  release(workspaceId: string): void {
    this.tracked.delete(workspaceId)
  }

  releaseTombstoneForUserCreate(workspaceId: string): void {
    this.tombstones.delete(workspaceId)
  }

  owns(workspaceId: string): boolean {
    return this.tracked.has(workspaceId) || this.pending.has(workspaceId) || this.tombstones.has(workspaceId)
  }

  shouldIgnoreEvent(workspaceId: string): boolean {
    return this.pending.has(workspaceId) || this.tombstones.has(workspaceId)
  }

  discardCreated(workspace: T, options?: { retainTombstone?: boolean }): Promise<void> {
    return this.start(workspace, options)
  }

  discardTracked(workspaceId: string, options?: { retainTombstone?: boolean }): Promise<void> {
    const pending = this.pending.get(workspaceId)
    if (pending) return pending.completion
    if (this.tombstones.has(workspaceId)) return Promise.resolve()

    const workspace = this.tracked.get(workspaceId)
    if (!workspace) return Promise.resolve()
    return this.start(workspace, options)
  }

  private start(workspace: T, options?: { retainTombstone?: boolean }): Promise<void> {
    const pending = this.pending.get(workspace.id)
    if (pending) return pending.completion
    if (this.tombstones.has(workspace.id)) return Promise.resolve()

    let resolve!: () => void
    const completion = new Promise<void>((done) => {
      resolve = done
    })
    const entry = { workspace, completion, resolve, retainTombstone: options?.retainTombstone === true }
    this.tracked.delete(workspace.id)
    this.pending.set(workspace.id, entry)
    void this.run(entry)
    return completion
  }

  private async run(entry: CleanupEntry<T>): Promise<void> {
    let lastError: unknown

    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.options.deleteWorkspace(entry.workspace.id)
        this.finish(entry, true)
        return
      } catch (error) {
        lastError = error
      }

      const delayMs = this.retryDelaysMs[attempt]
      if (delayMs === undefined) break

      try {
        await this.wait(delayMs)
      } catch (error) {
        lastError = error
        break
      }
      if (this.pending.get(entry.workspace.id) !== entry) return
    }

    if (this.pending.get(entry.workspace.id) !== entry) return
    try {
      this.options.restoreWorkspace(entry.workspace)
    } catch (error) {
      lastError = error
    }
    this.finish(entry, false)
    try {
      this.options.onPermanentFailure?.(entry.workspace, lastError)
    } catch {
      // Cleanup has already reached its safe terminal state.
    }
  }

  private finish(entry: CleanupEntry<T>, deleted: boolean): void {
    if (this.pending.get(entry.workspace.id) !== entry) return
    this.pending.delete(entry.workspace.id)
    if (deleted && entry.retainTombstone) {
      this.tombstones.add(entry.workspace.id)
    } else {
      this.tombstones.delete(entry.workspace.id)
    }
    entry.resolve()
  }
}
