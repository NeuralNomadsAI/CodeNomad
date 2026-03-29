import { connect } from "net"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { SettingsService } from "../settings/service"
import type { SideCar, SideCarKind, SideCarPrefixMode, SideCarStatus } from "../api-types"

const SIDECAR_START_TIMEOUT_MS = 15000
const STOP_TIMEOUT_MS = 2000
const EXIT_WAIT_TIMEOUT_MS = 5000

interface SideCarManagerOptions {
  settings: SettingsService
  eventBus: EventBus
  logger: Logger
  rootDir: string
}

interface SideCarConfigRecord {
  id: string
  kind: SideCarKind
  name: string
  port: number
  insecure: boolean
  autoStart: boolean
  prefixMode: SideCarPrefixMode
  startupCommand?: string
  createdAt: string
  updatedAt: string
}

interface SideCarRuntimeRecord {
  status: SideCarStatus
  pid?: number
  error?: string
  child?: ChildProcess
  requestedStop?: boolean
  exitPromise?: Promise<void>
}

export class SideCarManager {
  private readonly configs = new Map<string, SideCarConfigRecord>()
  private readonly runtime = new Map<string, SideCarRuntimeRecord>()

  constructor(private readonly options: SideCarManagerOptions) {
    for (const record of this.loadConfiguredSideCars()) {
      this.configs.set(record.id, record)
      this.runtime.set(record.id, { status: "stopped" })
    }

    queueMicrotask(() => {
      for (const record of this.configs.values()) {
        if (record.kind === "managed" && record.autoStart) {
          void this.start(record.id).catch((error) => {
            this.options.logger.warn({ sidecarId: record.id, err: error }, "Failed to auto-start sidecar")
          })
        }
      }

      for (const record of this.configs.values()) {
        if (record.kind === "port") {
          void this.refreshPortSideCar(record.id).catch((error) => {
            this.options.logger.warn({ sidecarId: record.id, err: error }, "Failed to probe sidecar port")
          })
        }
      }
    })
  }

  async list(): Promise<SideCar[]> {
    await this.refreshPortStatuses()
    return Array.from(this.configs.values()).map((record) => this.toSideCar(record))
  }

  async get(id: string): Promise<SideCar | undefined> {
    if (!this.configs.has(id)) return undefined
    await this.refreshPortSideCar(id)
    return this.toSideCar(this.requireConfig(id))
  }

  async create(input: {
    kind: SideCarKind
    name: string
    port: number
    insecure: boolean
    autoStart: boolean
    prefixMode: SideCarPrefixMode
    startupCommand?: string
  }): Promise<SideCar> {
    const normalizedName = input.name.trim()
    const id = this.buildSideCarId(normalizedName)
    if (this.configs.has(id)) {
      throw new Error(`SideCar '${id}' already exists`)
    }

    const now = new Date().toISOString()
    const record: SideCarConfigRecord = {
      id,
      kind: input.kind,
      name: normalizedName,
      port: input.port,
      insecure: input.insecure,
      autoStart: input.autoStart,
      prefixMode: input.prefixMode,
      startupCommand: input.kind === "managed" ? input.startupCommand?.trim() : undefined,
      createdAt: now,
      updatedAt: now,
    }

    this.configs.set(record.id, record)
    this.runtime.set(record.id, { status: "stopped" })
    this.persistConfigs()

    if (record.kind === "managed" && record.autoStart) {
      void this.start(record.id).catch((error) => {
        this.options.logger.warn({ sidecarId: record.id, err: error }, "Failed to auto-start created sidecar")
      })
    } else if (record.kind === "port") {
      await this.refreshPortSideCar(record.id)
    } else {
      this.publish(record.id)
    }

    return this.toSideCar(record)
  }

  async update(
    id: string,
    input: Partial<{
      name: string
      port: number
      insecure: boolean
      autoStart: boolean
      prefixMode: SideCarPrefixMode
      startupCommand?: string
    }>,
  ): Promise<SideCar> {
    const record = this.requireConfig(id)
    const wasRunning = this.runtime.get(id)?.status === "running" || this.runtime.get(id)?.status === "starting"

    record.name = typeof input.name === "string" ? input.name.trim() : record.name
    record.port = typeof input.port === "number" ? input.port : record.port
    record.insecure = typeof input.insecure === "boolean" ? input.insecure : record.insecure
    record.autoStart = typeof input.autoStart === "boolean" ? input.autoStart : record.autoStart
    record.prefixMode = typeof input.prefixMode === "string" ? input.prefixMode : record.prefixMode
    if (record.kind === "managed") {
      record.startupCommand = typeof input.startupCommand === "string" ? input.startupCommand.trim() : record.startupCommand
    }
    record.updatedAt = new Date().toISOString()

    this.persistConfigs()

    if (record.kind === "managed" && wasRunning) {
      await this.stop(id)
      void this.start(id).catch((error) => {
        this.options.logger.warn({ sidecarId: id, err: error }, "Failed to restart sidecar after update")
      })
    } else if (record.kind === "port") {
      await this.refreshPortSideCar(id)
    } else {
      this.publish(id)
    }

    return this.toSideCar(record)
  }

