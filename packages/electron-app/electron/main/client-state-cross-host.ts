import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, posix, win32 } from "node:path"
import { getProcessStartIdentity, type ProcessStartIdentityLookup } from "./client-state-process-identity"
import { hasErrorCode, isPidAlive, type ProcessOwner } from "./client-state-process"

export const CROSS_HOST_OWNER_FILENAME = "primary.owner.json"
const PARTICIPANT_PREFIX = "participant."
const PARTICIPANT_SUFFIX = ".json"
const REMOVAL_CLAIM_PREFIX = "removed."
const REMOVAL_CLAIM_SUFFIX = ".claim"
const ACQUIRE_ATTEMPTS = 10

export interface CrossHostLeaseDependencies {
  pidAlive(pid: number): boolean
  processStartIdentity: ProcessStartIdentityLookup
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
  return pathApi.join(configured ?? fallbackHome, ".codenomad", "client-state", "election")
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
  let appDataRoot: string
  if (platform === "win32") {
    appDataRoot = validHome(environment.APPDATA, platform) ?? pathApi.join(home, "AppData", "Roaming")
  } else if (platform === "darwin") {
    appDataRoot = pathApi.join(home, "Library", "Application Support")
  } else {
    appDataRoot = validHome(environment.XDG_DATA_HOME, platform) ?? pathApi.join(home, ".local", "share")
  }
  return pathApi.join(appDataRoot, "ai.neuralnomads.codenomad.client")
}

export function createCrossHostOwner(): ProcessOwner | undefined {
  const processStartIdentity = getProcessStartIdentity(process.pid)
  if (!processStartIdentity) return undefined
  return { pid: process.pid, runToken: randomUUID(), processStartIdentity }
}

function serializeOwner(owner: ProcessOwner): string {
  return JSON.stringify({
    pid: owner.pid,
    runToken: owner.runToken,
    processStartIdentity: owner.processStartIdentity,
  })
}

function parseOwner(value: string): ProcessOwner | undefined {
  try {
    const candidate = JSON.parse(value) as Partial<ProcessOwner>
    if (
      Number.isInteger(candidate.pid) && Number(candidate.pid) > 0 && Number(candidate.pid) <= 0xffff_ffff &&
      typeof candidate.runToken === "string" && candidate.runToken.length > 0 &&
      typeof candidate.processStartIdentity === "string" && candidate.processStartIdentity.length > 0
    ) {
      return {
        pid: Number(candidate.pid),
        runToken: candidate.runToken,
        processStartIdentity: candidate.processStartIdentity,
      }
    }
  } catch {
    // Unknown or partially published ownership must fail closed.
  }
  return undefined
}

function sameOwner(left: ProcessOwner, right: ProcessOwner): boolean {
  return left.pid === right.pid &&
    left.runToken === right.runToken &&
    left.processStartIdentity === right.processStartIdentity
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined
    throw error
  }
}

