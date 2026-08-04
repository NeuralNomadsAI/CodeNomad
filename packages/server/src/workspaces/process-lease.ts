import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import { normalizeWorkspaceIdentityPath } from "./workspace-identity"
import {
  probeLaunchCleanupToken,
  probePosixProcesses,
  probeWindowsProcesses,
  sameProcess,
  type ProcessIdentity,
} from "./process-identity"

const OWNER_FILE = "owner.json"
const DEFAULT_HEARTBEAT_MS = 5_000

interface LeaseOwner {
  version: 1
  managerToken: string
  leaseToken: string
  pid: number
  hostname: string
  processStart?: string
  workspacePath: string
}

export interface WorkspaceProcessLease {
  release(): Promise<void>
  prepareLaunch(): Promise<string>
  setProcessIdentity(identity: ProcessIdentity): Promise<void>
  onLost(callback: () => void): void
}

export interface WorkspaceProcessLeaseRegistryOptions {
  directory: string
  heartbeatMs?: number
  staleMs?: number
  managerToken?: string
  pid?: number
  hostname?: string
  processStart?: string
  isPidAlive?: (pid: number) => boolean
  isProcessIdentityAlive?: (identity: ProcessIdentity) => boolean
  isLaunchTokenAlive?: (token: string) => boolean | undefined
}

interface ObservedOwner {
  owner: LeaseOwner
  serialized: string
  heartbeat: string
}

interface HeldLease {
  count: number
  directory: string
  owner: LeaseOwner
  heartbeat: NodeJS.Timeout
  lost: boolean
  releaseFailed: boolean
  launchToken?: string
  onLost: Set<() => void>
}

export class WorkspaceProcessLeaseRegistry {
  private readonly managerToken: string
  private readonly pid: number
  private readonly hostname: string
  private readonly heartbeatMs: number
  private readonly held = new Map<string, HeldLease>()
  private processStart: string | undefined

  constructor(private readonly options: WorkspaceProcessLeaseRegistryOptions) {
    this.managerToken = options.managerToken ?? randomUUID()
    this.pid = options.pid ?? process.pid
    this.hostname = options.hostname ?? os.hostname()
    this.processStart = options.processStart
    this.heartbeatMs = Math.max(10, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
  }

  async acquire(workspacePath: string): Promise<WorkspaceProcessLease | undefined> {
    const canonicalPath = normalizeWorkspaceIdentityPath(workspacePath)
    const key = createHash("sha256").update(canonicalPath).digest("hex")
    const existing = this.held.get(key)
    if (existing) {
      if (existing.releaseFailed) existing.releaseFailed = false
      else existing.count += 1
      return this.handle(key, existing.owner.leaseToken)
    }

    const directory = path.join(this.options.directory, key)
    await fs.mkdir(directory, { recursive: true })
    this.processStart ??= await readProcessStart(this.pid)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const owner: LeaseOwner = {
        version: 1,
        managerToken: this.managerToken,
        leaseToken: randomUUID(),
        pid: this.pid,
        hostname: this.hostname,
        processStart: this.processStart,
        workspacePath: canonicalPath,
      }
      if (await publishOwner(directory, owner)) {
        const heartbeat = setInterval(() => void this.heartbeat(key, owner), this.heartbeatMs)
        heartbeat.unref()
        this.held.set(key, { count: 1, directory, owner, heartbeat, lost: false, releaseFailed: false, onLost: new Set() })
        return this.handle(key, owner.leaseToken)
      }

      const observed = await readOwner(directory)
      if (!observed || !await this.ownerIsStale(directory, observed.owner)) return undefined
      if (!await retireOwner(directory, observed)) return undefined
    }
    return undefined
  }

