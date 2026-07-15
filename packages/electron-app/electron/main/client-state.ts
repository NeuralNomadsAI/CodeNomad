import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  electClientStateProcess,
  getRunningMarkerPath,
  hasErrorCode,
  isProcessOwnerLockOwned,
  removeProcessOwnerLockIfOwned,
  type ProcessOwner,
  removeRunningMarkerIfOwned,
} from "./client-state-process"
import { getProcessStartIdentity } from "./client-state-process-identity"
import { normalizeNativeWindowState } from "./window-state"

const CLIENT_STATE_VERSION = 1
const CLIENT_STATE_FILENAME = "client-state.json"
const PRIMARY_LOCK_FILENAME = "client-state.primary.lock"
const REGISTRATION_LOCK_FILENAME = "client-state.registration.lock"

export const MAX_CLIENT_SNAPSHOT_BYTES = 1024 * 1024

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeWindowState {
  bounds: WindowBounds
  maximized: boolean
  fullscreen: boolean
  zoomFactor: number
}

export interface ClientStateLoadResult {
  isPrimary: boolean
  restoreEnabled: boolean
  snapshot: unknown | null
}

interface PersistedClientState {
  version: typeof CLIENT_STATE_VERSION
  restoreEnabled: boolean
  snapshot?: unknown
  window?: NativeWindowState
}

export type ClientStateWriter = (
  temporaryPath: string,
  serializedState: string,
) => Promise<void>

async function writeClientStateTemporary(temporaryPath: string, serializedState: string): Promise<void> {
  await writeFile(temporaryPath, serializedState, { encoding: "utf8", mode: 0o600 })
}

interface ParsedClientState {
  state: PersistedClientState
  unsupportedFutureEnvelope: boolean
}

function parseClientState(value: string): ParsedClientState {
  const defaults: PersistedClientState = { version: CLIENT_STATE_VERSION, restoreEnabled: true }
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>
    if (candidate && typeof candidate.version === "number" && candidate.version > CLIENT_STATE_VERSION) {
      return { state: defaults, unsupportedFutureEnvelope: true }
    }
    if (!candidate || candidate.version !== CLIENT_STATE_VERSION) {
      return { state: defaults, unsupportedFutureEnvelope: false }
    }

    const state: PersistedClientState = {
      version: CLIENT_STATE_VERSION,
      restoreEnabled: typeof candidate.restoreEnabled === "boolean" ? candidate.restoreEnabled : true,
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "snapshot")) {
      state.snapshot = candidate.snapshot
    }
    const windowState = normalizeNativeWindowState(candidate.window)
    if (windowState) {
      state.window = windowState
    }
    return { state, unsupportedFutureEnvelope: false }
  } catch (error) {
    console.warn("[client-state] ignored invalid state file", error)
    return { state: defaults, unsupportedFutureEnvelope: false }
  }
}

export class ClientStateManager {
  private readonly userDataPath: string
  private readonly statePath: string
  private readonly lockPath: string
  private readonly registrationLockPath: string
  private readonly owner: ProcessOwner = {
    pid: process.pid,
    runToken: randomUUID(),
    processStartIdentity: getProcessStartIdentity(process.pid),
  }
  private readonly runningMarkerPath: string
  private state: PersistedClientState = { version: CLIENT_STATE_VERSION, restoreEnabled: true }
  private writeQueue: Promise<void> = Promise.resolve()
  private drainAndReleasePromise: Promise<void> | undefined
  private primary = false
  private persistenceSuppressed = false
  private unsupportedFutureEnvelope = false
  private ownershipGeneration = 1
  private frozenGeneration: number | undefined
  private rendererAccessToken: string | undefined

  constructor(userDataPath: string, private readonly writeState: ClientStateWriter = writeClientStateTemporary) {
    mkdirSync(userDataPath, { recursive: true })
    this.userDataPath = userDataPath
    this.statePath = join(userDataPath, CLIENT_STATE_FILENAME)
    this.lockPath = join(userDataPath, PRIMARY_LOCK_FILENAME)
    this.registrationLockPath = join(userDataPath, REGISTRATION_LOCK_FILENAME)
    this.runningMarkerPath = getRunningMarkerPath(userDataPath, this.owner)

    const election = electClientStateProcess(
      userDataPath,
      this.owner,
      { primaryLockPath: this.lockPath, registrationLockPath: this.registrationLockPath },
      (message, error) => console.warn(`[client-state] ${message}`, error),
    )
    this.primary = election.isPrimary
    if (this.primary) {
      const persisted = this.readState()
      this.state = persisted.state
      this.persistenceSuppressed = !this.state.restoreEnabled
      this.unsupportedFutureEnvelope = persisted.unsupportedFutureEnvelope
    }
  }

  get isPrimary(): boolean {
    return this.primary
  }

  loadClientState(): ClientStateLoadResult {
    if (!this.primary) {
      return { isPrimary: false, restoreEnabled: true, snapshot: null }
    }
    return {
      isPrimary: true,
      restoreEnabled: this.state.restoreEnabled,
      snapshot: this.state.restoreEnabled ? (this.state.snapshot ?? null) : null,
    }
  }

  getWindowState(): NativeWindowState | undefined {
    return this.primary && !this.unsupportedFutureEnvelope && this.state.restoreEnabled ? this.state.window : undefined
  }

  claimClientStateAccess(token: unknown): true {
    this.validateRendererAccessTokenValue(token)
    if (this.rendererAccessToken === undefined) {
      this.rendererAccessToken = token
      return true
    }
    if (this.rendererAccessToken !== token) {
      throw new Error("Client state access token does not match the claimed renderer")
    }
    return true
  }

