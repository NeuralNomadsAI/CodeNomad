import path from "path"
import { spawnSync } from "child_process"
import { randomUUID } from "node:crypto"
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
import { resolveWorkspacePath } from "./workspace-identity"
import {
  buildServiceLaunchSpec,
  parseWslUncPath,
  resolveWslHostDirectory,
  resolveWslServiceDirectory,
  type ServiceLaunchSpec,
} from "./spawn"
import {
  HostOpenCodeService,
  hostOpenCodeServiceIdentity,
  startupEnvironmentHash,
} from "./host-opencode-service"
import {
  OpenCodeSharedService,
  type OpenCodeServiceLifecycle,
  type OpenCodeSharedServiceOptions,
} from "./opencode-service"
import { WslOpenCodeService } from "./wsl-opencode-service"
import { isPathOwnedByWorktree, resolveWorktreeSlugForDirectory } from "./worktree-directory"

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000
const WORKSPACE_STATE = Symbol("workspaceState")
type ManagerTimeout = number | NodeJS.Timeout

interface SharedService {
  endpoint: (options?: OpenCodeSharedServiceOptions) => Promise<Endpoint>
  client: (options?: OpenCodeSharedServiceOptions) => Promise<OpenCodeClient>
  headers: (options?: OpenCodeSharedServiceOptions) => Promise<{ authorization: string } | undefined>
  validateLocation: (location: LocationRef, requestOptions?: { signal?: AbortSignal }, serviceOptions?: OpenCodeSharedServiceOptions) => Promise<LocationGetOutput>
  evictLocation: (location: LocationRef, requestOptions?: { signal?: AbortSignal }, serviceOptions?: OpenCodeSharedServiceOptions) => Promise<void>
  subscribe: (requestOptions?: { signal?: AbortSignal }, serviceOptions?: OpenCodeSharedServiceOptions) => Promise<AsyncIterable<OpenCodeEvent>>
  shutdown: (options?: { timeoutMs?: number }) => Promise<void>
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
  sharedService?: SharedService
  shutdownTimeoutMs?: number
  launchSettlementTimeoutMs?: number
  launchTimeoutMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => ManagerTimeout
  clearTimeout?: (timer: ManagerTimeout) => void
  platform?: NodeJS.Platform
  wslServiceDirectoryResolver?: (directory: string, distro: string, timeoutMs: number) => string | null
  wslHostDirectoryResolver?: (directory: string, distro: string, timeoutMs: number) => string | null
  wslServiceLifecycleFactory?: (
    spec: Extract<ServiceLaunchSpec, { kind: "wsl" }>,
    timeoutMs: number,
    startupEnvironment: NodeJS.ProcessEnv,
  ) => OpenCodeServiceLifecycle
  hostServiceLifecycleFactory?: (
    spec: Extract<ServiceLaunchSpec, { kind: "host" }>,
    timeoutMs: number,
    startupEnvironment: NodeJS.ProcessEnv,
  ) => OpenCodeServiceLifecycle
}

interface WorkspaceRecord extends WorkspaceDescriptor {
  location?: LocationRef
  wslDistro?: string
  [WORKSPACE_STATE]: WorkspaceState
}

