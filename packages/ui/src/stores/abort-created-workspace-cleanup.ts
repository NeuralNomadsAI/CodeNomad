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
  owner: Map<string, OwnedWorkspace<T>>
  key: string
}

type OwnedWorkspace<T> = { workspace: T } | PendingCleanup<T> | { tombstone: true; workspace: T } | { released: true; workspace: T }

interface AbortCreatedWorkspaceCleanupOptions<T> {
  discardWorkspace: (workspace: T) => Promise<void>
  /** Publish only on current authority; failed settlement retains the original claim. */
  restoreWorkspace: (workspace: T) => void
  requestKey?: (workspace: T) => string | undefined
  isCurrent?: (workspace: T) => boolean
  retryDelaysMs?: readonly number[]
  wait?: (delayMs: number) => Promise<void>
  onPermanentFailure?: (workspace: T, error: unknown) => void
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const

export class AbortCreatedWorkspaceCleanup<T extends CreatedWorkspace> {
  private readonly owned = new Map<string, OwnedWorkspace<T>>()
  private readonly retired = new Map<string, OwnedWorkspace<T>>()
  private readonly pendingRequestIds = new Map<string, boolean>()

  constructor(private readonly options: AbortCreatedWorkspaceCleanupOptions<T>) {}

  private requestKey(workspace: T): string | undefined {
    return this.options.requestKey ? this.options.requestKey(workspace) : workspace.requestId
  }

  private retire(workspaceId: string, entry: OwnedWorkspace<T>): void {
    const key = this.requestKey(entry.workspace)
    if (!key) return
    this.retired.set(key, entry)
    if ("completion" in entry) { entry.owner = this.retired; entry.key = key }
    this.owned.delete(workspaceId)
  }

  track(workspace: T): void {
    const entry = this.owned.get(workspace.id)
    if (!entry) this.owned.set(workspace.id, { workspace })
    else {
      if (this.options.requestKey && this.requestKey(entry.workspace) !== this.requestKey(workspace)) {
        if (!this.options.isCurrent?.(workspace) || this.options.isCurrent(entry.workspace)) return
        this.retire(workspace.id, entry)
        this.owned.set(workspace.id, { workspace })
        return
      }
      if ("released" in entry || "tombstone" in entry) return
      entry.workspace = workspace
    }
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
    if (entry && !("released" in entry) && !("tombstone" in entry) && !("completion" in entry) && this.requestKey(entry.workspace) === requestId) {
      this.owned.delete(workspaceId)
    }
  }

  quarantineRequest(requestId: string): Promise<void> | undefined {
    if (!this.pendingRequestIds.has(requestId)) return undefined
    this.pendingRequestIds.set(requestId, true)
    for (const [workspaceId, entry] of this.owned) {
      if ("released" in entry || "tombstone" in entry || this.requestKey(entry.workspace) !== requestId) continue
      const cleanup = this.discardTracked(workspaceId, { retainTombstone: entry.workspace.reused !== true })
      void cleanup.finally(() => this.finishRequest(requestId))
      return cleanup
    }
    return undefined
  }

  trackPendingRequest(workspace: T): boolean {
    const requestId = this.requestKey(workspace)
    if (!requestId) return false
    const quarantined = this.pendingRequestIds.get(requestId)
    if (quarantined === undefined) return false
    this.track(workspace)
    if (quarantined) void this.discardTracked(workspace.id, { retainTombstone: workspace.reused !== true })
      .finally(() => this.finishRequest(requestId))
    return true
  }

  private slot(workspaceId: string, requestKey?: string) {
    const current = this.owned.get(workspaceId)
    const retired = requestKey && (!current || this.requestKey(current.workspace) !== requestKey)
    const owner = retired ? this.retired : this.owned
    const key = retired ? requestKey : workspaceId
    return { owner, key, entry: owner.get(key) }
  }

