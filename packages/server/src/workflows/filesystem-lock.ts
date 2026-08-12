import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { probePosixProcesses, probeWindowsProcesses } from "../workspaces/process-identity"

interface LockOwner {
  token: string
  pid: number
  hostname?: string
  runtimeToken?: string
  processStart?: string
  bootId?: string
}

interface ObservedOwner {
  token?: string
  serialized?: string
}

interface ReclaimClaim {
  token: string
  owner: ObservedOwner
  createdAt: number
}

export interface FilesystemLockOptions {
  waitMs?: number
  staleMs?: number
  pollMs?: number
}

const WAIT_MS = 5_000
const STALE_MS = 30_000
const POLL_MS = 20
const RUNTIME_TOKEN = randomUUID()
const PROCESS_IDENTITY = processIdentity(process.pid)

export async function withFilesystemLock<T>(
  lockPath: string,
  operation: (assertOwned: () => Promise<void>) => Promise<T>,
  options: FilesystemLockOptions = {},
): Promise<T> {
  const waitMs = options.waitMs ?? WAIT_MS
  const staleMs = options.staleMs ?? STALE_MS
  const pollMs = options.pollMs ?? POLL_MS
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  let deadline = Date.now() + waitMs
  let staleRetryGranted = false
  const identity = PROCESS_IDENTITY
  const owner: LockOwner = {
    token: randomUUID(), pid: process.pid, hostname: os.hostname(), runtimeToken: RUNTIME_TOKEN,
    ...(identity ? { processStart: identity.startTime, ...(identity.bootId ? { bootId: identity.bootId } : {}) } : {}),
  }

  while (true) {
    try {
      if (!await publishLock(lockPath, owner)) throw Object.assign(new Error("Lock exists"), { code: "EEXIST" })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() < deadline) {
        await delay(pollMs)
        continue
      }
      if (!staleRetryGranted && await removeStaleLock(lockPath, staleMs, pollMs)) {
        staleRetryGranted = true
        deadline = Date.now() + waitMs
        await delay(pollMs)
        continue
      }
      if (staleRetryGranted && Date.now() < deadline) {
        await delay(pollMs)
        continue
      }
      throw new Error(`Timed out waiting for filesystem lock ${lockPath}`)
    }
  }

  const assertOwned = async () => {
    const current = await readObservedOwner(lockPath)
    if (current.token !== owner.token || await readClaim(lockPath)) {
      throw new Error(`Filesystem lock ownership was lost for ${lockPath}`)
    }
  }
  const heartbeat = setInterval(() => void heartbeatOwned(lockPath, owner.token).catch(() => undefined), staleMs / 3)
  heartbeat.unref()
  try {
    return await operation(assertOwned)
  } finally {
    clearInterval(heartbeat)
    await releaseOwnedLock(lockPath, owner.token, waitMs, staleMs, pollMs)
  }
}

