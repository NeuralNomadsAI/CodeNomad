import path from "path"
import { spawnSync } from "child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import os from "node:os"
import type { Endpoint } from "@opencode-ai/client/service"
import type { LocationGetOutput, LocationRef, OpenCodeClient, OpenCodeEvent } from "@opencode-ai/client"
import { EventBus } from "../events/bus"
import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { Logger } from "../logger"
import { resolveWorkspaceIdentity } from "./workspace-identity"
import { buildServiceLaunchSpec, parseWslUncPath } from "./spawn"
import { OpenCodeSharedService, type OpenCodeEnsureOptions } from "./opencode-service"
import { resolveWorktreeSlugForDirectory } from "./worktree-directory"

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000
const ORDINARY_CREATION_OWNER = ""
const WORKSPACE_STATE = Symbol("workspaceState")
const SERVICE_STATE_ROOT = path.join(os.tmpdir(), "codenomad-opencode-v2")
const SERVICE_REGISTRATION_FILE = path.join(SERVICE_STATE_ROOT, "opencode", "service.json")
const SERVICE_CONTENDER_FILE = path.join(SERVICE_STATE_ROOT, `contenders-${process.pid}-${randomUUID()}.txt`)
type ManagerTimeout = ReturnType<typeof setTimeout>

interface SharedService {
  endpoint: (options?: OpenCodeEnsureOptions) => Promise<Endpoint>
  client: (options?: OpenCodeEnsureOptions) => Promise<OpenCodeClient>
  headers: (options?: OpenCodeEnsureOptions) => Promise<{ authorization: string } | undefined>
  validateLocation: (location: LocationRef, requestOptions?: { signal?: AbortSignal }, ensureOptions?: OpenCodeEnsureOptions) => Promise<LocationGetOutput>
  subscribe: (requestOptions?: { signal?: AbortSignal }, ensureOptions?: OpenCodeEnsureOptions) => Promise<AsyncIterable<OpenCodeEvent>>
  evict: (location: LocationRef, requestOptions?: { signal?: AbortSignal }, ensureOptions?: OpenCodeEnsureOptions) => Promise<void>
  shutdown: () => Promise<void>
}

