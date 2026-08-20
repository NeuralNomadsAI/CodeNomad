import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
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
  resolveCrossHostStatePath,
  resolveLegacyCrossHostStatePath,
  resolveLegacyTauriDataDirectory,
  type CrossHostLeaseDependencies,
} from "./client-state-cross-host"
import { normalizeNativeWindowState, type NativeWindowState } from "./window-state"
import {
  CLIENT_STATE_PARTITION_PROTOCOL_VERSION,
  ClientStatePartitionStore,
  isPartitionKey,
  validateClientStatePartitionCommit,
  syncDirectory,
} from "./client-state-partitions"
import {
  CLIENT_STATE_ENVELOPE_VERSION,
  CLIENT_STATE_MONOLITHIC_VERSION,
  MAX_CLIENT_SNAPSHOT_BYTES,
  MAX_CLIENT_STATE_WINDOWS,
  createClientState,
  isWindowId,
  parseClientState,
  retainedPartitionKeys,
  type ClientWindowStateRecord,
  type ParsedClientState,
  type PersistedClientState,
} from "./client-state-envelope"

const CLIENT_STATE_FILENAME = "client-state.json"
const PRIMARY_LOCK_FILENAME = "client-state.primary.lock"
const REGISTRATION_LOCK_FILENAME = "client-state.registration.lock"
const CROSS_HOST_PARTICIPANT_GRACE_MS = 50

export { MAX_CLIENT_SNAPSHOT_BYTES } from "./client-state-envelope"
export type { NativeWindowState, WindowBounds } from "./window-state"

export interface ClientStateLoadResult {
  isPrimary: boolean
  restoreEnabled: boolean
  snapshot: unknown | null
  partitionProtocolVersion: typeof CLIENT_STATE_PARTITION_PROTOCOL_VERSION
}

interface LegacyPersistedClientState {
  version: typeof CLIENT_STATE_MONOLITHIC_VERSION
  restoreEnabled: boolean
  snapshot?: unknown
}

export type ClientStateWriter = (
  temporaryPath: string,
  serializedState: string,
) => Promise<void>

interface ClientStateManagerOptions {
  crossHostElectionDirectory?: string
  crossHostDependencies?: CrossHostLeaseDependencies
  legacySharedStatePath?: string | null
  legacyTauriDataPath?: string | null
  processOwner?: ProcessOwner
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

function legacyCandidate(path: string, host: "electron" | "tauri"): { host: string; state: LegacyPersistedClientState; savedAt: number; hasSnapshot: boolean } | undefined {
  try {
    const candidate = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    if (!candidate || candidate.version !== CLIENT_STATE_MONOLITHIC_VERSION) return undefined
    const parsedEnvelope = parseClientState(JSON.stringify(candidate))
    if (parsedEnvelope.unsupportedFutureEnvelope) return undefined
    const record = parsedEnvelope.state.windows[parsedEnvelope.state.activeWindowId]!
    const parsed: LegacyPersistedClientState = {
      version: CLIENT_STATE_MONOLITHIC_VERSION,
      restoreEnabled: record.restoreEnabled,
      ...(record.snapshot === undefined ? {} : { snapshot: record.snapshot }),
    }
    const snapshot = candidate.snapshot as Record<string, unknown> | undefined
    const savedAt = typeof snapshot?.savedAt === "number" && Number.isFinite(snapshot.savedAt) ? snapshot.savedAt : -1
    return { host, state: parsed, savedAt, hasSnapshot: snapshot !== undefined }
  } catch {
    return undefined
  }
}

function isFutureLegacyCandidate(path: string): boolean {
  try {
    const candidate = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    return typeof candidate?.version === "number" && candidate.version > CLIENT_STATE_MONOLITHIC_VERSION
  } catch {
    return false
  }
}

export class ClientStateManager {
  private readonly userDataPath: string
  private readonly statePath: string
  private readonly lockPath: string
  private readonly legacyTauriDataPath: string | null
  private readonly owner: ProcessOwner
  private readonly partitions: ClientStatePartitionStore
  private state: PersistedClientState = createClientState()
  private writeQueue: Promise<void> = Promise.resolve()
  private drainAndReleasePromise: Promise<void> | undefined
  private crossHostRegistration: CrossHostRegistration | undefined
  private primary = false
  private persistenceSuppressed = new Set<string>()
  private unsupportedFutureEnvelope = false
  private frozen = false
  private rendererAccessTokens = new Map<string, string>()

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
    const crossHostElectionDirectory = options?.crossHostElectionDirectory ?? resolveCrossHostElectionDirectory()
    this.statePath = options?.crossHostElectionDirectory
      ? join(dirname(crossHostElectionDirectory), CLIENT_STATE_FILENAME)
      : resolveCrossHostStatePath()
    mkdirSync(dirname(this.statePath), { recursive: true })
    this.partitions = new ClientStatePartitionStore(dirname(this.statePath))
    this.lockPath = join(userDataPath, PRIMARY_LOCK_FILENAME)
    const registrationLockPath = join(userDataPath, REGISTRATION_LOCK_FILENAME)

