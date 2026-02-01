import path from "path"
import { spawnSync } from "child_process"
import { EventBus } from "../events/bus"
import { ConfigStore } from "../config/store"
import { BinaryRegistry } from "../config/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { WorkspaceRuntime } from "./runtime"
import { Logger } from "../logger"
import { ToolRegistry } from "../tools/tool-registry"

interface WorkspaceManagerOptions {
  rootDir: string
  configStore: ConfigStore
  binaryRegistry: BinaryRegistry
  eventBus: EventBus
  logger: Logger
}

interface WorkspaceRecord extends WorkspaceDescriptor {}

/**
 * Build the environment variables for a workspace process.
 * Extracted as a standalone function for testability.
 */
export function buildWorkspaceEnvironment(prefs: Record<string, unknown>): Record<string, string> {
  return {
    ...((prefs.environmentVariables ?? {}) as Record<string, string>),
    ERA_MAX_SUBAGENT_ITERATIONS: String((prefs as any).maxSubagentIterations ?? 3),
    ERA_AGENT_AUTONOMY: String((prefs as any).agentAutonomy ?? "balanced"),
  }
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly toolRegistries = new Map<string, ToolRegistry>()
  private readonly runtime: WorkspaceRuntime

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.runtime = new WorkspaceRuntime(this.options.eventBus, this.options.logger)
  }

  /** Get the ToolRegistry for a workspace, if one exists */
  getToolRegistry(workspaceId: string): ToolRegistry | undefined {
    return this.toolRegistries.get(workspaceId)
  }

  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
  }

  /**
   * Get the set of active workspace IDs
   */
  getActiveWorkspaceIds(): Set<string> {
    return new Set(this.workspaces.keys())
  }

  get(id: string): WorkspaceDescriptor | undefined {
    return this.workspaces.get(id)
  }

  getInstancePort(id: string): number | undefined {
    return this.workspaces.get(id)?.port
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

  /**
   * Find an existing workspace by its folder path
   */
  findByPath(folderPath: string): WorkspaceDescriptor | undefined {
    const normalizedPath = path.isAbsolute(folderPath) ? folderPath : path.resolve(this.options.rootDir, folderPath)
    for (const workspace of this.workspaces.values()) {
      if (workspace.path === normalizedPath) {
        return workspace
      }
    }
    return undefined
  }

  async create(folder: string, name?: string): Promise<WorkspaceDescriptor> {
    const workspacePath = path.isAbsolute(folder) ? folder : path.resolve(this.options.rootDir, folder)

    // Check if workspace for this folder already exists - return existing instead of creating duplicate
    const existing = this.findByPath(workspacePath)
    if (existing) {
      this.options.logger.info(
        { workspaceId: existing.id, folder: workspacePath },
        "Workspace already exists for this folder, returning existing"
      )
      return existing
    }

    const id = `${Date.now().toString(36)}`
    const binary = this.options.binaryRegistry.resolveDefault()
    const resolvedBinaryPath = this.resolveBinaryPath(binary.path)
    clearWorkspaceSearchCache(workspacePath)

    this.options.logger.info({ workspaceId: id, folder: workspacePath, binary: resolvedBinaryPath }, "Creating workspace")

    const proxyPath = `/workspaces/${id}/instance`


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

    const prefs = this.options.configStore.get().preferences
    const environment = buildWorkspaceEnvironment(prefs as unknown as Record<string, unknown>)

    // Create a ToolRegistry for this workspace (populated with built-in tools;
    // MCP tools will be registered as MCP servers connect via event bus)
    const toolRegistry = new ToolRegistry()
    this.toolRegistries.set(id, toolRegistry)

    try {
      const { pid, port } = await this.runtime.launch({
        workspaceId: id,
        folder: workspacePath,
        binaryPath: resolvedBinaryPath,
        environment,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })

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

  async delete(id: string, options?: { force?: boolean }): Promise<WorkspaceDescriptor | undefined> {
    const workspace = this.workspaces.get(id)
    if (!workspace) return undefined

    this.options.logger.info({ workspaceId: id }, "Stopping workspace")
    const wasRunning = Boolean(workspace.pid)

    if (wasRunning) {
      const result = await this.runtime.stop(id)

      if (!result.stopped) {
        if (options?.force) {
          this.options.logger.error(
            { workspaceId: id, error: result.error },
            "Process failed to stop but force=true, proceeding with workspace deletion"
          )
        } else {
          this.options.logger.error(
            { workspaceId: id, error: result.error },
            "Failed to stop workspace process - workspace deletion aborted"
          )
          // Update workspace status to reflect the error state
          workspace.status = "error"
          workspace.error = result.error || "Process failed to stop"
          workspace.updatedAt = new Date().toISOString()
          this.options.eventBus.publish({ type: "workspace.error", workspace })
          throw new Error(result.error || "Failed to stop workspace process")
        }
      }
    }

    this.workspaces.delete(id)
    this.toolRegistries.delete(id)
    clearWorkspaceSearchCache(workspace.path)

    // Always publish stopped event after successful deletion
    this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: id })

    return workspace
  }

  /**
   * Force delete a workspace even if the process won't stop
   * Use this for cleanup of orphaned/stuck workspaces
   */
  async forceDelete(id: string): Promise<WorkspaceDescriptor | undefined> {
    return this.delete(id, { force: true })
  }

  async shutdown() {
    this.options.logger.info("Shutting down all workspaces")
    for (const [id, workspace] of this.workspaces) {
      if (workspace.pid) {
        this.options.logger.info({ workspaceId: id }, "Stopping workspace during shutdown")
        await this.runtime.stop(id).catch((error) => {
          this.options.logger.error({ workspaceId: id, err: error }, "Failed to stop workspace during shutdown")
        })
      } else {
        this.options.logger.debug({ workspaceId: id }, "Workspace already stopped")
      }
    }
    this.workspaces.clear()
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

  private handleProcessExit(workspaceId: string, info: { code: number | null; requested: boolean }) {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return

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
