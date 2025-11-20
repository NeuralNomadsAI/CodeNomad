import {
  BinaryCreateRequest,
  BinaryRecord,
  BinaryUpdateRequest,
  BinaryValidationResult,
} from "../api-types"
import { ConfigStore } from "./store"
import { EventBus } from "../events/bus"
import type { ConfigFile } from "./schema"
import { Logger } from "../logger"

export class BinaryRegistry {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly eventBus: EventBus | undefined,
    private readonly logger: Logger,
  ) {}

  list(): BinaryRecord[] {
    return this.mapRecords()
  }

  resolveDefault(): BinaryRecord {
    const binaries = this.mapRecords()
    if (binaries.length === 0) {
      this.logger.warn("No configured binaries found, falling back to opencode")
      return this.buildFallbackRecord("opencode")
    }
    return binaries.find((binary) => binary.isDefault) ?? binaries[0]
  }

  create(request: BinaryCreateRequest): BinaryRecord {
    this.logger.debug({ path: request.path }, "Registering OpenCode binary")
    const entry = {
      path: request.path,
      version: undefined,
      lastUsed: Date.now(),
      label: request.label,
    }

    const config = this.configStore.get()
    const nextConfig = this.cloneConfig(config)
    const deduped = nextConfig.opencodeBinaries.filter((binary) => binary.path !== request.path)
    nextConfig.opencodeBinaries = [entry, ...deduped]

    if (request.makeDefault) {
      nextConfig.preferences.lastUsedBinary = request.path
    }

    this.configStore.replace(nextConfig)
    const record = this.getById(request.path)
    this.emitChange()
    return record
  }

  update(id: string, updates: BinaryUpdateRequest): BinaryRecord {
    this.logger.debug({ id }, "Updating OpenCode binary")
    const config = this.configStore.get()
    const nextConfig = this.cloneConfig(config)
    nextConfig.opencodeBinaries = nextConfig.opencodeBinaries.map((binary) =>
      binary.path === id ? { ...binary, label: updates.label ?? binary.label } : binary,
    )

    if (updates.makeDefault) {
      nextConfig.preferences.lastUsedBinary = id
    }

    this.configStore.replace(nextConfig)
    const record = this.getById(id)
    this.emitChange()
    return record
  }

  remove(id: string) {
    this.logger.debug({ id }, "Removing OpenCode binary")
    const config = this.configStore.get()
    const nextConfig = this.cloneConfig(config)
    const remaining = nextConfig.opencodeBinaries.filter((binary) => binary.path !== id)
    nextConfig.opencodeBinaries = remaining

    if (nextConfig.preferences.lastUsedBinary === id) {
      nextConfig.preferences.lastUsedBinary = remaining[0]?.path
    }

    this.configStore.replace(nextConfig)
    this.emitChange()
  }

  validatePath(path: string): BinaryValidationResult {
    this.logger.debug({ path }, "Validating OpenCode binary path")
    return this.validateRecord({
      id: path,
      path,
      label: this.prettyLabel(path),
      isDefault: false,
    })
  }

  private cloneConfig(config: ConfigFile): ConfigFile {
    return JSON.parse(JSON.stringify(config)) as ConfigFile
  }

  private mapRecords(): BinaryRecord[] {

    const config = this.configStore.get()
    const configuredBinaries = config.opencodeBinaries.map<BinaryRecord>((binary) => ({
      id: binary.path,
      path: binary.path,
      label: binary.label ?? this.prettyLabel(binary.path),
      version: binary.version,
      isDefault: false,
    }))

    const defaultPath = config.preferences.lastUsedBinary ?? configuredBinaries[0]?.path ?? "opencode"

    const annotated = configuredBinaries.map((binary) => ({
      ...binary,
      isDefault: binary.path === defaultPath,
    }))

    if (!annotated.some((binary) => binary.path === defaultPath)) {
      annotated.unshift(this.buildFallbackRecord(defaultPath))
    }

    return annotated
  }

  private getById(id: string): BinaryRecord {
    return this.mapRecords().find((binary) => binary.id === id) ?? this.buildFallbackRecord(id)
  }

  private emitChange() {
    this.logger.debug("Emitting binaries changed event")
    this.eventBus?.publish({ type: "config.binariesChanged", binaries: this.mapRecords() })
  }

  private validateRecord(record: BinaryRecord): BinaryValidationResult {
    // TODO: call actual binary -v check.
    return { valid: true, version: record.version }
  }

  private buildFallbackRecord(path: string): BinaryRecord {
    return {
      id: path,
      path,
      label: this.prettyLabel(path),
      isDefault: true,
    }
  }

  private prettyLabel(path: string) {
    const parts = path.split(/[\\/]/)
    const last = parts[parts.length - 1] || path
    return last || path
  }
}