export function binaryPathsEqual(left: string, right: string, platform = process.platform): boolean {
  const leftWsl = parseWslUncPath(left)
  const rightWsl = parseWslUncPath(right)
  if (leftWsl || rightWsl) {
    return Boolean(
      leftWsl
      && rightWsl
      && leftWsl.distro.toLowerCase() === rightWsl.distro.toLowerCase()
      && leftWsl.linuxPath === rightWsl.linuxPath,
    )
  }
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

interface WorkspaceManagerOptions {
  rootDir: string
  settings: SettingsService
  binaryResolver: BinaryResolver
  eventBus: EventBus
  logger: Logger
  getServerBaseUrl: () => string
  /** Optional CA bundle path to trust CodeNomad HTTPS certs. */
  nodeExtraCaCertsPath?: string
  sharedService?: SharedService
  shutdownTimeoutMs?: number
  launchSettlementTimeoutMs?: number
  launchTimeoutMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => ManagerTimeout
  clearTimeout?: (timer: ManagerTimeout) => void
}

interface WorkspaceRecord extends WorkspaceDescriptor {
  identityKey: string
  location?: LocationRef
  ownership: WorkspaceCreationOwnership
  [WORKSPACE_STATE]: WorkspaceState
}

interface WorkspaceState {
  abortController: AbortController
  creation?: Promise<WorkspaceCreateResult>
  settlement?: Promise<void>
  deletePromise?: Promise<WorkspaceDescriptor | undefined>
  published: boolean
  stoppedPublished: boolean
}
export class WorkspaceLaunchCancelledError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} launch was cancelled`)
    this.name = "WorkspaceLaunchCancelledError"
  }
}
export class WorkspaceLaunchTimeoutError extends Error {
  readonly code = "WORKSPACE_LAUNCH_TIMEOUT"
  readonly retryable = true
  constructor(workspaceId: string | undefined, timeoutMs: number) {
    super(`${workspaceId ? `Workspace ${workspaceId}` : "Workspace"} did not finish launching within ${timeoutMs}ms`)
    this.name = "WorkspaceLaunchTimeoutError"
  }
}
export class WorkspaceCleanupTimeoutError extends Error {
  readonly code = "WORKSPACE_CLEANUP_TIMEOUT"
  readonly retryable = true
  constructor(operation: string, timeoutMs: number) {
    super(`Workspace ${operation} did not finish within ${timeoutMs}ms; cleanup can be retried`)
    this.name = "WorkspaceCleanupTimeoutError"
  }
}
export class WorkspaceShutdownError extends AggregateError {
  readonly code = "WORKSPACE_SHUTDOWN_FAILED"
  readonly retryable = true
  constructor(errors: unknown[]) {
    super(errors, `Failed to stop ${errors.length} workspace${errors.length === 1 ? "" : "s"} during shutdown; cleanup can be retried`)
    this.name = "WorkspaceShutdownError"
  }
}
export interface WorkspaceCreateResult {
  workspace: WorkspaceDescriptor
  created: boolean
}
export interface WorkspaceCreateOptions {
  requestId?: string
  forceNew?: boolean
}
type CreationRequestState = "active" | "cancelled" | "released"
type WorkspaceCreationOwnership = Map<string, CreationRequestState>
export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly pendingWorkspaceCreations = new Map<string, WorkspaceRecord>()
  private readonly deletingWorktreeRoots = new Set<string>()
  private readonly cancelledCreationRequests = new Set<string>()
  private shuttingDown = false
  private readonly sharedService: SharedService
  private serviceEndpoint?: Endpoint
  private serviceAuthorization?: string

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.sharedService = options.sharedService ?? new OpenCodeSharedService()
  }
  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
      .filter((record) => record[WORKSPACE_STATE].published)
  }

  get(id: string): WorkspaceDescriptor | undefined {
    const record = this.workspaces.get(id)
    return record?.[WORKSPACE_STATE].published ? record : undefined
  }

  getInstanceAuthorizationHeader(id: string): string | undefined {
    return this.workspaces.get(id)?.[WORKSPACE_STATE].published ? this.serviceAuthorization : undefined
  }

  async getSharedServiceEndpoint(id: string): Promise<Endpoint | undefined> {
    if (!this.workspaces.get(id)?.[WORKSPACE_STATE].published) return undefined
    try {
      const [endpoint, headers] = await Promise.all([this.sharedService.endpoint(), this.sharedService.headers()])
      this.serviceEndpoint = endpoint
      this.serviceAuthorization = headers?.authorization
      return endpoint
    } catch (error) {
      this.options.logger.warn({ err: error }, "Shared OpenCode service is unavailable")
      return undefined
    }
  }

  getSharedServiceClient(): Promise<OpenCodeClient> {
    return this.sharedService.client()
  }

  async reserveWorktreeDeletion(directory: string): Promise<() => void> {
    const target = (await resolveWorkspaceIdentity(directory, this.options.rootDir)).workspacePath
    if (Array.from(this.deletingWorktreeRoots).some((root) => pathsOverlap(root, target))) {
      throw new Error("Worktree deletion is already in progress")
    }
    if (Array.from(this.workspaces.values()).some((workspace) => pathContains(target, workspace.path))) {
      throw new Error("Worktree is open as another workspace")
    }
    this.deletingWorktreeRoots.add(target)
    return () => this.deletingWorktreeRoots.delete(target)
  }

  async ownsDirectory(id: string, directory: string): Promise<boolean> {
    const workspace = this.get(id)
    if (!workspace) return false
    return (await resolveWorktreeSlugForDirectory({
      workspaceId: id,
      workspacePath: workspace.path,
      directory,
      logger: this.options.logger,
    })) !== null
  }

  subscribeToSharedService(signal?: AbortSignal): Promise<AsyncIterable<OpenCodeEvent>> {
    return this.sharedService.subscribe({ signal })
  }

  findReadyInstanceIdByBinary(binaryPath: string): string | undefined {
    const resolvedPath = this.resolveBinaryPath(binaryPath)
    return this.list().find((workspace) => {
      return workspace.status === "ready" && binaryPathsEqual(workspace.binaryId, resolvedPath)
    })?.id
  }

  private findReadyWorkspaceByIdentity(
    identityKey: string,
    includeRestoreOwned: boolean,
  ): WorkspaceDescriptor | undefined {
    for (const record of this.workspaces.values()) {
      const state = record[WORKSPACE_STATE]
      if (
        state.published
        && !state.abortController.signal.aborted
        && (includeRestoreOwned || !record.requestId)
        && record.status === "ready"
        && record.identityKey === identityKey
      ) {
        return record
      }
    }
    return undefined
  }

  listFiles(workspaceId: string, relativePath = "."): FileSystemEntry[] {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    return browser.list(relativePath)
  }

  searchFiles(workspaceId: string, query: string, options?: WorkspaceFileSearchOptions): FileSystemEntry[] {
    const workspace = this.requireWorkspace(workspaceId)
    return searchWorkspaceFiles(workspace.path, query, options)
  }

  readFile(workspaceId: string, relativePath: string, options?: { encoding?: "utf-8" | "base64" }): WorkspaceFileResponse {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    const encoding = options?.encoding ?? "utf-8"
    const contents = encoding === "base64" ? browser.readFileBase64(relativePath) : browser.readFile(relativePath)
    return {
      workspaceId,
      relativePath,
      contents,
      encoding,
    }
  }

  readFileInDirectory(workspaceId: string, directory: string, relativePath: string, options?: { encoding?: "utf-8" | "base64" }): WorkspaceFileResponse {
    this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: directory })
    const encoding = options?.encoding ?? "utf-8"
    const contents = encoding === "base64" ? browser.readFileBase64(relativePath) : browser.readFile(relativePath)
    return {
      workspaceId,
      relativePath,
      contents,
      encoding,
    }
  }

  writeFile(workspaceId: string, relativePath: string, contents: string): void {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    browser.writeFile(relativePath, contents)
  }

  writeFileInDirectory(workspaceId: string, directory: string, relativePath: string, contents: string): void {
    this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: directory })
    browser.writeFile(relativePath, contents)
  }

  async create(
    folder: string,
    name?: string,
    options: WorkspaceCreateOptions = {},
  ): Promise<WorkspaceCreateResult> {
    const launchTimeoutMs = Math.max(1, this.options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS)
    const launchDeadlineAt = Date.now() + launchTimeoutMs
    try {
      const { workspacePath, identityKey } = await this.withLaunchDeadline(
        resolveWorkspaceIdentity(folder, this.options.rootDir),
        undefined,
        launchDeadlineAt,
        launchTimeoutMs,
      )
      if (Array.from(this.deletingWorktreeRoots).some((root) => pathContains(root, workspacePath))) {
        throw new Error("Workspace directory is being removed")
      }
      if (options.requestId && this.cancelledCreationRequests.has(options.requestId)) {
        throw new Error(`Workspace creation request ${options.requestId} was cancelled`)
      }
      if (this.shuttingDown) {
        throw new Error("Workspace manager is shutting down")
      }
      if (options.forceNew) {
        const ownership = this.createOwnership(options.requestId)
        const record = this.reserveWorkspace(workspacePath, identityKey, name, options, ownership, launchDeadlineAt)
        const result = await this.startCreation(record, options, launchDeadlineAt, launchTimeoutMs)
        return this.finishCreation(result, options.requestId, ownership)
      }
      const existing = this.findReadyWorkspaceByIdentity(identityKey, Boolean(options.requestId))
      if (existing) {
        this.options.logger.info({ workspaceId: existing.id, folder: workspacePath }, "Reusing existing workspace")
        const record = this.workspaces.get(existing.id)
        if (options.requestId && record) {
          if (!record.ownership.has(options.requestId)) record.ownership.set(options.requestId, "active")
          this.syncOwnership(record)
          return this.finishCreation({ workspace: existing, created: false }, options.requestId, record.ownership)
        }
        return { workspace: existing, created: false }
      }
      const pending = this.pendingWorkspaceCreations.get(identityKey)
      if (pending) {
        const state = pending[WORKSPACE_STATE]
        const owner = options.requestId ?? ORDINARY_CREATION_OWNER
        if (!pending.ownership.has(owner)) pending.ownership.set(owner, "active")
        this.syncOwnership(pending)
        const result = await state.creation!
        return this.finishCreation({ workspace: result.workspace, created: false }, options.requestId, pending.ownership)
      }
      const ownership = this.createOwnership(options.requestId)
      const record = this.reserveWorkspace(workspacePath, identityKey, name, options, ownership, launchDeadlineAt)
      const creation = this.startCreation(record, options, launchDeadlineAt, launchTimeoutMs)
      this.pendingWorkspaceCreations.set(identityKey, record)
      try {
        return this.finishCreation(await creation, options.requestId, ownership)
      } finally {
        if (this.pendingWorkspaceCreations.get(identityKey) === record) {
          this.pendingWorkspaceCreations.delete(identityKey)
        }
      }
    } finally {
      if (options.requestId) this.cancelledCreationRequests.delete(options.requestId)
    }
  }
  private reserveWorkspace(
    workspacePath: string,
    identityKey: string,
    name: string | undefined,
    options: WorkspaceCreateOptions,
    ownership: WorkspaceCreationOwnership,
    launchDeadlineAt: number,
  ): WorkspaceRecord {
    const id = randomUUID()
    const binary = this.options.binaryResolver.resolveDefault()
    const resolvedBinaryPath = this.resolveBinaryPath(binary.path, Math.max(1, launchDeadlineAt - Date.now()))
    clearWorkspaceSearchCache(workspacePath)

    this.options.logger.info({ workspaceId: id, folder: workspacePath, binary: resolvedBinaryPath }, "Creating workspace")

    const proxyPath = `/workspaces/${id}/instance`


    const record = {
      id,
      requestId: options.requestId,
      path: workspacePath,
      name,
      status: "starting",
      proxyPath,
      binaryId: resolvedBinaryPath,
      binaryLabel: binary.label,
      binaryVersion: binary.version,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as WorkspaceRecord
    Object.defineProperties(record, {
      identityKey: { value: identityKey },
      ownership: { value: ownership },
      [WORKSPACE_STATE]: { value: { abortController: new AbortController(), published: false, stoppedPublished: false } },
    })

    this.workspaces.set(id, record)
    if (options.requestId && this.cancelledCreationRequests.has(options.requestId)) {
      record[WORKSPACE_STATE].abortController.abort(new WorkspaceLaunchCancelledError(id))
    }
    return record
  }
  private startCreation(record: WorkspaceRecord, options: WorkspaceCreateOptions,
    launchDeadlineAt: number, launchTimeoutMs: number): Promise<WorkspaceCreateResult> {
    const creation = this.createWithDeadline(record, options, launchDeadlineAt, launchTimeoutMs)
    record[WORKSPACE_STATE].creation = creation
    record[WORKSPACE_STATE].settlement = creation.then(() => undefined, () => undefined)
    return creation
  }
  private async createWithDeadline(record: WorkspaceRecord, options: WorkspaceCreateOptions,
    launchDeadlineAt: number, launchTimeoutMs: number): Promise<WorkspaceCreateResult> {
    const timeoutMs = Math.max(1, launchDeadlineAt - Date.now())
    const state = record[WORKSPACE_STATE]
    let timeout: ManagerTimeout | null = (this.options.setTimeout ?? setTimeout)(() => {
      timeout = null
      if (!state.abortController.signal.aborted) {
        state.abortController.abort(new WorkspaceLaunchTimeoutError(record.id, launchTimeoutMs))
      }
    }, timeoutMs)
    try {
      return await this.createResolvedWorkspace(record)
    } finally {
      if (timeout) (this.options.clearTimeout ?? clearTimeout)(timeout)
    }
  }

  private async withLaunchDeadline<T>(operation: Promise<T>, workspaceId: string | undefined,
    deadlineAt: number, launchTimeoutMs: number): Promise<T> {
    const timeoutMs = Math.max(1, deadlineAt - Date.now())
    let timeout: ManagerTimeout | null = null
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = (this.options.setTimeout ?? setTimeout)(() => {
        timeout = null
        reject(new WorkspaceLaunchTimeoutError(workspaceId, launchTimeoutMs))
      }, timeoutMs)
    })
    try {
      return await Promise.race([operation, deadline])
    } finally {
      if (timeout) (this.options.clearTimeout ?? clearTimeout)(timeout)
    }
  }
  private async createResolvedWorkspace(
    record: WorkspaceRecord,
  ): Promise<WorkspaceCreateResult> {
    const state = record[WORKSPACE_STATE]
    const { id, path: workspacePath, binaryId: resolvedBinaryPath } = record
    const serverConfig = this.options.settings.getOwner("config", "server")
    const configuredEnvironment = this.readConfiguredEnvironment(serverConfig)
    if (this.options.nodeExtraCaCertsPath) configuredEnvironment.NODE_EXTRA_CA_CERTS = this.options.nodeExtraCaCertsPath
    configuredEnvironment.XDG_STATE_HOME = SERVICE_STATE_ROOT
    configuredEnvironment.CODENOMAD_SERVICE_CONTENDERS = SERVICE_CONTENDER_FILE
    mkdirSync(SERVICE_STATE_ROOT, { recursive: true })
    const launch = buildServiceLaunchSpec(resolvedBinaryPath, ["serve", "--service"], {
      env: { ...process.env, ...configuredEnvironment },
      propagateEnvKeys: Object.keys(configuredEnvironment),
      contenderFile: SERVICE_CONTENDER_FILE,
    })
    const ensureOptions: OpenCodeEnsureOptions = {
      file: SERVICE_REGISTRATION_FILE,
      command: launch.command,
      environment: {
        ...configuredEnvironment,
        ...(launch.env?.WSLENV ? { WSLENV: launch.env.WSLENV } : {}),
      },
    }
    try {
      this.throwIfCancelled(record)
      record.location = { directory: workspacePath }
      const [endpoint, headers, location] = await Promise.all([
        this.sharedService.endpoint(ensureOptions),
        this.sharedService.headers(ensureOptions),
        this.sharedService.validateLocation(
          { directory: workspacePath },
          { signal: state.abortController.signal },
          ensureOptions,
        ),
      ])
      this.serviceEndpoint = endpoint
      this.serviceAuthorization = headers?.authorization
      record.location = { directory: location.directory, workspaceID: location.workspaceID }
      this.throwIfCancelled(record)
      state.published = true
      this.options.eventBus.publish({ type: "workspace.created", workspace: record })
      this.throwIfCancelled(record)

      record.status = "ready"
      record.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.started", workspace: record })
      this.options.logger.info({ workspaceId: id, location: record.location }, "Workspace ready")
      return { workspace: record, created: true }
    } catch (error) {
      const launchFailure = state.abortController.signal.aborted ? state.abortController.signal.reason : error
      if (!state.deletePromise) {
        await this.evictLocationIfUnused(record).catch((cleanupError) => {
          this.options.logger.warn({ workspaceId: id, err: cleanupError }, "Failed to evict rejected workspace location")
        })
        this.removeRecord(id, record, state.published)
      }
      this.options.logger.error({ workspaceId: id, err: launchFailure }, "Workspace failed to start")
      throw launchFailure
    }
  }

  delete(id: string): Promise<WorkspaceDescriptor | undefined> {
    const record = this.workspaces.get(id)
    if (!record) return Promise.resolve(undefined)
    const state = record[WORKSPACE_STATE]
    if (!state.abortController.signal.aborted) {
      state.abortController.abort(new WorkspaceLaunchCancelledError(id))
    }
    const pending = this.pendingWorkspaceCreations.get(record.identityKey)
    if (pending === record) {
      this.pendingWorkspaceCreations.delete(record.identityKey)
    }
    if (!state.deletePromise) {
      let deletePromise!: Promise<WorkspaceDescriptor | undefined>
      deletePromise = this.cleanupDeletedWorkspace(id, record).catch((error) => {
        if (state.deletePromise === deletePromise) state.deletePromise = undefined
        throw error
      })
      state.deletePromise = deletePromise
    }
    return state.deletePromise
  }

  releaseCreationRequest(id: string, requestId: string): boolean {
    const record = this.workspaces.get(id)
    if (!record?.[WORKSPACE_STATE].published) return false
    const ownership = record.ownership
    const state = ownership.get(requestId)
    if (state === "released") return true
    if (state === "cancelled") return false
    if (state !== "active") return false
    ownership.set(requestId, "released")
    this.syncOwnership(record)
    return true
  }

  async cancelCreationRequest(requestId: string): Promise<void> {
    let matched = false
    for (const [workspaceId, record] of this.workspaces) {
      const ownership = record.ownership
      const state = ownership.get(requestId)
      if (state === "released") { matched = true; continue }
      if (state === "cancelled") {
        matched = true
        if (this.hasActiveRequest(ownership) || this.isRetained(ownership)) continue
        await this.delete(workspaceId)
        return
      }
      if (state !== "active") continue
      matched = true
      ownership.set(requestId, "cancelled")
      this.syncOwnership(record)
      if (this.hasActiveRequest(ownership) || this.isRetained(ownership)) return
      await this.delete(workspaceId)
      return
    }
    if (!matched) this.cancelledCreationRequests.add(requestId)
  }

  private createOwnership(requestId?: string): WorkspaceCreationOwnership {
    return new Map([[requestId ?? ORDINARY_CREATION_OWNER, "active"]])
  }

  private finishCreation(
    result: WorkspaceCreateResult,
    requestId: string | undefined,
    ownership: WorkspaceCreationOwnership,
  ): WorkspaceCreateResult {
    if (requestId && ownership.get(requestId) === "cancelled") {
      throw new Error(`Workspace creation request ${requestId} was cancelled`)
    }
    const retained = this.isRetained(ownership)
    return {
      workspace: requestId ? { ...result.workspace, requestId } : result.workspace,
      created: result.created && !(requestId && retained),
    }
  }

  private syncOwnership(record: WorkspaceRecord | undefined): void {
    if (!record) return
    const ownership = record.ownership
    record.requestId = this.isRetained(ownership)
      ? undefined
      : Array.from(ownership).find(([, state]) => state === "active")?.[0]
  }

  private isRetained(ownership: WorkspaceCreationOwnership): boolean {
    return ownership.has(ORDINARY_CREATION_OWNER) || Array.from(ownership.values()).includes("released")
  }

  private hasActiveRequest(ownership: WorkspaceCreationOwnership): boolean {
    return Array.from(ownership).some(([requestId, state]) => Boolean(requestId) && state === "active")
  }

  async shutdown() {
    this.shuttingDown = true
    this.options.logger.info("Shutting down all workspaces")
    const stopTasks = Array.from(this.workspaces.keys(), (id) => this.delete(id))
    const results = stopTasks.length
      ? await this.withTimeout(Promise.allSettled(stopTasks), this.options.shutdownTimeoutMs ?? 10000, "shutdown")
      : []
    const stopFailures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (this.workspaces.size === 0) {
      this.pendingWorkspaceCreations.clear()
      this.cancelledCreationRequests.clear()
      await this.sharedService.shutdown().catch((error) => stopFailures.push(error))
    } else if (!stopFailures.length) stopFailures.push(
      new Error(`Workspace cleanup remains incomplete for: ${Array.from(this.workspaces.keys()).join(", ")}`),
    )
    if (stopFailures.length) throw new WorkspaceShutdownError(stopFailures)
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeout: ManagerTimeout | null = null
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = (this.options.setTimeout ?? setTimeout)(() => {
        timeout = null
        reject(new WorkspaceCleanupTimeoutError(label, timeoutMs))
      }, timeoutMs)
    })

    try {
      return await Promise.race([operation, deadline])
    } finally {
      if (timeout) (this.options.clearTimeout ?? clearTimeout)(timeout)
    }
  }

  private requireWorkspace(id: string): WorkspaceDescriptor {
    const record = this.workspaces.get(id)
    if (!record?.[WORKSPACE_STATE].published) throw new Error("Workspace not found")
    return record
  }

  private throwIfCancelled(record: WorkspaceRecord): void {
    record[WORKSPACE_STATE].abortController.signal.throwIfAborted()
  }

  private async cleanupDeletedWorkspace(id: string, record: WorkspaceRecord): Promise<WorkspaceDescriptor> {
    await this.withTimeout(record[WORKSPACE_STATE].settlement!, this.options.launchSettlementTimeoutMs ?? 5000, `${id} launch cancellation`)
    await this.evictLocationIfUnused(record)
    this.removeRecord(id, record, true)
    return record
  }

  private async evictLocationIfUnused(record: WorkspaceRecord): Promise<void> {
    if (!record.location) return
    const peers = Array.from(this.workspaces.values()).filter((candidate) => {
      return candidate !== record && candidate.identityKey === record.identityKey
    })
    if (peers.some((candidate) => !candidate[WORKSPACE_STATE].deletePromise)) return
    if (peers.some((candidate) => candidate.id < record.id)) return
    await this.sharedService.evict(record.location)
  }

  private removeRecord(id: string, record: WorkspaceRecord, publishStopped: boolean): void {
    if (this.workspaces.get(id) !== record) return
    this.workspaces.delete(id)
    clearWorkspaceSearchCache(record.path)
    if (publishStopped) this.publishStopped(record, "deleted")
  }

  private publishStopped(record: WorkspaceRecord, reason: "deleted" | "stopped" = "stopped"): void {
    const state = record[WORKSPACE_STATE]
    if (!state.published || state.stoppedPublished) return
    state.stoppedPublished = true
    record.status = "stopped"
    record.error = undefined
    this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: record.id, reason })
  }

  private readConfiguredEnvironment(serverConfig: unknown): NodeJS.ProcessEnv {
    if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) return {}
    const environment = (serverConfig as { environmentVariables?: unknown }).environmentVariables
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) return {}
    return Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
  }

  resolveBinaryPath(identifier: string, timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS): string {
    if (!identifier) {
      return identifier
    }

    const looksLikePath = identifier.includes("/") || identifier.includes("\\") || identifier.startsWith(".")
    if (path.isAbsolute(identifier) || looksLikePath) {
      return identifier
    }

    const locator = process.platform === "win32" ? "where" : "which"

    try {
      const result = spawnSync(locator, [identifier], { encoding: "utf8", timeout: Math.max(1, timeoutMs) })
      if (result.status === 0 && result.stdout) {
        const candidates = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .filter((line) => !/^INFO:/i.test(line))

        if (candidates.length > 0) {
          const resolved = this.pickBinaryCandidate(candidates)
          this.options.logger.debug({ identifier, resolved, candidates }, "Resolved binary path from system PATH")
          return resolved
        }
      } else if (result.error) {
        this.options.logger.warn({ identifier, err: result.error }, "Failed to resolve binary path via locator command")
      }
    } catch (error) {
      this.options.logger.warn({ identifier, err: error }, "Failed to resolve binary path from system PATH")
    }

    return identifier
  }

  private pickBinaryCandidate(candidates: string[]): string {
    if (process.platform !== "win32") {
      return candidates[0] ?? ""
    }

    const extensionPreference = [".exe", ".cmd", ".bat", ".ps1"]

    for (const ext of extensionPreference) {
      const match = candidates.find((candidate) => candidate.toLowerCase().endsWith(ext))
      if (match) {
        return match
      }
    }

    return candidates[0] ?? ""
  }
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left)
}
