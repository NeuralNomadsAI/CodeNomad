import { createSignal } from "solid-js"
import type { WorkspaceDirectoryChange } from "../../../server/src/api-types"
import { normalizeSessionDirectory } from "../stores/session-list-options"
import { serverEvents } from "./server-events"

interface Snapshot { version: number; full: number; roots: Map<string, number>; paths: Map<string, number> }
interface Pending { timer: ReturnType<typeof setTimeout>; all: boolean; changes: Map<string, WorkspaceDirectoryChange> }
const [filesystemInvalidations, setFilesystemInvalidations] = createSignal<Map<string, Snapshot>>(new Map())
const pending = new Map<string, Pending>(), lastPassive = new Map<string, number>()
const PASSIVE_INTERVAL_MS = 5_000
const rootKey = (value: string) => normalizeSessionDirectory(value).replace(/^([A-Z]):$/, (_, drive: string) => `${drive.toLowerCase()}:`)

function pathKey(directory: string, relative: string): string {
  const root = rootKey(directory)
  return normalizeSessionDirectory(`${root === "/" ? "" : root}/${relative === "." ? "" : relative}`)
}

function publish(instanceId: string, changes?: readonly WorkspaceDirectoryChange[]): void {
  setFilesystemInvalidations(previous => {
    const old = previous.get(instanceId)
    const version = (old?.version ?? 0) + 1
    const snapshot: Snapshot = { version, full: old?.full ?? 0, roots: new Map(old?.roots), paths: new Map(old?.paths) }
    for (const change of changes ?? []) {
      snapshot.roots.set(rootKey(change.directory), version)
      snapshot.paths.set(pathKey(change.directory, change.path), version)
    }
    // Bound retained version metadata; overflow conservatively invalidates all
    // cached directories rather than forgetting a change to an inactive tree.
    if (!changes || snapshot.roots.size > 64 || snapshot.paths.size > 1_024) {
      snapshot.full = version; snapshot.roots.clear(); snapshot.paths.clear()
    }
    return new Map(previous).set(instanceId, snapshot)
  })
}

/** Explicit mutations/recovery invalidate immediately, dominating earlier passive demand. */
export function invalidateFilesystemCaches(instanceId: string): void {
  const queued = pending.get(instanceId)
  if (queued) clearTimeout(queued.timer)
  pending.delete(instanceId)
  publish(instanceId)
}

/** Passive observations merge before any consumer is invalidated: a short quiet-case
 * delay, then at most one publication per five seconds during continuous activity. */
export function queueFilesystemInvalidation(instanceId: string, changes?: readonly WorkspaceDirectoryChange[]): void {
  if (changes && !changes.length) return
  let queued = pending.get(instanceId)
  if (!queued) {
    const last = lastPassive.get(instanceId)
    const next: Pending = { timer: setTimeout(() => {
      pending.delete(instanceId)
      lastPassive.set(instanceId, performance.now())
      publish(instanceId, next.all ? undefined : [...next.changes.values()])
    }, last === undefined ? 100 : Math.max(100, PASSIVE_INTERVAL_MS - (performance.now() - last))), all: false, changes: new Map() }
    pending.set(instanceId, next)
    queued = next
  }
  if (!changes) { queued.all = true; queued.changes.clear() }
  else if (!queued.all) {
    for (const change of changes) queued.changes.set(JSON.stringify([rootKey(change.directory), change.path]), change)
    if (queued.changes.size > 1_024) { queued.all = true; queued.changes.clear() }
  }
}

/** With a root/path, only changes to that browsing scope/directory (or a full
 * invalidation) count. Legacy consumers without a scope still see every batch. */
export function filesystemInvalidationVersion(instanceId: string, directory?: string, relative?: string): number {
  const snapshot = filesystemInvalidations().get(instanceId)
  if (!snapshot) return 0
  if (directory === undefined) return snapshot.version
  const version = relative === undefined ? snapshot.roots.get(rootKey(directory))
    : snapshot.paths.get(pathKey(directory, relative))
  return Math.max(snapshot.full, version ?? 0)
}

serverEvents.on("workspace.filesChanged", event => {
  if (event.type === "workspace.filesChanged") queueFilesystemInvalidation(event.workspaceId, event.changes)
})
serverEvents.on("workspace.stopped", event => {
  if (event.type !== "workspace.stopped") return
  const queued = pending.get(event.workspaceId)
  if (queued) clearTimeout(queued.timer)
  pending.delete(event.workspaceId); lastPassive.delete(event.workspaceId)
  setFilesystemInvalidations(previous => { const next = new Map(previous); next.delete(event.workspaceId); return next })
})

export function createDebouncedRefresh(callback: () => void, delay = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    trigger() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; callback() }, delay)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