  async delete(id: string): Promise<boolean> {
    const record = this.configs.get(id)
    if (!record) return false

    if (record.kind === "managed") {
      await this.stop(id).catch(() => undefined)
    }

    this.configs.delete(id)
    this.runtime.delete(id)
    this.persistConfigs()
    this.options.eventBus.publish({ type: "sidecar.removed", sidecarId: id })
    return true
  }

  async start(id: string): Promise<SideCar> {
    const record = this.requireConfig(id)
    if (record.kind === "port") {
      await this.refreshPortSideCar(id)
      return this.toSideCar(record)
    }

    const runtime = this.runtime.get(id)
    if (runtime?.status === "running") {
      return this.toSideCar(record)
    }
    if (runtime?.status === "starting") {
      return this.toSideCar(record)
    }

    if (!record.startupCommand) {
      this.runtime.set(id, { status: "error", error: "Missing startup command" })
      this.publish(id)
      return this.toSideCar(record)
    }

    const nextRuntime: SideCarRuntimeRecord = { status: "starting" }
    this.runtime.set(id, nextRuntime)
    record.updatedAt = new Date().toISOString()
    this.publish(id)

    const { shellCommand, shellArgs, spawnOptions } = this.buildShellSpawn(record.startupCommand)
    const child = spawn(shellCommand, shellArgs, {
      cwd: this.options.rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: process.env,
      ...spawnOptions,
    })

    nextRuntime.child = child
    nextRuntime.pid = child.pid
    nextRuntime.requestedStop = false

    const exitPromise = new Promise<void>((resolve) => {
      child.once("close", (code) => {
        const current = this.runtime.get(id)
        if (current?.child !== child) {
          resolve()
          return
        }

        const requested = Boolean(current.requestedStop)
        const status: SideCarStatus = requested || code === 0 ? "stopped" : "error"
        this.runtime.set(id, {
          status,
          error: requested || code === 0 ? undefined : `Process exited with code ${code ?? "unknown"}`,
        })
        record.updatedAt = new Date().toISOString()
        this.publish(id)
        resolve()
      })
    })
    nextRuntime.exitPromise = exitPromise

    try {
      await this.waitForPort(record.port, SIDECAR_START_TIMEOUT_MS)
      const current = this.runtime.get(id)
      if (current?.child === child) {
        this.runtime.set(id, { ...current, status: "running", error: undefined, pid: child.pid })
        record.updatedAt = new Date().toISOString()
        this.publish(id)
      }
    } catch (error) {
      this.runtime.set(id, {
        child,
        pid: child.pid,
        requestedStop: true,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        exitPromise,
      })
      record.updatedAt = new Date().toISOString()
      this.publish(id)
      await this.stop(id).catch(() => undefined)
      throw error
    }

    return this.toSideCar(record)
  }

  async stop(id: string): Promise<SideCar> {
    const record = this.requireConfig(id)
    const runtime = this.runtime.get(id)

    if (record.kind === "port") {
      await this.refreshPortSideCar(id)
      return this.toSideCar(record)
    }

    if (!runtime?.child) {
      this.runtime.set(id, { status: "stopped" })
      record.updatedAt = new Date().toISOString()
      this.publish(id)
      return this.toSideCar(record)
    }

    runtime.requestedStop = true
    this.killProcessTree(runtime.child, "SIGTERM")
    await this.waitForExit(id, runtime)
    record.updatedAt = new Date().toISOString()
    this.publish(id)
    return this.toSideCar(record)
  }

  async shutdown() {
    const stopTasks: Promise<unknown>[] = []
    for (const [id, config] of this.configs) {
      if (config.kind === "managed") {
        stopTasks.push(this.stop(id).catch(() => undefined))
      }
    }
    await Promise.allSettled(stopTasks)
  }

  buildTargetOrigin(sidecar: Pick<SideCar, "port" | "insecure">): string {
    const protocol = sidecar.insecure ? "http" : "https"
    return `${protocol}://127.0.0.1:${sidecar.port}`
  }

  private async refreshPortStatuses() {
    await Promise.all(
      Array.from(this.configs.values())
        .filter((record) => record.kind === "port")
        .map((record) => this.refreshPortSideCar(record.id)),
    )
  }

  private async refreshPortSideCar(id: string) {
    const record = this.configs.get(id)
    if (!record || record.kind !== "port") return
    const isAvailable = await this.isPortAvailable(record.port)
    const current = this.runtime.get(id)
    const nextStatus: SideCarStatus = isAvailable ? "running" : "stopped"
    if (current?.status === nextStatus && !current.error) {
      return
    }
    this.runtime.set(id, {
      status: nextStatus,
      error: isAvailable ? undefined : undefined,
    })
    record.updatedAt = new Date().toISOString()
    this.publish(id)
  }

