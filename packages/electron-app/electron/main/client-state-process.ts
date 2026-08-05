import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import {
  type AsyncExpectedProcessLookup,
  type AsyncProcessStartIdentityLookup,
  type ExpectedProcessLookup,
  getProcessStartIdentity,
  getProcessStartIdentityAsync,
  isExpectedTauriProcess,
  isExpectedTauriProcessAsync,
  type ProcessStartIdentityLookup,
} from "./client-state-process-identity"

const RUNNING_MARKER_PREFIX = "client-state.running."
const RUNNING_MARKER_SUFFIX = ".json"
const PRIMARY_LOCK_ACQUIRE_ATTEMPTS = 5
const LOCK_RETRY_DELAY_MS = 10
export const REGISTRATION_LOCK_WAIT_MS = 1_000

export interface ProcessOwner {
  pid: number
  runToken: string
  processStartIdentity?: string
  machineIdentity?: string
}

export type RunningMarkerStatus = "current" | "other-live" | "stale"

export interface ClientStateElectionPaths {
  primaryLockPath: string
  registrationLockPath: string
}

interface ProcessOwnerLockAcquisition {
  acquired: boolean
  liveOwner?: {
    owner: ProcessOwner
    observed: string
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function isTransientFileContentionError(error: unknown): boolean {
  return hasErrorCode(error, "EPERM") || hasErrorCode(error, "EACCES") || hasErrorCode(error, "EBUSY")
}

export function parseProcessOwner(value: string): ProcessOwner | undefined {
  try {
    return normalizeProcessOwner(JSON.parse(value))
  } catch {
    // Incomplete process files are handled conservatively using their filename owner.
  }
  return undefined
}

function normalizeProcessOwner(candidate: unknown): ProcessOwner | undefined {
  if (!candidate || typeof candidate !== "object") {
    return undefined
  }
  const owner = candidate as Partial<ProcessOwner>
  if (Number.isInteger(owner.pid) && Number(owner.pid) > 0 && typeof owner.runToken === "string" && owner.runToken) {
    return {
      pid: Number(owner.pid),
      runToken: owner.runToken,
      ...(typeof owner.processStartIdentity === "string" && owner.processStartIdentity
        ? { processStartIdentity: owner.processStartIdentity }
        : {}),
      ...(typeof owner.machineIdentity === "string" && owner.machineIdentity
        ? { machineIdentity: owner.machineIdentity }
        : {}),
    }
  }
  return undefined
}

function parseAcknowledgedPrimary(value: string): ProcessOwner | undefined {
  try {
    const candidate = JSON.parse(value) as { primaryOwner?: unknown }
    return normalizeProcessOwner(candidate.primaryOwner)
  } catch {
    return undefined
  }
}

export function isSameProcessOwner(left: ProcessOwner, right: ProcessOwner): boolean {
  return left.pid === right.pid && left.runToken === right.runToken
}

export function isPidAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !hasErrorCode(error, "ESRCH")
  }
}

export function hasLiveTauriClient(
  tauriDataPath: string,
  pidAlive: (pid: number) => boolean = isPidAlive,
  processStartIdentity: ProcessStartIdentityLookup = getProcessStartIdentity,
  expectedProcess: ExpectedProcessLookup = isExpectedTauriProcess,
  upgradedParticipants: readonly ProcessOwner[] = [],
): boolean {
  let entries: string[]
  try {
    entries = readdirSync(tauriDataPath)
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false
    throw error
  }
  return entries.some((name) => {
    const match = /^client-state\.running\.(\d+)\..+\.lock$/.exec(name)
    if (!match) return false
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return false
    const liveIdentity = processStartIdentity(pid)
    if (liveIdentity && upgradedParticipants.some((owner) => owner.pid === pid && owner.processStartIdentity === liveIdentity)) return false
    return expectedProcess(pid) !== false
  })
}

export async function hasLiveTauriClientAsync(
  tauriDataPath: string,
  pidAlive: (pid: number) => boolean = isPidAlive,
  processStartIdentity: AsyncProcessStartIdentityLookup = getProcessStartIdentityAsync,
  expectedProcess: AsyncExpectedProcessLookup = isExpectedTauriProcessAsync,
  upgradedParticipants: readonly ProcessOwner[] = [],
  timeoutMs = 1_000,
): Promise<boolean> {
  let entries: string[]
  try {
    entries = readdirSync(tauriDataPath)
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false
    throw error
  }
  for (const name of entries) {
    const match = /^client-state\.running\.(\d+)\..+\.lock$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) continue
    const liveIdentity = await processStartIdentity(pid, timeoutMs)
    if (liveIdentity && upgradedParticipants.some((owner) => owner.pid === pid && owner.processStartIdentity === liveIdentity)) continue
    if (await expectedProcess(pid, timeoutMs) !== false) return true
  }
  return false
}

