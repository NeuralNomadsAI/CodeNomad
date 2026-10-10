import { readdir, stat } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import path from "node:path"

export const PRESENCE_INTERVAL_MS = 2_000
export const PRESENCE_EXPIRY_MS = 15_000

type Snapshot = {
  users: number
  checkedAt: number
  active: boolean
  pending?: Promise<boolean>
}

// Each native Location loads each plugin, and the independently bundled plugins
// contain separate copies of this module. Share observations across those copies,
// not their registrations: execution-time backend authority remains unchanged.
const snapshotsKey = Symbol.for("codenomad.desktop-plugin-presence.snapshot.v1")
const processScope = globalThis as typeof globalThis & { [key: symbol]: Map<string, Snapshot> | undefined }
const snapshots = processScope[snapshotsKey] ??= new Map<string, Snapshot>()

function acquireSnapshot(directory: string) {
  let snapshot = snapshots.get(directory)
  if (!snapshot) {
    snapshot = { users: 0, checkedAt: Number.NEGATIVE_INFINITY, active: false }
    snapshots.set(directory, snapshot)
  }
  const entry = snapshot
  entry.users++
  return {
    read(): Promise<boolean> {
      if (entry.pending) return entry.pending
      const checkedAt = performance.now()
      if (checkedAt - entry.checkedAt < PRESENCE_INTERVAL_MS) return Promise.resolve(entry.active)
      entry.pending = hasPresence(directory).then(active => {
        // Age from scan admission, not completion: a slow scan gets no extra TTL.
        entry.checkedAt = checkedAt
        entry.active = active
        return active
      }).finally(() => { entry.pending = undefined })
      return entry.pending
    },
    release() {
      if (--entry.users === 0 && snapshots.get(directory) === entry) snapshots.delete(directory)
    },
  }
}

export async function hasPresence(directory: string, now = Date.now()): Promise<boolean> {
  const names = await readdir(directory).catch(() => [])
  const active = await Promise.all(names.filter(name => /^[\da-f-]+\.lease$/.test(name)).map(async name => {
    const entry = await stat(path.join(directory, name)).catch(() => undefined)
    return Boolean(entry?.isFile() && now - entry.mtimeMs < PRESENCE_EXPIRY_MS)
  }))
  return active.some(Boolean)
}

// Serial reconciliation prevents overlapping setup/dispose and resurrection on unload.
export async function followPresence(
  directory: string | readonly string[],
  register: () => Promise<() => void | Promise<void>>,
  onError: (error: unknown) => void = console.error,
  retainWithoutPresence: () => Promise<boolean> = async () => false,
) {
  const readers = [...new Set(typeof directory === "string" ? [directory] : directory)].map(acquireSnapshot)
  let dispose: (() => void | Promise<void>) | undefined
  let stopped = false
  let pending: Promise<void> | undefined
  let cleanup: Promise<void> | undefined
  let released = false
  const reconcile = () => {
    if (pending) return pending
    pending = (async () => {
      const active = !stopped && (await Promise.all(readers.map(reader => reader.read()))).some(Boolean)
      if (active && !dispose && !stopped) dispose = await register()
      if (dispose && (stopped || (!active && !await retainWithoutPresence()))) {
        await dispose()
        dispose = undefined
      }
    })().finally(() => { pending = undefined })
    return pending
  }
  try {
    await reconcile()
  } catch (error) {
    readers.forEach(reader => reader.release())
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
      if (!released) {
        released = true
        readers.forEach(reader => reader.release())
      }
    }
  })().catch(error => {
    cleanup = undefined
    throw error
  })
}
