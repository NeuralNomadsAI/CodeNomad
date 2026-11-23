import { randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { lstat, readFile, readdir, rename, rm, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, posix, win32 } from "node:path"
import { getProcessStartIdentity, type ProcessStartIdentityLookup } from "./client-state-process-identity"
import { hasErrorCode, isPidAlive, type ProcessOwner } from "./client-state-process"

export const CROSS_HOST_OWNER_DIRECTORY = "primary.owner.json"
const OWNER_FILENAME = "owner.json"
const PARTICIPANT_PREFIX = "participant."
const PARTICIPANT_SUFFIX = ".json"
const RECOVERY_PREFIX = "recovery."
const RECOVERY_SUFFIX = ".claim"
const RETIRED_PREFIX = "retired."
const ACQUIRE_ATTEMPTS = 10

export interface CrossHostLeaseDependencies {
  pidAlive(pid: number): boolean
  processStartIdentity: ProcessStartIdentityLookup
  onParticipantPublished?(): void
  onOwnerPrepared?(): void
  onOwnerRetired?(): void
  onGracefulOwnerChecked?(): void
  onGracefulOwnerRetiring?(): void
}

const defaultDependencies: CrossHostLeaseDependencies = {
  pidAlive: isPidAlive,
  processStartIdentity: getProcessStartIdentity,
}

function validHome(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  if (!value) return undefined
  if (platform !== "win32") return posix.isAbsolute(value) ? value : undefined
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) ? value : undefined
}

export function resolveCrossHostElectionDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome = homedir(),
): string {
  const pathApi = platform === "win32" ? win32 : posix
  const configured = platform === "win32"
    ? validHome(environment.USERPROFILE, platform) ?? validHome(environment.HOME, platform)
    : validHome(environment.HOME, platform)
  return pathApi.join(configured ?? fallbackHome, ".codenomad", "client-state", "v2", "election")
}

export function resolveCrossHostStatePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome = homedir(),
): string {
  const pathApi = platform === "win32" ? win32 : posix
  const configured = platform === "win32"
    ? validHome(environment.USERPROFILE, platform) ?? validHome(environment.HOME, platform)
    : validHome(environment.HOME, platform)
  return pathApi.join(configured ?? fallbackHome, ".codenomad", "client-state", "v2", "client-state.json")
}

export function resolveLegacyCrossHostStatePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome = homedir(),
): string {
  const pathApi = platform === "win32" ? win32 : posix
  const configured = platform === "win32"
    ? validHome(environment.USERPROFILE, platform) ?? validHome(environment.HOME, platform)
    : validHome(environment.HOME, platform)
  return pathApi.join(configured ?? fallbackHome, ".codenomad", "client-state", "client-state.json")
}

export function resolveLegacyTauriDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome = homedir(),
): string {
  const pathApi = platform === "win32" ? win32 : posix
  const home = platform === "win32"
    ? validHome(environment.USERPROFILE, platform) ?? validHome(environment.HOME, platform) ?? fallbackHome
    : validHome(environment.HOME, platform) ?? fallbackHome
  const root = platform === "win32"
    ? validHome(environment.APPDATA, platform) ?? pathApi.join(home, "AppData", "Roaming")
    : platform === "darwin"
      ? pathApi.join(home, "Library", "Application Support")
      : validHome(environment.XDG_DATA_HOME, platform) ?? pathApi.join(home, ".local", "share")
  return pathApi.join(root, "ai.neuralnomads.codenomad.client")
}

export function createCrossHostOwner(): ProcessOwner | undefined {
  const processStartIdentity = getProcessStartIdentity(process.pid)
  return processStartIdentity ? { pid: process.pid, runToken: randomUUID(), processStartIdentity } : undefined
}

function serializeOwner(owner: ProcessOwner): string {
  return JSON.stringify({ pid: owner.pid, runToken: owner.runToken, processStartIdentity: owner.processStartIdentity })
}