async function publishLock(lockPath: string, owner: LockOwner): Promise<boolean> {
  const prepared = `${lockPath}.prepared.${owner.token}`
  try {
    await fs.mkdir(prepared)
    await fs.writeFile(path.join(prepared, "owner.json"), JSON.stringify(owner), { encoding: "utf8", flag: "wx" })
    await fs.writeFile(path.join(prepared, "heartbeat"), randomUUID(), { encoding: "utf8", flag: "wx" })
    await fs.rename(prepared, lockPath)
    return true
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false
    throw error
  } finally {
    await fs.rm(prepared, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function removeStaleLock(lockPath: string, staleMs: number, pollMs: number): Promise<boolean> {
  let stale = false
  let observed: ObservedOwner = {}
  try {
    const serialized = await fs.readFile(path.join(lockPath, "owner.json"), "utf8")
    const owner = JSON.parse(serialized) as LockOwner
    observed = { token: owner.token, serialized }
    stale = !await ownerIsAlive(owner, lockPath, staleMs, pollMs)
  } catch {
    const first = await heartbeatState(lockPath)
    await delay(staleMs)
    stale = await heartbeatState(lockPath) === first
  }
  if (!stale) {
    const claim = await readClaim(lockPath)
    if (claim && Date.now() - claim.createdAt < staleMs) return true
    if (claim) await removeOwnedClaim(lockPath, claim.token)
    return !sameObservedOwner(await readObservedOwner(lockPath), observed)
  }

  const claim = await acquireClaim(lockPath, observed, staleMs)
  if (!claim) return true
  const quarantinePath = `${lockPath}.stale.${claim.token}`
  let moved = false
  try {
    const current = await readObservedOwner(lockPath)
    const currentClaim = await readClaim(lockPath)
    if (!sameObservedOwner(current, observed) || currentClaim?.token !== claim.token) return true
    await fs.rename(lockPath, quarantinePath)
    moved = true
    const movedOwner = await readObservedOwner(quarantinePath)
    const movedClaim = await readClaim(quarantinePath)
    if (!sameObservedOwner(movedOwner, observed) || movedClaim?.token !== claim.token) {
      await fs.rename(quarantinePath, lockPath).then(() => { moved = false }).catch(() => undefined)
      return true
    }
    await fs.rm(quarantinePath, { recursive: true, force: true })
    return true
  } catch (error) {
    if (["ENOENT", "EPERM", "EACCES", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) return true
    throw error
  } finally {
    if (!moved) await removeOwnedClaim(lockPath, claim.token)
  }
}

async function acquireClaim(lockPath: string, owner: ObservedOwner, staleMs: number): Promise<ReclaimClaim | undefined> {
  const claimPath = path.join(lockPath, ".reclaim")
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim: ReclaimClaim = { token: randomUUID(), owner, createdAt: Date.now() }
    try {
      await fs.writeFile(claimPath, JSON.stringify(claim), { encoding: "utf8", flag: "wx" })
      return claim
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const existing = await readClaim(lockPath)
    if (!existing || Date.now() - existing.createdAt < staleMs) return undefined
    const abandoned = `${claimPath}.abandoned.${randomUUID()}`
    try {
      await fs.rename(claimPath, abandoned)
      const moved = await readClaimFile(abandoned)
      if (moved?.token !== existing.token) return undefined
    } catch (error) {
      if (!["ENOENT", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
    } finally {
      await fs.rm(abandoned, { force: true }).catch(() => undefined)
    }
  }
  return undefined
}

async function releaseOwnedLock(lockPath: string, token: string, waitMs: number, staleMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  while (true) {
    const observed = await readObservedOwner(lockPath)
    if (observed.token !== token) return
    const claim = await acquireClaim(lockPath, observed, staleMs)
    if (!claim) {
      if (Date.now() >= deadline) return
      await delay(pollMs)
      continue
    }
    const releasedPath = `${lockPath}.released.${claim.token}`
    let moved = false
    try {
      if ((await readObservedOwner(lockPath)).token !== token || (await readClaim(lockPath))?.token !== claim.token) return
      await fs.rename(lockPath, releasedPath)
      moved = true
      if ((await readObservedOwner(releasedPath)).token !== token) {
        await fs.rename(releasedPath, lockPath).then(() => { moved = false }).catch(() => undefined)
        return
      }
      await fs.rm(releasedPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (["ENOENT", "EPERM", "EACCES", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) return
      throw error
    } finally {
      if (!moved) await removeOwnedClaim(lockPath, claim.token)
    }
  }
}

async function heartbeatOwned(lockPath: string, token: string): Promise<void> {
  if ((await readObservedOwner(lockPath)).token !== token || await readClaim(lockPath)) return
  await fs.writeFile(path.join(lockPath, "heartbeat"), randomUUID(), "utf8")
}

async function readClaim(lockPath: string): Promise<ReclaimClaim | undefined> {
  return readClaimFile(path.join(lockPath, ".reclaim"))
}

async function readClaimFile(claimPath: string): Promise<ReclaimClaim | undefined> {
  try {
    const serialized = await fs.readFile(claimPath, "utf8")
    try {
      const claim = JSON.parse(serialized) as ReclaimClaim
      if (typeof claim.token === "string" && Number.isFinite(claim.createdAt)) return claim
    } catch {
      // Malformed claims are treated as an expiring generation, never removed blindly.
    }
    const stat = await fs.stat(claimPath)
    return { token: `malformed-${createHash("sha256").update(serialized).digest("hex")}`, owner: { serialized }, createdAt: stat.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function removeOwnedClaim(lockPath: string, token: string): Promise<void> {
  const claim = await readClaim(lockPath)
  if (claim?.token === token) await fs.rm(path.join(lockPath, ".reclaim"), { force: true }).catch(() => undefined)
}

async function readObservedOwner(lockPath: string): Promise<ObservedOwner> {
  try {
    const serialized = await fs.readFile(path.join(lockPath, "owner.json"), "utf8")
    try {
      return { token: (JSON.parse(serialized) as LockOwner).token, serialized }
    } catch {
      return { serialized }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}

function sameObservedOwner(left: ObservedOwner, right: ObservedOwner): boolean {
  return left.token !== undefined || right.token !== undefined
    ? left.token !== undefined && left.token === right.token
    : left.serialized === right.serialized
}

async function ownerIsAlive(owner: LockOwner, lockPath: string, staleMs: number, pollMs: number): Promise<boolean> {
  if (owner.runtimeToken === RUNTIME_TOKEN) return true
  if (owner.hostname && owner.hostname !== os.hostname()) return true
  const liveness = processLiveness(owner)
  if (liveness !== "unknown") return liveness === "alive"
  const first = await heartbeatState(lockPath)
  const deadline = Date.now() + staleMs
  while (Date.now() < deadline) {
    await delay(Math.min(Math.max(pollMs, 1), deadline - Date.now()))
    try {
      const current = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as LockOwner
      if (current.token !== owner.token) return true
    } catch {
      return true
    }
    if (await heartbeatState(lockPath) !== first) return true
  }
  return false
}

async function heartbeatState(lockPath: string): Promise<string> {
  try {
    return await fs.readFile(path.join(lockPath, "heartbeat"), "utf8")
  } catch {
    try {
      return String((await fs.stat(lockPath)).mtimeMs)
    } catch {
      return "missing"
    }
  }
}

function processIdentity(pid: number): { startTime: string; bootId?: string } | undefined {
  const snapshot = process.platform === "win32"
    ? probeWindowsProcesses(spawnSync, 1_000)
    : probePosixProcesses(spawnSync, 1_000, process.platform, { pids: [pid] })
  const identity = snapshot.ok ? snapshot.processes.get(pid) : undefined
  return identity && { startTime: identity.startTime, ...(identity.bootId ? { bootId: identity.bootId } : {}) }
}

function processLiveness(owner: LockOwner): "alive" | "dead" | "unknown" {
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"
  }
  if (!owner.processStart) return "alive"
  if (owner.pid === process.pid && PROCESS_IDENTITY) {
    return PROCESS_IDENTITY.startTime === owner.processStart && (!owner.bootId || PROCESS_IDENTITY.bootId === owner.bootId)
      ? "alive" : "dead"
  }
  const snapshot = process.platform === "win32"
    ? probeWindowsProcesses(spawnSync, 1_000)
    : probePosixProcesses(spawnSync, 1_000, process.platform, { pids: [owner.pid] })
  if (snapshot.ok) {
    const current = snapshot.processes.get(owner.pid)
    if (!current) return "dead"
    return current.startTime === owner.processStart && (!owner.bootId || current.bootId === owner.bootId) ? "alive" : "dead"
  }
  return "unknown"
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
