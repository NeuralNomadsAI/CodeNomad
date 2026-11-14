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
  isCurrentKey?: (workspaceId: string, requestKey: string) => boolean
  onSettled?: (workspace: T) => void
  retryDelaysMs?: readonly number[]
  wait?: (delayMs: number) => Promise<void>
  onPermanentFailure?: (workspace: T, error: unknown) => void
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const

export class AbortCreatedWorkspaceCleanup<T extends CreatedWorkspace> {
  private readonly owned = new Map<string, OwnedWorkspace<T>>()
  private readonly retired = new Map<string, OwnedWorkspace<T>>()
  private readonly superseded = new Set<string>()
  // Exact request fences survive duplicate responses; settled entries retain no client or attachment.
  private readonly settled = new Set<string>()
  private readonly settledRequests = new Set<string>()
  private readonly cancelledRequests = new Map<string, number>()
  // Admission survives retries; only confirmed cancellation enters the observation fence.
  private readonly cancellationOrders = new Map<string, number>()
  private readonly userOpenings = new Map<string, number>()
  private observationSequence = 0
  private readonly markers = new Map<string, { requestKey: string; tombstone: boolean }>()
  private readonly pendingRequestIds = new Map<string, boolean>()

  constructor(private readonly options: AbortCreatedWorkspaceCleanupOptions<T>) {}

  private requestKey(workspace: T): string | undefined {
    return this.options.requestKey ? this.options.requestKey(workspace) : workspace.requestId
  }

  private retire(workspaceId: string, entry: OwnedWorkspace<T>): void {
    const key = this.requestKey(entry.workspace)
    if (!key) return
    this.superseded.add(key)
    this.retired.set(key, entry)
    if ("completion" in entry) { entry.owner = this.retired; entry.key = key }
    this.owned.delete(workspaceId)
  }

