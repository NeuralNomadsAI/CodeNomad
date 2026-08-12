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
const DEFAULT_STALE_MS = 15_000

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
  setProcessIdentities(identities: ProcessIdentity[]): Promise<void>
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
  isProcessIdentityAlive?: (identity: ProcessIdentity) => boolean | undefined
  isLaunchTokenAlive?: (token: string) => boolean | undefined
  platform?: NodeJS.Platform
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
  onLost: Set<() => void>
}

interface LaunchGeneration {
  version: 1
  generation: string
  token: string
  complete: boolean
  identities?: ProcessIdentity[]
}

export class WorkspaceProcessLeaseRegistry {
  private readonly managerToken: string
  private readonly pid: number
  private readonly hostname: string
  private readonly heartbeatMs: number
  private readonly staleMs: number
  private readonly held = new Map<string, HeldLease>()
  private processStart: string | undefined

  constructor(private readonly options: WorkspaceProcessLeaseRegistryOptions) {
    this.managerToken = options.managerToken ?? randomUUID()
    this.pid = options.pid ?? process.pid
    this.hostname = options.hostname ?? os.hostname()
    this.processStart = options.processStart
    this.heartbeatMs = Math.max(10, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
    this.staleMs = Math.max(10, options.staleMs ?? DEFAULT_STALE_MS)
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
    let launchGeneration: string | undefined
    let launchToken: string | undefined
    return {
      release: async () => {
        if (released) return
        const held = this.held.get(key)
        if (!held || held.owner.leaseToken !== leaseToken) return
        if (held.count > 1) {
          if (launchGeneration) await removeLaunchGeneration(held.directory, leaseToken, launchGeneration)
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
        if (launchToken) return launchToken
        const generation = randomUUID()
        const token = randomUUID()
        await writeLaunchGeneration(held.directory, leaseToken, { version: 1, generation, token, complete: false })
        if ((await readOwner(held.directory))?.owner.leaseToken !== leaseToken) {
          this.lose(key, held)
          throw new Error("Workspace process lease was lost")
        }
        launchGeneration = generation
        launchToken = token
        return token
      },
      setProcessIdentities: async (identities) => {
        const held = this.held.get(key)
        if (!held || held.owner.leaseToken !== leaseToken || held.lost) throw new Error("Workspace process lease was lost")
        if (!launchGeneration || !launchToken) throw new Error("Workspace launch was not prepared")
        await writeLaunchGeneration(held.directory, leaseToken, {
          version: 1, generation: launchGeneration, token: launchToken, complete: true, identities,
        }, true)
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
      if (serverAlive) return false
      const launches = await readLaunchGenerations(directory, owner.leaseToken)
      if (launches.kind === "unknown") return false
      const platform = this.options.platform ?? process.platform
      if (launches.kind === "absent") return true
      const identities: ProcessIdentity[] = []
      for (const launch of launches.launches) {
        let tokenAlive: boolean | undefined
        try {
          tokenAlive = this.options.isLaunchTokenAlive
            ? this.options.isLaunchTokenAlive(launch.token)
            : launchTokenIsAlive(launch.token, platform)
        } catch {
          tokenAlive = undefined
        }
        if (tokenAlive === true) return false
        if (!launch.complete) {
          if (platform === "win32" || tokenAlive === undefined) return false
          continue
        }
        identities.push(...launch.identities!)
      }
      if (launches.malformed && (launches.malformed.failClosed || platform === "win32" ||
        Date.now() - launches.malformed.modifiedAt < this.staleMs)) return false
      return identities.length === 0 || this.persistedProcessesAreGone(identities)
    }
    return false
  }

  private persistedProcessesAreGone(identities: ProcessIdentity[]): boolean {
    if (identities.length === 0) return true
    if (this.options.isProcessIdentityAlive) {
      for (const identity of identities) {
        try {
          if (this.options.isProcessIdentityAlive(identity) !== false) return false
        } catch {
          return false
        }
      }
      return true
    }
    const platform = this.options.platform ?? process.platform
    const snapshot = platform === "win32"
      ? probeWindowsProcesses(spawnSync, 1_000)
      : probePosixProcesses(spawnSync, 1_000, platform, { pids: identities.map(({ pid }) => pid) })
    return snapshot.ok && identities.every((identity) => !sameProcess(identity, snapshot.processes.get(identity.pid)))
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

async function writeLaunchGeneration(directory: string, leaseToken: string, launch: LaunchGeneration,
  replace = false): Promise<void> {
  if (launch.complete && (!launch.identities?.length || launch.identities.some((identity) => !validProcessIdentity(identity)))) {
    throw new Error("A complete process identity generation requires at least one valid identity")
  }
  const temporary = path.join(directory, `.launch.${leaseToken}.${launch.generation}.${randomUUID()}.tmp`)
  const destination = launchGenerationPath(directory, leaseToken, launch.generation)
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(launch), "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (!replace && await fileExists(destination)) throw Object.assign(new Error("Launch generation already exists"), { code: "EEXIST" })
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function removeLaunchGeneration(directory: string, leaseToken: string, generation: string): Promise<void> {
  await fs.rm(launchGenerationPath(directory, leaseToken, generation))
}

type LaunchGenerationObservation =
  | { kind: "absent" }
  | { kind: "observed"; launches: LaunchGeneration[]; malformed?: { modifiedAt: number; failClosed: boolean } }
  | { kind: "unknown" }

async function readLaunchGenerations(directory: string, leaseToken: string): Promise<LaunchGenerationObservation> {
  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { kind: "absent" }
    return { kind: "unknown" }
  }
  const legacyLaunch = `launch.${leaseToken}.json`
  const launchPrefix = `launch.${leaseToken}.`
  const processPrefix = `process.${leaseToken}.`
  const launchEntries = entries.filter((entry) => entry === legacyLaunch ||
    (entry.startsWith(launchPrefix) && entry.endsWith(".json")))
  const processEntries = entries.filter((entry) => entry.startsWith(processPrefix) && entry.endsWith(".json"))
  if (launchEntries.length === 0 && processEntries.length === 0) return { kind: "absent" }

  const launches: LaunchGeneration[] = []
  const malformedGenerationPaths: string[] = []
  let legacyMalformed = processEntries.length > 0 && !launchEntries.includes(legacyLaunch)
  for (const entry of launchEntries) {
    const launchPath = path.join(directory, entry)
    let serialized: string
    let value: unknown
    try {
      serialized = await fs.readFile(launchPath, "utf8")
      value = JSON.parse(serialized)
    } catch (error) {
      if (!(error instanceof SyntaxError)) return { kind: "unknown" }
      if (entry === legacyLaunch) legacyMalformed = true
      else malformedGenerationPaths.push(launchPath)
      continue
    }

    if (entry === legacyLaunch) {
      const token = value && typeof value === "object" ? (value as { token?: unknown }).token : undefined
      const identities: ProcessIdentity[] = []
      let complete = safeToken(token) && processEntries.length > 0
      for (const processEntry of processEntries) {
        try {
          const processSerialized = await fs.readFile(path.join(directory, processEntry), "utf8")
          const identity = JSON.parse(processSerialized) as unknown
          const digest = createHash("sha256").update(processSerialized).digest("hex")
          if (!validProcessIdentity(identity) || processEntry !== `process.${leaseToken}.${digest}.json`) complete = false
          else identities.push(identity)
        } catch {
          complete = false
        }
      }
      if (complete && safeToken(token)) launches.push({ version: 1, generation: "legacy", token, complete: true, identities })
      else legacyMalformed = true
      continue
    }

    const launch = value as LaunchGeneration
    if (validLaunchGeneration(launch) && launchGenerationPath(directory, leaseToken, launch.generation) === launchPath) {
      launches.push(launch)
    } else {
      malformedGenerationPaths.push(launchPath)
    }
  }

  if (legacyMalformed) {
    return { kind: "observed", launches, malformed: { modifiedAt: Date.now(), failClosed: true } }
  }
  if (malformedGenerationPaths.length === 0) return { kind: "observed", launches }
  try {
    const stats = await Promise.all([...malformedGenerationPaths, path.join(directory, "owner", "heartbeat")]
      .map((file) => fs.stat(file)))
    return {
      kind: "observed",
      launches,
      malformed: { modifiedAt: Math.max(...stats.map((stat) => stat.mtimeMs)), failClosed: false },
    }
  } catch {
    return { kind: "unknown" }
  }
}

function validLaunchGeneration(value: LaunchGeneration): boolean {
  return value?.version === 1 && safeToken(value.generation) && safeToken(value.token) && typeof value.complete === "boolean" &&
    (!value.complete || Boolean(value.identities?.length && value.identities.every(validProcessIdentity)))
}

function launchGenerationPath(directory: string, leaseToken: string, generation: string): string {
  return path.join(directory, `launch.${leaseToken}.${generation}.json`)
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false
    throw error
  }
}

function validProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") return false
  const identity = value as Partial<ProcessIdentity>
  return Number.isInteger(identity.pid) && Number(identity.pid) > 0 &&
    Number.isInteger(identity.parentPid) && Number(identity.parentPid) >= 0 &&
    Number.isInteger(identity.groupId) && Number(identity.groupId) > 0 &&
    typeof identity.startTime === "string" && identity.startTime.length > 0 &&
    (identity.bootId === undefined || typeof identity.bootId === "string") &&
    (identity.startOrder === undefined || typeof identity.startOrder === "string")
}

function launchTokenIsAlive(token: string, platform: NodeJS.Platform): boolean | undefined {
  if (!token) return undefined
  if (platform === "win32") return undefined
  const snapshot = probeLaunchCleanupToken(spawnSync, token, 1_000, undefined, platform)
  return snapshot.ok ? snapshot.processes.size > 0 : undefined
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
