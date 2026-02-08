import path from "path"
import { spawnSync } from "child_process"
import { connect } from "net"
import { EventBus } from "../events/bus"
import { ConfigStore } from "../config/store"
import { BinaryRegistry } from "../config/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { WorkspaceRuntime, ProcessExitInfo } from "./runtime"
import { Logger } from "../logger"
import { getOpencodeConfigDir } from "../opencode-config.js"
import {
  buildOpencodeBasicAuthHeader,
  DEFAULT_OPENCODE_USERNAME,
  generateOpencodeServerPassword,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME_ENV,
} from "./opencode-auth"

const STARTUP_STABILITY_DELAY_MS = 1500

interface WorkspaceManagerOptions {
  rootDir: string
  configStore: ConfigStore
  binaryRegistry: BinaryRegistry
  eventBus: EventBus
  logger: Logger
  getServerBaseUrl: () => string
  /** Optional CA bundle path to trust CodeNomad HTTPS certs. */
  nodeExtraCaCertsPath?: string
}

interface WorkspaceRecord extends WorkspaceDescriptor {}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly runtime: WorkspaceRuntime
  private readonly opencodeConfigDir: string
  private readonly opencodeAuth = new Map<string, { username: string; password: string; authorization: string }>()

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.runtime = new WorkspaceRuntime(this.options.eventBus, this.options.logger)
    this.opencodeConfigDir = getOpencodeConfigDir()
  }

  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
  }

  get(id: string): WorkspaceDescriptor | undefined {
    return this.workspaces.get(id)
  }

  getInstancePort(id: string): number | undefined {
    return this.workspaces.get(id)?.port
  }

  getInstanceAuthorizationHeader(id: string): string | undefined {
    return this.opencodeAuth.get(id)?.authorization
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

  readFile(workspaceId: string, relativePath: string): WorkspaceFileResponse {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    const contents = browser.readFile(relativePath)
    return {
      workspaceId,
      relativePath,
      contents,
    }
  }

  async create(folder: string, name?: string): Promise<WorkspaceDescriptor> {
 
    const id = `${Date.now().toString(36)}`
    const binary = this.options.binaryRegistry.resolveDefault()
    const resolvedBinaryPath = this.resolveBinaryPath(binary.path)
    const workspacePath = path.isAbsolute(folder) ? folder : path.resolve(this.options.rootDir, folder)
    clearWorkspaceSearchCache(workspacePath)

    this.options.logger.info({ workspaceId: id, folder: workspacePath, binary: resolvedBinaryPath }, "Creating workspace")

    const proxyPath = `/workspaces/${id}/worktrees/root/instance`


    const descriptor: WorkspaceRecord = {
      id,
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

    if (!descriptor.binaryVersion) {
      descriptor.binaryVersion = this.detectBinaryVersion(resolvedBinaryPath)
    }

    this.workspaces.set(id, descriptor)


    this.options.eventBus.publish({ type: "workspace.created", workspace: descriptor })

    const preferences = this.options.configStore.get().preferences ?? {}
    const userEnvironment = preferences.environmentVariables ?? {}

    const opencodeUsername = DEFAULT_OPENCODE_USERNAME
    const opencodePassword = generateOpencodeServerPassword()
    const authorization = buildOpencodeBasicAuthHeader({ username: opencodeUsername, password: opencodePassword })
    if (!authorization) {
      throw new Error("Failed to build OpenCode auth header")
    }
    this.opencodeAuth.set(id, { username: opencodeUsername, password: opencodePassword, authorization })

    const environment = {
      ...userEnvironment,
      OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
      CODENOMAD_INSTANCE_ID: id,
      CODENOMAD_BASE_URL: this.options.getServerBaseUrl(),
      ...(this.options.nodeExtraCaCertsPath ? { NODE_EXTRA_CA_CERTS: this.options.nodeExtraCaCertsPath } : {}),
      [OPENCODE_SERVER_USERNAME_ENV]: opencodeUsername,
      [OPENCODE_SERVER_PASSWORD_ENV]: opencodePassword,
    }

    try {
      const { pid, port, exitPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: id,
        folder: workspacePath,
        binaryPath: resolvedBinaryPath,
        environment,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })

      await this.waitForWorkspaceReadiness({ workspaceId: id, port, exitPromise, getLastOutput })

      descriptor.pid = pid
      descriptor.port = port
      descriptor.status = "ready"
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.started", workspace: descriptor })
      this.options.logger.info({ workspaceId: id, port }, "Workspace ready")
      return descriptor
    } catch (error) {
      descriptor.status = "error"
      descriptor.error = error instanceof Error ? error.message : String(error)
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.error", workspace: descriptor })
      this.options.logger.error({ workspaceId: id, err: error }, "Workspace failed to start")
      throw error
    }
  }

  async delete(id: string): Promise<WorkspaceDescriptor | undefined> {
    const workspace = this.workspaces.get(id)
    if (!workspace) return undefined

    this.options.logger.info({ workspaceId: id }, "Stopping workspace")
    const wasRunning = Boolean(workspace.pid)
    if (wasRunning) {
      await this.runtime.stop(id).catch((error) => {
        this.options.logger.warn({ workspaceId: id, err: error }, "Failed to stop workspace process cleanly")
      })
    }

    this.workspaces.delete(id)
    this.opencodeAuth.delete(id)
    clearWorkspaceSearchCache(workspace.path)
    if (!wasRunning) {
      this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: id })
    }
    return workspace
  }

  async shutdown() {
    this.options.logger.info("Shutting down all workspaces")

    const stopTasks: Array<Promise<void>> = []

    for (const [id, workspace] of this.workspaces) {
      if (!workspace.pid) {
        this.options.logger.debug({ workspaceId: id }, "Workspace already stopped")
        continue
      }

      this.options.logger.info({ workspaceId: id }, "Stopping workspace during shutdown")
      stopTasks.push(
        this.runtime.stop(id).catch((error) => {
          this.options.logger.error({ workspaceId: id, err: error }, "Failed to stop workspace during shutdown")
        }),
      )
    }

    if (stopTasks.length > 0) {
      await Promise.allSettled(stopTasks)
    }

    this.workspaces.clear()
    this.opencodeAuth.clear()
    this.options.logger.info("All workspaces cleared")
  }

  private requireWorkspace(id: string): WorkspaceRecord {
    const workspace = this.workspaces.get(id)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    return workspace
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

  private detectBinaryVersion(resolvedPath: string): string | undefined {
    if (!resolvedPath) {
      return undefined
    }

    try {
      const result = spawnSync(resolvedPath, ["--version"], { encoding: "utf8" })
      if (result.status === 0 && result.stdout) {
        const line = result.stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0)
        if (line) {
          const normalized = line.trim()
          const versionMatch = normalized.match(/([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+)/)
          if (versionMatch) {
            const version = versionMatch[1]
            this.options.logger.debug({ binary: resolvedPath, version }, "Detected binary version")
            return version
          }
          this.options.logger.debug({ binary: resolvedPath, reported: normalized }, "Binary reported version string")
          return normalized
        }
      } else if (result.error) {
        this.options.logger.warn({ binary: resolvedPath, err: result.error }, "Failed to read binary version")
      }
    } catch (error) {
      this.options.logger.warn({ binary: resolvedPath, err: error }, "Failed to detect binary version")
    }

    return undefined
  }

  private async waitForWorkspaceReadiness(params: {
    workspaceId: string
    port: number
    exitPromise: Promise<ProcessExitInfo>
    getLastOutput: () => string
  }) {

    await Promise.race([
      this.waitForPortAvailability(params.port),
      params.exitPromise.then((info) => {
        throw this.buildStartupError(
          params.workspaceId,
          "exited before becoming ready",
          info,
          params.getLastOutput(),
        )
      }),
    ])

    await this.waitForInstanceHealth(params)

    await Promise.race([
      this.delay(STARTUP_STABILITY_DELAY_MS),
      params.exitPromise.then((info) => {
        throw this.buildStartupError(
          params.workspaceId,
          "exited shortly after start",
          info,
          params.getLastOutput(),
        )
      }),
    ])
  }

  private async waitForInstanceHealth(params: {
    workspaceId: string
    port: number
    exitPromise: Promise<ProcessExitInfo>
    getLastOutput: () => string
  }) {
    const probeResult = await Promise.race([
      this.probeInstance(params.workspaceId, params.port),
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
      return
    }

    const latestOutput = params.getLastOutput().trim()
    if (latestOutput) {
      throw new Error(latestOutput)
    }
    const reason = probeResult.reason ?? "Health check failed"
    throw new Error(`Workspace ${params.workspaceId} failed health check: ${reason}.`)
  }

  private async probeInstance(workspaceId: string, port: number): Promise<{ ok: boolean; reason?: string }> {
    const url = `http://127.0.0.1:${port}/project/current`

    try {
      const headers: Record<string, string> = {}
      const authHeader = this.opencodeAuth.get(workspaceId)?.authorization
      if (authHeader) {
        headers["Authorization"] = authHeader
      }

      const response = await fetch(url, { headers })
      if (!response.ok) {
        const reason = `health probe returned HTTP ${response.status}`
        this.options.logger.debug({ workspaceId, status: response.status }, "Health probe returned server error")
        return { ok: false, reason }
      }
      return { ok: true }
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

  private waitForPortAvailability(port: number, timeoutMs = 5000): Promise<void> {
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
        if (settled) {
          return
        }
        const socket = connect({ port, host: "127.0.0.1" }, () => {
          cleanup()
          socket.end()
          resolve()
        })
        socket.once("error", () => {
          socket.destroy()
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

      tryConnect()
    })
  }

  private delay(durationMs: number): Promise<void> {
    if (durationMs <= 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => setTimeout(resolve, durationMs))
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
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return

    this.opencodeAuth.delete(workspaceId)

    this.options.logger.info({ workspaceId, ...info }, "Workspace process exited")

    workspace.pid = undefined
    workspace.port = undefined
    workspace.updatedAt = new Date().toISOString()

    if (info.requested || info.code === 0) {
      workspace.status = "stopped"
      workspace.error = undefined
      this.options.eventBus.publish({ type: "workspace.stopped", workspaceId })
    } else {
      workspace.status = "error"
      workspace.error = `Process exited with code ${info.code}`
      this.options.eventBus.publish({ type: "workspace.error", workspace })
    }
  }
}