  track(workspace: T): void {
    const key = this.requestKey(workspace)
    if (key && this.superseded.has(key)) return
    if (key && this.isReleased(workspace.id, key)) return
    const marker = this.markers.get(workspace.id)
    if (marker) {
      if (!this.options.isCurrent || this.options.isCurrent(workspace)) this.markers.delete(workspace.id)
      else return
    }
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

  /** An explicit commit supersedes the previous claim; observations only enrich it. */
  trackCommitted(workspace: T): void {
    const key = this.requestKey(workspace)
    if (key && this.superseded.has(key)) return
    const entry = this.owned.get(workspace.id)
    if (entry && this.requestKey(entry.workspace) !== this.requestKey(workspace)) this.retire(workspace.id, entry)
    if (workspace.requestId) this.track(workspace)
  }

  beginRequest(requestId: string): void {
    this.pendingRequestIds.set(requestId, false)
  }

  finishRequest(requestId: string): void {
    this.pendingRequestIds.delete(requestId)
  }

  captureOperationOrder(): number {
    return ++this.observationSequence
  }

  beginCancellation(requestKey: string): number {
    let order = this.cancellationOrders.get(requestKey)
    if (order === undefined) this.cancellationOrders.set(requestKey, order = this.captureOperationOrder())
    return order
  }

  settleRequest(requestKey: string): void {
    if (!this.settledRequests.has(requestKey)) this.cancelledRequests.set(requestKey, this.beginCancellation(requestKey))
    this.settledRequests.add(requestKey)
    this.finishRequest(requestKey)
    for (const owner of [this.owned, this.retired]) {
      for (const [key, entry] of owner) {
        if (this.requestKey(entry.workspace) !== requestKey) continue
        this.settle(entry.workspace, !("released" in entry) && entry.workspace.reused !== true, owner, key)
        if ("completion" in entry) entry.resolve()
      }
    }
  }

  isRequestSettled(requestKey: string): boolean {
    return this.settledRequests.has(requestKey)
  }

  shouldIgnoreObservation(workspaceId: string, requestKey: string, reused = false): boolean {
    if (this.superseded.has(requestKey)) {
      const entry = this.retired.get(requestKey)
      if (entry && this.pendingRequestIds.get(requestKey)) {
        void this.discardCreated(entry.workspace, { retainTombstone: entry.workspace.reused !== true })
      }
      return true
    }
    const cancelled = this.cancelledRequests.get(requestKey)
    if (reused || cancelled === undefined) return false
    if (this.options.isCurrentKey && !this.options.isCurrentKey(workspaceId, requestKey)) return false
    // A delayed cancelled descriptor stays stale; a later user occurrence stays visible.
    this.markCancelledOccurrence(workspaceId, requestKey)
    return true
  }

  private markCancelledOccurrence(workspaceId: string, requestKey: string): void {
    const order = this.cancelledRequests.get(requestKey) ?? 0
    const marker = this.markers.get(workspaceId)
    if (order > (this.userOpenings.get(workspaceId) ?? 0)
      && order >= (marker ? this.cancelledRequests.get(marker.requestKey) ?? 0 : 0)) {
      this.markers.set(workspaceId, { requestKey, tombstone: true })
    }
  }

  forgetRequest(workspaceId: string, requestId: string): void {
    this.pendingRequestIds.delete(requestId)
    const entry = this.owned.get(workspaceId)
    if (entry && !("released" in entry) && !("tombstone" in entry) && !("completion" in entry) && this.requestKey(entry.workspace) === requestId) {
      this.owned.delete(workspaceId)
    }
  }

  quarantineRequest(requestId: string): Promise<void> | undefined {
    this.beginCancellation(requestId)
    if (!this.pendingRequestIds.has(requestId)) return undefined
    this.pendingRequestIds.set(requestId, true)
    for (const [workspaceId, entry] of this.owned) {
      if ("released" in entry || "tombstone" in entry || this.requestKey(entry.workspace) !== requestId) continue
      return this.discardTracked(workspaceId, { retainTombstone: entry.workspace.reused !== true })
    }
    return undefined
  }

  trackPendingRequest(workspace: T): boolean {
    const requestId = this.requestKey(workspace)
    if (!requestId) return false
    const quarantined = this.pendingRequestIds.get(requestId)
    if (quarantined === undefined) return false
    this.track(workspace)
    if (quarantined) void this.discardCreated(workspace, { retainTombstone: workspace.reused !== true })
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
    if (this.options.requestKey && !requestKey) return undefined
    const { owner, key, entry } = this.slot(workspaceId, requestKey)
    if (!entry) return undefined
    this.settle(entry.workspace, false, owner, key)
    if ("completion" in entry) entry.resolve()
    return entry.workspace
  }

  private settle(workspace: T, tombstone: boolean, owner: Map<string, OwnedWorkspace<T>>, key: string): void {
    owner.delete(key)
    const requestKey = this.requestKey(workspace)
    if (requestKey) {
      if (this.options.requestKey) this.settledRequests.add(requestKey)
      else this.settled.add(JSON.stringify([workspace.id, requestKey]))
      this.finishRequest(requestKey)
      if (tombstone && !this.cancelledRequests.has(requestKey)) this.cancelledRequests.set(requestKey, this.beginCancellation(requestKey))
      if (owner === this.owned && tombstone) this.markCancelledOccurrence(workspace.id, requestKey)
    }
    this.options.onSettled?.(workspace)
  }

  get(workspaceId: string, includePending = false): T | undefined {
    const entry = this.owned.get(workspaceId)
    return entry && !("tombstone" in entry) && (includePending || (!("released" in entry) && !("completion" in entry))) ? entry.workspace : undefined
  }

  async releaseAfter(workspaceId: string, operation: (workspace: T) => Promise<void>, requestKey?: string): Promise<T | undefined> {
    const slot = this.slot(workspaceId, requestKey)
    const entry = slot.entry
    if (!entry || "tombstone" in entry || "released" in entry || "completion" in entry) return undefined
    const workspace = entry.workspace
    const released = { released: true as const, workspace }
    slot.owner.set(slot.key, released)
    try {
      await operation(workspace)
      if (slot.owner.get(slot.key) === released) this.settle(workspace, false, slot.owner, slot.key)
      else {
        const key = this.requestKey(workspace)
        if (key && this.retired.get(key) === released) this.settle(workspace, false, this.retired, key)
      }
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

  releaseTombstoneForUserCreate(workspaceId: string, order = this.captureOperationOrder()): void {
    this.userOpenings.set(workspaceId, Math.max(order, this.userOpenings.get(workspaceId) ?? 0))
    const marker = this.markers.get(workspaceId)
    if (!marker || (this.cancelledRequests.get(marker.requestKey) ?? 0) < this.userOpenings.get(workspaceId)!) this.markers.delete(workspaceId)
    const entry = this.owned.get(workspaceId)
    if (entry && ("tombstone" in entry || "released" in entry)) {
      this.retire(workspaceId, entry)
      this.owned.delete(workspaceId)
    }
  }

  owns(workspaceId: string): boolean {
    if (this.markers.has(workspaceId)) return this.shouldIgnoreEvent(workspaceId)
    const entry = this.owned.get(workspaceId)
    return Boolean(entry && !("released" in entry) && (!this.options.isCurrent || this.options.isCurrent(entry.workspace)))
  }

  isReleased(workspaceId: string, requestKey?: string): boolean {
    if (requestKey && (this.settled.has(JSON.stringify([workspaceId, requestKey])) || this.settledRequests.has(requestKey))) return true
    if (!requestKey && this.markers.has(workspaceId)) return true
    const { entry } = this.slot(workspaceId, requestKey)
    return !!entry && "released" in entry
  }

  shouldIgnoreEvent(workspaceId: string, requestKey?: string): boolean {
    const marker = this.markers.get(workspaceId)
    if (marker && (!requestKey || marker.requestKey === requestKey)) return marker.tombstone && (!this.options.isCurrentKey || this.options.isCurrentKey(workspaceId, marker.requestKey))
    const { entry } = this.slot(workspaceId, requestKey)
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
    const requestKey = this.requestKey(workspace)
    if (requestKey && this.isReleased(workspace.id, requestKey)) return Promise.resolve()
    if (requestKey) this.beginCancellation(requestKey)
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
    else this.settle(entry.workspace, entry.retainTombstone, entry.owner, entry.key)
    entry.resolve()

    if (deleted) return
    try {
      this.options.onPermanentFailure?.(entry.workspace, lastError)
    } catch {
      // Cleanup has already reached its safe terminal state.
    }
  }
}