  assertRendererAccessToken(token: unknown): void {
    this.validateRendererAccessTokenValue(token)
    if (this.rendererAccessToken === undefined || this.rendererAccessToken !== token) {
      throw new Error("Client state access has not been claimed by this renderer")
    }
  }

  resetRendererAccessToken(): void {
    this.rendererAccessToken = undefined
  }

  saveClientState(snapshot: unknown): Promise<boolean> {
    const disposition = this.getMutationDisposition()
    if (disposition) return disposition

    const serialized = JSON.stringify(snapshot)
    if (serialized === undefined) {
      throw new TypeError("Client snapshot must be JSON-serializable")
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_CLIENT_SNAPSHOT_BYTES) {
      throw new RangeError("Client snapshot exceeds the 1 MiB limit")
    }

    const normalizedSnapshot = JSON.parse(serialized) as unknown
    return this.mutateAndPersist((state) => {
      state.snapshot = normalizedSnapshot
    }, true)
  }

  setRestoreEnabled(enabled: boolean): Promise<boolean> {
    const disposition = this.getMutationDisposition(false)
    if (disposition) return disposition

    if (typeof enabled !== "boolean") {
      throw new TypeError("Restore enabled must be a boolean")
    }

    return this.mutateAndPersist((state) => {
      state.restoreEnabled = enabled
      if (enabled) {
        this.persistenceSuppressed = false
      } else {
        delete state.snapshot
        delete state.window
        this.persistenceSuppressed = true
      }
    })
  }

  clearClientState(): Promise<boolean> {
    if (!this.primary) {
      return Promise.resolve(false)
    }
    if (this.frozenGeneration !== undefined) {
      return Promise.reject(new Error("Client state persistence is frozen for shutdown"))
    }

    const clearingFutureEnvelope = this.unsupportedFutureEnvelope

    return this.mutateAndPersist((state) => {
      delete state.snapshot
      delete state.window
      this.unsupportedFutureEnvelope = false
      this.persistenceSuppressed = !clearingFutureEnvelope
    })
  }

  saveWindowState(windowState: NativeWindowState): Promise<boolean> {
    const disposition = this.getMutationDisposition()
    if (disposition) return disposition

    const normalized = normalizeNativeWindowState(windowState)
    if (!normalized) {
      return Promise.resolve(false)
    }
    return this.mutateAndPersist((state) => {
      state.window = normalized
    }, true)
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  drainAndReleasePrimary(): Promise<void> {
    if (this.drainAndReleasePromise) {
      return this.drainAndReleasePromise
    }

    this.frozenGeneration = this.ownershipGeneration
    this.drainAndReleasePromise = (async () => {
      try {
        await this.writeQueue
      } finally {
        this.primary = false
        this.ownershipGeneration += 1
        this.releaseOwnedProcessFiles()
      }
    })()
    return this.drainAndReleasePromise
  }

  private readState(): ParsedClientState {
    try {
      return parseClientState(readFileSync(this.statePath, "utf8"))
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        console.warn("[client-state] failed to read state", error)
      }
      return {
        state: { version: CLIENT_STATE_VERSION, restoreEnabled: true },
        unsupportedFutureEnvelope: false,
      }
    }
  }

  private getMutationDisposition(futureEnvelopeResult = true): Promise<boolean> | undefined {
    if (!this.primary) {
      return Promise.resolve(false)
    }
    if (this.frozenGeneration !== undefined) {
      return Promise.reject(new Error("Client state persistence is frozen for shutdown"))
    }
    if (this.unsupportedFutureEnvelope) {
      return Promise.resolve(futureEnvelopeResult)
    }
    return undefined
  }

  private mutateAndPersist(
    mutate: (state: PersistedClientState) => void,
    skipWhenSuppressed = false,
  ): Promise<boolean> {
    const admittedGeneration = this.ownershipGeneration
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      if (skipWhenSuppressed && this.persistenceSuppressed) {
        return
      }

      const previousState = { ...this.state }
      const previousPersistenceSuppressed = this.persistenceSuppressed
      const previousUnsupportedFutureEnvelope = this.unsupportedFutureEnvelope
      try {
        mutate(this.state)
        await this.writeAtomically(JSON.stringify(this.state), admittedGeneration)
      } catch (error) {
        this.state = previousState
        this.persistenceSuppressed = previousPersistenceSuppressed
        this.unsupportedFutureEnvelope = previousUnsupportedFutureEnvelope
        throw error
      }
    })
    this.writeQueue = operation
    return operation.then(() => true)
  }

  private async writeAtomically(serializedState: string, admittedGeneration: number): Promise<void> {
    const temporaryPath = join(
      this.userDataPath,
      `.${CLIENT_STATE_FILENAME}.${this.owner.pid}.${this.owner.runToken}.tmp`,
    )
    try {
      await this.writeState(temporaryPath, serializedState)
      this.assertReplacementAllowed(admittedGeneration)
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  }

  private assertReplacementAllowed(admittedGeneration: number): void {
    if (
      !this.primary ||
      admittedGeneration !== this.ownershipGeneration ||
      (this.frozenGeneration !== undefined && admittedGeneration !== this.frozenGeneration) ||
      !isProcessOwnerLockOwned(this.lockPath, this.owner)
    ) {
      throw new Error("Client state ownership changed before atomic replacement")
    }
  }

  private releaseOwnedProcessFiles(): void {
    try {
      removeRunningMarkerIfOwned(this.runningMarkerPath, this.owner)
    } catch (error) {
      console.warn("[client-state] failed to remove running marker", error)
    }

    try {
      removeProcessOwnerLockIfOwned(this.lockPath, this.owner)
    } catch (error) {
      console.warn("[client-state] failed to release primary lock", error)
    }
  }

  private validateRendererAccessTokenValue(token: unknown): asserts token is string {
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new TypeError("Client state access token must be a nonempty string")
    }
  }
}