  private handle(key: string, leaseToken: string): WorkspaceProcessLease {
    let released = false
    let lostCallback: (() => void) | undefined
    return {
      release: async () => {
        if (released) return
        const held = this.held.get(key)
        if (!held || held.owner.leaseToken !== leaseToken) return
        if (held.count > 1) {
          held.count -= 1
          released = true
          if (lostCallback) held.onLost.delete(lostCallback)
          return
        }
        try {
          const observed = await readOwner(held.directory)
          if (observed?.owner.leaseToken === leaseToken
            && !await retireOwner(held.directory, observed)) {
            throw new Error(`Workspace process lease ${leaseToken} could not be retired; release can be retried`)
          }
        } catch (error) {
          held.releaseFailed = true
          throw error
        }
        released = true
        this.held.delete(key)
        clearInterval(held.heartbeat)
        if (lostCallback) held.onLost.delete(lostCallback)
      },
      prepareLaunch: async () => {
        const held = this.held.get(key)
        if (!held || held.owner.leaseToken !== leaseToken || held.lost) throw new Error("Workspace process lease was lost")
        if (held.launchToken) return held.launchToken
        const token = randomUUID()
        await writeLaunchToken(held.directory, leaseToken, token)
        if ((await readOwner(held.directory))?.owner.leaseToken !== leaseToken) {
          this.lose(key, held)
          throw new Error("Workspace process lease was lost")
        }
        held.launchToken = token
        return token
      },
      setProcessIdentity: async (identity) => {
        const held = this.held.get(key)
        if (!held || held.owner.leaseToken !== leaseToken || held.lost) throw new Error("Workspace process lease was lost")
        await writeProcessIdentity(held.directory, leaseToken, identity)
        if ((await readOwner(held.directory))?.owner.leaseToken !== leaseToken) {
          this.lose(key, held)
          throw new Error("Workspace process lease was lost")
        }
      },
      onLost: (callback) => {
        const held = this.held.get(key)
        if (!held || held.owner.leaseToken !== leaseToken || held.lost) queueMicrotask(callback)
        else {
          if (lostCallback) held.onLost.delete(lostCallback)
          lostCallback = callback
          held.onLost.add(callback)
        }
      },
    }
  }

  private async heartbeat(key: string, owner: LeaseOwner): Promise<void> {
    const held = this.held.get(key)
    if (!held || held.owner.leaseToken !== owner.leaseToken || held.lost) return
    try {
      if (await heartbeatOwner(held.directory, owner)) return
    } catch {
      // Fail closed: durable ownership cannot be assumed after a heartbeat I/O failure.
    }
    this.lose(key, held)
  }

  private lose(key: string, held: HeldLease): void {
    if (this.held.get(key) !== held || held.lost) return
    held.lost = true
    clearInterval(held.heartbeat)
    for (const callback of held.onLost) callback()
  }

  private async ownerIsStale(directory: string, owner: LeaseOwner): Promise<boolean> {
    if (owner.hostname === this.hostname) {
      let serverAlive = (this.options.isPidAlive ?? isPidAlive)(owner.pid)
      if (owner.processStart) {
        const currentStart = await readProcessStart(owner.pid)
        if (currentStart) serverAlive = currentStart === owner.processStart
      }
      const workspaceProcesses = await readProcessIdentities(directory, owner.leaseToken)
      const workspaceAlive = workspaceProcesses.some(this.options.isProcessIdentityAlive ?? processIdentityIsAlive)
      if (serverAlive || workspaceAlive) return false
      if (workspaceProcesses.length > 0) return true
      const launchTokens = await readLaunchTokens(directory, owner.leaseToken)
      const tokenAlive = this.options.isLaunchTokenAlive ?? launchTokenIsAlive
      for (const token of launchTokens) if (tokenAlive(token) !== false) return false
      return true
    }
    return false
  }
}

