import { retryWithBackoff } from "../lib/retry-utils"

interface CreatedWorkspace {
  id: string
  requestId?: string
  reused?: boolean
}

interface PendingCleanup<T> {
  workspace: T
  completion: Promise<void>
  resolve: () => void
  retainTombstone: boolean
}

type OwnedWorkspace<T> = { workspace: T } | PendingCleanup<T> | { tombstone: true } | { released: true }

interface AbortCreatedWorkspaceCleanupOptions<T> {
  discardWorkspace: (workspace: T) => Promise<void>
  restoreWorkspace: (workspace: T) => void
  retryDelaysMs?: readonly number[]
  wait?: (delayMs: number) => Promise<void>
  onPermanentFailure?: (workspace: T, error: unknown) => void
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const

export class AbortCreatedWorkspaceCleanup<T extends CreatedWorkspace> {
  private readonly owned = new Map<string, OwnedWorkspace<T>>()
  private readonly pendingRequestIds = new Map<string, boolean>()

  constructor(private readonly options: AbortCreatedWorkspaceCleanupOptions<T>) {}

  track(workspace: T): void {
    if (!this.owned.has(workspace.id)) this.owned.set(workspace.id, { workspace })
  }

  beginRequest(requestId: string): void {
    this.pendingRequestIds.set(requestId, false)
  }

  finishRequest(requestId: string): void {
    this.pendingRequestIds.delete(requestId)
  }

  forgetRequest(workspaceId: string, requestId: string): void {
    this.pendingRequestIds.delete(requestId)
    const entry = this.owned.get(workspaceId)
    if (entry && "workspace" in entry && !("completion" in entry) && entry.workspace.requestId === requestId) {
      this.owned.delete(workspaceId)
    }
  }

  quarantineRequest(requestId: string): void {
    if (this.pendingRequestIds.has(requestId)) this.pendingRequestIds.set(requestId, true)
  }

  trackPendingRequest(workspace: T): boolean {
    if (!workspace.requestId) return false
    const quarantined = this.pendingRequestIds.get(workspace.requestId)
    if (quarantined === undefined) return false
    this.track(workspace)
    if (quarantined) void this.discardTracked(workspace.id, { retainTombstone: workspace.reused !== true })
      .finally(() => this.finishRequest(workspace.requestId!))
    return true
  }

  release(workspaceId: string): T | undefined {
    const entry = this.owned.get(workspaceId)
    if (!entry || "tombstone" in entry || "released" in entry || "completion" in entry) return undefined
    this.owned.set(workspaceId, { released: true })
    return entry.workspace
  }

  get(workspaceId: string): T | undefined {
    const entry = this.owned.get(workspaceId)
    return entry && "workspace" in entry && !("completion" in entry) ? entry.workspace : undefined
  }

  async releaseAfter(workspaceId: string, operation: Promise<void>): Promise<T | undefined> {
    const workspace = this.release(workspaceId)
    try {
      await operation
      return workspace
    } catch (error) {
      const entry = this.owned.get(workspaceId)
      if (workspace && entry && "released" in entry) this.owned.set(workspaceId, { workspace })
      throw error
    }
  }

  releaseTombstoneForUserCreate(workspaceId: string): void {
    const entry = this.owned.get(workspaceId)
    if (entry && ("tombstone" in entry || "released" in entry)) this.owned.delete(workspaceId)
  }

  owns(workspaceId: string): boolean {
    const entry = this.owned.get(workspaceId)
    return Boolean(entry && !("released" in entry))
  }

  shouldIgnoreEvent(workspaceId: string): boolean {
    const entry = this.owned.get(workspaceId)
    return !!entry && ("completion" in entry || "tombstone" in entry)
  }

  discardCreated(workspace: T, options?: { retainTombstone?: boolean }): Promise<void> {
    return this.start(workspace, options)
  }

  discardTracked(workspaceId: string, options?: { retainTombstone?: boolean }): Promise<void> {
    const entry = this.owned.get(workspaceId)
    if (!entry || "tombstone" in entry || "released" in entry) return Promise.resolve()
    if ("completion" in entry) return entry.completion
    return this.start(entry.workspace, options)
  }

  private start(workspace: T, options?: { retainTombstone?: boolean }): Promise<void> {
    const current = this.owned.get(workspace.id)
    if (current && "completion" in current) return current.completion
    if (current && ("tombstone" in current || "released" in current)) return Promise.resolve()

    let resolve!: () => void
    const completion = new Promise<void>((done) => { resolve = done })
    const entry = { workspace, completion, resolve, retainTombstone: options?.retainTombstone === true }
    this.owned.set(workspace.id, entry)
    void this.run(entry)
    return completion
  }

  private async run(entry: PendingCleanup<T>): Promise<void> {
    let lastError: unknown
    let deleted = false
    const retryDelays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    let retryIndex = 0

    try {
      await retryWithBackoff(() => this.options.discardWorkspace(entry.workspace), {
        maxAttempts: retryDelays.length + 1,
        wait: () => (this.options.wait ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(
          retryDelays[retryIndex++] ?? 0,
        ),
      })
      deleted = true
    } catch (error) {
      lastError = error
    }

    if (this.owned.get(entry.workspace.id) !== entry) return
    if (!deleted) {
      try {
        this.options.restoreWorkspace(entry.workspace)
      } catch (error) {
        lastError = error
      }
    }
    if (deleted && entry.retainTombstone) this.owned.set(entry.workspace.id, { tombstone: true })
    else this.owned.delete(entry.workspace.id)
    entry.resolve()

    if (deleted) return
    try {
      this.options.onPermanentFailure?.(entry.workspace, lastError)
    } catch {
      // Cleanup has already reached its safe terminal state.
    }
  }
}