function publish(path: string, value: string): void {
  const temporaryPath = join(dirname(path), `.publish.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600)
    writeFileSync(descriptor, value, "utf8")
    try {
      fsyncSync(descriptor)
    } catch (error) {
      if (!hasErrorCode(error, "EINVAL") && !hasErrorCode(error, "ENOTSUP") && !hasErrorCode(error, "ENOSYS")) {
        throw error
      }
    }
    closeSync(descriptor)
    descriptor = undefined
    linkSync(temporaryPath, path)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    throw error
  } finally {
    try { unlinkSync(temporaryPath) } catch {}
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function participantPath(electionDirectory: string, owner: ProcessOwner): string {
  return join(electionDirectory, `${PARTICIPANT_PREFIX}${digest(serializeOwner(owner))}${PARTICIPANT_SUFFIX}`)
}

function publishParticipant(path: string, owner: ProcessOwner): void {
  const value = serializeOwner(owner)
  try {
    publish(path, value)
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST") || readIfExists(path) !== value) throw error
  }
}

function ownerIsStale(owner: ProcessOwner, dependencies: CrossHostLeaseDependencies): boolean | undefined {
  if (!dependencies.pidAlive(owner.pid)) return true
  const identity = dependencies.processStartIdentity(owner.pid)
  return identity ? identity !== owner.processStartIdentity : undefined
}

function removeObservedOwner(
  electionDirectory: string,
  path: string,
  observed: string,
  owner: ProcessOwner,
  claimant: ProcessOwner,
): boolean {
  const claimPath = join(electionDirectory, `${REMOVAL_CLAIM_PREFIX}${digest(observed)}${REMOVAL_CLAIM_SUFFIX}`)
  try {
    publish(claimPath, serializeOwner(claimant))
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return false
    throw error
  }

  const current = readIfExists(path)
  if (current !== observed) return false
  const currentOwner = parseOwner(current)
  if (!currentOwner || !sameOwner(currentOwner, owner)) return false
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false
    throw error
  }
}

function removeParticipantIfOwned(path: string, owner: ProcessOwner): void {
  const value = readIfExists(path)
  const current = value === undefined ? undefined : parseOwner(value)
  if (!current || !sameOwner(current, owner)) return
  try { unlinkSync(path) } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error
  }
}

function hasOtherLiveParticipants(
  electionDirectory: string,
  currentOwner: ProcessOwner,
  dependencies: CrossHostLeaseDependencies,
): boolean {
  for (const name of readdirSync(electionDirectory)) {
    if (!name.startsWith(PARTICIPANT_PREFIX) || !name.endsWith(PARTICIPANT_SUFFIX)) continue
    const path = join(electionDirectory, name)
    const value = readIfExists(path)
    if (value === undefined) continue
    const participant = parseOwner(value)
    if (!participant) return true
    if (sameOwner(participant, currentOwner)) continue
    const stale = ownerIsStale(participant, dependencies)
    if (stale === undefined || !stale) return true
    removeParticipantIfOwned(path, participant)
  }
  return false
}

export class CrossHostRegistration {
  private released = false

  private constructor(
    readonly path: string,
    readonly owner: ProcessOwner,
    private readonly electionDirectory: string,
    private readonly participant: string,
    private readonly dependencies: CrossHostLeaseDependencies,
    private primary: boolean,
  ) {}

  static register(
    electionDirectory: string,
    owner: ProcessOwner,
    primaryCandidate: boolean,
    dependencies: CrossHostLeaseDependencies = defaultDependencies,
  ): CrossHostRegistration | undefined {
    if (!owner.processStartIdentity) return undefined
    mkdirSync(electionDirectory, { recursive: true, mode: 0o700 })
    const path = join(electionDirectory, CROSS_HOST_OWNER_FILENAME)
    const participant = participantPath(electionDirectory, owner)
    let primary = false

    if (primaryCandidate) {
      try {
        publish(path, serializeOwner(owner))
        primary = true
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error
      }
    }

    if (primaryCandidate && !primary) {
      for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
        try {
          publish(path, serializeOwner(owner))
          primary = true
          break
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) throw error
        }

        const observed = readIfExists(path)
        if (observed === undefined) continue
        const existing = parseOwner(observed)
        if (!existing) break
        if (sameOwner(existing, owner)) {
          primary = true
          break
        }
        const stale = existing.pid === owner.pid && existing.runToken !== owner.runToken
          ? true
          : ownerIsStale(existing, dependencies)
        if (stale === undefined || !stale || hasOtherLiveParticipants(electionDirectory, owner, dependencies)) break
        if (!removeObservedOwner(electionDirectory, path, observed, existing, owner)) continue
      }
    }

    try {
      publishParticipant(participant, owner)
    } catch (error) {
      if (primary) {
        const observed = readIfExists(path)
        const current = observed === undefined ? undefined : parseOwner(observed)
        if (observed !== undefined && current && sameOwner(current, owner)) {
          removeObservedOwner(electionDirectory, path, observed, owner, owner)
        }
      }
      throw error
    }

    return new CrossHostRegistration(path, owner, electionDirectory, participant, dependencies, primary)
  }

  get isPrimary(): boolean {
    if (this.released || !this.primary) return false
    const value = readIfExists(this.path)
    const owner = value === undefined ? undefined : parseOwner(value)
    return Boolean(owner && sameOwner(owner, this.owner))
  }

  release(): boolean {
    if (this.released) return false
    let removed = false
    if (this.isPrimary && !hasOtherLiveParticipants(this.electionDirectory, this.owner, this.dependencies)) {
      const observed = readIfExists(this.path)
      const current = observed === undefined ? undefined : parseOwner(observed)
      if (observed !== undefined && current && sameOwner(current, this.owner)) {
        removed = removeObservedOwner(this.electionDirectory, this.path, observed, this.owner, this.owner)
      }
    }
    removeParticipantIfOwned(this.participant, this.owner)
    this.primary = false
    this.released = true
    return removed
  }
}
