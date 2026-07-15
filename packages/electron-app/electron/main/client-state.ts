import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  electClientStateProcess,
  getRunningMarkerPath,
  hasLiveTauriClient,
  hasErrorCode,
  isProcessOwnerLockOwned,
  removeProcessOwnerLockIfOwned,
  type ProcessOwner,
  removeRunningMarkerIfOwned,
} from "./client-state-process"
import { getProcessStartIdentity } from "./client-state-process-identity"
import {
  CrossHostRegistration,
  crossHostParticipants,
  resolveCrossHostElectionDirectory,
  resolveLegacyTauriDataDirectory,
  type CrossHostLeaseDependencies,
} from "./client-state-cross-host"
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

interface ClientStateManagerOptions {
  crossHostElectionDirectory?: string
  crossHostDependencies?: CrossHostLeaseDependencies
  legacyTauriDataPath?: string | null
  processOwner?: ProcessOwner
}

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
  private readonly legacyTauriDataPath: string | null
  private readonly owner: ProcessOwner
  private state: PersistedClientState = { version: CLIENT_STATE_VERSION, restoreEnabled: true }
  private writeQueue: Promise<void> = Promise.resolve()
  private drainAndReleasePromise: Promise<void> | undefined
  private crossHostRegistration: CrossHostRegistration | undefined
  private primary = false
  private persistenceSuppressed = false
  private unsupportedFutureEnvelope = false
  private frozen = false
  private rendererAccessToken: string | undefined

  constructor(
    userDataPath: string,
    private readonly writeState: ClientStateWriter = writeClientStateTemporary,
    options?: ClientStateManagerOptions,
  ) {
    this.owner = options?.processOwner ?? {
      pid: process.pid,
      runToken: randomUUID(),
      processStartIdentity: getProcessStartIdentity(process.pid),
    }
    mkdirSync(userDataPath, { recursive: true })
    this.userDataPath = userDataPath
    this.statePath = join(userDataPath, CLIENT_STATE_FILENAME)
    this.lockPath = join(userDataPath, PRIMARY_LOCK_FILENAME)
    const registrationLockPath = join(userDataPath, REGISTRATION_LOCK_FILENAME)

    const election = electClientStateProcess(
      userDataPath,
      this.owner,
      { primaryLockPath: this.lockPath, registrationLockPath },
      (message, error) => console.warn(`[client-state] ${message}`, error),
    )
    const crossHostElectionDirectory = options?.crossHostElectionDirectory ?? resolveCrossHostElectionDirectory()
    const legacyTauriDataPath = options?.legacyTauriDataPath === undefined
      ? (options?.crossHostElectionDirectory ? null : resolveLegacyTauriDataDirectory())
      : options.legacyTauriDataPath
    this.legacyTauriDataPath = legacyTauriDataPath
    this.primary = election
    try {
      this.crossHostRegistration = CrossHostRegistration.register(
        crossHostElectionDirectory,
        this.owner,
        () => {
          if (!this.primary || !legacyTauriDataPath) return this.primary
          try {
            return !hasLiveTauriClient(
              legacyTauriDataPath,
              options?.crossHostDependencies?.pidAlive,
              options?.crossHostDependencies?.processStartIdentity,
              undefined,
              crossHostParticipants(crossHostElectionDirectory),
            )
          } catch (error) {
            console.warn("[client-state] failed to inspect legacy Tauri process markers; continuing as secondary", error)
            return false
          }
        },
        options?.crossHostDependencies,
      )
    } catch (error) {
      console.warn("[client-state] failed to register cross-host ownership", error)
    }
    if (!this.crossHostRegistration?.isPrimary) {
      if (election) removeProcessOwnerLockIfOwned(this.lockPath, this.owner)
      this.primary = false
    }
    if (this.isPrimary) {
      const persisted = this.readState()
      this.state = persisted.state
      this.persistenceSuppressed = !this.state.restoreEnabled
      this.unsupportedFutureEnvelope = persisted.unsupportedFutureEnvelope
    }
  }

  get isPrimary(): boolean {
    if (!this.primary || !this.crossHostRegistration?.isPrimary) return false
    if (!this.legacyTauriDataPath) return true
    try {
      return !hasLiveTauriClient(this.legacyTauriDataPath, undefined, undefined, undefined, crossHostParticipants(this.crossHostRegistration.path))
    } catch (error) {
      console.warn("[client-state] failed to recheck legacy Tauri process markers; ownership disabled", error)
      return false
    }
  }

  loadClientState(): ClientStateLoadResult {
    if (!this.isPrimary) {
      return { isPrimary: false, restoreEnabled: true, snapshot: null }
    }
    return {
      isPrimary: true,
      restoreEnabled: this.state.restoreEnabled,
      snapshot: this.state.restoreEnabled ? (this.state.snapshot ?? null) : null,
    }
  }

  getWindowState(): NativeWindowState | undefined {
    return this.isPrimary && !this.unsupportedFutureEnvelope && this.state.restoreEnabled ? this.state.window : undefined
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
    if (!this.isPrimary) {
      return Promise.resolve(false)
    }
    if (this.frozen) {
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

    this.frozen = true
    this.drainAndReleasePromise = this.writeQueue.finally(() => {
      this.primary = false
      this.releaseOwnedProcessFiles()
    })
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
    if (!this.isPrimary) {
      return Promise.resolve(false)
    }
    if (this.frozen) {
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
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      if (skipWhenSuppressed && this.persistenceSuppressed) {
        return
      }

      const previousState = { ...this.state }
      const previousPersistenceSuppressed = this.persistenceSuppressed
      const previousUnsupportedFutureEnvelope = this.unsupportedFutureEnvelope
      try {
        mutate(this.state)
        await this.writeAtomically(JSON.stringify(this.state))
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

  private async writeAtomically(serializedState: string): Promise<void> {
    const temporaryPath = join(
      this.userDataPath,
      `.${CLIENT_STATE_FILENAME}.${this.owner.pid}.${this.owner.runToken}.tmp`,
    )
    try {
      await this.writeState(temporaryPath, serializedState)
      this.assertReplacementAllowed()
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  }

  private assertReplacementAllowed(): void {
    if (!this.isPrimary || !isProcessOwnerLockOwned(this.lockPath, this.owner)) {
      throw new Error("Client state ownership changed before atomic replacement")
    }
  }

  private releaseOwnedProcessFiles(): void {
    const releases: Array<[string, () => void]> = [
      ["remove running marker", () => { removeRunningMarkerIfOwned(getRunningMarkerPath(this.userDataPath, this.owner), this.owner) }],
      ["release primary lock", () => { removeProcessOwnerLockIfOwned(this.lockPath, this.owner) }],
      ["release cross-host registration", () => { this.crossHostRegistration?.release(); this.crossHostRegistration = undefined }],
    ]
    for (const [action, release] of releases) {
      try {
        release()
      } catch (error) {
        console.warn(`[client-state] failed to ${action}`, error)
      }
    }
  }

  private validateRendererAccessTokenValue(token: unknown): asserts token is string {
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new TypeError("Client state access token must be a nonempty string")
    }
  }
}
