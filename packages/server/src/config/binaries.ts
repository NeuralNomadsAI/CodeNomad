import { execSync } from "child_process"
import {
  BinaryCreateRequest,
  BinaryRecord,
  BinaryUpdateRequest,
  BinaryValidationResult,
} from "../api-types"
import { spawnSync } from "child_process"
import { ConfigStore } from "./store"
import { EventBus } from "../events/bus"
import type { ConfigFile } from "./schema"
import { Logger } from "../logger"
import { EraDetectionService } from "../era/detection"
import { buildSpawnSpec } from "../workspaces/runtime"

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
    // Merge auto-detected binaries with user-configured ones
    const autoDetected = this.detectAvailableBinaries()
    const configured = this.mapRecords()
    
    // Build a map of all binaries, auto-detected first, then configured
    // This ensures era-code appears in the list even if not manually added
    const binaryMap = new Map<string, BinaryRecord>()
    
    // Check if we have a real opencode path detected
    const hasRealOpencode = autoDetected.some((b) => b.id === "opencode" && b.path !== "opencode")
    
    // Add auto-detected binaries first
    for (const binary of autoDetected) {
      binaryMap.set(binary.path, binary)
    }
    
    // Add/override with user-configured binaries
    for (const binary of configured) {
      // Skip the generic "opencode" fallback if we have a real detected opencode
      if (binary.path === "opencode" && hasRealOpencode) {
        continue
      }
      // Skip if we already have this exact path
      if (binaryMap.has(binary.path)) {
        continue
      }
      binaryMap.set(binary.path, binary)
    }
    
    return Array.from(binaryMap.values())
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
    const preferenceSource = config.preferences.binaryPreferenceSource ?? "auto"

    // 1. Check for era-code first - it wins over auto preferences
    const autoDetected = this.detectAvailableBinaries()
    const eraCodeBinary = autoDetected.find((b) => b.id === "era-code")

    // 2. If user has EXPLICITLY set a preference (source = "user"), honor it
    if (preferenceSource === "user" && userPreferred) {
      const configured = this.mapRecords().find((b) => b.path === userPreferred)
      if (configured) {
        this.logger.debug(
          { binary: configured.path, source: "user-explicit" },
          "Using user-explicit binary preference"
        )
        return configured
      }
    }

    // 3. Era-code takes priority over auto preferences
    if (eraCodeBinary) {
      this.logger.debug(
        { binary: eraCodeBinary.path, version: eraCodeBinary.version },
        "Era-code detected, using as default"
      )
      return eraCodeBinary
    }

    // 4. Fall back to auto preference if no era-code
    if (userPreferred) {
      const configured = this.mapRecords().find((b) => b.path === userPreferred)
      if (configured) {
        return configured
      }
    }

    // 5. Use any other auto-detected binary
    if (autoDetected.length > 0) {
      return autoDetected[0]
    }

    // 6. Check configured binaries
    const binaries = this.mapRecords()
    if (binaries.length > 0) {
      return binaries.find((binary) => binary.isDefault) ?? binaries[0]
    }

    // 7. Fallback to opencode (may not exist)
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
      nextConfig.preferences.binaryPreferenceSource = "user"
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
      nextConfig.preferences.binaryPreferenceSource = "user"
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
      // Reset to auto since the user's explicit choice was removed
      nextConfig.preferences.binaryPreferenceSource = "auto"
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
    this.eventBus?.publish({ type: "config.binariesChanged", binaries: this.list() })
  }

  private validateRecord(record: BinaryRecord): BinaryValidationResult {
    const inputPath = record.path
    if (!inputPath) {
      return { valid: false, error: "Missing binary path" }
    }

    const spec = buildSpawnSpec(inputPath, ["--version"])

    try {
      const result = spawnSync(spec.command, spec.args, {
        encoding: "utf8",
        windowsVerbatimArguments: Boolean((spec.options as { windowsVerbatimArguments?: boolean }).windowsVerbatimArguments),
      })

      if (result.error) {
        return { valid: false, error: result.error.message }
      }

      if (result.status !== 0) {
        const stderr = result.stderr?.trim()
        const stdout = result.stdout?.trim()
        const combined = stderr || stdout
        const error = combined ? `Exited with code ${result.status}: ${combined}` : `Exited with code ${result.status}`
        return { valid: false, error }
      }

      const stdout = (result.stdout ?? "").trim()
      const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
      const normalized = firstLine?.trim()

      const versionMatch = normalized?.match(/([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+)/)
      const version = versionMatch?.[1]

      return { valid: true, version }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) }
    }
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