    const election = electClientStateProcess(
      userDataPath,
      this.owner,
      { primaryLockPath: this.lockPath, registrationLockPath },
      (message, error) => console.warn(`[client-state] ${message}`, error),
    )
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
            const legacyBlocked = () => hasLiveTauriClient(
              legacyTauriDataPath,
              options?.crossHostDependencies?.pidAlive,
              options?.crossHostDependencies?.processStartIdentity,
              undefined,
              crossHostParticipants(crossHostElectionDirectory),
            )
            if (!legacyBlocked()) return true
            // A peer may have published its legacy marker just before its
            // cross-host participant. Reconcile once before yielding ownership.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CROSS_HOST_PARTICIPANT_GRACE_MS)
            return !legacyBlocked()
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
      const legacySharedStatePath = options?.legacySharedStatePath === undefined
        ? (options?.crossHostElectionDirectory ? null : resolveLegacyCrossHostStatePath())
        : options.legacySharedStatePath
      this.copyLegacySharedStateIfNeeded(legacySharedStatePath)
      const legacyPaths = [
        ["electron", join(userDataPath, CLIENT_STATE_FILENAME)],
        ...(legacyTauriDataPath ? [["tauri", join(legacyTauriDataPath, CLIENT_STATE_FILENAME)] as const] : []),
      ] as ReadonlyArray<readonly ["electron" | "tauri", string]>
      this.migrateLegacyStateIfNeeded(legacyPaths)
      const futureLegacyBlocked = this.unsupportedFutureEnvelope
      const persisted = this.readState()
      this.state = futureLegacyBlocked
        ? (() => {
            const state = createClientState()
            state.windows[state.activeWindowId]!.restoreEnabled = false
            return state
          })()
        : persisted.state
      this.persistenceSuppressed = new Set(this.state.windowOrder.filter((id) => !this.state.windows[id]!.restoreEnabled))
      this.unsupportedFutureEnvelope = futureLegacyBlocked || persisted.unsupportedFutureEnvelope
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

  get activeWindowId(): string {
    return this.state.activeWindowId
  }

  get windowIds(): string[] {
    return [...this.state.windowOrder]
  }

  setActiveWindow(windowId: string): Promise<boolean> {
    return this.mutateWindowListAndPersist((state) => {
      if (!isWindowId(windowId) || !Object.prototype.hasOwnProperty.call(state.windows, windowId)) {
        throw new Error("Unknown client state window")
      }
      if (state.activeWindowId === windowId) return true
      if (!this.isPrimary || this.unsupportedFutureEnvelope) return false
      state.activeWindowId = windowId
    })
  }

  loadClientState(windowId = this.activeWindowId): ClientStateLoadResult {
    const record = this.windowRecord(windowId)
    if (!this.isPrimary) {
      return { isPrimary: false, restoreEnabled: false, snapshot: null, partitionProtocolVersion: CLIENT_STATE_PARTITION_PROTOCOL_VERSION }
    }
    return {
      isPrimary: true,
      restoreEnabled: record.restoreEnabled,
      snapshot: record.restoreEnabled ? (record.snapshot ?? null) : null,
      partitionProtocolVersion: CLIENT_STATE_PARTITION_PROTOCOL_VERSION,
    }
  }