export function classifyRunningMarker(
  markerOwner: ProcessOwner,
  currentOwner: ProcessOwner,
  pidAlive: (pid: number) => boolean = isPidAlive,
  processStartIdentity: ProcessStartIdentityLookup = getProcessStartIdentity,
): RunningMarkerStatus {
  if (isSameProcessOwner(markerOwner, currentOwner)) {
    return "current"
  }
  // Two live processes cannot share a PID. A different token therefore belongs to an old run.
  if (markerOwner.pid === currentOwner.pid) {
    return "stale"
  }
  if (!pidAlive(markerOwner.pid)) return "stale"
  if (markerOwner.processStartIdentity) {
    const liveIdentity = processStartIdentity(markerOwner.pid)
    if (liveIdentity && liveIdentity !== markerOwner.processStartIdentity) return "stale"
  }
  return "other-live"
}

export function getRunningMarkerPath(userDataPath: string, owner: ProcessOwner): string {
  return join(userDataPath, `${RUNNING_MARKER_PREFIX}${owner.pid}.${owner.runToken}${RUNNING_MARKER_SUFFIX}`)
}

function parseRunningMarkerFilename(filename: string): ProcessOwner | undefined {
  if (!filename.startsWith(RUNNING_MARKER_PREFIX) || !filename.endsWith(RUNNING_MARKER_SUFFIX)) {
    return undefined
  }

  const value = filename.slice(RUNNING_MARKER_PREFIX.length, -RUNNING_MARKER_SUFFIX.length)
  const separator = value.indexOf(".")
  if (separator < 1) {
    return undefined
  }
  const pid = Number(value.slice(0, separator))
  const runToken = value.slice(separator + 1)
  if (!Number.isInteger(pid) || pid <= 0 || !runToken) {
    return undefined
  }
  return { pid, runToken }
}

export function createRunningMarker(
  userDataPath: string,
  owner: ProcessOwner,
  primaryOwner?: ProcessOwner,
): string {
  const markerPath = getRunningMarkerPath(userDataPath, owner)
  publishProcessFile(markerPath, JSON.stringify(primaryOwner ? { ...owner, primaryOwner } : owner))
  return markerPath
}

function ensureRunningMarker(
  userDataPath: string,
  owner: ProcessOwner,
  primaryOwner?: ProcessOwner,
): string {
  try {
    return createRunningMarker(userDataPath, owner, primaryOwner)
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error
    const markerPath = getRunningMarkerPath(userDataPath, owner)
    const existing = readFileIfExists(markerPath)
    const existingOwner = existing === undefined ? undefined : parseProcessOwner(existing)
    if (existingOwner && isSameProcessOwner(existingOwner, owner)) {
      return markerPath
    }
    throw error
  }
}

function publishProcessFile(path: string, contents: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, "wx", 0o600)
    writeFileSync(descriptor, contents, "utf8")
    try {
      fsyncSync(descriptor)
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "ENOSYS"].some((code) => hasErrorCode(error, code))) throw error
    }
    closeSync(descriptor)
    descriptor = undefined
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
      try { unlinkSync(path) } catch {}
    }
    throw error
  }
}

function removeFileIfUnchanged(path: string, observed: string): boolean {
  try {
    if (readFileSync(path, "utf8") !== observed) {
      return false
    }
    unlinkSync(path)
    return true
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
}

function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined
    throw error
  }
}

function waitForLockRetry(delayMs = LOCK_RETRY_DELAY_MS) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, delayMs))
}

function removeContendedFile(path: string, observed: string): void {
  try {
    removeFileIfUnchanged(path, observed)
  } catch (error) {
    if (!isTransientFileContentionError(error)) throw error
    waitForLockRetry()
  }
}

