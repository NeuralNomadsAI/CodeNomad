import { execSync } from "child_process"
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
import { EraDetectionService } from "../era/detection"

export class BinaryRegistry {
  private eraDetection: EraDetectionService | null = null

  constructor(
    private readonly configStore: ConfigStore,
    private readonly eventBus: EventBus | undefined,
    private readonly logger: Logger,
  ) {
    // Initialize era detection lazily to avoid circular dependencies
    this.eraDetection = new EraDetectionService(logger)
  }

  list(): BinaryRecord[] {
    return this.mapRecords()
  }

  /**
   * Detect available binaries on the system (era-code, opencode)
   */
  detectAvailableBinaries(): BinaryRecord[] {
    const binaries: BinaryRecord[] = []

    // 1. Check for era-code first (highest priority)
    if (this.eraDetection) {
      const eraInfo = this.eraDetection.detectBinary()
      if (eraInfo.installed && eraInfo.path) {
        binaries.push({
          id: "era-code",
          path: eraInfo.path,
          label: `Era Code${eraInfo.version ? ` ${eraInfo.version}` : ""}`,
          version: eraInfo.version ?? undefined,
          isDefault: true,
          source: "auto-detected",
        })
        this.logger.info(
          { path: eraInfo.path, version: eraInfo.version },
          "Era Code detected as default binary"
        )
      }
    }

    // 2. Check for opencode in PATH
    const opencodePath = this.detectOpencodePath()
    if (opencodePath) {
      binaries.push({
        id: "opencode",
        path: opencodePath,
        label: "OpenCode",
        isDefault: binaries.length === 0, // Default only if era-code not found
        source: "auto-detected",
      })
    }

    return binaries
  }

  /**
   * Detect opencode binary path
   */
  private detectOpencodePath(): string | null {
    try {
      const command = process.platform === "win32" ? "where opencode" : "which opencode"
      const result = execSync(command, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      const binaryPath = result.trim().split("\n")[0]
      return binaryPath || null
    } catch {
      return null
    }
  }

  resolveDefault(): BinaryRecord {
    const config = this.configStore.get()
    const userPreferred = config.preferences.lastUsedBinary

    // 1. If user has explicitly set a preference, use it
    if (userPreferred) {
      const configured = this.mapRecords().find((b) => b.path === userPreferred)
      if (configured) {
        return configured
      }
    }

    // 2. Check for auto-detected binaries (era-code prioritized)
    const autoDetected = this.detectAvailableBinaries()
    if (autoDetected.length > 0) {
      return autoDetected[0]
    }

    // 3. Check configured binaries
    const binaries = this.mapRecords()
    if (binaries.length > 0) {
      return binaries.find((binary) => binary.isDefault) ?? binaries[0]
    }

    // 4. Fallback to opencode (may not exist)
    this.logger.warn("No binaries found, falling back to opencode")
    return this.buildFallbackRecord("opencode")
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