  loadClientStatePartition(key: unknown, rendererToken?: unknown, windowId = this.activeWindowId): Promise<string | null> {
    if (!isPartitionKey(key)) return Promise.reject(new TypeError("Invalid client state partition key"))
    this.windowRecord(windowId)
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      if (rendererToken !== undefined) this.assertRendererAccessToken(rendererToken, windowId)
      const record = this.windowRecord(windowId)
      if (!this.isPrimary || !record.restoreEnabled
        || record.partitionProtocolVersion !== CLIENT_STATE_PARTITION_PROTOCOL_VERSION
        || !record.partitionKeys?.includes(key)) return null
      return this.partitions.load(key, () => this.assertReplacementAllowed(rendererToken, windowId))
    })
    this.writeQueue = operation.then(() => {})
    return operation
  }

  getWindowState(windowId = this.activeWindowId): NativeWindowState | undefined {
    const record = this.windowRecord(windowId)
    return this.isPrimary && !this.unsupportedFutureEnvelope && record.restoreEnabled ? record.window : undefined
  }

  claimClientStateAccess(token: unknown, windowId = this.activeWindowId): true {
    this.windowRecord(windowId)
    this.validateRendererAccessTokenValue(token)
    const current = this.rendererAccessTokens.get(windowId)
    if (current === undefined) {
      this.rendererAccessTokens.set(windowId, token)
      return true
    }
    if (current !== token) {
      throw new Error("Client state access token does not match the claimed renderer")
    }
    return true
  }

  assertRendererAccessToken(token: unknown, windowId = this.activeWindowId): void {
    this.windowRecord(windowId)
    this.validateRendererAccessTokenValue(token)
    if (this.rendererAccessTokens.get(windowId) !== token) {
      throw new Error("Client state access has not been claimed by this renderer")
    }
  }

  resetRendererAccessToken(windowId = this.activeWindowId): void {
    this.windowRecord(windowId)
    this.rendererAccessTokens.delete(windowId)
  }

  saveClientState(snapshot: unknown, rendererToken?: unknown, windowId = this.activeWindowId): Promise<boolean> {
    const disposition = this.getMutationDisposition(windowId)
    if (disposition) return disposition

    const serialized = JSON.stringify(snapshot)
    if (serialized === undefined) {
      throw new TypeError("Client snapshot must be JSON-serializable")
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_CLIENT_SNAPSHOT_BYTES) {
      throw new RangeError("Client snapshot exceeds the 1 MiB limit")
    }

    const normalizedSnapshot = JSON.parse(serialized) as unknown
    return this.mutateAndPersist(windowId, (record) => {
      record.snapshot = normalizedSnapshot
      delete record.partitionProtocolVersion
      delete record.partitionKeys
    }, true, rendererToken, undefined,
    () => this.partitions.sweep(retainedPartitionKeys(this.state), () => this.assertReplacementAllowed(rendererToken, windowId)))
  }

  commitClientStatePartitions(payload: unknown, rendererToken?: unknown, windowId = this.activeWindowId): Promise<boolean> {
    const commit = validateClientStatePartitionCommit(payload)
    const disposition = this.getMutationDisposition(windowId)
    if (disposition) return disposition
    return this.mutateAndPersist(windowId, (record) => {
      record.snapshot = commit.snapshot
      record.partitionProtocolVersion = CLIENT_STATE_PARTITION_PROTOCOL_VERSION
      record.partitionKeys = commit.partitionKeys
    }, true, rendererToken,
    () => this.partitions.prepare(commit, () => this.assertReplacementAllowed(rendererToken, windowId)),
    () => this.partitions.sweep(retainedPartitionKeys(this.state), () => this.assertReplacementAllowed(rendererToken, windowId)))
  }

  setRestoreEnabled(enabled: boolean, rendererToken?: unknown, windowId = this.activeWindowId): Promise<boolean> {
    const disposition = this.getMutationDisposition(windowId, false)
    if (disposition) return disposition

    if (typeof enabled !== "boolean") {
      throw new TypeError("Restore enabled must be a boolean")
    }

    return this.mutateAndPersist(windowId, (record) => {
      record.restoreEnabled = enabled
      if (enabled) {
        this.persistenceSuppressed.delete(windowId)
      } else {
        delete record.snapshot
        delete record.window
        delete record.partitionProtocolVersion
        delete record.partitionKeys
        this.persistenceSuppressed.add(windowId)
      }
    }, false, rendererToken, undefined,
    enabled ? undefined : () => this.partitions.sweep(retainedPartitionKeys(this.state), () => this.assertReplacementAllowed(rendererToken, windowId)))
  }

  clearClientState(rendererToken?: unknown, windowId = this.activeWindowId): Promise<boolean> {
    this.windowRecord(windowId)
    if (!this.isPrimary) {
      return Promise.resolve(false)
    }
    if (this.frozen) {
      return Promise.reject(new Error("Client state persistence is frozen for shutdown"))
    }

    const clearingFutureEnvelope = this.unsupportedFutureEnvelope

    return this.mutateAndPersist(windowId, (record) => {
      delete record.snapshot
      delete record.window
      delete record.partitionProtocolVersion
      delete record.partitionKeys
      this.unsupportedFutureEnvelope = false
      if (clearingFutureEnvelope) this.persistenceSuppressed.delete(windowId)
      else this.persistenceSuppressed.add(windowId)
    }, false, rendererToken, undefined,
    () => this.partitions.sweep(retainedPartitionKeys(this.state), () => this.assertReplacementAllowed(rendererToken, windowId)))
  }

  saveWindowState(windowState: NativeWindowState, windowId = this.activeWindowId): Promise<boolean> {
    const disposition = this.getMutationDisposition(windowId)
    if (disposition) return disposition

    const normalized = normalizeNativeWindowState(windowState)
    if (!normalized) {
      return Promise.resolve(false)
    }
    return this.mutateAndPersist(windowId, (record) => {
      record.window = normalized
    }, true)
  }

  addWindow(windowId = randomUUID()): Promise<string | null> {
    return this.mutateWindowListAndPersist((state) => {
      if (!isWindowId(windowId)) throw new TypeError("Invalid client state window ID")
      if (state.windowOrder.length >= MAX_CLIENT_STATE_WINDOWS) throw new RangeError("Too many client state windows")
      if (state.windows[windowId]) throw new Error("Client state window already exists")
      if (!this.isPrimary || this.unsupportedFutureEnvelope) return false
      if (state.windowOrder.length === 0) state.activeWindowId = windowId
      state.windowOrder.push(windowId)
      state.windows[windowId] = { restoreEnabled: true }
    }).then((persisted) => persisted ? windowId : null)
  }

  removeWindow(windowId: string): Promise<boolean> {
    return this.mutateWindowListAndPersist((state) => {
      if (!isWindowId(windowId) || !Object.prototype.hasOwnProperty.call(state.windows, windowId)) {
        throw new Error("Unknown client state window")
      }
      if (!this.isPrimary || this.unsupportedFutureEnvelope) return false
      state.windowOrder = state.windowOrder.filter((id) => id !== windowId)
      delete state.windows[windowId]
      if (state.activeWindowId === windowId && state.windowOrder.length > 0) state.activeWindowId = state.windowOrder[0]!
    },
    () => this.partitions.sweep(retainedPartitionKeys(this.state), () => this.assertReplacementAllowed()))
      .then((removed) => {
        if (removed) {
          this.rendererAccessTokens.delete(windowId)
          this.persistenceSuppressed.delete(windowId)
        }
        return removed
      })
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  drainAndReleasePrimary(): Promise<void> {
    if (this.drainAndReleasePromise) {
      return this.drainAndReleasePromise
    }

    this.frozen = true
    // The primary locks stay held until the queued root publication and GC have both drained.
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
      if (hasErrorCode(error, "ENOENT")) {
        return {
          state: createClientState(),
          unsupportedFutureEnvelope: false,
        }
      }
      console.warn("[client-state] failed to read state", error)
      const state = createClientState()
      state.windows[state.activeWindowId]!.restoreEnabled = false
      return {
        state,
        unsupportedFutureEnvelope: true,
      }
    }
  }

  private migrateLegacyStateIfNeeded(
    paths: ReadonlyArray<readonly ["electron" | "tauri", string]>,
  ): void {
    try {
      readFileSync(this.statePath)
      return
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) return
    }
    if (paths.some(([, path]) => isFutureLegacyCandidate(path))) {
      this.unsupportedFutureEnvelope = true
      return
    }
    const winner = paths
      .map(([host, path]) => legacyCandidate(path, host))
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
      this.assertReplacementAllowed()
      renameSync(temporaryPath, this.statePath)
      this.syncStateDirectorySync()
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  private copyLegacySharedStateIfNeeded(legacyPath: string | null): void {
    if (!legacyPath) return
    try {
      readFileSync(this.statePath)
      return
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) return
    }

    let bytes: Buffer
    try {
      bytes = readFileSync(legacyPath)
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return
      throw error
    }
    try {
      const serialized = bytes.toString("utf8")
      const candidate = JSON.parse(serialized) as Record<string, unknown>
      if (candidate?.version !== CLIENT_STATE_MONOLITHIC_VERSION || parseClientState(serialized).unsupportedFutureEnvelope) return
    } catch {
      return
    }

    const temporaryPath = join(dirname(this.statePath), `.${CLIENT_STATE_FILENAME}.${this.owner.pid}.${this.owner.runToken}.shared-migration.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600)
      writeFileSync(descriptor, bytes)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      this.assertReplacementAllowed()
      try {
        linkSync(temporaryPath, this.statePath)
        this.syncStateDirectorySync()
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  private windowRecord(windowId: string): ClientWindowStateRecord {
    if (!isWindowId(windowId) || !Object.prototype.hasOwnProperty.call(this.state.windows, windowId)) {
      throw new Error("Unknown client state window")
    }
    return this.state.windows[windowId]!
  }

  private getMutationDisposition(windowId: string, futureEnvelopeResult = true): Promise<boolean> | undefined {
    this.windowRecord(windowId)
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
    windowId: string,
    mutate: (record: ClientWindowStateRecord, state: PersistedClientState) => void,
    skipWhenSuppressed = false,
    rendererToken?: unknown,
    prepare?: () => Promise<void>,
    committed?: () => Promise<void>,
  ): Promise<boolean> {
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      if (rendererToken !== undefined) this.assertRendererAccessToken(rendererToken, windowId)
      if (skipWhenSuppressed && this.persistenceSuppressed.has(windowId)) {
        return
      }

      const previousState = JSON.parse(JSON.stringify(this.state)) as PersistedClientState
      const previousPersistenceSuppressed = new Set(this.persistenceSuppressed)
      const previousUnsupportedFutureEnvelope = this.unsupportedFutureEnvelope
      try {
        await prepare?.()
        mutate(this.windowRecord(windowId), this.state)
        await this.writeAtomically(JSON.stringify(this.state), rendererToken, windowId)
      } catch (error) {
        this.state = previousState
        this.persistenceSuppressed = previousPersistenceSuppressed
        this.unsupportedFutureEnvelope = previousUnsupportedFutureEnvelope
        throw error
      }
      await committed?.().catch((error) => console.warn("[client-state] failed to sweep partitions", error))
    })
    this.writeQueue = operation
    return operation.then(() => true)
  }

  private mutateWindowListAndPersist(
    mutate: (state: PersistedClientState) => boolean | void,
    committed?: () => Promise<void>,
  ): Promise<boolean> {
    if (this.frozen) return Promise.reject(new Error("Client state persistence is frozen for shutdown"))
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      const previousState = JSON.parse(JSON.stringify(this.state)) as PersistedClientState
      try {
        const result = mutate(this.state)
        if (result !== undefined) return result
        await this.writeAtomically(JSON.stringify(this.state))
      } catch (error) {
        this.state = previousState
        throw error
      }
      await committed?.().catch((error) => console.warn("[client-state] failed to sweep partitions", error))
      return true
    })
    this.writeQueue = operation.then(() => {})
    return operation
  }

  private async writeAtomically(serializedState: string, rendererToken?: unknown, windowId = this.activeWindowId): Promise<void> {
    const temporaryPath = join(
      dirname(this.statePath),
      `.${CLIENT_STATE_FILENAME}.${this.owner.pid}.${this.owner.runToken}.tmp`,
    )
    try {
      await this.writeState(temporaryPath, serializedState)
      this.assertReplacementAllowed(rendererToken, windowId)
      await rename(temporaryPath, this.statePath)
      await syncDirectory(dirname(this.statePath))
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  }

  private syncStateDirectorySync(): void {
    let descriptor: number | undefined
    try {
      descriptor = openSync(dirname(this.statePath), "r")
      fsyncSync(descriptor)
    } catch (error) {
      if (process.platform === "win32" && (hasErrorCode(error, "EISDIR") || hasErrorCode(error, "EPERM") || hasErrorCode(error, "EINVAL"))) return
      throw error
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  private assertReplacementAllowed(rendererToken?: unknown, windowId = this.activeWindowId): void {
    if (rendererToken !== undefined) this.assertRendererAccessToken(rendererToken, windowId)
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
