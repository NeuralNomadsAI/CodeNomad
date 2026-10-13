import { readdir, stat, writeFile } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import path from "node:path"

export const PRESENCE_INTERVAL_MS = 2_000
export const PRESENCE_EXPIRY_MS = 15_000
// Written beside a backend lease once every follower of that presence directory
// in this native process has observed the lease while registered. The backend
// waits (bounded) for it before its first plugin RPC.
export const PRESENCE_READY_SUFFIX = ".ready"
const LEASE = /^[\da-f-]+\.lease$/

type Follower = { acknowledged: ReadonlySet<string> }
type Snapshot = {
  users: number
  checkedAt: number
  leases: readonly string[]
  pending?: Promise<readonly string[]>
  followers: Set<Follower>
  marked: Set<string>
}

// Each native Location loads each plugin, and the independently bundled plugins
// contain separate copies of this module. Share observations across those copies,
// not their registrations: execution-time backend authority remains unchanged.
// v2 observations carry lease names; older bundle copies keep their own v1 map.
const snapshotsKey = Symbol.for("codenomad.desktop-plugin-presence.snapshot.v2")
const processScope = globalThis as typeof globalThis & { [key: symbol]: Map<string, Snapshot> | undefined }
const snapshots = processScope[snapshotsKey] ??= new Map<string, Snapshot>()

function acquireSnapshot(directory: string) {
  let snapshot = snapshots.get(directory)
  if (!snapshot) {
    snapshot = { users: 0, checkedAt: Number.NEGATIVE_INFINITY, leases: [], followers: new Set(), marked: new Set() }
    snapshots.set(directory, snapshot)
  }
  const entry = snapshot
  entry.users++
  return {
    read(): Promise<readonly string[]> {
      if (entry.pending) return entry.pending
      const checkedAt = performance.now()
      if (checkedAt - entry.checkedAt < PRESENCE_INTERVAL_MS) return Promise.resolve(entry.leases)
      entry.pending = activeLeases(directory).then(leases => {
        // Age from scan admission, not completion: a slow scan gets no extra TTL.
        entry.checkedAt = checkedAt
        entry.leases = leases
        return leases
      }).finally(() => { entry.pending = undefined })
      return entry.pending
    },
    join(follower: Follower) { entry.followers.add(follower) },
    leave(follower: Follower) { entry.followers.delete(follower) },
    // Marks each lease every follower has acknowledged; a failed write is retried
    // on a later reconciliation. A marker never implies a later re-registration.
    acknowledge() {
      const followers = [...entry.followers]
      for (const lease of entry.marked) if (!entry.leases.includes(lease)) entry.marked.delete(lease)
      for (const lease of entry.leases) {
        if (entry.marked.has(lease) || !followers.length || !followers.every(follower => follower.acknowledged.has(lease))) continue
        entry.marked.add(lease)
        void writeFile(path.join(directory, `${lease}${PRESENCE_READY_SUFFIX}`), "").catch(() => { entry.marked.delete(lease) })
      }
    },
    release() {
      if (--entry.users === 0 && snapshots.get(directory) === entry) snapshots.delete(directory)
    },
  }
}

async function activeLeases(directory: string, now = Date.now()): Promise<string[]> {
  const names = await readdir(directory).catch(() => [])
  const active = await Promise.all(names.filter(name => LEASE.test(name)).map(async name => {
    const entry = await stat(path.join(directory, name)).catch(() => undefined)
    return entry?.isFile() && now - entry.mtimeMs < PRESENCE_EXPIRY_MS ? name : undefined
  }))
  return active.filter((name): name is string => name !== undefined)
}

export async function hasPresence(directory: string, now = Date.now()): Promise<boolean> {
  return (await activeLeases(directory, now)).length > 0
}

// Serial reconciliation prevents overlapping setup/dispose and resurrection on unload.
export async function followPresence(
  directory: string | readonly string[],
  register: () => Promise<() => void | Promise<void>>,
  onError: (error: unknown) => void = console.error,
  retainWithoutPresence: () => Promise<boolean> = async () => false,
) {
  const readers = [...new Set(typeof directory === "string" ? [directory] : directory)].map(acquireSnapshot)
  // The first directory is the current backend namespace; older ones are read-only.
  const primary = readers[0]
  const follower: Follower = { acknowledged: new Set() }
  primary?.join(follower)
  let dispose: (() => void | Promise<void>) | undefined
  let stopped = false
  let pending: Promise<void> | undefined
  let cleanup: Promise<void> | undefined
  let released = false
  const reconcile = () => {
    if (pending) return pending
    pending = (async () => {
      const observed = stopped ? [] : await Promise.all(readers.map(reader => reader.read()))
      const active = !stopped && observed.some(leases => leases.length > 0)
      if (active && !dispose && !stopped) dispose = await register()
      if (dispose && (stopped || (!active && !await retainWithoutPresence()))) {
        await dispose()
        dispose = undefined
      }
      follower.acknowledged = new Set(dispose ? observed[0] : [])
      // Outside the serialized reconciliation: marker IO must not delay or
      // swallow the next presence check.
      primary?.acknowledge()
    })().finally(() => { pending = undefined })
    return pending
  }
  const releaseReaders = () => {
    if (released) return
    released = true
    primary?.leave(follower)
    readers.forEach(reader => reader.release())
  }
  try {
    await reconcile()
  } catch (error) {
    releaseReaders()
    throw error
  }
  const timer = setInterval(() => void reconcile().catch(onError), PRESENCE_INTERVAL_MS)
  timer.unref?.()
  return () => cleanup ??= (async () => {
    stopped = true
    clearInterval(timer)
    try {
      await pending?.catch(onError)
      await reconcile()
    } finally {
      releaseReaders()
    }
  })().catch(error => {
    cleanup = undefined
    throw error
  })
}
