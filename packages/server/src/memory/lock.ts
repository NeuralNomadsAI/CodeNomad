import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { hostname } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { lookupProcess, type ProcessLookup, type ProcessState } from "../host-lifetime/process-identity"
import { validateOwner, type Owner } from "../host-lifetime/protocol"
import { MemoryError } from "./model"

type LockOwner = Partial<Owner> & { pid: number; nonce: string; host?: string; platform?: string }
const HOST = hostname()
const WAIT_MS = 30_000
let self: Promise<ProcessState> | undefined

async function selfState(): Promise<ProcessState> {
  // ponytail: nonce fallback waits for PID exit; use a native Windows helper if
  // recovery of reused PIDs must also work without a process-inspection tool.
  return self ??= lookupProcess(process.pid).then(result => result.state === "live" ? result
    : { state: "live", startIdentity: `memory-self:${randomUUID()}` })
}

async function memoryOwnerState(owner: Owner, lookup: ProcessLookup): Promise<"live" | "dead" | "unknown"> {
  validateOwner(owner)
  const found = await lookup(owner.pid)
  if (found.state !== "live") return found.state
  if (found.startIdentity === owner.startIdentity) return "live"
  // A process-local nonce is qualified only by that process. Another live PID
  // cannot disprove its generation; only a confirmed exit permits recovery.
  if ([found.startIdentity, owner.startIdentity].some(id => id.startsWith("memory-self:"))) return "unknown"
  return "dead"
}

function sharingViolation(error: unknown): boolean {
  return ["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
}

/** Called after publication, before admitting the writer. Every possible old
 * reaper published its candidate before observing the retired lock. Keep the
 * fences while any such participant could still resume. New contenders can only
 * observe our current lock, so their arrival during cleanup is harmless. */
async function pruneRecoveryMarkers(lock: string, lookup: ProcessLookup): Promise<void> {
  const parent = path.dirname(lock), base = path.basename(lock)
  const names = await readdir(parent)
  const nonce = /^[a-f0-9-]{36}$/
  const candidates = names.filter(name => name.startsWith(`${base}.`) && nonce.test(name.slice(base.length + 1)))
  for (const name of candidates) {
    try {
      const directory = path.join(parent, name)
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) return
      const owner = JSON.parse(await readFile(path.join(directory, "owner"), "utf8")) as LockOwner
      if (owner.nonce !== name.slice(base.length + 1) || !Number.isSafeInteger(owner.pid) || owner.pid < 1
        || owner.host !== HOST || owner.platform !== process.platform) return
      if (owner.startIdentity !== undefined) validateOwner(owner as Owner)
      const state = owner.startIdentity !== undefined ? await memoryOwnerState(owner as Owner, lookup)
        : (await lookup(owner.pid)).state === "dead" ? "dead" : "unknown"
      if (state !== "dead") return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return
    }
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.dead-`) || !nonce.test(name.slice(base.length + 6))) continue
    const directory = path.join(parent, name)
    const info = await lstat(directory)
    if (info.isDirectory() && !info.isSymbolicLink()) await rm(directory, { recursive: true, force: true })
  }
}

/** Publish a populated directory atomically; a crash can never leave an ownerless lock. */
export async function lockMemoryRepository(directory: string, lookup: ProcessLookup = lookupProcess): Promise<() => Promise<void>> {
  const lock = `${directory}.lock`
  const nonce = randomUUID()
  const candidate = `${lock}.${nonce}`
  const current = await (lookup === lookupProcess ? selfState() : lookup(process.pid))
  if (current.state !== "live") throw new MemoryError("conflict", "Memory process identity is unavailable")
  const owner = JSON.stringify({ pid: process.pid, startIdentity: current.startIdentity, nonce, host: HOST, platform: process.platform })
  const localLookup: ProcessLookup = pid => {
    if (pid === process.pid) return Promise.resolve(current)
    if (lookup === lookupProcess) {
      try { process.kill(pid, 0) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return Promise.resolve({ state: "dead" }) }
    }
    return lookup(pid)
  }
  await mkdir(candidate, { mode: 0o700 })
  try {
    await writeFile(`${candidate}/owner`, owner, { flag: "wx", mode: 0o600 })
    const deadline = Date.now() + WAIT_MS
    let checked: { nonce: string; at: number; state: "live" | "dead" | "unknown" } | undefined
    for (;;) {
      if (Date.now() >= deadline) throw new MemoryError("conflict", "Memory repository is busy")
      try {
        await rename(candidate, lock)
        // Maintenance owns the published lock; errors conservatively retain fences.
        await pruneRecoveryMarkers(lock, localLookup).catch(() => undefined)
        let released = false
        return async () => {
          if (released) return
          const releaseDeadline = Date.now() + WAIT_MS
          for (;;) {
            try {
              if (await readFile(`${lock}/owner`, "utf8") !== owner)
                throw new MemoryError("conflict", "Memory repository ownership changed")
              // Windows readers/scanners can briefly deny directory renames.
              // Reverify ownership on every retry; never remove the published directory.
              await rename(lock, candidate)
              released = true
              break
            } catch (error) {
              if (!sharingViolation(error) || Date.now() >= releaseDeadline) throw error
              await delay(20)
            }
          }
          // The published name is already free. A delayed private cleanup cannot
          // invalidate a completed commit or remove a successor's lock.
          await rm(candidate, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }).catch(() => undefined)
        }
      } catch (error) {
        let previous: LockOwner
        let previousText: string
        try {
          const info = await lstat(lock)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid lock")
          previousText = await readFile(`${lock}/owner`, "utf8")
          previous = JSON.parse(previousText)
          if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || !/^[a-f0-9-]{36}$/.test(previous.nonce))
            throw new Error("Invalid owner")
          if (previous.startIdentity !== undefined) validateOwner(previous as Owner)
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") {
            await delay(20)
            continue
          }
          if (sharingViolation(inspectionError)) { await delay(20); continue }
          throw new MemoryError("conflict", "Memory repository lock is unavailable")
        }
        if (previous.host !== undefined && (previous.host !== HOST || previous.platform !== process.platform))
          throw new MemoryError("conflict", "Memory repository owner is on another host")
        if (!checked || checked.nonce !== previous.nonce || Date.now() - checked.at >= 1000) {
          const state = previous.startIdentity !== undefined
            ? await memoryOwnerState(previous as Owner, localLookup)
            : (await localLookup(previous.pid)).state === "dead" ? "dead" : "unknown"
          checked = { nonce: previous.nonce, state, at: Date.now() }
        }
        // The observed owner may have released and exited while its process was
        // being probed. Its successor then has no dead-owner fence yet.
        if (await readFile(`${lock}/owner`, "utf8").catch(() => undefined) !== previousText) continue
        if (checked.state === "unknown") throw new MemoryError("conflict", "Memory repository owner is unavailable")
        if (checked.state === "dead") {
          // Keep a nonempty tombstone until acquisition proves old reapers are
          // quiescent. Concurrent reapers cannot move a successor into this name.
          await rename(lock, `${lock}.dead-${previous.nonce}`).catch(() => undefined)
        }
        if (Date.now() >= deadline) throw new MemoryError("conflict", "Memory repository is busy")
        await delay(20)
      }
    }
  } finally {
    await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
  }
}
