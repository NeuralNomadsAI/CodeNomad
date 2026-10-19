import { watch, type FSWatcher } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { WorkspaceDirectoryChange } from "../api-types"

interface Entry {
  workspaceId: string
  root: string
  target: string
  identity: string
  watcher: FSWatcher
  current: () => boolean
}
interface Pending { timer: ReturnType<typeof setTimeout>; entries: Map<string, Entry> }

/** Host observations of listed directories, never recursive project scans. They
 * invalidate display caches; subsequent reads retain their ownership checks. */
export class WorkspaceFileWatches {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Pending>()
  private closed = false
  private warnedLimit = false

  constructor(private readonly notify: (workspaceId: string, changes: WorkspaceDirectoryChange[]) => void,
    private readonly warn: (error: unknown) => void, private readonly limit = 256) {}

  async observe(workspaceId: string, root: string, directory: string, current: () => boolean): Promise<void> {
    if (this.closed || !current()) return
    let base: string, target: string, identity: string
    try {
      ;[base, target] = await Promise.all([realpath(root), realpath(directory)])
      const relative = path.relative(base, target)
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
      const info = await stat(target, { bigint: true })
      if (!info.isDirectory()) return
      identity = `${info.dev}:${info.ino}`
    } catch { return }
    if (this.closed || !current()) return
    const key = JSON.stringify([workspaceId, this.pathKey(base), this.pathKey(target)])
    const previous = this.entries.get(key)
    if (previous?.identity === identity) {
      this.entries.delete(key)
      this.entries.set(key, previous)
      return
    }
    if (previous) this.remove(key)
    // ponytail: 256 most recently listed directories; replace this LRU with
    // explicit visible-directory demand if larger trees demonstrate the need.
    if (this.entries.size >= this.limit) {
      this.remove(this.entries.keys().next().value!)
      if (!this.warnedLimit) { this.warnedLimit = true; this.warn(new Error("Workspace directory watch limit reached")) }
    }
    try {
      const watcher = watch(target, { persistent: false, recursive: false }, () => {
        const entry = this.entries.get(key)
        if (entry?.watcher === watcher) this.changed(key, entry)
      })
      this.entries.set(key, { workspaceId, root: base, target, watcher, identity, current })
      watcher.on("error", error => {
        if (this.entries.get(key)?.watcher !== watcher) return
        this.remove(key)
        this.warn(error)
      })
      watcher.on("close", () => {
        if (this.entries.get(key)?.watcher === watcher) this.entries.delete(key)
      })
    } catch (error) { this.warn(error) }
  }

  forget(workspaceId: string): void {
    for (const [key, entry] of this.entries) if (entry.workspaceId === workspaceId) this.remove(key)
    const pending = this.pending.get(workspaceId)
    if (pending) clearTimeout(pending.timer)
    this.pending.delete(workspaceId)
  }

  close(): void {
    this.closed = true
    for (const key of this.entries.keys()) this.remove(key)
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
  }

  private changed(key: string, entry: Entry): void {
    if (this.closed) return
    if (!entry.current()) { this.remove(key); return }
    const pending = this.pending.get(entry.workspaceId)
    if (pending) { pending.entries.set(key, entry); return }
    const next: Pending = { timer: setTimeout(() => { void this.flush(entry.workspaceId, next) }, 100), entries: new Map([[key, entry]]) }
    next.timer.unref()
    this.pending.set(entry.workspaceId, next)
  }

  private async flush(workspaceId: string, pending: Pending): Promise<void> {
    const snapshot = [...pending.entries]
    pending.entries.clear()
    const changes = await Promise.all(snapshot.map(async ([key, entry]): Promise<WorkspaceDirectoryChange | undefined> => {
      if (this.entries.get(key) !== entry || !entry.current()) return
      // Native watches follow moved inodes. Stop following a directory once it
      // no longer occupies the admitted physical path; invalidate it one last time.
      try {
        const [root, target, info] = await Promise.all([realpath(entry.root), realpath(entry.target), stat(entry.target, { bigint: true })])
        if (root !== entry.root || target !== entry.target || `${info.dev}:${info.ino}` !== entry.identity) this.remove(key)
      } catch { this.remove(key) }
      if (!entry.current()) return
      return { directory: entry.root, path: path.relative(entry.root, entry.target).replace(/\\/g, "/") || "." }
    }))
    if (this.pending.get(workspaceId) !== pending || this.closed) return
    this.pending.delete(workspaceId)
    const admitted = changes.filter((change): change is WorkspaceDirectoryChange => Boolean(change))
    if (admitted.length) this.notify(workspaceId, admitted)
    for (const [key, entry] of pending.entries) if (this.entries.get(key) === entry) this.changed(key, entry)
  }

  private pathKey(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    this.entries.delete(key)
    entry?.watcher.close()
  }
}
