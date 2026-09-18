import type { WorktreeListResponse } from "../api-types"

type ReadMode = "cached" | "validated" | "fresh"
type Entry = {
  value?: WorktreeListResponse
  expiresAt: number
  retryAt: number
  revision: number
  pending?: Promise<WorktreeListResponse>
}

const MAX_AGE_MS = 10_000

/** Demand-driven inventory: display reads keep the last snapshot while refreshing.
 * Directory authorization waits for validation; family transactions force a scan.
 * No timers, and no rejected/obsolete scan can replace the last good snapshot.
 */
export class WorktreeInventory {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly options: {
    load: (id: string) => Promise<WorktreeListResponse>
    changed: (id: string) => void
    failed: (id: string, error: unknown) => void
    now?: () => number
  }) {}

  async read(id: string, mode: ReadMode = "cached"): Promise<WorktreeListResponse> {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { expiresAt: 0, retryAt: 0, revision: 0 }
      this.entries.set(id, entry)
    }
    const now = this.now()
    if (mode !== "fresh" && entry.value && entry.expiresAt > now) return entry.value
    if (mode === "cached" && entry.value) {
      if (!entry.pending && entry.retryAt <= now) void this.load(id, entry).catch(error => this.options.failed(id, error))
      return entry.value
    }
    return this.load(id, entry)
  }

  // Invalidation is lazy: retain the display snapshot, but fence any running scan.
  invalidate(id?: string): void {
    const entries = id === undefined ? this.entries.values() : [this.entries.get(id)]
    for (const entry of entries) {
      if (!entry) continue
      entry.revision += 1
      entry.expiresAt = 0
      entry.retryAt = 0
    }
  }

  forget(id: string): void {
    this.entries.delete(id)
  }

  private load(id: string, entry: Entry): Promise<WorktreeListResponse> {
    if (entry.pending) return entry.pending
    const revision = entry.revision
    const previous = entry.value
    const task = Promise.resolve().then(() => this.options.load(id)).then(async value => {
      if (this.entries.get(id) !== entry) throw new Error("Workspace inventory was disposed")
      if (revision !== entry.revision) {
        // A mutation overtook the scan. Serialize one trailing validation rather
        // than publishing obsolete data or starting overlapping Git process fans.
        entry.pending = undefined
        return this.load(id, entry)
      }
      entry.value = value
      entry.expiresAt = this.now() + MAX_AGE_MS
      entry.retryAt = 0
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) this.options.changed(id)
      return value
    }).catch(error => {
      if (revision === entry.revision) entry.retryAt = this.now() + MAX_AGE_MS
      throw error
    }).finally(() => {
      if (entry.pending === task) entry.pending = undefined
    })
    entry.pending = task
    return task
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}
