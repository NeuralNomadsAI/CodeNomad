import path from "path"
import { spawnSync } from "child_process"
import { randomUUID } from "node:crypto"
import { connect } from "net"
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

const STARTUP_STABILITY_DELAY_MS = 1500
type ManagerTimeout = ReturnType<typeof setTimeout>

interface WorkspaceRuntimeController {
  launch: WorkspaceRuntime["launch"]
  stop: WorkspaceRuntime["stop"]
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
  runtime?: WorkspaceRuntimeController
  shutdownTimeoutMs?: number
  launchSettlementTimeoutMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => ManagerTimeout
  clearTimeout?: (timer: ManagerTimeout) => void
}

interface WorkspaceLaunchLifecycle {
  cancelled: boolean
  settled: boolean
  completion: Promise<void>
  complete: () => void
  deletePromise?: Promise<WorkspaceDescriptor | undefined>
  stoppedEventPublished: boolean
}

interface WorkspaceRecord {
  descriptor: WorkspaceDescriptor
  lifecycle: WorkspaceLaunchLifecycle
  published: boolean
  releasedCreationRequestId?: string
}

export class WorkspaceLaunchCancelledError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} launch was cancelled`)
    this.name = "WorkspaceLaunchCancelledError"
  }
}

export class WorkspaceShutdownTimeoutError extends Error {
  readonly code = "WORKSPACE_SHUTDOWN_TIMEOUT"
  readonly retryable = true

  constructor(timeoutMs: number) {
    super(`Workspace shutdown did not finish within ${timeoutMs}ms; remaining workspace cleanup can be retried`)
    this.name = "WorkspaceShutdownTimeoutError"
  }
}

export class WorkspaceLaunchSettlementTimeoutError extends Error {
  readonly code = "WORKSPACE_LAUNCH_SETTLEMENT_TIMEOUT"
  readonly retryable = true

  constructor(workspaceId: string, timeoutMs: number) {
    super(`Workspace ${workspaceId} launch cancellation did not settle within ${timeoutMs}ms; cleanup can be retried`)
    this.name = "WorkspaceLaunchSettlementTimeoutError"
  }
}

export class WorkspaceShutdownError extends Error {
  readonly code = "WORKSPACE_SHUTDOWN_FAILED"
  readonly retryable = true
  readonly errors: unknown[]

  constructor(errors: unknown[]) {
    super(`Failed to stop ${errors.length} workspace${errors.length === 1 ? "" : "s"} during shutdown; cleanup can be retried`)
    this.name = "WorkspaceShutdownError"
    this.errors = errors
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

interface PendingWorkspaceCreation {
  promise: Promise<WorkspaceCreateResult>
  sharedByNonRestoreCaller: boolean
  followerCount: number
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly workspaceIdentities = new Map<string, string>()
  private readonly pendingWorkspaceCreations = new Map<string, PendingWorkspaceCreation>()
  private readonly pendingWorkspaceOwners = new Map<string, string>()
  private shuttingDown = false
  private readonly runtime: WorkspaceRuntimeController
  private readonly codeNomadPluginUrl: string
  private readonly opencodeAuth = new Map<string, { username: string; password: string; authorization: string }>()
  private readonly shutdownTimeoutMs: number
  private readonly launchSettlementTimeoutMs: number
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => ManagerTimeout
  private readonly cancelTimeout: (timer: ManagerTimeout) => void

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.runtime = options.runtime ?? new WorkspaceRuntime(this.options.eventBus, this.options.logger)
    this.codeNomadPluginUrl = getCodeNomadPluginUrl()
    this.shutdownTimeoutMs = Math.max(1, options.shutdownTimeoutMs ?? 10000)
    this.launchSettlementTimeoutMs = Math.max(1, options.launchSettlementTimeoutMs ?? 5000)
    this.scheduleTimeout = options.setTimeout ?? setTimeout
    this.cancelTimeout = options.clearTimeout ?? clearTimeout
  }

  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
      .filter((record) => record.published)
      .map((record) => record.descriptor)
  }

  get(id: string): WorkspaceDescriptor | undefined {
    const record = this.workspaces.get(id)
    return record?.published ? record.descriptor : undefined
  }

  getInstancePort(id: string): number | undefined {
    const record = this.workspaces.get(id)
    return record?.published ? record.descriptor.port : undefined
  }

  getInstanceAuthorizationHeader(id: string): string | undefined {
    return this.workspaces.get(id)?.published ? this.opencodeAuth.get(id)?.authorization : undefined
  }

  private findReadyWorkspaceByIdentity(
    identityKey: string,
    includeRestoreOwned: boolean,
  ): WorkspaceDescriptor | undefined {
    for (const [workspaceId, record] of this.workspaces) {
      if (
        record.published
        && !record.lifecycle.cancelled
        && (includeRestoreOwned || !record.descriptor.requestId)
        && record.descriptor.status === "ready"
        && this.workspaceIdentities.get(workspaceId) === identityKey
      ) {
        return record.descriptor
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
    const { workspacePath, identityKey } = await resolveWorkspaceIdentity(folder, this.options.rootDir)
    if (this.shuttingDown) {
      throw new Error("Workspace manager is shutting down")
    }
    if (options.forceNew) {
      return this.createResolvedWorkspace(workspacePath, identityKey, name, options)
    }

    const existing = this.findReadyWorkspaceByIdentity(identityKey, Boolean(options.requestId))
    if (existing) {
      this.options.logger.info({ workspaceId: existing.id, folder: workspacePath }, "Reusing existing workspace")
      return { workspace: existing, created: false }
    }

    const pending = this.pendingWorkspaceCreations.get(identityKey)
    if (pending) {
      pending.followerCount += 1
      if (!options.requestId) pending.sharedByNonRestoreCaller = true
      const result = await pending.promise
      return { workspace: result.workspace, created: false }
    }

    const creation = this.createResolvedWorkspace(
      workspacePath,
      identityKey,
      name,
      options,
      (workspaceId) => {
        this.pendingWorkspaceOwners.set(identityKey, workspaceId)
      },
    )
    const pendingCreation = { promise: creation, sharedByNonRestoreCaller: false, followerCount: 0 }
    this.pendingWorkspaceCreations.set(identityKey, pendingCreation)
    try {
      const result = await creation
      if (options.requestId && pendingCreation.sharedByNonRestoreCaller) {
        result.workspace.requestId = undefined
        return { workspace: result.workspace, created: false }
      }
      return result
    } finally {
      if (this.pendingWorkspaceCreations.get(identityKey) === pendingCreation) {
        this.pendingWorkspaceCreations.delete(identityKey)
        this.pendingWorkspaceOwners.delete(identityKey)
      }
    }
  }

  private async createResolvedWorkspace(
    workspacePath: string,
    identityKey: string,
    name: string | undefined,
    options: WorkspaceCreateOptions,
    onReserved?: (workspaceId: string) => void,
  ): Promise<WorkspaceCreateResult> {
    const id = randomUUID()
    const binary = this.options.binaryResolver.resolve(options.binaryPath)
    const resolvedBinaryPath = this.resolveBinaryPath(binary.path)
    clearWorkspaceSearchCache(workspacePath)

    this.options.logger.info({ workspaceId: id, folder: workspacePath, binary: resolvedBinaryPath }, "Creating workspace")

    const proxyPath = `/workspaces/${id}/instance`


    const descriptor: WorkspaceDescriptor = {
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
    }

    let completeLaunch!: () => void
    const completion = new Promise<void>((resolve) => {
      completeLaunch = resolve
    })
    const record: WorkspaceRecord = {
      descriptor,
      lifecycle: {
        cancelled: false,
        settled: false,
        completion,
        complete: completeLaunch,
        stoppedEventPublished: false,
      },
      published: false,
    }

    this.workspaces.set(id, record)
    this.workspaceIdentities.set(id, identityKey)
    onReserved?.(id)

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
      const { pid, port, exitPromise, cancellationPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: id,
        folder: workspacePath,
        binaryPath: resolvedBinaryPath,
        environment,
        logLevel,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })
      descriptor.pid = pid
      descriptor.port = port

      this.throwIfCancelled(record)
      record.published = true
      this.options.eventBus.publish({ type: "workspace.created", workspace: descriptor })
      this.throwIfCancelled(record)
      const readinessAbort = new AbortController()
      const runtimeVersion = await Promise.race([
        this.waitForWorkspaceReadiness({ workspaceId: id, port, exitPromise, getLastOutput, signal: readinessAbort.signal }),
        cancellationPromise.then((error) => {
          readinessAbort.abort(error)
          throw error
        }),
      ])
      this.throwIfCancelled(record)
      if (runtimeVersion) {
        descriptor.binaryVersion = runtimeVersion
      }

      descriptor.status = "ready"
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.started", workspace: descriptor })
      this.options.logger.info({ workspaceId: id, port }, "Workspace ready")
      return { workspace: descriptor, created: true }
    } catch (error) {
      if (record.lifecycle.cancelled) {
        await this.stopRuntime(id)
        throw error instanceof WorkspaceLaunchCancelledError ? error : new WorkspaceLaunchCancelledError(id)
      }
      if (!record.published) {
        try {
          await this.stopRuntime(id)
        } catch (cleanupError) {
          this.options.logger.error({ workspaceId: id, err: cleanupError }, "Unpublished workspace cleanup remains pending")
          throw cleanupError
        }
        if (this.workspaces.get(id) === record) {
          this.workspaces.delete(id)
          this.workspaceIdentities.delete(id)
        }
        this.opencodeAuth.delete(id)
        this.options.logger.error({ workspaceId: id, err: error }, "Workspace failed before identity publication")
        throw error
      }

      let stopFailure: unknown
      await this.stopRuntime(id).catch((stopError) => {
        stopFailure = stopError
        this.options.logger.warn({ workspaceId: id, err: stopError }, "Failed to stop workspace after startup error")
      })
      if (!stopFailure) {
        this.publishStopped(record)
        if (this.workspaces.get(id) === record) {
          this.workspaces.delete(id)
          this.workspaceIdentities.delete(id)
        }
        this.opencodeAuth.delete(id)
        throw error
      }
      descriptor.status = "error"
      descriptor.error = stopFailure instanceof Error
        ? `Workspace startup failed and its process could not be stopped: ${stopFailure.message}`
        : error instanceof Error ? error.message : String(error)
      descriptor.updatedAt = new Date().toISOString()
      if (this.workspaces.get(id) === record && record.published) {
        this.options.eventBus.publish({ type: "workspace.error", workspace: descriptor })
      }
      this.options.logger.error({ workspaceId: id, err: error }, "Workspace failed to start")
      throw error
    } finally {
      record.lifecycle.settled = true
      record.lifecycle.complete()
    }
  }

  delete(id: string): Promise<WorkspaceDescriptor | undefined> {
    const record = this.workspaces.get(id)
    if (!record) return Promise.resolve(undefined)

    record.lifecycle.cancelled = true
    const identityKey = this.workspaceIdentities.get(id)
    if (identityKey && this.pendingWorkspaceOwners.get(identityKey) === id) {
      this.pendingWorkspaceCreations.delete(identityKey)
      this.pendingWorkspaceOwners.delete(identityKey)
    }
    if (!record.lifecycle.deletePromise) {
      let deletePromise!: Promise<WorkspaceDescriptor | undefined>
      deletePromise = this.cleanupDeletedWorkspace(id, record).catch((error) => {
        if (record.lifecycle.deletePromise === deletePromise) {
          record.lifecycle.deletePromise = undefined
        }
        throw error
      })
      record.lifecycle.deletePromise = deletePromise
    }
    return record.lifecycle.deletePromise
  }

  releaseCreationRequest(id: string, requestId: string): boolean {
    const record = this.workspaces.get(id)
    if (!record?.published) return false
    if (record.releasedCreationRequestId === requestId) return true
    if (record.descriptor.requestId !== requestId) return false
    record.descriptor.requestId = undefined
    record.releasedCreationRequestId = requestId
    return true
  }

  async shutdown() {
    this.shuttingDown = true
    this.options.logger.info("Shutting down all workspaces")

    const stopTasks = Array.from(this.workspaces.keys(), (id) => this.delete(id))
    let stopFailures: unknown[] = []

    if (stopTasks.length > 0) {
      const results = await this.withShutdownTimeout(Promise.allSettled(stopTasks))
      stopFailures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    }

    if (this.workspaces.size === 0) {
      this.workspaceIdentities.clear()
      this.pendingWorkspaceCreations.clear()
      this.pendingWorkspaceOwners.clear()
      this.options.logger.info("All workspaces cleared")
    } else {
      this.options.logger.warn(
        { workspaceIds: Array.from(this.workspaces.keys()) },
        "Some workspace records remain after failed shutdown cleanup",
      )
      if (stopFailures.length === 0) {
        stopFailures.push(new Error(`Workspace cleanup remains incomplete for: ${Array.from(this.workspaces.keys()).join(", ")}`))
      }
    }

    if (stopFailures.length > 0) {
      throw new WorkspaceShutdownError(stopFailures)
    }
  }

  private async withShutdownTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: ManagerTimeout | null = null
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = this.scheduleTimeout(() => {
        timeout = null
        reject(new WorkspaceShutdownTimeoutError(this.shutdownTimeoutMs))
      }, this.shutdownTimeoutMs)
    })

    try {
      return await Promise.race([operation, deadline])
    } finally {
      if (timeout) {
        this.cancelTimeout(timeout)
      }
    }
  }

  private requireWorkspace(id: string): WorkspaceDescriptor {
    const record = this.workspaces.get(id)
    if (!record?.published) {
      throw new Error("Workspace not found")
    }
    return record.descriptor
  }

  private throwIfCancelled(record: WorkspaceRecord): void {
    if (record.lifecycle.cancelled) {
      throw new WorkspaceLaunchCancelledError(record.descriptor.id)
    }
  }

  private async stopRuntime(workspaceId: string): Promise<void> {
    try {
      await this.runtime.stop(workspaceId)
    } catch (error) {
      this.options.logger.warn({ workspaceId, err: error }, "Failed to stop workspace process cleanly")
      throw error
    }
  }

  private async cleanupDeletedWorkspace(id: string, record: WorkspaceRecord): Promise<WorkspaceDescriptor> {
    this.options.logger.info({ workspaceId: id }, "Stopping workspace")

    // Stop once immediately, then again after launch settlement to cover a child
    // that became available while cancellation was propagating.
    await this.stopRuntime(id)
    if (!record.lifecycle.settled) {
      await this.withLaunchSettlementTimeout(id, record.lifecycle.completion)
    }
    try {
      await this.runtime.stop(id)
    } catch (error) {
      this.options.logger.warn({ workspaceId: id, err: error }, "Failed final workspace process cleanup")
      throw error
    }

    if (this.workspaces.get(id) === record) {
      this.workspaces.delete(id)
      this.workspaceIdentities.delete(id)
      this.opencodeAuth.delete(id)
      clearWorkspaceSearchCache(record.descriptor.path)
      this.publishStopped(record)
    }
    return record.descriptor
  }

  private async withLaunchSettlementTimeout(workspaceId: string, completion: Promise<void>): Promise<void> {
    let timeout: ManagerTimeout | null = null
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = this.scheduleTimeout(() => {
        timeout = null
        reject(new WorkspaceLaunchSettlementTimeoutError(workspaceId, this.launchSettlementTimeoutMs))
      }, this.launchSettlementTimeoutMs)
    })

    try {
      await Promise.race([completion, deadline])
    } finally {
      if (timeout) {
        this.cancelTimeout(timeout)
      }
    }
  }

  private publishStopped(record: WorkspaceRecord): void {
    if (record.lifecycle.stoppedEventPublished) return
    record.lifecycle.stoppedEventPublished = true
    this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: record.descriptor.id })
  }

  private resolveBinaryPath(identifier: string): string {
    if (!identifier) {
      return identifier
    }

    const looksLikePath = identifier.includes("/") || identifier.includes("\\") || identifier.startsWith(".")
    if (path.isAbsolute(identifier) || looksLikePath) {
      return identifier
    }

    const locator = process.platform === "win32" ? "where" : "which"

    try {
      const result = spawnSync(locator, [identifier], { encoding: "utf8" })
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

  private async waitForWorkspaceReadiness(params: {
    workspaceId: string
    port: number
    exitPromise: Promise<ProcessExitInfo>
    getLastOutput: () => string
    signal?: AbortSignal
  }): Promise<string | undefined> {

    await Promise.race([
      this.waitForPortAvailability(params.port, 5000, params.signal),
      params.exitPromise.then((info) => {
        throw this.buildStartupError(
          params.workspaceId,
          "exited before becoming ready",
          info,
          params.getLastOutput(),
        )
      }),
    ])

    const version = await this.waitForInstanceHealth(params)

    await Promise.race([
      this.delay(STARTUP_STABILITY_DELAY_MS, params.signal),
      params.exitPromise.then((info) => {
        throw this.buildStartupError(
          params.workspaceId,
          "exited shortly after start",
          info,
          params.getLastOutput(),
        )
      }),
    ])

    return version
  }

  private async waitForInstanceHealth(params: {
    workspaceId: string
    port: number
    exitPromise: Promise<ProcessExitInfo>
    getLastOutput: () => string
    signal?: AbortSignal
  }): Promise<string | undefined> {
    const probeResult = await Promise.race([
      this.probeInstance(params.workspaceId, params.port, params.signal),
      params.exitPromise.then((info) => {
        throw this.buildStartupError(
          params.workspaceId,
          "exited during health checks",
          info,
          params.getLastOutput(),
        )
      }),
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
      let socket: ReturnType<typeof connect> | null = null

      const cleanup = () => {
        settled = true
        if (retryTimer) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        if (settled) return
        cleanup()
        socket?.destroy()
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Workspace readiness was cancelled"))
      }

      const tryConnect = () => {
        if (settled) {
          return
        }
        socket = connect({ port, host: "127.0.0.1" }, () => {
          cleanup()
          socket?.end()
          resolve()
        })
        socket.once("error", () => {
          socket?.destroy()
          if (settled) {
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

      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      tryConnect()
    })
  }

  private delay(durationMs: number, signal?: AbortSignal): Promise<void> {
    if (durationMs <= 0) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, durationMs)
      const onAbort = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Workspace readiness was cancelled"))
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })
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
    const workspace = record.descriptor

    this.opencodeAuth.delete(workspaceId)

    this.options.logger.info({ workspaceId, ...info }, "Workspace process exited")

    workspace.pid = undefined
    workspace.port = undefined
    workspace.updatedAt = new Date().toISOString()

    if (record.lifecycle.cancelled || info.requested || info.code === 0) {
      workspace.status = "stopped"
      workspace.error = undefined
      this.publishStopped(record)
    } else {
      workspace.status = "error"
      workspace.error = `Process exited with code ${info.code}`
      this.options.eventBus.publish({ type: "workspace.error", workspace })
    }
  }
}