  release(workspaceId: string, requestKey?: string): T | undefined {
    const { owner, key, entry } = this.slot(workspaceId, requestKey)
    if (!entry || "tombstone" in entry || "released" in entry || "completion" in entry) return undefined
    owner.set(key, { released: true, workspace: entry.workspace })
    return entry.workspace
  }

  get(workspaceId: string, includePending = false): T | undefined {
    const entry = this.owned.get(workspaceId)
    return entry && !("released" in entry) && !("tombstone" in entry) && (includePending || !("completion" in entry)) ? entry.workspace : undefined
  }

  async releaseAfter(workspaceId: string, operation: (workspace: T) => Promise<void>, requestKey?: string): Promise<T | undefined> {
    const slot = this.slot(workspaceId, requestKey)
    const workspace = this.release(workspaceId, requestKey)
    if (!workspace) return undefined
    const released = slot.owner.get(slot.key)
    try {
      await operation(workspace)
      return workspace
    } catch (error) {
      const entry = slot.owner.get(slot.key)
      if (entry === released) slot.owner.set(slot.key, { workspace })
      else {
        const key = this.requestKey(workspace)
        if (key && this.retired.get(key) === released) this.retired.set(key, { workspace })
      }
      throw error
    }
  }

  releaseTombstoneForUserCreate(workspaceId: string): void {
    const entry = this.owned.get(workspaceId)
    if (entry && ("tombstone" in entry || "released" in entry)) {
      this.retire(workspaceId, entry)
      this.owned.delete(workspaceId)
    }
  }

  owns(workspaceId: string): boolean {
    const entry = this.owned.get(workspaceId)
    return Boolean(entry && !("released" in entry) && (!this.options.isCurrent || this.options.isCurrent(entry.workspace)))
  }

  isReleased(workspaceId: string, requestKey?: string): boolean {
    const { entry } = this.slot(workspaceId, requestKey)
    return !!entry && "released" in entry
  }

  shouldIgnoreEvent(workspaceId: string): boolean {
    const entry = this.owned.get(workspaceId)
    return !!entry && ("completion" in entry || "tombstone" in entry)
      && (!this.options.isCurrent || this.options.isCurrent(entry.workspace))
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
    let current = this.owned.get(workspace.id)
    let owner = this.owned, key = workspace.id
    const retired = this.retired.get(this.requestKey(workspace) ?? "")
    if (retired) {
      owner = this.retired
      key = this.requestKey(workspace)!
      current = retired
    } else if (current && this.options.requestKey
      && this.requestKey(current.workspace) !== this.requestKey(workspace)) {
      if (this.options.isCurrent?.(workspace) && !this.options.isCurrent(current.workspace)) {
        this.retire(workspace.id, current)
        current = undefined
      } else {
        owner = this.retired
        key = this.requestKey(workspace)!
        current = owner.get(key)
      }
    }
    if (current && "completion" in current) return current.completion
    if (current && ("tombstone" in current || "released" in current)) return Promise.resolve()

    let resolve!: () => void
    const completion = new Promise<void>((done) => { resolve = done })
    const entry = { workspace, completion, resolve, retainTombstone: options?.retainTombstone === true, owner, key }
    owner.set(key, entry)
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

    if (entry.owner.get(entry.key) !== entry) { entry.resolve(); return }
    if (!deleted) {
      try {
        if (entry.owner === this.owned) this.options.restoreWorkspace(entry.workspace)
      } catch (error) {
        lastError = error
      }
    }
    if (!deleted) entry.owner.set(entry.key, { workspace: entry.workspace })
    else if (deleted && entry.retainTombstone) entry.owner.set(entry.key, { tombstone: true, workspace: entry.workspace })
    else entry.owner.delete(entry.key)
    entry.resolve()

    if (deleted) return
    try {
      this.options.onPermanentFailure?.(entry.workspace, lastError)
    } catch {
      // Cleanup has already reached its safe terminal state.
    }
  }
}