interface WorkspaceState {
  abortController: AbortController
  creation?: Promise<WorkspaceCreateResult>
  settlement?: Promise<void>
  deletePromise?: Promise<WorkspaceDescriptor | undefined>
  published: boolean
  stoppedPublished: boolean
  locationOwned: boolean
  creationRequestId?: string
  creationRequestState?: CreationRequestState
  serviceOptions?: OpenCodeSharedServiceOptions
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
}
type CreationRequestState = "active" | "cancelled" | "released"
export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly cancelledCreationRequests = new Set<string>()
  private shuttingDown = false
  private readonly sharedService: SharedService
  private serviceAuthorization?: string
  private warnedLegacyServiceEnvironment = false

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

  getServiceDirectory(id: string): string | undefined {
    const record = this.workspaces.get(id)
    return record?.[WORKSPACE_STATE].published ? record.location?.directory ?? record.path : undefined
  }

  async getSharedServiceEndpoint(id: string): Promise<Endpoint | undefined> {
    if (!this.workspaces.get(id)?.[WORKSPACE_STATE].published) return undefined
    try {
      const [endpoint, headers] = await Promise.all([this.sharedService.endpoint(), this.sharedService.headers()])
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

  async ownsDirectory(id: string, directory: string): Promise<boolean> {
    const record = this.workspaces.get(id)
    if (!record?.[WORKSPACE_STATE].published) return false
    if (directory === record.path || directory === record.location?.directory) return true
    if (await this.ownsHostDirectory(record, directory)) return true
    if (!record.wslDistro) return false
    const hostDirectory = this.resolveWslHostDirectory(directory, record.wslDistro, DEFAULT_LAUNCH_TIMEOUT_MS)
    return Boolean(hostDirectory && await this.ownsHostDirectory(record, hostDirectory))
  }

  async getServiceDirectoryForPath(id: string, directory: string): Promise<string | undefined> {
    const record = this.workspaces.get(id)
    if (!record?.[WORKSPACE_STATE].published || !await this.ownsDirectory(id, directory)) return undefined
    if (!record.wslDistro) return directory
    return this.resolveWslServiceDirectory(directory, record.wslDistro, DEFAULT_LAUNCH_TIMEOUT_MS)
      ?? (path.posix.isAbsolute(directory) ? directory : undefined)
  }

  async getServicePathForPath(id: string, candidate: string): Promise<string | undefined> {
    const record = this.workspaces.get(id)
    if (!record?.[WORKSPACE_STATE].published || !await this.ownsPath(id, candidate)) return undefined
    if (!record.wslDistro) return candidate
    return this.resolveWslServiceDirectory(candidate, record.wslDistro, DEFAULT_LAUNCH_TIMEOUT_MS)
      ?? (path.posix.isAbsolute(candidate) ? candidate : undefined)
  }

  private async ownsHostDirectory(record: WorkspaceRecord, directory: string): Promise<boolean> {
    return (await resolveWorktreeSlugForDirectory({
      workspaceId: record.id,
      workspacePath: record.path,
      directory,
      logger: this.options.logger,
    })) !== null
  }

  async ownsPath(id: string, candidate: string): Promise<boolean> {
    const record = this.workspaces.get(id)
    if (!record?.[WORKSPACE_STATE].published) return false
    if (await this.ownsHostPath(record, candidate)) return true
    if (!record.wslDistro) return false
    const hostPath = this.resolveWslHostDirectory(candidate, record.wslDistro, DEFAULT_LAUNCH_TIMEOUT_MS)
    return Boolean(hostPath && await this.ownsHostPath(record, hostPath))
  }

  private ownsHostPath(record: WorkspaceRecord, candidate: string): Promise<boolean> {
    return isPathOwnedByWorktree({
      workspaceId: record.id,
      workspacePath: record.path,
      candidate,
      logger: this.options.logger,
    })
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
      const workspacePath = await this.withLaunchDeadline(
        resolveWorkspacePath(folder, this.options.rootDir),
        undefined,
        launchDeadlineAt,
        launchTimeoutMs,
      )
      if (options.requestId && this.cancelledCreationRequests.has(options.requestId)) {
        throw new Error(`Workspace creation request ${options.requestId} was cancelled`)
      }
      if (this.shuttingDown) {
        throw new Error("Workspace manager is shutting down")
      }
      const record = this.reserveWorkspace(workspacePath, name, options, launchDeadlineAt)
      const creation = this.startCreation(record, options, launchDeadlineAt, launchTimeoutMs)
      return this.finishCreation(await creation, options.requestId, record)
    } finally {
      if (options.requestId) this.cancelledCreationRequests.delete(options.requestId)
    }
  }
  private reserveWorkspace(
    workspacePath: string,
    name: string | undefined,
    options: WorkspaceCreateOptions,
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
      wslDistro: { value: undefined, writable: true },
      [WORKSPACE_STATE]: { value: {
        abortController: new AbortController(),
        published: false,
        stoppedPublished: false,
        locationOwned: false,
        creationRequestId: options.requestId,
        creationRequestState: options.requestId ? "active" : undefined,
      } },
    })

    this.workspaces.set(id, record)
    if (options.requestId && this.cancelledCreationRequests.has(options.requestId)) {
      record[WORKSPACE_STATE].abortController.abort(new WorkspaceLaunchCancelledError(id))
    }
    return record
  }
  private startCreation(record: WorkspaceRecord, options: WorkspaceCreateOptions,
    launchDeadlineAt: number, launchTimeoutMs: number): Promise<WorkspaceCreateResult> {
    const launch = this.createResolvedWorkspace(record, Math.max(1, launchDeadlineAt - Date.now()))
    const creation = this.createWithDeadline(record, options, launchDeadlineAt, launchTimeoutMs, launch)
    record[WORKSPACE_STATE].creation = creation
    record[WORKSPACE_STATE].settlement = launch.then(() => undefined, () => undefined)
    return creation
  }
  private async createWithDeadline(record: WorkspaceRecord, options: WorkspaceCreateOptions,
    launchDeadlineAt: number, launchTimeoutMs: number,
    launch: Promise<WorkspaceCreateResult>): Promise<WorkspaceCreateResult> {
    const timeoutMs = Math.max(1, launchDeadlineAt - Date.now())
    const state = record[WORKSPACE_STATE]
    let timeout: ManagerTimeout | null = (this.options.setTimeout ?? setTimeout)(() => {
      timeout = null
      if (!state.abortController.signal.aborted) {
        state.abortController.abort(new WorkspaceLaunchTimeoutError(record.id, launchTimeoutMs))
      }
    }, timeoutMs)
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        state.abortController.signal.addEventListener("abort", () => reject(state.abortController.signal.reason), { once: true })
      })
      return await Promise.race([launch, deadline])
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
    timeoutMs: number,
  ): Promise<WorkspaceCreateResult> {
    const state = record[WORKSPACE_STATE]
    const { id, path: workspacePath, binaryId: resolvedBinaryPath } = record
    try {
      const launch = buildServiceLaunchSpec(resolvedBinaryPath, {
        platform: this.options.platform,
      })
      const startupEnvironment = this.serviceStartupEnvironment()
      const serviceOptions: OpenCodeSharedServiceOptions = {
        kind: "lifecycle",
        identity: launch.kind === "host"
          ? hostOpenCodeServiceIdentity({
              binary: launch.binary,
              platform: launch.platform,
              startupEnvironment,
            })
          : `wsl:${launch.distro.trim().toLowerCase()}:${path.posix.normalize(launch.binary)}`
            + `:env:${startupEnvironmentHash(startupEnvironment, "linux")}`,
        lifecycle: launch.kind === "host"
          ? this.createHostServiceLifecycle(launch, timeoutMs, startupEnvironment)
          : this.createWslServiceLifecycle(launch, timeoutMs, startupEnvironment),
      }
      state.serviceOptions = serviceOptions
      this.throwIfCancelled(record)
      record.wslDistro = launch.kind === "wsl" ? launch.distro : undefined
      const serviceDirectory = launch.kind === "wsl"
        ? this.requireWslServiceDirectory(workspacePath, launch.distro, timeoutMs)
        : workspacePath
      record.location = { directory: serviceDirectory }
      const [headers, location] = await Promise.all([
        this.sharedService.headers(serviceOptions),
        this.sharedService.validateLocation(
          { directory: serviceDirectory },
          { signal: state.abortController.signal },
          serviceOptions,
        ),
      ])
      if (this.shuttingDown) this.throwIfCancelled(record)
      this.serviceAuthorization = headers?.authorization
      record.location = { directory: location.directory, workspaceID: location.workspaceID }
      state.locationOwned = true
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
      if (state.locationOwned && !this.shuttingDown) {
        await this.evictRecordLocation(record, timeoutMs).catch((evictionError) => {
          this.options.logger.warn(
            { workspaceId: id, err: evictionError },
            "Failed to evict an OpenCode location after workspace launch failure",
          )
        })
      }
      if (!state.deletePromise && !state.locationOwned) {
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
    const state = record[WORKSPACE_STATE]
    if (state.creationRequestId !== requestId) return false
    if (state.creationRequestState === "released") return true
    if (state.creationRequestState !== "active") return false
    state.creationRequestState = "released"
    record.requestId = undefined
    return true
  }

  async cancelCreationRequest(requestId: string): Promise<void> {
    for (const [workspaceId, record] of this.workspaces) {
      const state = record[WORKSPACE_STATE]
      if (state.creationRequestId !== requestId) continue
      if (state.creationRequestState === "released") return
      state.creationRequestState = "cancelled"
      record.requestId = undefined
      await this.delete(workspaceId)
      return
    }
    this.cancelledCreationRequests.add(requestId)
  }

  private finishCreation(
    result: WorkspaceCreateResult,
    requestId: string | undefined,
    record: WorkspaceRecord,
  ): WorkspaceCreateResult {
    const requestState = record[WORKSPACE_STATE].creationRequestState
    if (requestId && requestState === "cancelled") {
      throw new Error(`Workspace creation request ${requestId} was cancelled`)
    }
    return {
      workspace: requestId ? { ...result.workspace, requestId } : result.workspace,
      created: result.created && requestState !== "released",
    }
  }

  async shutdown() {
    this.shuttingDown = true
    this.options.logger.info("Shutting down all workspaces")
    const shutdownTimeoutMs = Math.max(1, this.options.shutdownTimeoutMs ?? 10000)
    const deadlineAt = Date.now() + shutdownTimeoutMs
    const records = Array.from(this.workspaces.entries())
    for (const [id, record] of records) {
      const state = record[WORKSPACE_STATE]
      if (!state.abortController.signal.aborted) state.abortController.abort(new WorkspaceLaunchCancelledError(id))
    }
    const settlements = records.map(([, record]) => {
      const state = record[WORKSPACE_STATE]
      return state.deletePromise ?? state.settlement ?? Promise.resolve()
    })
    const stopFailures: unknown[] = []
    if (settlements.length) {
      await this.withTimeout(Promise.allSettled(settlements), shutdownTimeoutMs, "shutdown")
        .then((results) => {
          stopFailures.push(...results.flatMap((result) => result.status === "rejected" ? [result.reason] : []))
        })
        .catch((error) => stopFailures.push(error))
    }
    for (const [id, record] of records) this.removeRecord(id, record, true, "stopped")
    this.cancelledCreationRequests.clear()
    const remaining = Math.max(1, deadlineAt - Date.now())
    await this.withTimeout(
      this.sharedService.shutdown({ timeoutMs: remaining }),
      remaining,
      "shared service shutdown",
    ).catch((error) => stopFailures.push(error))
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
    const timeoutMs = Math.max(1, this.options.launchSettlementTimeoutMs ?? 5000)
    await this.withTimeout(record[WORKSPACE_STATE].settlement!, timeoutMs, `${id} launch cancellation`)
    await this.evictRecordLocation(record, timeoutMs)
    this.removeRecord(id, record, true)
    return record
  }

  private async evictRecordLocation(record: WorkspaceRecord, timeoutMs: number): Promise<void> {
    const state = record[WORKSPACE_STATE]
    if (!state.locationOwned || !record.location) return
    const shared = Array.from(this.workspaces.values()).some((candidate) => (
      candidate !== record
      && !candidate[WORKSPACE_STATE].abortController.signal.aborted
      && candidate.location?.directory === record.location?.directory
    ))
    if (shared) {
      state.locationOwned = false
      return
    }
    await this.withTimeout(
      this.sharedService.evictLocation(
        record.location,
        { signal: AbortSignal.timeout(timeoutMs) },
        state.serviceOptions,
      ),
      timeoutMs,
      `${record.id} location eviction`,
    )
    state.locationOwned = false
  }

  private requireWslServiceDirectory(directory: string, distro: string, timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS): string {
    const translated = this.resolveWslServiceDirectory(directory, distro, timeoutMs)
    if (!translated) {
      throw new Error(`Unable to translate workspace location for WSL distro "${distro}": ${directory}`)
    }
    return translated
  }

  private resolveWslServiceDirectory(directory: string, distro: string, timeoutMs: number): string | null {
    if (this.options.wslServiceDirectoryResolver) {
      return this.options.wslServiceDirectoryResolver(directory, distro, timeoutMs)
    }
    return resolveWslServiceDirectory(directory, distro, undefined, timeoutMs)
  }

  private resolveWslHostDirectory(directory: string, distro: string, timeoutMs: number): string | null {
    if (this.options.wslHostDirectoryResolver) {
      return this.options.wslHostDirectoryResolver(directory, distro, timeoutMs)
    }
    return resolveWslHostDirectory(directory, distro, undefined, timeoutMs)
  }

  private createWslServiceLifecycle(
    spec: Extract<ServiceLaunchSpec, { kind: "wsl" }>,
    timeoutMs: number,
    startupEnvironment: NodeJS.ProcessEnv,
  ): OpenCodeServiceLifecycle {
    return this.options.wslServiceLifecycleFactory?.(spec, timeoutMs, startupEnvironment)
      ?? new WslOpenCodeService({
        distro: spec.distro,
        binary: spec.binary,
        startupEnvironment,
        timeoutMs,
      })
  }

  private createHostServiceLifecycle(
    spec: Extract<ServiceLaunchSpec, { kind: "host" }>,
    timeoutMs: number,
    startupEnvironment: NodeJS.ProcessEnv,
  ): OpenCodeServiceLifecycle {
    return this.options.hostServiceLifecycleFactory?.(spec, timeoutMs, startupEnvironment)
      ?? new HostOpenCodeService({
        binary: spec.binary,
        platform: spec.platform,
        startupEnvironment,
        timeoutMs,
      })
  }

  private serviceStartupEnvironment(): NodeJS.ProcessEnv {
    const configured = this.options.settings.getOwner("config", "server").environmentVariables
    const environment: NodeJS.ProcessEnv = {}
    const omitted: string[] = []
    if (configured && typeof configured === "object" && !Array.isArray(configured)) {
      for (const [key, value] of Object.entries(configured)) {
        if (typeof value !== "string") continue
        if (["OPENCODE_DB", "XDG_STATE_HOME"].includes(key.toUpperCase())) {
          omitted.push(key)
          continue
        }
        if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
          throw new Error(`Invalid OpenCode service environment variable name: ${key || "(empty)"}`)
        }
        environment[key] = value
      }
    }
    if (omitted.length && !this.warnedLegacyServiceEnvironment) {
      this.warnedLegacyServiceEnvironment = true
      this.options.logger.warn(
        { variables: omitted },
        "Ignoring legacy OpenCode storage ownership variables for the global daemon",
      )
    }
    if (process.env.NODE_EXTRA_CA_CERTS !== undefined) {
      for (const key of Object.keys(environment)) {
        if (key.toUpperCase() === "NODE_EXTRA_CA_CERTS") delete environment[key]
      }
      environment.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS
    }
    return environment
  }

  private removeRecord(
    id: string,
    record: WorkspaceRecord,
    publishStopped: boolean,
    reason: "deleted" | "stopped" = "deleted",
  ): void {
    if (this.workspaces.get(id) !== record) return
    this.workspaces.delete(id)
    clearWorkspaceSearchCache(record.path)
    if (publishStopped) this.publishStopped(record, reason)
  }

  private publishStopped(record: WorkspaceRecord, reason: "deleted" | "stopped" = "stopped"): void {
    const state = record[WORKSPACE_STATE]
    if (!state.published || state.stoppedPublished) return
    state.stoppedPublished = true
    record.status = "stopped"
    record.error = undefined
    this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: record.id, reason })
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