function parseOwner(value: string): ProcessOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<ProcessOwner>
    if (Number.isInteger(owner.pid) && Number(owner.pid) > 0 && Number(owner.pid) <= 0xffff_ffff &&
      typeof owner.runToken === "string" && /^[A-Za-z0-9_-]+$/.test(owner.runToken) &&
      typeof owner.processStartIdentity === "string" && owner.processStartIdentity) {
      return { pid: Number(owner.pid), runToken: owner.runToken, processStartIdentity: owner.processStartIdentity }
    }
  } catch {}
  return undefined
}

function sameOwner(left: ProcessOwner, right: ProcessOwner): boolean {
  return left.pid === right.pid && left.runToken === right.runToken && left.processStartIdentity === right.processStartIdentity
}

function readIfExists(path: string): string | undefined {
  try { return readFileSync(path, "utf8") } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined
    throw error
  }
}

function sync(descriptor: number): void {
  try { fsyncSync(descriptor) } catch (error) {
    if (!["EINVAL", "ENOTSUP", "ENOSYS"].some((code) => hasErrorCode(error, code))) throw error
  }
}

function publishFile(path: string, value: string, replace = false): void {
  const temporary = join(dirname(path), `.publish.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, "wx", 0o600)
    writeFileSync(descriptor, value, "utf8")
    sync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (replace) renameSync(temporary, path)
    else linkSync(temporary, path)
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor) } catch {}
    try { unlinkSync(temporary) } catch {}
  }
}

function participantPath(directory: string, owner: ProcessOwner): string {
  return join(directory, `${PARTICIPANT_PREFIX}${owner.pid}.${owner.runToken}${PARTICIPANT_SUFFIX}`)
}

function recoveryPath(directory: string, owner: ProcessOwner): string {
  return join(directory, `${RECOVERY_PREFIX}${owner.pid}.${owner.runToken}${RECOVERY_SUFFIX}`)
}

function serializeParticipant(owner: ProcessOwner, cohort: ProcessOwner | null): string {
  const { pid, runToken, processStartIdentity } = owner
  return JSON.stringify({ pid, runToken, processStartIdentity, cohort })
}

function participantCohort(value: string): ProcessOwner | null | undefined {
  try {
    const record = JSON.parse(value)
    if (Object.hasOwn(record, "cohort")) return parseOwner(JSON.stringify(record.cohort)) ?? null
  } catch {}
}

function publishParticipant(path: string, owner: ProcessOwner): void {
  const value = serializeParticipant(owner, null)
  try { publishFile(path, value) } catch (error) {
    if (!hasErrorCode(error, "EEXIST") || readIfExists(path) !== value) throw error
  }
}

function ownerPath(directory: string): string {
  return join(directory, CROSS_HOST_OWNER_DIRECTORY, OWNER_FILENAME)
}

function retiredOwnerDirectory(directory: string, owner: ProcessOwner): string {
  return join(directory, `${RETIRED_PREFIX}${owner.pid}.${owner.runToken}`)
}

function ownerIsStale(owner: ProcessOwner, dependencies: CrossHostLeaseDependencies): boolean | undefined {
  if (!dependencies.pidAlive(owner.pid)) return true
  const identity = dependencies.processStartIdentity(owner.pid)
  return identity ? identity !== owner.processStartIdentity : undefined
}

function removeParticipantIfOwned(path: string, owner: ProcessOwner): void {
  const observed = readIfExists(path)
  const current = observed === undefined ? undefined : parseOwner(observed)
  if (!current || !sameOwner(current, owner)) return
  try { unlinkSync(path) } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try { await unlink(path) } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error
  }
}

async function retireOwnerIfOwned(directory: string, owner: ProcessOwner, dependencies: CrossHostLeaseDependencies): Promise<void> {
  const observed = await readIfExistsAsync(ownerPath(directory))
  const current = parseOwner(observed ?? "")
  if (!current || !sameOwner(current, owner)) return
  dependencies.onGracefulOwnerChecked?.()
  // Freeze the retiring cohort before the rename admits a new owner.
  const participants = new Map<string, string>()
  for (const name of await readdir(directory)) {
    if (!name.startsWith(PARTICIPANT_PREFIX) || !name.endsWith(PARTICIPANT_SUFFIX)) continue
    const path = join(directory, name)
    const participant = await readIfExistsAsync(path)
    if (participant === undefined) continue
    const cohort = participantCohort(participant)
    if (cohort === undefined || (cohort && sameOwner(cohort, owner))) participants.set(path, participant)
  }
  if (await readIfExistsAsync(ownerPath(directory)) !== observed) return
  dependencies.onGracefulOwnerRetiring?.()
  const retired = retiredOwnerDirectory(directory, owner)
  try { await rename(join(directory, CROSS_HOST_OWNER_DIRECTORY), retired) } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].some((code) => hasErrorCode(error, code)) || await lstat(retired).catch(() => undefined)) return
    throw error
  }
  try {
    dependencies.onOwnerRetired?.()
    for (const [path, observedParticipant] of participants) {
      if (await readIfExistsAsync(path) !== observedParticipant) continue
      await unlinkIfExists(path)
      const participant = parseOwner(observedParticipant)
      if (participant) await unlink(recoveryPath(directory, participant)).catch(() => {})
    }
  } finally {
    await rm(retired, { recursive: true, force: true }).catch(() => {})
  }
}

function recoveryClaimants(
  directory: string,
  current: ProcessOwner,
  observedOwner: string,
  owner: ProcessOwner,
  dependencies: CrossHostLeaseDependencies,
): ProcessOwner[] | undefined {
  const claimants = [current]
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(PARTICIPANT_PREFIX) || !name.endsWith(PARTICIPANT_SUFFIX)) continue
    const path = join(directory, name)
    const value = readIfExists(path)
    if (value === undefined) continue
    const participant = parseOwner(value)
    if (!participant) return undefined
    if (sameOwner(participant, current)) continue
    const stale = ownerIsStale(participant, dependencies)
    if (stale === true) {
      removeParticipantIfOwned(path, participant)
      try { unlinkSync(recoveryPath(directory, participant)) } catch {}
      continue
    }
    const cohort = participantCohort(value)
    if (cohort && !sameOwner(cohort, owner)) continue
    const claimPath = recoveryPath(directory, participant)
    let claim = readIfExists(claimPath)
    for (let attempt = 0; claim !== observedOwner && attempt < 20; attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      claim = readIfExists(claimPath)
    }
    if (claim !== observedOwner) return undefined
    claimants.push(participant)
  }
  return claimants
}

function retireOwner(directory: string, observed: string, owner: ProcessOwner, claimant: ProcessOwner, dependencies: CrossHostLeaseDependencies): boolean {
  if (ownerIsStale(owner, dependencies) !== true) return false
  const claimants = recoveryClaimants(directory, claimant, observed, owner, dependencies)
  if (!claimants) return false
  claimants.sort((left, right) => serializeOwner(left) < serializeOwner(right) ? -1 : 1)
  if (!sameOwner(claimants[0]!, claimant)) return false
  if (readIfExists(ownerPath(directory)) !== observed) return false
  const retired = retiredOwnerDirectory(directory, owner)
  try {
    renameSync(join(directory, CROSS_HOST_OWNER_DIRECTORY), retired)
    dependencies.onOwnerRetired?.()
    return true
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].some((code) => hasErrorCode(error, code)) || existsSync(retired)) return false
    throw error
  }
}

function publishOwner(directory: string, owner: ProcessOwner, dependencies: CrossHostLeaseDependencies): boolean {
  const temporary = join(directory, `.owner.${randomUUID()}.tmp`)
  try {
    mkdirSync(temporary, { mode: 0o700 })
    const descriptor = openSync(join(temporary, OWNER_FILENAME), "wx", 0o600)
    try { writeFileSync(descriptor, serializeOwner(owner), "utf8"); sync(descriptor) } finally { closeSync(descriptor) }
    dependencies.onOwnerPrepared?.()
    renameSync(temporary, join(directory, CROSS_HOST_OWNER_DIRECTORY))
    return true
  } catch (error) {
    if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY") || existsSync(join(directory, CROSS_HOST_OWNER_DIRECTORY))) return false
    throw error
  } finally {
    try { rmSync(temporary, { recursive: true, force: true }) } catch {}
  }
}

export function crossHostParticipants(directory: string): ProcessOwner[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith(PARTICIPANT_PREFIX) && name.endsWith(PARTICIPANT_SUFFIX))
      .map((name) => parseOwner(readIfExists(join(directory, name)) ?? ""))
      .filter((owner): owner is ProcessOwner => Boolean(owner))
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return []
    throw error
  }
}

async function readIfExistsAsync(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8") } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return
    throw error
  }
}

export async function crossHostParticipantsAsync(directory: string): Promise<ProcessOwner[]> {
  try {
    const participants = []
    for (const name of await readdir(directory)) {
      if (!name.startsWith(PARTICIPANT_PREFIX) || !name.endsWith(PARTICIPANT_SUFFIX)) continue
      const owner = parseOwner(await readIfExistsAsync(join(directory, name)) ?? "")
      if (owner) participants.push(owner)
    }
    return participants
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return []
    throw error
  }
}

export class CrossHostRegistration {
  private released = false

  private constructor(
    private readonly directory: string,
    readonly owner: ProcessOwner,
    private readonly participant: string,
    private readonly recoveryClaim: string | undefined,
    private primary: boolean,
    private readonly dependencies: CrossHostLeaseDependencies,
  ) {}

  get path(): string { return this.directory }

  static register(
    directory: string,
    owner: ProcessOwner,
    primaryCandidate: boolean | (() => boolean),
    dependencies: CrossHostLeaseDependencies = defaultDependencies,
  ): CrossHostRegistration | undefined {
    if (!owner.processStartIdentity || !/^[A-Za-z0-9_-]+$/.test(owner.runToken)) return undefined
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const participant = participantPath(directory, owner)
    publishParticipant(participant, owner)
    dependencies.onParticipantPublished?.()
    let primary = false
    let cohort: ProcessOwner | undefined
    let recoveryClaim: string | undefined
    try {
      if (typeof primaryCandidate === "function" ? primaryCandidate() : primaryCandidate) {
        for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
          if (publishOwner(directory, owner, dependencies)) { primary = true; cohort = owner; break }
          const observed = readIfExists(ownerPath(directory))
          if (observed === undefined) continue
          const existing = parseOwner(observed)
          if (!existing) break
          cohort = existing
          if (sameOwner(existing, owner)) { primary = true; break }
          if (ownerIsStale(existing, dependencies) === true) {
            recoveryClaim ??= recoveryPath(directory, owner)
            try { publishFile(recoveryClaim, observed) } catch (error) {
              if (!hasErrorCode(error, "EEXIST") || readIfExists(recoveryClaim) !== observed) throw error
            }
          }
          if (!retireOwner(directory, observed, existing, owner, dependencies)) break
        }
      } else {
        cohort = parseOwner(readIfExists(ownerPath(directory)) ?? "")
      }
      try { publishFile(participant, serializeParticipant(owner, cohort ?? owner), true) } catch (error) {
        // A successfully elected owner still has its original conservative
        // registration if the filesystem refuses to update the cohort.
        if (!primary) throw error
        console.warn("[client-state] failed to bind cross-host owner cohort", error)
      }
      return new CrossHostRegistration(directory, owner, participant, recoveryClaim, primary, dependencies)
    } catch (error) {
      removeParticipantIfOwned(participant, owner)
      if (recoveryClaim) try { unlinkSync(recoveryClaim) } catch {}
      throw error
    }
  }

  get isPrimary(): boolean {
    if (this.released || !this.primary) return false
    const current = parseOwner(readIfExists(ownerPath(this.directory)) ?? "")
    return Boolean(current && sameOwner(current, this.owner))
  }

  async checkPrimary(): Promise<boolean> {
    if (this.released || !this.primary) return false
    const current = parseOwner(await readIfExistsAsync(ownerPath(this.directory)) ?? "")
    return Boolean(!this.released && current && sameOwner(current, this.owner))
  }

  async release(): Promise<boolean> {
    if (this.released) return false
    await retireOwnerIfOwned(this.directory, this.owner, this.dependencies)
    const participant = parseOwner(await readIfExistsAsync(this.participant) ?? "")
    if (participant && sameOwner(participant, this.owner)) await unlinkIfExists(this.participant)
    if (this.recoveryClaim) await unlink(this.recoveryClaim).catch(() => {})
    this.primary = false
    this.released = true
    return true
  }
}
