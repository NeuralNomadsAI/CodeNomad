import { closeSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import {
  getProcessStartIdentity,
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
}

export type RunningMarkerStatus = "current" | "other-live" | "stale"

export interface ClientStateElectionPaths {
  primaryLockPath: string
  registrationLockPath: string
}

export interface ClientStateElectionResult {
  isPrimary: boolean
  runningMarkerPath: string
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
  let descriptor: number | undefined
  let created = false
  try {
    descriptor = openSync(markerPath, "wx", 0o600)
    created = true
    writeFileSync(descriptor, JSON.stringify(primaryOwner ? { ...owner, primaryOwner } : owner), "utf8")
    closeSync(descriptor)
    return markerPath
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // Ignore cleanup errors after a failed marker write.
      }
    }
    if (created) {
      try {
        unlinkSync(markerPath)
      } catch {
        // The unique run-token path cannot be owned by another process.
      }
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

function waitForLockRetry(delayMs = LOCK_RETRY_DELAY_MS) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, delayMs))
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

    let descriptor: number | undefined
    let created = false
    try {
      descriptor = openSync(path, "wx", 0o600)
      created = true
      writeFileSync(descriptor, serializedOwner, "utf8")
      closeSync(descriptor)
      return { acquired: true }
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {
          // Ignore cleanup errors after a failed exclusive create.
        }
      }
      if (created) {
        try {
          unlinkSync(path)
        } catch {
          // The lock remains conservative if cleanup fails.
        }
      }
      if (!hasErrorCode(error, "EEXIST")) {
        throw error
      }
    }

    let observed: string
    try {
      observed = readFileSync(path, "utf8")
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        continue
      }
      throw error
    }

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

    try {
      removeFileIfUnchanged(path, observed)
    } catch (error) {
      if (!isTransientFileContentionError(error)) {
        throw error
      }
      waitForLockRetry()
    }
  }

  return { acquired: false, liveOwner }
}

export function acquireProcessOwnerLock(
  path: string,
  owner: ProcessOwner,
  waitForLiveOwner: boolean,
  pidAlive: (pid: number) => boolean = isPidAlive,
  liveOwnerWaitMs = REGISTRATION_LOCK_WAIT_MS,
  processStartIdentity: ProcessStartIdentityLookup = getProcessStartIdentity,
): boolean {
  return acquireProcessOwnerLockWithStatus(
    path,
    owner,
    waitForLiveOwner,
    pidAlive,
    liveOwnerWaitMs,
    processStartIdentity,
  ).acquired
}

export function removeProcessOwnerLockIfOwned(path: string, owner: ProcessOwner): boolean {
  try {
    const observed = readFileSync(path, "utf8")
    const current = parseProcessOwner(observed)
    return Boolean(current && isSameProcessOwner(current, owner) && removeFileIfUnchanged(path, observed))
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
}

export function isProcessOwnerLockOwned(path: string, owner: ProcessOwner): boolean {
  try {
    const current = parseProcessOwner(readFileSync(path, "utf8"))
    return Boolean(current && isSameProcessOwner(current, owner))
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
}

export function removeRunningMarkerIfOwned(markerPath: string, owner: ProcessOwner): boolean {
  const filenameOwner = parseRunningMarkerFilename(basename(markerPath))
  if (!filenameOwner || !isSameProcessOwner(filenameOwner, owner)) {
    return false
  }

  try {
    const observed = readFileSync(markerPath, "utf8")
    const storedOwner = parseProcessOwner(observed)
    return Boolean(storedOwner && isSameProcessOwner(storedOwner, owner) && removeFileIfUnchanged(markerPath, observed))
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
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
    let observed: string
    try {
      observed = readFileSync(markerPath, "utf8")
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        continue
      }
      throw error
    }

    const storedOwner = parseProcessOwner(observed)
    if (storedOwner && !isSameProcessOwner(storedOwner, filenameOwner)) {
      if (classifyRunningMarker(storedOwner, currentOwner, pidAlive, processStartIdentity) === "other-live") {
        hasOtherLiveProcess = true
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

  try {
    const markerOwner = parseProcessOwner(readFileSync(getRunningMarkerPath(userDataPath, owner), "utf8"))
    if (!markerOwner || !isSameProcessOwner(markerOwner, owner)) return false
    if (markerOwner.processStartIdentity) {
      const liveIdentity = processStartIdentity(markerOwner.pid)
      if (liveIdentity && liveIdentity !== markerOwner.processStartIdentity) return false
    }
    return true
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
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
    try {
      removeFileIfUnchanged(path, acquisition.liveOwner.observed)
    } catch (error) {
      if (!isTransientFileContentionError(error)) {
        throw error
      }
      waitForLockRetry()
    }
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
): ClientStateElectionResult {
  const runningMarkerPath = getRunningMarkerPath(userDataPath, owner)
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
      createRunningMarker(userDataPath, owner, registeringOwner)
    } catch (error) {
      onWarning("failed to create running marker", error)
    }
    return { isPrimary: false, runningMarkerPath }
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
        if (cleanStaleRunningMarkers(userDataPath, owner, pidAlive, processStartIdentity)) {
          removeProcessOwnerLockIfOwned(paths.primaryLockPath, owner)
          isPrimary = false
        }
      } catch (error) {
        onWarning("failed to inspect running markers", error)
        try {
          removeProcessOwnerLockIfOwned(paths.primaryLockPath, owner)
        } catch (releaseError) {
          onWarning("failed to release primary lock", releaseError)
        }
        isPrimary = false
      }
    }

    try {
      createRunningMarker(userDataPath, owner, acknowledgedPrimary)
    } catch (error) {
      onWarning("failed to create running marker", error)
      try {
        if (isPrimary) {
          removeProcessOwnerLockIfOwned(paths.primaryLockPath, owner)
        }
      } catch (releaseError) {
        onWarning("failed to release primary lock", releaseError)
      }
      return { isPrimary: false, runningMarkerPath }
    }

    return { isPrimary, runningMarkerPath }
  } finally {
    try {
      removeProcessOwnerLockIfOwned(paths.registrationLockPath, owner)
    } catch (error) {
      onWarning("failed to release registration lock", error)
    }
  }
}
