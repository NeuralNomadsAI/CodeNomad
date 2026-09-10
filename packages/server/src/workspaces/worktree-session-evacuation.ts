import { normalizeWslUncPath } from "./worktree-directory"

const MUTATION_DRAIN_TIMEOUT_MS = 30_000

function normalizeDirectory(directory: string): string {
  const wsl = normalizeWslUncPath(directory)
  if (wsl) return wsl
  const normalized = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}

export class WorktreeDeletionFence {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly blocked = new Map<string, number>()
  private readonly active = new Map<string, number>()
  private readonly idleWaiters = new Map<string, Set<() => void>>()

  constructor(private readonly mutationDrainTimeoutMs = MUTATION_DRAIN_TIMEOUT_MS) {}

  isBlocked(directory: string): boolean {
    return this.blocked.has(normalizeDirectory(directory))
  }

  enter(directories: string[]): (() => void) | undefined {
    const normalized = [...new Set(directories.map(normalizeDirectory))]
    if (normalized.some((directory) => this.blocked.has(directory))) return undefined
    for (const directory of normalized) this.active.set(directory, (this.active.get(directory) ?? 0) + 1)

    let released = false
    return () => {
      if (released) return
      released = true
      for (const directory of normalized) {
        const count = this.active.get(directory) ?? 0
        if (count > 1) {
          this.active.set(directory, count - 1)
          continue
        }
        this.active.delete(directory)
        for (const resolve of this.idleWaiters.get(directory) ?? []) resolve()
        this.idleWaiters.delete(directory)
      }
    }
  }

  run<T>(key: string, directories: string[], operation: () => Promise<T>): Promise<T> {
    const normalizedKey = normalizeDirectory(key)
    const blocked = [...new Set(directories.map(normalizeDirectory))]
    for (const directory of blocked) this.blocked.set(directory, (this.blocked.get(directory) ?? 0) + 1)

    const previous = this.queues.get(normalizedKey) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      await Promise.all(blocked.map((directory) => this.waitForIdle(directory)))
      return operation()
    })
    this.queues.set(normalizedKey, current)
    return current.finally(() => {
      for (const directory of blocked) {
        const count = this.blocked.get(directory) ?? 0
        if (count > 1) this.blocked.set(directory, count - 1)
        else this.blocked.delete(directory)
      }
      if (this.queues.get(normalizedKey) === current) this.queues.delete(normalizedKey)
    })
  }

  private waitForIdle(directory: string): Promise<void> {
    if (!this.active.has(directory)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiters = this.idleWaiters.get(directory) ?? new Set()
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      waiters.add(done)
      this.idleWaiters.set(directory, waiters)
      const timer = setTimeout(() => {
        waiters.delete(done)
        if (!waiters.size) this.idleWaiters.delete(directory)
        reject(new Error("Timed out waiting for worktree mutations to finish"))
      }, this.mutationDrainTimeoutMs)
    })
  }
}