function acquireProcessOwnerLockWithStatus(
  path: string,
  owner: ProcessOwner,
  waitForLiveOwner: boolean,
  pidAlive: (pid: number) => boolean = isPidAlive,
  liveOwnerWaitMs = REGISTRATION_LOCK_WAIT_MS,
  processStartIdentity: ProcessStartIdentityLookup = getProcessStartIdentity,
): ProcessOwnerLockAcquisition {
  const serializedOwner = JSON.stringify(owner)
  const waitDeadline = Date.now() + Math.max(0, liveOwnerWaitMs)
  let liveOwner: ProcessOwnerLockAcquisition["liveOwner"]

  for (let attempt = 0; ; attempt += 1) {
    if (
      (!waitForLiveOwner && attempt >= PRIMARY_LOCK_ACQUIRE_ATTEMPTS) ||
      (waitForLiveOwner && attempt > 0 && Date.now() >= waitDeadline)
    ) {
      return { acquired: false, liveOwner }
    }

    try {
      publishProcessFile(path, serializedOwner)
      return { acquired: true }
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error
      }
    }

    const observed = readFileIfExists(path)
    if (observed === undefined) continue

    const existingOwner = parseProcessOwner(observed)
    if (existingOwner) {
      const status = classifyRunningMarker(existingOwner, owner, pidAlive, processStartIdentity)
      if (status === "other-live") {
        liveOwner = { owner: existingOwner, observed }
        if (!waitForLiveOwner) {
          return { acquired: false, liveOwner }
        }
        const remainingWaitMs = waitDeadline - Date.now()
        if (remainingWaitMs <= 0) {
          return { acquired: false, liveOwner }
        }
        waitForLockRetry(Math.min(LOCK_RETRY_DELAY_MS, remainingWaitMs))
        continue
      }
    } else if (waitForLiveOwner && attempt < PRIMARY_LOCK_ACQUIRE_ATTEMPTS - 1) {
      // The owner may still be writing a newly-created lock file.
      waitForLockRetry()
      continue
    }

    removeContendedFile(path, observed)
  }

  return { acquired: false, liveOwner }
}

export function removeProcessOwnerLockIfOwned(path: string, owner: ProcessOwner): boolean {
  const observed = readFileIfExists(path)
  const current = observed === undefined ? undefined : parseProcessOwner(observed)
  return Boolean(current && isSameProcessOwner(current, owner) && removeFileIfUnchanged(path, observed!))
}

function releaseProcessOwnerLock(
  path: string,
  owner: ProcessOwner,
  onWarning: (message: string, error: unknown) => void,
  warning: string,
): void {
  try {
    removeProcessOwnerLockIfOwned(path, owner)
  } catch (error) {
    onWarning(warning, error)
  }
}

export function isProcessOwnerLockOwned(path: string, owner: ProcessOwner): boolean {
  const value = readFileIfExists(path)
  const current = value === undefined ? undefined : parseProcessOwner(value)
  return Boolean(current && isSameProcessOwner(current, owner))
}

export function readProcessOwnerLock(path: string): ProcessOwner | undefined {
  const value = readFileIfExists(path)
  return value === undefined ? undefined : parseProcessOwner(value)
}

export function removeRunningMarkerIfOwned(markerPath: string, owner: ProcessOwner): boolean {
  const filenameOwner = parseRunningMarkerFilename(basename(markerPath))
  if (!filenameOwner || !isSameProcessOwner(filenameOwner, owner)) {
    return false
  }

  const observed = readFileIfExists(markerPath)
  const storedOwner = observed === undefined ? undefined : parseProcessOwner(observed)
  return Boolean(storedOwner && isSameProcessOwner(storedOwner, owner) && removeFileIfUnchanged(markerPath, observed!))
}

export function cleanStaleRunningMarkers(
  userDataPath: string,
  currentOwner: ProcessOwner,
  pidAlive: (pid: number) => boolean = isPidAlive,
  processStartIdentity: ProcessStartIdentityLookup = getProcessStartIdentity,
): boolean {
  let hasOtherLiveProcess = false

  for (const filename of readdirSync(userDataPath)) {
    const filenameOwner = parseRunningMarkerFilename(filename)
    if (!filenameOwner) {
      continue
    }

    const markerPath = join(userDataPath, filename)
    const observed = readFileIfExists(markerPath)
    if (observed === undefined) continue

    const storedOwner = parseProcessOwner(observed)
    if (storedOwner && !isSameProcessOwner(storedOwner, filenameOwner)) {
      const storedStatus = classifyRunningMarker(storedOwner, currentOwner, pidAlive, processStartIdentity)
      const filenameStatus = classifyRunningMarker(filenameOwner, currentOwner, pidAlive, processStartIdentity)
      if (storedStatus === "other-live" || filenameStatus === "other-live") {
        hasOtherLiveProcess = true
      } else {
        removeFileIfUnchanged(markerPath, observed)
      }
      continue
    }

    const markerOwner = storedOwner ?? filenameOwner
    const status = classifyRunningMarker(markerOwner, currentOwner, pidAlive, processStartIdentity)
    if (status === "other-live") {
      const acknowledgedPrimary = parseAcknowledgedPrimary(observed)
      if (!acknowledgedPrimary || !isSameProcessOwner(acknowledgedPrimary, currentOwner)) {
        hasOtherLiveProcess = true
      }
    } else if (status === "stale") {
      removeFileIfUnchanged(markerPath, observed)
    }
  }

  return hasOtherLiveProcess
}

