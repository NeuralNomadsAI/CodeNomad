import { open, readdir, stat, writeFile } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import path from "node:path"
import { leaseRequestsDesign } from "./design/activation"
import { LEASE_REQUEST_MAX_BYTES } from "./lease-request"
import { leaseRequestsMemory } from "./memory/activation"
import { registeredReadiness } from "./desktop-plugin-readiness"

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
  // Each handle owns only the marker writes it admits, even across bundle copies.
  const writes = new Set<Promise<void>>()
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
        const writing = writeFile(path.join(directory, `${lease}${PRESENCE_READY_SUFFIX}`), "")
          .catch(() => { entry.marked.delete(lease) })
          .finally(() => { writes.delete(writing) })
        writes.add(writing)
      }
    },
    async drain() { await Promise.all(writes) },
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

// Feature requests carried in lease content (Design, agent memory) have their own
// shared observations, so the presence snapshot above, and its readiness
// acknowledgement, stay shared with older bundle copies. Each request keeps its
// own versioned key and snapshot shape for the same reason.
type RequestSnapshot = { users: number; checkedAt: number; requested: boolean; pending?: Promise<boolean> }
type RequestKind = { key: symbol; matches: (content: string) => boolean }
const requestScope = globalThis as typeof globalThis & { [key: symbol]: Map<string, RequestSnapshot> | undefined }
const DESIGN: RequestKind = { key: Symbol.for("codenomad.desktop-plugin-presence.design.v1"), matches: leaseRequestsDesign }
const MEMORY: RequestKind = { key: Symbol.for("codenomad.desktop-plugin-presence.memory.v1"), matches: leaseRequestsMemory }

function acquireRequestSnapshot(kind: RequestKind, directory: string) {
  const snapshots = requestScope[kind.key] ??= new Map<string, RequestSnapshot>()
  let snapshot = snapshots.get(directory)
  if (!snapshot) {
    snapshot = { users: 0, checkedAt: Number.NEGATIVE_INFINITY, requested: false }
    snapshots.set(directory, snapshot)
  }
  const entry = snapshot
  entry.users++
  return {
    read(): Promise<boolean> {
      if (entry.pending) return entry.pending
      const checkedAt = performance.now()
      if (checkedAt - entry.checkedAt < PRESENCE_INTERVAL_MS) return Promise.resolve(entry.requested)
      entry.pending = leasesRequest(directory, kind.matches).then(requested => {
        entry.checkedAt = checkedAt
        entry.requested = requested
        return requested
      }).finally(() => { entry.pending = undefined })
      return entry.pending
    },
    release() {
      if (--entry.users === 0 && snapshots.get(directory) === entry) snapshots.delete(directory)
    },
  }
}

async function leasesRequest(directory: string, matches: RequestKind["matches"], now = Date.now()): Promise<boolean> {
  const names = await readdir(directory).catch(() => [])
  const requests = await Promise.all(names.filter(name => LEASE.test(name)).map(async name => {
    const file = path.join(directory, name)
    const entry = await stat(file).catch(() => undefined)
    return Boolean(entry?.isFile() && now - entry.mtimeMs < PRESENCE_EXPIRY_MS
      && entry.size > 0 && entry.size <= LEASE_REQUEST_MAX_BYTES && await leaseFileRequests(file, matches))
  }))
  return requests.some(Boolean)
}

// Bounded read: an unreadable, oversized or unknown lease requests nothing.
async function leaseFileRequests(file: string, matches: RequestKind["matches"]): Promise<boolean> {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return false
  try {
    const buffer = Buffer.alloc(LEASE_REQUEST_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead <= LEASE_REQUEST_MAX_BYTES && matches(buffer.toString("utf8", 0, bytesRead))
  } catch {
    return false
  } finally {
    await handle.close().catch(() => {})
  }
}

function observeRequest(kind: RequestKind, directory: string | readonly string[]) {
  const readers = [...new Set(typeof directory === "string" ? [directory] : directory)].map(entry => acquireRequestSnapshot(kind, entry))
  let released = false
  return {
    read: async () => (await Promise.all(readers.map(reader => reader.read()))).some(Boolean),
    release() {
      if (released) return
      released = true
      readers.forEach(reader => reader.release())
    },
  }
}

/**
 * Whether any live lease of these directories requests the Design agent, from the
 * shared per-process observation. `read` reuses a scan younger than one interval.
 */
export const observeDesignRequest = (directory: string | readonly string[]) => observeRequest(DESIGN, directory)

/** Whether any live lease of these memory presence directories requests agent memory, as `observeDesignRequest`. */
export const observeMemoryRequest = (directory: string | readonly string[]) => observeRequest(MEMORY, directory)

// Serial reconciliation prevents overlapping setup/dispose and resurrection on unload.
export async function followPresence(
  directory: string | readonly string[],
  register: () => Promise<() => void | Promise<void>>,
  onError: (error: unknown) => void = console.error,
  retainWithoutPresence: () => Promise<boolean> = async () => false,
  readinessLocation?: string,
) {
  const directories = [...new Set(typeof directory === "string" ? [directory] : directory)]
  const readers = directories.map(acquireSnapshot)
  // The first directory is the current backend namespace; older ones are read-only.
  const primary = readers[0]
  const follower: Follower = { acknowledged: new Set() }
  primary?.join(follower)
  let dispose: (() => void | Promise<void>) | undefined
  let stopped = false
  let pending: Promise<void> | undefined
  let cleanup: Promise<void> | undefined
  let released = false
  let readiness: ReturnType<typeof registeredReadiness> | undefined
  const reconcile = () => {
    if (pending) return pending
    pending = (async () => {
      const observed = stopped ? [] : await Promise.all(readers.map(reader => reader.read()))
      const active = !stopped && observed.some(leases => leases.length > 0)
      if (active && !dispose && !stopped) {
        dispose = await register()
        if (readinessLocation && directories[0]) readiness = registeredReadiness(directories[0], readinessLocation, () => {
          if (stopped || !dispose) throw new Error("Pruning readiness scope disposed")
        })
      }
      if (dispose && (stopped || (!active && !await retainWithoutPresence()))) {
        await readiness?.close()
        readiness = undefined
        await dispose()
        dispose = undefined
      }
      if (!stopped && dispose) await readiness?.reconcile(observed[0] ?? [])
      follower.acknowledged = new Set(dispose ? observed[0] : [])
      // Outside the serialized reconciliation: marker IO must not delay or
      // swallow the next presence check.
      if (!stopped) primary?.acknowledge()
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
    try { await readiness?.close(); await dispose?.() }
    finally { releaseReaders() }
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
      await primary?.drain()
      releaseReaders()
    }
  })().catch(error => {
    cleanup = undefined
    throw error
  })
}