  private publish(id: string) {
    const record = this.configs.get(id)
    if (!record) return
    this.options.eventBus.publish({ type: "sidecar.updated", sidecar: this.toSideCar(record) })
  }

  private toSideCar(record: SideCarConfigRecord): SideCar {
    const runtime = this.runtime.get(record.id)
    return {
      id: record.id,
      kind: record.kind,
      name: record.name,
      port: record.port,
        insecure: record.insecure,
        autoStart: record.autoStart,
        prefixMode: record.prefixMode,
        startupCommand: record.kind === "managed" ? record.startupCommand : undefined,
        status: runtime?.status ?? "stopped",
        pid: runtime?.pid,
      error: runtime?.error,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private requireConfig(id: string): SideCarConfigRecord {
    const record = this.configs.get(id)
    if (!record) {
      throw new Error("SideCar not found")
    }
    return record
  }

  private persistConfigs() {
    const sidecars = Array.from(this.configs.values()).map((record) => ({ ...record }))
    this.options.settings.mergePatchOwner("config", "server", { sidecars })
  }

  private loadConfiguredSideCars(): SideCarConfigRecord[] {
    const serverConfig = this.options.settings.getOwner("config", "server") as { sidecars?: unknown }
    const list = Array.isArray(serverConfig?.sidecars) ? serverConfig.sidecars : []
    const records: SideCarConfigRecord[] = []
    for (const item of list) {
      if (!item || typeof item !== "object") continue
      const record = item as Record<string, unknown>
      const kind = record.kind === "port" ? "port" : record.kind === "managed" ? "managed" : null
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : null
      const port = typeof record.port === "number" && Number.isInteger(record.port) ? record.port : null
      if (!kind || !id || !name || !port) continue
      const insecure = record.insecure === true
      const autoStart = record.autoStart !== false
      const prefixMode = record.prefixMode === "preserve" ? "preserve" : "strip"
      const startupCommand = typeof record.startupCommand === "string" && record.startupCommand.trim()
        ? record.startupCommand.trim()
        : undefined
      const createdAt = typeof record.createdAt === "string" && record.createdAt ? record.createdAt : new Date().toISOString()
      const updatedAt = typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : createdAt
      records.push({ id, kind, name, port, insecure, autoStart, prefixMode, startupCommand, createdAt, updatedAt })
    }
    return records
  }

  buildProxyBasePath(id: string): string {
    return `/sidecars/${encodeURIComponent(id)}`
  }

  buildTargetPath(id: string, incomingPath: string, search = ""): string {
    const record = this.requireConfig(id)
    const publicBase = this.buildProxyBasePath(id)
    const normalizedPath = incomingPath || publicBase

    if (record.prefixMode === "preserve") {
      return `${normalizedPath}${search}`
    }

    let stripped = normalizedPath.startsWith(publicBase) ? normalizedPath.slice(publicBase.length) : normalizedPath
    if (!stripped || stripped === "/") {
      stripped = "/"
    } else if (!stripped.startsWith("/")) {
      stripped = `/${stripped}`
    }
    return `${stripped}${search}`
  }

  private buildShellSpawn(command: string): { shellCommand: string; shellArgs: string[]; spawnOptions?: Record<string, unknown> } {
    if (process.platform === "win32") {
      const comspec = process.env.ComSpec || "cmd.exe"
      return {
        shellCommand: comspec,
        shellArgs: ["/d", "/s", "/c", command],
        spawnOptions: { windowsVerbatimArguments: true },
      }
    }
    return { shellCommand: "bash", shellArgs: ["-c", command] }
  }

  private killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
    const pid = child.pid
    if (!pid) return
    if (process.platform === "win32") {
      const args = ["/PID", String(pid), "/T"]
      if (signal === "SIGKILL") {
        args.push("/F")
      }
      try {
        spawnSync("taskkill", args, { encoding: "utf8" })
      } catch {
        // ignore
      }
      return
    }
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        // ignore
      }
    }
  }

  private async waitForExit(id: string, runtime: SideCarRuntimeRecord) {
    let exited = false
    const exitPromise = runtime.exitPromise?.finally(() => {
      exited = true
    })

    const killTimeout = setTimeout(() => {
      if (!exited && runtime.child) {
        this.killProcessTree(runtime.child, "SIGKILL")
      }
    }, STOP_TIMEOUT_MS)

    try {
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, EXIT_WAIT_TIMEOUT_MS)),
      ])

      if (!exited && runtime.child) {
        this.killProcessTree(runtime.child, "SIGKILL")
        this.runtime.set(id, { status: "stopped" })
      }
    } finally {
      clearTimeout(killTimeout)
    }
  }

  private async waitForPort(port: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.isPortAvailable(port)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`SideCar port ${port} did not become ready within ${timeoutMs}ms`)
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.end()
        resolve(true)
      })
      socket.once("error", () => {
        socket.destroy()
        resolve(false)
      })
    })
  }

  private buildSideCarId(name: string): string {
    const normalized = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")

    if (!normalized) {
      throw new Error("SideCar name must include letters or numbers")
    }

    return normalized
  }
}