function hasMatchingLiveRunningMarker(
  userDataPath: string,
  owner: ProcessOwner,
  pidAlive: (pid: number) => boolean,
  processStartIdentity: ProcessStartIdentityLookup,
): boolean {
  if (!pidAlive(owner.pid)) {
    return false
  }

  const value = readFileIfExists(getRunningMarkerPath(userDataPath, owner))
  const markerOwner = value === undefined ? undefined : parseProcessOwner(value)
  if (!markerOwner || !isSameProcessOwner(markerOwner, owner)) return false
  const liveIdentity = markerOwner.processStartIdentity && processStartIdentity(markerOwner.pid)
  return !liveIdentity || liveIdentity === markerOwner.processStartIdentity
}

function acquireMarkerBackedProcessOwnerLock(
  userDataPath: string,
  path: string,
  owner: ProcessOwner,
  pidAlive: (pid: number) => boolean,
  liveOwnerWaitMs: number,
  processStartIdentity: ProcessStartIdentityLookup,
): ProcessOwnerLockAcquisition {
  let lastAcquisition: ProcessOwnerLockAcquisition = { acquired: false }
  for (let recoveryAttempt = 0; recoveryAttempt < PRIMARY_LOCK_ACQUIRE_ATTEMPTS; recoveryAttempt += 1) {
    const acquisition = acquireProcessOwnerLockWithStatus(
      path,
      owner,
      true,
      pidAlive,
      liveOwnerWaitMs,
      processStartIdentity,
    )
    lastAcquisition = acquisition
    if (acquisition.acquired || !acquisition.liveOwner) {
      if (acquisition.acquired) return acquisition
      continue
    }
    // An identity-backed owner only reaches this point after an exact identity match
    // or an inconclusive lookup. Never steal its lock while its PID remains live.
    if (acquisition.liveOwner.owner.processStartIdentity) {
      return acquisition
    }
    if (hasMatchingLiveRunningMarker(
      userDataPath,
      acquisition.liveOwner.owner,
      pidAlive,
      processStartIdentity,
    )) {
      return acquisition
    }
    removeContendedFile(path, acquisition.liveOwner.observed)
  }
  return lastAcquisition
}

export function electClientStateProcess(
  userDataPath: string,
  owner: ProcessOwner,
  paths: ClientStateElectionPaths,
  onWarning: (message: string, error: unknown) => void = () => {},
  pidAlive: (pid: number) => boolean = isPidAlive,
  registrationLockWaitMs = REGISTRATION_LOCK_WAIT_MS,
  onPrimaryLockAcquired: () => void = () => {},
  processStartIdentity: ProcessStartIdentityLookup = getProcessStartIdentity,
  retainedCandidate = false,
): boolean {
  let registrationAcquired = false
  let registeringOwner: ProcessOwner | undefined

  try {
    const registration = acquireMarkerBackedProcessOwnerLock(
      userDataPath,
      paths.registrationLockPath,
      owner,
      pidAlive,
      registrationLockWaitMs,
      processStartIdentity,
    )
    registrationAcquired = registration.acquired
    registeringOwner = registration.liveOwner?.owner
  } catch (error) {
    onWarning("failed to acquire registration lock", error)
  }

  if (!registrationAcquired) {
    try {
      if (retainedCandidate) ensureRunningMarker(userDataPath, owner, registeringOwner)
      else createRunningMarker(userDataPath, owner, registeringOwner)
    } catch (error) {
      onWarning("failed to create running marker", error)
    }
    return false
  }

  try {
    let isPrimary = false
    let acknowledgedPrimary: ProcessOwner | undefined
    try {
      const acquisition = acquireMarkerBackedProcessOwnerLock(
        userDataPath,
        paths.primaryLockPath,
        owner,
        pidAlive,
        registrationLockWaitMs,
        processStartIdentity,
      )
      isPrimary = acquisition.acquired
      acknowledgedPrimary = acquisition.liveOwner?.owner
    } catch (error) {
      onWarning("failed to acquire primary lock", error)
    }

    if (isPrimary) {
      try {
        onPrimaryLockAcquired()
        if (cleanStaleRunningMarkers(userDataPath, owner, pidAlive, processStartIdentity) && !retainedCandidate) {
          removeProcessOwnerLockIfOwned(paths.primaryLockPath, owner)
          isPrimary = false
        }
      } catch (error) {
        onWarning("failed to inspect running markers", error)
        releaseProcessOwnerLock(paths.primaryLockPath, owner, onWarning, "failed to release primary lock")
        isPrimary = false
      }
    }

    try {
      if (retainedCandidate) ensureRunningMarker(userDataPath, owner, acknowledgedPrimary)
      else createRunningMarker(userDataPath, owner, acknowledgedPrimary)
    } catch (error) {
      onWarning("failed to create running marker", error)
      if (isPrimary) releaseProcessOwnerLock(paths.primaryLockPath, owner, onWarning, "failed to release primary lock")
      return false
    }

    return isPrimary
  } finally {
    releaseProcessOwnerLock(paths.registrationLockPath, owner, onWarning, "failed to release registration lock")
  }
}
