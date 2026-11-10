import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, opendir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

// Presence-owned pruning preparation v1. Uniform fresh challenges avoid a
// first-activation cache: the native catalogue stays active across scope disposal.
export const READINESS_WAIT_MS = 5_000
export const READINESS_MAX_BYTES = 8_192
export const READINESS_MAX_PENDING = 32
const MAX_LEASES = 64
const MAX_RESPONSES = 64
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/
const leaseName = (name: string) => name.endsWith(".lease") && UUID.test(name.slice(0, -6))
type Request = { version: 1; nonce: string; lease: string; directory: string; expires: number }
type Ack = Request & { incarnation: string }
const requestKeys = "directory,expires,lease,nonce,version"

export function isReadinessDirectory(directory: unknown): directory is string {
  return typeof directory === "string" && directory.length > 0 && Buffer.byteLength(directory) <= 4_096
    && !directory.includes("\0") && (path.posix.isAbsolute(directory) || path.win32.isAbsolute(directory))
}

function request(value: unknown): value is Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Request
  return v.version === 1 && typeof v.nonce === "string" && UUID.test(v.nonce)
    && typeof v.lease === "string" && leaseName(v.lease)
    && isReadinessDirectory(v.directory)
    && Number.isSafeInteger(v.expires) && v.expires > Date.now() && v.expires <= Date.now() + READINESS_WAIT_MS
}

async function plainDirectory(directory: string, check: () => void) {
  check()
  const info = await lstat(directory)
  check()
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid readiness directory")
}

// Open bounded regular single-link files; pathname/handle identity also rejects
// a link swapped between lstat and open (Windows has no portable O_NOFOLLOW).
async function read(file: string, check: () => void): Promise<unknown> {
  check()
  const before = await lstat(file, { bigint: true }).catch(() => undefined)
  check()
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(READINESS_MAX_BYTES)) return
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) { check(); return }
  try {
    check()
    const info = await handle.stat({ bigint: true })
    check()
    if (!info.isFile() || info.nlink !== 1n || info.ino !== before.ino || info.dev !== before.dev) return
    const buffer = Buffer.alloc(READINESS_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    check()
    if (bytesRead > READINESS_MAX_BYTES) return
    try { return JSON.parse(buffer.toString("utf8", 0, bytesRead)) } catch { return }
  } finally { await handle.close() }
}

async function liveLease(file: string, check: () => void) {
  check()
  const info = await lstat(file).catch(() => undefined)
  check()
  return Boolean(info?.isFile() && !info.isSymbolicLink() && info.nlink === 1
    && Date.now() - info.mtimeMs >= -1_000 && Date.now() - info.mtimeMs < 15_000)
}

async function names(directory: string, max: number, check: () => void) {
  check()
  const stream = await opendir(directory).catch(() => undefined)
  if (!stream) { check(); return [] }
  const result: string[] = []
  try {
    check()
    for (let i = 0; i <= max; i++) {
      check()
      const entry = await stream.read()
      check()
      if (!entry) return result
      result.push(entry.name)
    }
    throw new Error("Readiness directory exceeds limit")
  } finally { await stream.close() }
}

