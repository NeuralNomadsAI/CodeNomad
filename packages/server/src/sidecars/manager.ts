import { connect } from "net"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { SettingsService } from "../settings/service"
import type { SideCar, SideCarKind, SideCarPrefixMode, SideCarStatus } from "../api-types"

interface SideCarManagerOptions {
  settings: SettingsService
  eventBus: EventBus
  logger: Logger
}

interface SideCarConfigRecord {
  id: string
  kind: SideCarKind
  name: string
  port: number
  insecure: boolean
  prefixMode: SideCarPrefixMode
  createdAt: string
  updatedAt: string
}

interface SideCarRuntimeRecord {
  status: SideCarStatus
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
        void this.refreshPortSideCar(record.id).catch((error) => {
          this.options.logger.warn({ sidecarId: record.id, err: error }, "Failed to probe sidecar port")
        })
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
    prefixMode: SideCarPrefixMode
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
      prefixMode: input.prefixMode,
      createdAt: now,
      updatedAt: now,
    }

    this.configs.set(record.id, record)
    this.runtime.set(record.id, { status: "stopped" })
    this.persistConfigs()
    await this.refreshPortSideCar(record.id)
    return this.toSideCar(record)
  }

  async update(
    id: string,
    input: Partial<{
      name: string
      port: number
      insecure: boolean
      prefixMode: SideCarPrefixMode
    }>,
  ): Promise<SideCar> {
    const record = this.requireConfig(id)

    record.name = typeof input.name === "string" ? input.name.trim() : record.name
    record.port = typeof input.port === "number" ? input.port : record.port
    record.insecure = typeof input.insecure === "boolean" ? input.insecure : record.insecure
    record.prefixMode = typeof input.prefixMode === "string" ? input.prefixMode : record.prefixMode
    record.updatedAt = new Date().toISOString()

    this.persistConfigs()
    await this.refreshPortSideCar(id)
    return this.toSideCar(record)
  }

  async delete(id: string): Promise<boolean> {
    const record = this.configs.get(id)
    if (!record) return false

    this.configs.delete(id)
    this.runtime.delete(id)
    this.persistConfigs()
    this.options.eventBus.publish({ type: "sidecar.removed", sidecarId: id })
    return true
  }

  async shutdown() {
    return
  }

  buildTargetOrigin(sidecar: Pick<SideCar, "port" | "insecure">): string {
    const protocol = sidecar.insecure ? "http" : "https"
    return `${protocol}://127.0.0.1:${sidecar.port}`
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

  private async refreshPortStatuses() {
    await Promise.all(Array.from(this.configs.values()).map((record) => this.refreshPortSideCar(record.id)))
  }

  private async refreshPortSideCar(id: string) {
    const record = this.configs.get(id)
    if (!record) return
    const isAvailable = await this.isPortAvailable(record.port)
    const current = this.runtime.get(id)
    const nextStatus: SideCarStatus = isAvailable ? "running" : "stopped"
    if (current?.status === nextStatus) {
      return
    }

    this.runtime.set(id, { status: nextStatus })
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
      prefixMode: record.prefixMode,
      status: runtime?.status ?? "stopped",
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
      const kind = record.kind === "port" ? "port" : null
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : null
      const port = typeof record.port === "number" && Number.isInteger(record.port) ? record.port : null
      if (!kind || !id || !name || !port) continue

      const insecure = record.insecure === true
      const prefixMode = record.prefixMode === "preserve" ? "preserve" : "strip"
      const createdAt = typeof record.createdAt === "string" && record.createdAt ? record.createdAt : new Date().toISOString()
      const updatedAt = typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : createdAt
      records.push({ id, kind, name, port, insecure, prefixMode, createdAt, updatedAt })
    }
    return records
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
