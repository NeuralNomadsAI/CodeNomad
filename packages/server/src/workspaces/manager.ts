import path from "path"
import { spawnSync } from "child_process"
import { randomUUID } from "node:crypto"
import { connect } from "net"
import { setTimeout as delay } from "node:timers/promises"
import { EventBus } from "../events/bus"
import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { WorkspaceRuntime, ProcessExitInfo } from "./runtime"
import { Logger } from "../logger"
import {
  buildOpencodeConfigContent,
  getCodeNomadPluginUrl,
  resolveExistingOpencodeConfigContent,
} from "../opencode-plugin.js"
import {
  OPENCODE_SERVER_BASE_URL_ENV,
  buildOpencodeBasicAuthHeader,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME_ENV,
  resolveOpencodeServerAuth,
} from "./opencode-auth"
import { resolveWorkspaceIdentity } from "./workspace-identity"
import { parseWslUncPath } from "./spawn"

const STARTUP_STABILITY_DELAY_MS = 1500
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000
const ORDINARY_CREATION_OWNER = ""
const WORKSPACE_STATE = Symbol("workspaceState")
type ManagerTimeout = ReturnType<typeof setTimeout>

interface WorkspaceRuntimeController {
  launch: WorkspaceRuntime["launch"]
  stop: WorkspaceRuntime["stop"]
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
  runtime?: Pick<WorkspaceRuntime, "launch" | "stop">
  shutdownTimeoutMs?: number
  launchSettlementTimeoutMs?: number
  launchTimeoutMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => ManagerTimeout
  clearTimeout?: (timer: ManagerTimeout) => void
}