/** One owner per backend lease; close drains requests before removing the lease. */
export function ownReadiness(lease: string) {
  let closed = false
  const pending = new Set<Promise<unknown>>()
  const directory = `${lease}.prepare`
  return {
    prepare(location: string, signal: AbortSignal, assertCurrent: () => void, deadlineAt = Date.now() + READINESS_WAIT_MS): Promise<Ack> {
      const expires = Math.min(deadlineAt, Date.now() + READINESS_WAIT_MS)
      const check = () => {
        signal.throwIfAborted()
        if (closed) throw new Error("Readiness lease closed")
        if (Date.now() >= expires) throw new Error("Pruning Location readiness timed out or unsupported")
        assertCurrent()
      }
      check()
      if (pending.size >= READINESS_MAX_PENDING) throw new Error("Too many readiness requests")
      const run = (async () => {
        const value: Request = { version: 1, nonce: randomUUID(), lease: path.basename(lease), directory: location, expires }
        if (!request(value)) throw new Error("Invalid readiness Location")
        const content = JSON.stringify(value)
        if (Buffer.byteLength(content) > READINESS_MAX_BYTES) throw new Error("Readiness Location exceeds limit")
        const file = path.join(directory, `${value.nonce}.json`)
        const ackFile = path.join(directory, `${value.nonce}.ack`)
        try {
          check()
          await plainDirectory(path.dirname(lease), check)
          check()
          await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
          check()
          await plainDirectory(directory, check)
          if (!await liveLease(lease, check)) throw new Error("Readiness lease expired")
          check()
          await writeFile(file, content, { flag: "wx" })
          check()
          while (true) {
            check()
            if (!await liveLease(lease, check)) throw new Error("Readiness lease expired")
            const ack = await read(ackFile, check) as Ack | undefined
            check()
            if (ack && Object.keys(ack).sort().join(",") === `${requestKeys},incarnation`.split(",").sort().join(",")
              && request(ack) && UUID.test(ack.incarnation)
              && Object.keys(value).every(key => ack[key as keyof Request] === value[key as keyof Request])) {
              const scope = await read(path.join(path.dirname(lease), `${ack.incarnation}.scope`), check) as Record<string, unknown> | undefined
              check()
              if (scope && Object.keys(scope).sort().join(",") === "directory,incarnation,version"
                && scope.version === 1 && scope.incarnation === ack.incarnation && scope.directory === location) return ack
            }
            check()
            if (Date.now() >= value.expires) throw new Error("Pruning Location readiness timed out or unsupported")
            await delay(100, undefined, { signal })
            check()
          }
        } finally {
          // These are owned cleanup effects, including after cancellation.
          await rm(file, { force: true })
          await rm(ackFile, { force: true })
        }
      })()
      pending.add(run)
      void run.finally(() => pending.delete(run)).catch(() => {})
      return run
    },
    async close() {
      closed = true
      await Promise.allSettled([...pending])
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** Acquired only after actual RPC registration; renewed for each scope incarnation. */
export function registeredReadiness(directory: string, location: string, current: () => void) {
  const incarnation = randomUUID()
  const marker = path.join(directory, `${incarnation}.scope`)
  const responses = new Set<string>()
  let published = false
  let closed = false
  const check = () => { if (closed) throw new Error("Readiness scope closed"); current() }
  return {
    async reconcile(leases: readonly string[]) {
      check()
      if (!published) {
        await plainDirectory(directory, check)
        check()
        await writeFile(marker, JSON.stringify({ version: 1, directory: location, incarnation }), { flag: "wx" })
        published = true
        check()
      }
      // Reclaim only our own responses whose request has gone; at most 64 held.
      for (const file of responses) {
        check()
        const value = await read(file.slice(0, -4) + ".json", check)
        check()
        if (request(value)) continue
        await rm(file, { force: true })
        responses.delete(file)
        check()
      }
      if (leases.length > MAX_LEASES) throw new Error("Too many readiness leases")
      for (const lease of leases) {
        check()
        if (!leaseName(lease) || !await liveLease(path.join(directory, lease), check)) continue
        const requests = path.join(directory, `${lease}.prepare`)
        const info = await lstat(requests).catch(() => undefined)
        check()
        if (!info) continue
        await plainDirectory(requests, check)
        const entries = await names(requests, READINESS_MAX_PENDING * 2, check)
        check()
        for (const entry of entries) {
          check()
          if (!entry.endsWith(".json") || !UUID.test(entry.slice(0, -5))) continue
          const file = path.join(requests, entry)
          const ackFile = file.slice(0, -5) + ".ack"
          if (responses.has(ackFile)) continue
          if (responses.size >= MAX_RESPONSES) return
          const value = await read(file, check)
          check()
          if (!request(value) || Object.keys(value).sort().join(",") !== requestKeys
            || value.nonce !== entry.slice(0, -5) || value.lease !== lease || value.directory !== location) continue
          if (!await liveLease(path.join(directory, lease), check)) continue
          check()
          if (!request(value)) continue
          // wx refuses a foreign or old scope's response rather than replacing it.
          try {
            await writeFile(ackFile, JSON.stringify({ ...value, incarnation }), { flag: "wx" })
            responses.add(ackFile)
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
          check()
        }
      }
    },
    async close() {
      closed = true
      // Caller serializes reconciliation and joins any admitted write first.
      await rm(marker, { force: true })
      for (const file of responses) await rm(file, { force: true })
      responses.clear()
    },
  }
}