async function publishOwner(directory: string, owner: LeaseOwner): Promise<boolean> {
  const temporary = path.join(directory, `.owner.${owner.leaseToken}.tmp`)
  const destination = path.join(directory, "owner")
  try {
    await fs.mkdir(temporary)
    const file = await fs.open(path.join(temporary, OWNER_FILE), "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify(owner), "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.writeFile(path.join(temporary, "heartbeat"), randomUUID(), { encoding: "utf8", flag: "wx", mode: 0o600 })
    await fs.rename(temporary, destination)
    return true
  } catch (error) {
    if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY") || hasCode(error, "EPERM")) return false
    throw error
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function readOwner(directory: string, ownerDirectory = "owner"): Promise<ObservedOwner | undefined> {
  try {
    const [serialized, heartbeat] = await Promise.all([
      fs.readFile(path.join(directory, ownerDirectory, OWNER_FILE), "utf8"),
      fs.readFile(path.join(directory, ownerDirectory, "heartbeat"), "utf8"),
    ])
    const owner = JSON.parse(serialized) as Partial<LeaseOwner>
    if (owner.version !== 1 || !safeToken(owner.managerToken) || !safeToken(owner.leaseToken) ||
      !Number.isInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.hostname !== "string" ||
      typeof owner.workspacePath !== "string") return undefined
    return { owner: owner as LeaseOwner, serialized, heartbeat }
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function heartbeatOwner(directory: string, owner: LeaseOwner): Promise<boolean> {
  const current = await readOwner(directory)
  if (current?.owner.leaseToken !== owner.leaseToken) return false
  const temporary = path.join(directory, `.heartbeat.${owner.leaseToken}.${randomUUID()}.tmp`)
  await fs.writeFile(temporary, randomUUID(), { encoding: "utf8", flag: "wx", mode: 0o600 })
  try {
    if ((await readOwner(directory))?.owner.leaseToken !== owner.leaseToken) return false
    await fs.rename(temporary, path.join(directory, "owner", "heartbeat"))
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
  return (await readOwner(directory))?.owner.leaseToken === owner.leaseToken
}

async function retireOwner(directory: string, observed: ObservedOwner): Promise<boolean> {
  const current = await readOwner(directory)
  if (!sameObservedOwner(current, observed)) return false
  const retired = `retired.${observed.owner.leaseToken}`
  try {
    // ponytail: generation tombstones are tiny and prevent a stale reclaimer from ever targeting a successor.
    await fs.rename(path.join(directory, "owner"), path.join(directory, retired))
    const moved = await readOwner(directory, retired)
    if (!sameObservedOwner(moved, observed)) {
      await fs.rename(path.join(directory, retired), path.join(directory, "owner")).catch(() => undefined)
      return false
    }
    return true
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].some((code) => hasCode(error, code))) return false
    throw error
  }
}

function sameObservedOwner(left: ObservedOwner | undefined, right: ObservedOwner): boolean {
  return left?.serialized === right.serialized
    && left.owner.leaseToken === right.owner.leaseToken
    && left.heartbeat === right.heartbeat
}

function safeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !hasCode(error, "ESRCH")
  }
}

async function readProcessStart(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  } catch {
    return undefined
  }
}

async function writeProcessIdentity(directory: string, leaseToken: string, identity: ProcessIdentity): Promise<void> {
  const identityToken = createHash("sha256").update(JSON.stringify(identity)).digest("hex")
  await fs.writeFile(path.join(directory, `process.${leaseToken}.${identityToken}.json`), JSON.stringify(identity), {
    encoding: "utf8", flag: "wx", mode: 0o600,
  }).catch((error) => { if (!hasCode(error, "EEXIST")) throw error })
}

async function writeLaunchToken(directory: string, leaseToken: string, token: string): Promise<void> {
  const handle = await fs.open(path.join(directory, `launch.${leaseToken}.json`), "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify({ token }), "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readLaunchTokens(directory: string, leaseToken: string): Promise<string[]> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, `launch.${leaseToken}.json`), "utf8")) as { token?: unknown }
    return typeof value.token === "string" && value.token.length > 0 ? [value.token] : []
  } catch (error) {
    if (hasCode(error, "ENOENT")) return []
    return [""]
  }
}

async function readProcessIdentities(directory: string, leaseToken: string): Promise<ProcessIdentity[]> {
  try {
    const entries = await fs.readdir(directory)
    const identities = await Promise.all(entries.filter((entry) => entry.startsWith(`process.${leaseToken}.`) && entry.endsWith(".json"))
      .map(async (entry) => JSON.parse(await fs.readFile(path.join(directory, entry), "utf8")) as ProcessIdentity))
    return identities.filter((identity) => Number.isInteger(identity.pid) && identity.pid > 0 && typeof identity.startTime === "string")
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) return []
    throw error
  }
}

function processIdentityIsAlive(identity: ProcessIdentity): boolean {
  const snapshot = process.platform === "win32"
    ? probeWindowsProcesses(spawnSync, 1_000)
    : probePosixProcesses(spawnSync, 1_000, process.platform, { pids: [identity.pid] })
  return snapshot.ok && sameProcess(identity, snapshot.processes.get(identity.pid))
}

function launchTokenIsAlive(token: string): boolean | undefined {
  if (!token) return undefined
  const snapshot = probeLaunchCleanupToken(spawnSync, token, 1_000, undefined, process.platform)
  return snapshot.ok ? snapshot.processes.size > 0 : undefined
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