interface WorkspaceRecord extends WorkspaceDescriptor {
  identityKey: string
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
  binaryPath?: string
  requestId?: string
  forceNew?: boolean
}
type CreationRequestState = "active" | "cancelled" | "released"
type WorkspaceCreationOwnership = Map<string, CreationRequestState>
interface WorkspaceReadiness {
  workspaceId: string
  port: number
  exitPromise: Promise<ProcessExitInfo>
  getLastOutput: () => string
  signal?: AbortSignal
}
export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly pendingWorkspaceCreations = new Map<string, WorkspaceRecord>()
  private readonly cancelledCreationRequests = new Set<string>()
  private shuttingDown = false
  private readonly runtime: Pick<WorkspaceRuntime, "launch" | "stop">
  private readonly codeNomadPluginUrl: string
  private readonly opencodeAuth = new Map<string, { username: string; password: string; authorization: string }>()

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.runtime = options.runtime ?? new WorkspaceRuntime(this.options.eventBus, this.options.logger)
    this.codeNomadPluginUrl = getCodeNomadPluginUrl()
  }
  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
      .filter((record) => record[WORKSPACE_STATE].published)
  }

  get(id: string): WorkspaceDescriptor | undefined {
    const record = this.workspaces.get(id)
    return record?.[WORKSPACE_STATE].published ? record : undefined
  }

  getInstancePort(id: string): number | undefined {
    const record = this.workspaces.get(id)
    return record?.[WORKSPACE_STATE].published ? record.port : undefined
  }

  getInstanceAuthorizationHeader(id: string): string | undefined {
    return this.workspaces.get(id)?.[WORKSPACE_STATE].published ? this.opencodeAuth.get(id)?.authorization : undefined
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
    const binary = this.options.binaryResolver.resolve(options.binaryPath)
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
      return await this.createResolvedWorkspace(record, options)
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
    options: WorkspaceCreateOptions,
  ): Promise<WorkspaceCreateResult> {
    const state = record[WORKSPACE_STATE]
    const { id, path: workspacePath, binaryId: resolvedBinaryPath, proxyPath } = record
    try {
      this.throwIfCancelled(record)

      const serverConfig = this.options.settings.getOwner("config", "server")
      const envVars = (serverConfig as any)?.environmentVariables
      const userEnvironment = envVars && typeof envVars === "object" && !Array.isArray(envVars) ? (envVars as any) : {}
      const opencodeConfigContent = buildOpencodeConfigContent(
        resolveExistingOpencodeConfigContent(userEnvironment),
        this.codeNomadPluginUrl,
      )
      const serverBaseUrl = this.options.getServerBaseUrl()
      const normalizedServerBaseUrl = serverBaseUrl.replace(/\/+$/, "")

      const { username: opencodeUsername, password: opencodePassword } = resolveOpencodeServerAuth({
        userEnvironment,
        processEnv: process.env,
      })
      const authorization = buildOpencodeBasicAuthHeader({ username: opencodeUsername, password: opencodePassword })
      if (!authorization) {
        throw new Error("Failed to build OpenCode auth header")
      }
      this.opencodeAuth.set(id, { username: opencodeUsername, password: opencodePassword, authorization })

      const environment = {
        ...userEnvironment,
        OPENCODE_CONFIG_CONTENT: opencodeConfigContent,
        OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
        CODENOMAD_INSTANCE_ID: id,
        CODENOMAD_BASE_URL: serverBaseUrl,
        ...(this.options.nodeExtraCaCertsPath ? { NODE_EXTRA_CA_CERTS: this.options.nodeExtraCaCertsPath } : {}),
        [OPENCODE_SERVER_BASE_URL_ENV]: `${normalizedServerBaseUrl}${proxyPath}`,
        [OPENCODE_SERVER_USERNAME_ENV]: opencodeUsername,
        [OPENCODE_SERVER_PASSWORD_ENV]: opencodePassword,
      }

      const logLevel = (serverConfig as any)?.logLevel
      const { pid, port, exitPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: id,
        folder: workspacePath,
        binaryPath: resolvedBinaryPath,
        environment,
        logLevel,
        signal: state.abortController.signal,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })
      record.pid = pid
      record.port = port

      this.throwIfCancelled(record)
      state.published = true
      this.options.eventBus.publish({ type: "workspace.created", workspace: record })
      this.throwIfCancelled(record)
      const runtimeVersion = await this.waitForWorkspaceReadiness({
        workspaceId: id,
        port,
        exitPromise,
        getLastOutput,
        signal: state.abortController.signal,
      })
      this.throwIfCancelled(record)
      if (runtimeVersion) {
        record.binaryVersion = runtimeVersion
      }

      record.status = "ready"
      record.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.started", workspace: record })
      this.options.logger.info({ workspaceId: id, port }, "Workspace ready")
      return { workspace: record, created: true }
    } catch (error) {
      const launchFailure = state.abortController.signal.aborted ? state.abortController.signal.reason : error
      let stopFailure: unknown
      await this.runtime.stop(id).catch((stopError) => {
        stopFailure = stopError
      })
      if (!stopFailure) {
        this.removeRecord(id, record, state.published)
        throw launchFailure
      }
      if (!state.published) {
        throw stopFailure
      }
      record.status = "error"
      record.error = stopFailure instanceof Error
        ? `Workspace startup failed and its process could not be stopped: ${stopFailure.message}`
        : launchFailure instanceof Error ? launchFailure.message : String(launchFailure)
      record.updatedAt = new Date().toISOString()
      if (this.workspaces.get(id) === record && state.published) {
        this.options.eventBus.publish({ type: "workspace.error", workspace: record })
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
    // Stop once immediately, then again after launch settlement to cover a child
    // that became available while cancellation was propagating.
    const immediateStop = this.runtime.stop(id).catch((error) => {
      this.options.logger.warn({ workspaceId: id, err: error }, "Initial workspace process cleanup failed; retrying after launch settles")
    })
    await this.withTimeout(record[WORKSPACE_STATE].settlement!, this.options.launchSettlementTimeoutMs ?? 5000, `${id} launch cancellation`)
    await immediateStop
    await this.runtime.stop(id)

    this.removeRecord(id, record, true)
    return record
  }

  private removeRecord(id: string, record: WorkspaceRecord, publishStopped: boolean): void {
    if (this.workspaces.get(id) !== record) return
    this.workspaces.delete(id)
    this.opencodeAuth.delete(id)
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

  private async waitForWorkspaceReadiness(params: WorkspaceReadiness): Promise<string | undefined> {

    await Promise.race([
      this.waitForPortAvailability(params.port, 5000, params.signal),
      this.exitDuringStartup(params, "exited before becoming ready"),
    ])

    const version = await this.waitForInstanceHealth(params)

    await Promise.race([
      delay(STARTUP_STABILITY_DELAY_MS, undefined, { signal: params.signal }),
      this.exitDuringStartup(params, "exited shortly after start"),
    ])

    return version
  }

  private async waitForInstanceHealth(params: WorkspaceReadiness): Promise<string | undefined> {
    const probeResult = await Promise.race([
      this.probeInstance(params.workspaceId, params.port, params.signal),
      this.exitDuringStartup(params, "exited during health checks"),
    ])

    if (probeResult.ok) {
      return probeResult.version
    }

    const latestOutput = params.getLastOutput().trim()
    if (latestOutput) {
      throw new Error(latestOutput)
    }
    const reason = probeResult.reason ?? "Health check failed"
    throw new Error(`Workspace ${params.workspaceId} failed health check: ${reason}.`)
  }

  private exitDuringStartup(params: WorkspaceReadiness, phase: string): Promise<never> {
    return params.exitPromise.then((info) => {
      throw this.buildStartupError(params.workspaceId, phase, info, params.getLastOutput())
    })
  }

  private async probeInstance(
    workspaceId: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; reason?: string; version?: string }> {
    const url = `http://127.0.0.1:${port}/global/health`

    try {
      const headers: Record<string, string> = {}
      const authHeader = this.opencodeAuth.get(workspaceId)?.authorization
      if (authHeader) {
        headers["Authorization"] = authHeader
      }

      const response = await fetch(url, { headers, signal })
      if (!response.ok) {
        const reason = `/global/health returned HTTP ${response.status}`
        this.options.logger.debug({ workspaceId, status: response.status }, "Health probe returned server error")
        return { ok: false, reason }
      }

      const payload = (await response.json().catch(() => null)) as null | { healthy?: unknown; version?: unknown }
      const healthy = payload?.healthy === true
      const version = typeof payload?.version === "string" ? payload.version.trim() : undefined

      if (!healthy) {
        const reason = "Instance reported unhealthy"
        this.options.logger.debug({ workspaceId, payload }, "Health probe returned unhealthy response")
        return { ok: false, reason }
      }

      return { ok: true, version: version || undefined }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.options.logger.debug({ workspaceId, err: error }, "Health probe failed")
      return { ok: false, reason }
    }
  }

  private buildStartupError(
    workspaceId: string,
    phase: string,
    exitInfo: ProcessExitInfo,
    lastOutput: string,
  ): Error {
    const exitDetails = this.describeExit(exitInfo)
    const trimmedOutput = lastOutput.trim()
    const outputDetails = trimmedOutput ? ` Last output: ${trimmedOutput}` : ""
    return new Error(`Workspace ${workspaceId} ${phase} (${exitDetails}).${outputDetails}`)
  }

  private waitForPortAvailability(port: number, timeoutMs = 5000, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      let settled = false
      let retryTimer: NodeJS.Timeout | null = null

      const cleanup = () => {
        settled = true
        if (retryTimer) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
      }

      const tryConnect = () => {
        if (settled) return
        const socket = connect({ port, host: "127.0.0.1", signal }, () => {
          cleanup()
          socket.end()
          resolve()
        })
        socket.once("error", () => {
          socket.destroy()
          if (settled) return
          if (signal?.aborted) {
            cleanup()
            reject(signal.reason)
            return
          }
          if (Date.now() >= deadline) {
            cleanup()
            reject(new Error(`Workspace port ${port} did not become ready within ${timeoutMs}ms`))
          } else {
            retryTimer = setTimeout(() => {
              retryTimer = null
              tryConnect()
            }, 100)
          }
        })
      }

      if (signal?.aborted) return reject(signal.reason)
      tryConnect()
    })
  }

  private describeExit(info: ProcessExitInfo): string {
    if (info.signal) {
      return `signal ${info.signal}`
    }
    if (info.code !== null) {
      return `code ${info.code}`
    }
    return "unknown reason"
  }

  private handleProcessExit(workspaceId: string, info: { code: number | null; requested: boolean }) {
    const record = this.workspaces.get(workspaceId)
    if (!record) return
    const workspace = record

    this.opencodeAuth.delete(workspaceId)

    this.options.logger.info({ workspaceId, ...info }, "Workspace process exited")

    workspace.pid = undefined
    workspace.port = undefined
    workspace.updatedAt = new Date().toISOString()

    if (record[WORKSPACE_STATE].abortController.signal.aborted || info.requested || info.code === 0) {
      this.publishStopped(record)
    } else {
      workspace.status = "error"
      workspace.error = `Process exited with code ${info.code}`
      this.options.eventBus.publish({ type: "workspace.error", workspace })
    }
  }
}
