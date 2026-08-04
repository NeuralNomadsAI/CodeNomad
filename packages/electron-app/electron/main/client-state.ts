import { randomUUID } from "node:crypto"
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  electClientStateProcess,
  getRunningMarkerPath,
  hasLiveTauriClient,
  hasLiveTauriClientAsync,
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
  resolveCrossHostStatePath,
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
  removeLegacyState?(path: string): void
}

async function writeClientStateTemporary(temporaryPath: string, serializedState: string): Promise<void> {
  const file = await open(temporaryPath, "w", 0o600)
  try {
    await file.writeFile(serializedState, "utf8")
    await file.sync()
  } finally {
    await file.close()
  }
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
      return { state: { ...defaults, restoreEnabled: false }, unsupportedFutureEnvelope: true }
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

interface LegacyStateSnapshot {
  path: string
  host: "electron" | "tauri"
  contents: Buffer
  identity: string
}

function snapshotLegacyState(path: string, host: LegacyStateSnapshot["host"]): LegacyStateSnapshot | undefined {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, "r")
    const before = legacyFileIdentity(descriptor)
    const contents = readFileSync(descriptor)
    const after = legacyFileIdentity(descriptor)
    return before === after ? { path, host, contents, identity: after } : undefined
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function legacyFileIdentity(descriptor: number): string {
  const value = fstatSync(descriptor, { bigint: true })
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.birthtimeNs}`
}

function legacySnapshotMatches(snapshot: LegacyStateSnapshot): boolean {
  const current = snapshotLegacyState(snapshot.path, snapshot.host)
  return Boolean(current && current.identity === snapshot.identity && current.contents.equals(snapshot.contents))
}

function legacyCandidate(snapshot: LegacyStateSnapshot): { host: string; state: PersistedClientState; savedAt: number; hasSnapshot: boolean } | undefined {
  try {
    const candidate = JSON.parse(snapshot.contents.toString("utf8")) as Record<string, unknown>
    if (!candidate || candidate.version !== CLIENT_STATE_VERSION) return undefined
    const parsed = parseClientState(JSON.stringify(candidate)).state
    delete parsed.window
    const candidateSnapshot = candidate.snapshot as Record<string, unknown> | undefined
    const savedAt = typeof candidateSnapshot?.savedAt === "number" && Number.isFinite(candidateSnapshot.savedAt) ? candidateSnapshot.savedAt : -1
    return { host: snapshot.host, state: parsed, savedAt, hasSnapshot: candidateSnapshot !== undefined }
  } catch {
    return undefined
  }
}

function isFutureLegacyCandidate(snapshot: LegacyStateSnapshot): boolean {
  try {
    const candidate = JSON.parse(snapshot.contents.toString("utf8")) as Record<string, unknown>
    return typeof candidate?.version === "number" && candidate.version > CLIENT_STATE_VERSION
  } catch {
    return false
  }
}

export class ClientStateManager {
  private readonly userDataPath: string
  private readonly statePath: string
  private readonly lockPath: string
  private readonly registrationLockPath: string
  private readonly legacyTauriDataPath: string | null
  private readonly legacyPaths: ReadonlyArray<readonly ["electron" | "tauri", string]>
  private readonly removeLegacyState: (path: string) => void
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
  private rendererReconciliationPending = false
  private effectivePrimary = false
  private ownershipEpoch = 0
  private readonly ownershipListeners = new Set<() => void>()
  private readonly crossHostDependencies: CrossHostLeaseDependencies | undefined

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
    this.crossHostDependencies = options?.crossHostDependencies
    mkdirSync(userDataPath, { recursive: true })
    this.userDataPath = userDataPath
    const crossHostElectionDirectory = options?.crossHostElectionDirectory ?? resolveCrossHostElectionDirectory()
    this.statePath = options?.crossHostElectionDirectory
      ? join(dirname(crossHostElectionDirectory), CLIENT_STATE_FILENAME)
      : resolveCrossHostStatePath()
    mkdirSync(dirname(this.statePath), { recursive: true })
    this.lockPath = join(userDataPath, PRIMARY_LOCK_FILENAME)
    this.registrationLockPath = join(userDataPath, REGISTRATION_LOCK_FILENAME)

    const election = electClientStateProcess(
      userDataPath,
      this.owner,
      { primaryLockPath: this.lockPath, registrationLockPath: this.registrationLockPath },
      (message, error) => console.warn(`[client-state] ${message}`, error),
    )
    const legacyTauriDataPath = options?.legacyTauriDataPath === undefined
      ? (options?.crossHostElectionDirectory ? null : resolveLegacyTauriDataDirectory())
      : options.legacyTauriDataPath
    this.legacyTauriDataPath = legacyTauriDataPath
    this.legacyPaths = [
      ["electron", join(userDataPath, CLIENT_STATE_FILENAME)],
      ...(legacyTauriDataPath ? [["tauri", join(legacyTauriDataPath, CLIENT_STATE_FILENAME)] as const] : []),
    ]
    this.removeLegacyState = options?.removeLegacyState ?? ((path) => rmSync(path, { force: true }))
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
    if (!this.crossHostRegistration) {
      if (election) removeProcessOwnerLockIfOwned(this.lockPath, this.owner)
      this.primary = false
    }
    if (this.isPrimary) {
      this.reloadAuthoritativeState()
      this.setEffectivePrimary(true, false)
    }
  }

  get isPrimary(): boolean {
    let primary = this.primary && Boolean(this.crossHostRegistration?.isPrimary)
    if (!primary) {
      this.setEffectivePrimary(false)
      return false
    }
    if (!this.legacyTauriDataPath) return true
    try {
      primary = !hasLiveTauriClient(
        this.legacyTauriDataPath,
        this.crossHostDependencies?.pidAlive,
        this.crossHostDependencies?.processStartIdentity,
        undefined,
        crossHostParticipants(this.crossHostRegistration!.path),
      )
    } catch (error) {
      console.warn("[client-state] failed to recheck legacy Tauri process markers; ownership disabled", error)
      primary = false
    }
    if (!primary) this.setEffectivePrimary(false)
    return primary
  }

  loadClientState(): ClientStateLoadResult {
    if (!this.isPrimary) {
      return { isPrimary: false, restoreEnabled: false, snapshot: null }
    }
    const result = {
      isPrimary: true,
      restoreEnabled: this.state.restoreEnabled,
      snapshot: this.state.restoreEnabled ? (this.state.snapshot ?? null) : null,
    }
    this.rendererReconciliationPending = false
    return result
  }

  onOwnershipChanged(listener: () => void): () => void {
    this.ownershipListeners.add(listener)
    return () => this.ownershipListeners.delete(listener)
  }

  async refreshPrimary(): Promise<boolean> {
    if (this.frozen) return false
    if (this.primary && !isProcessOwnerLockOwned(this.lockPath, this.owner)) {
      this.primary = false
      this.crossHostRegistration?.deferPrimary()
      this.setEffectivePrimary(false)
      return false
    }
    if (!this.primary) {
      this.primary = electClientStateProcess(
        this.userDataPath,
        this.owner,
        { primaryLockPath: this.lockPath, registrationLockPath: this.registrationLockPath },
        (message, error) => console.warn(`[client-state] ${message}`, error),
        this.crossHostDependencies?.pidAlive,
        0,
        () => {},
        this.crossHostDependencies?.processStartIdentity,
        true,
      )
      if (!this.primary) return false
    }
    try {
      if (this.crossHostRegistration?.isPrimary) {
        if (await this.canOwnCrossHostStateAsync()) {
          if (this.effectivePrimary) return false
          this.reloadAuthoritativeState()
          this.rendererReconciliationPending = true
          this.setEffectivePrimary(true)
          return true
        }
        this.crossHostRegistration?.deferPrimary()
        this.setEffectivePrimary(false)
        return false
      }
      if (!await this.canOwnCrossHostStateAsync()) {
        this.crossHostRegistration?.deferPrimary()
        this.setEffectivePrimary(false)
        return false
      }
      const registration = this.crossHostRegistration
      if (!registration || !await registration.tryAcquireAsync(true)) return false
      if (!await this.canOwnCrossHostStateAsync()) {
        registration.deferPrimary()
        this.setEffectivePrimary(false)
        return false
      }
      this.reloadAuthoritativeState()
      this.rendererReconciliationPending = true
      this.setEffectivePrimary(true)
      return true
    } catch (error) {
      this.crossHostRegistration?.deferPrimary()
      this.setEffectivePrimary(false)
      console.warn("[client-state] failed to promote from shared state", error)
      return false
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

  saveClientState(snapshot: unknown, rendererToken?: unknown): Promise<boolean> {
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
    }, true, rendererToken)
  }

  setRestoreEnabled(enabled: boolean, rendererToken?: unknown): Promise<boolean> {
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
    }, false, rendererToken)
  }

  clearClientState(rendererToken?: unknown): Promise<boolean> {
    if (!this.isPrimary || this.rendererReconciliationPending) {
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
    }, false, rendererToken)
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

  private readState(authoritative = false): ParsedClientState {
    try {
      return parseClientState(readFileSync(this.statePath, "utf8"))
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        console.warn("[client-state] failed to read state", error)
        if (authoritative) throw error
      }
      return {
        state: { version: CLIENT_STATE_VERSION, restoreEnabled: true },
        unsupportedFutureEnvelope: false,
      }
    }
  }

  private migrateLegacyStateIfNeeded(): void {
    try {
      readFileSync(this.statePath)
      return
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) return
    }
    const legacySnapshots = this.legacyPaths
      .map(([host, path]) => snapshotLegacyState(path, host))
      .filter((snapshot): snapshot is LegacyStateSnapshot => Boolean(snapshot))
    if (legacySnapshots.some(isFutureLegacyCandidate)) {
      this.unsupportedFutureEnvelope = true
      return
    }
    const winner = legacySnapshots
      .map(legacyCandidate)
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .sort((left, right) =>
        Number(left.state.restoreEnabled) - Number(right.state.restoreEnabled) ||
        Number(left.hasSnapshot) - Number(right.hasSnapshot) ||
        right.savedAt - left.savedAt ||
        right.host.localeCompare(left.host),
      )[0]
    if (!winner) return

    const temporaryPath = join(dirname(this.statePath), `.${CLIENT_STATE_FILENAME}.${this.owner.pid}.${this.owner.runToken}.migration.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600)
      writeFileSync(descriptor, JSON.stringify(winner.state), "utf8")
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      this.assertSharedOwnershipAllowed()
      renameSync(temporaryPath, this.statePath)
      for (const snapshot of legacySnapshots) {
        try {
          this.assertSharedOwnershipAllowed()
          if (!legacySnapshotMatches(snapshot)) continue
          this.assertSharedOwnershipAllowed()
          this.removeLegacyState(snapshot.path)
        } catch (error) {
          console.warn(`[client-state] failed to remove migrated legacy state at ${snapshot.path}`, error)
        }
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  private getMutationDisposition(futureEnvelopeResult = true): Promise<boolean> | undefined {
    if (!this.isPrimary || this.rendererReconciliationPending) {
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
    rendererToken?: unknown,
  ): Promise<boolean> {
    const ownershipEpoch = this.ownershipEpoch
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      if (rendererToken !== undefined) this.assertRendererAccessToken(rendererToken)
      this.assertReplacementAllowed(ownershipEpoch, rendererToken)
      const runtimeSuppression = this.persistenceSuppressed
      this.reloadAuthoritativeState()
      this.persistenceSuppressed = runtimeSuppression
      if (skipWhenSuppressed && this.persistenceSuppressed) {
        return
      }

      const previousState = { ...this.state }
      const previousPersistenceSuppressed = this.persistenceSuppressed
      const previousUnsupportedFutureEnvelope = this.unsupportedFutureEnvelope
      try {
        mutate(this.state)
        await this.writeAtomically(JSON.stringify(this.state), ownershipEpoch, rendererToken)
      } catch (error) {
        if (ownershipEpoch === this.ownershipEpoch) {
          this.state = previousState
          this.persistenceSuppressed = previousPersistenceSuppressed
          this.unsupportedFutureEnvelope = previousUnsupportedFutureEnvelope
        } else if (this.isPrimary) {
          this.reloadAuthoritativeState()
        }
        throw error
      }
    })
    this.writeQueue = operation
    return operation.then(() => true)
  }

  private async writeAtomically(serializedState: string, ownershipEpoch: number, rendererToken?: unknown): Promise<void> {
    const temporaryPath = join(
      dirname(this.statePath),
      `.${CLIENT_STATE_FILENAME}.${this.owner.pid}.${this.owner.runToken}.tmp`,
    )
    try {
      await this.writeState(temporaryPath, serializedState)
      this.assertReplacementAllowed(ownershipEpoch, rendererToken)
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  }

  private assertReplacementAllowed(ownershipEpoch: number, rendererToken?: unknown): void {
    if (rendererToken !== undefined) this.assertRendererAccessToken(rendererToken)
    if (!this.isPrimary || this.ownershipEpoch !== ownershipEpoch || !isProcessOwnerLockOwned(this.lockPath, this.owner)) {
      throw new Error("Client state ownership changed before atomic replacement")
    }
  }

  private canOwnCrossHostState(): boolean {
    if (!this.primary || !isProcessOwnerLockOwned(this.lockPath, this.owner)) return false
    if (!this.legacyTauriDataPath) return true
    return !hasLiveTauriClient(
      this.legacyTauriDataPath,
      this.crossHostDependencies?.pidAlive,
      this.crossHostDependencies?.processStartIdentity,
      undefined,
      crossHostParticipants(this.crossHostRegistration?.path ?? ""),
    )
  }

  private async canOwnCrossHostStateAsync(): Promise<boolean> {
    if (!this.primary || !isProcessOwnerLockOwned(this.lockPath, this.owner)) return false
    if (!this.legacyTauriDataPath) return true
    return !await hasLiveTauriClientAsync(
      this.legacyTauriDataPath,
      this.crossHostDependencies?.pidAlive,
      this.crossHostDependencies?.processStartIdentityAsync ?? this.crossHostDependencies?.processStartIdentity,
      undefined,
      crossHostParticipants(this.crossHostRegistration?.path ?? ""),
    )
  }

  private reloadAuthoritativeState(): void {
    this.unsupportedFutureEnvelope = false
    this.migrateLegacyStateIfNeeded()
    const futureLegacyBlocked = this.unsupportedFutureEnvelope
    const persisted = this.readState(true)
    this.state = futureLegacyBlocked
      ? { version: CLIENT_STATE_VERSION, restoreEnabled: false }
      : persisted.state
    this.persistenceSuppressed = !this.state.restoreEnabled
    this.unsupportedFutureEnvelope = futureLegacyBlocked || persisted.unsupportedFutureEnvelope
  }

  private assertSharedOwnershipAllowed(): void {
    if (!this.crossHostRegistration?.isPrimary || !this.canOwnCrossHostState()) {
      throw new Error("Client state ownership changed before atomic replacement")
    }
  }

  private setEffectivePrimary(primary: boolean, notify = true): void {
    if (this.effectivePrimary === primary) return
    this.effectivePrimary = primary
    this.ownershipEpoch += 1
    if (notify) {
      this.rendererReconciliationPending = true
      for (const listener of this.ownershipListeners) listener()
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
