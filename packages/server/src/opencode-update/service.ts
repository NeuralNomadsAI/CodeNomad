import { fetch } from "undici"
import type { OpenCodeUpdateResponse, OpenCodeUpdateStatus } from "../api-types"
import type { SettingsService } from "../settings/service"
import { BinaryResolver, type ResolvedBinary } from "../settings/binaries"
import type { WorkspaceManager } from "../workspaces/manager"
import { createInstanceClient } from "../workspaces/instance-client"
import { probeBinaryVersion } from "../workspaces/spawn"
import { compareVersionStrings, stripTagPrefix } from "../releases/release-monitor"

const OPENCODE_LATEST_URL = "https://registry.npmjs.org/opencode-ai/latest"
const LATEST_VERSION_CACHE_MS = 5 * 60_000

type UpgradeResult = { success: true; version: string } | { success: false; error: string }

export interface OpenCodeUpdateServiceDeps {
  resolveBinary: (binaryPath?: string) => ResolvedBinary
  probeBinary: typeof probeBinaryVersion
  findReadyInstanceId: (binaryPath: string) => string | undefined
  upgradeInstance: (instanceId: string, target: string) => Promise<UpgradeResult>
  fetchLatestVersion: () => Promise<string>
  now?: () => number
}

export class OpenCodeUpdateError extends Error {
  constructor(
    readonly code: "binary_unavailable" | "no_ready_instance" | "update_check_failed" | "upgrade_failed",
    message: string,
  ) {
    super(message)
    this.name = "OpenCodeUpdateError"
  }
}

export class OpenCodeUpdateService {
  private latestVersionCache: { version: string; expiresAt: number } | null = null

  constructor(private readonly deps: OpenCodeUpdateServiceDeps) {}

  async getStatus(binaryPath?: string): Promise<OpenCodeUpdateStatus> {
    const binary = this.deps.resolveBinary(binaryPath)
    const currentVersion = this.readCurrentVersion(binary.path)
    const latestVersion = await this.readLatestVersion()
    const updateAvailable = compareVersionStrings(latestVersion, currentVersion) > 0
    const readyInstanceId = this.deps.findReadyInstanceId(binary.path)

    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      canUpgrade: updateAvailable && Boolean(readyInstanceId),
    }
  }

  async upgrade(binaryPath?: string): Promise<OpenCodeUpdateResponse> {
    const binary = this.deps.resolveBinary(binaryPath)
    const currentVersion = this.readCurrentVersion(binary.path)
    const latestVersion = await this.readLatestVersion()

    if (compareVersionStrings(latestVersion, currentVersion) <= 0) {
      return { success: true, version: currentVersion }
    }

    const instanceId = this.deps.findReadyInstanceId(binary.path)
    if (!instanceId) {
      throw new OpenCodeUpdateError(
        "no_ready_instance",
        "No running OpenCode instance uses the configured binary",
      )
    }

    try {
      const result = await this.deps.upgradeInstance(instanceId, latestVersion)
      if (!result.success) {
        throw new OpenCodeUpdateError("upgrade_failed", result.error)
      }
      return result
    } catch (error) {
      if (error instanceof OpenCodeUpdateError) throw error
      throw new OpenCodeUpdateError(
        "upgrade_failed",
        error instanceof Error ? error.message : "OpenCode upgrade failed",
      )
    }
  }

  private readCurrentVersion(binaryPath: string): string {
    const result = this.deps.probeBinary(binaryPath)
    const version = stripTagPrefix(result.version)
    if (!result.valid || !version) {
      throw new OpenCodeUpdateError("binary_unavailable", result.error ?? "Unable to read OpenCode version")
    }
    return version
  }

  private async readLatestVersion(): Promise<string> {
    const now = (this.deps.now ?? Date.now)()
    if (this.latestVersionCache && this.latestVersionCache.expiresAt > now) {
      return this.latestVersionCache.version
    }

    try {
      const version = stripTagPrefix(await this.deps.fetchLatestVersion())
      if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error("OpenCode registry returned an invalid version")
      }
      this.latestVersionCache = { version, expiresAt: now + LATEST_VERSION_CACHE_MS }
      return version
    } catch (error) {
      throw new OpenCodeUpdateError(
        "update_check_failed",
        error instanceof Error ? error.message : "Unable to check the latest OpenCode version",
      )
    }
  }
}

export async function fetchLatestOpenCodeVersion(): Promise<string> {
  const response = await fetch(OPENCODE_LATEST_URL, {
    headers: { Accept: "application/json", "User-Agent": "CodeNomad-CLI" },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`OpenCode registry responded with ${response.status}`)
  }
  const payload = (await response.json()) as { version?: unknown }
  if (typeof payload.version !== "string") {
    throw new Error("OpenCode registry response did not include a version")
  }
  return payload.version
}

export function createOpenCodeUpdateService(
  settings: SettingsService,
  workspaceManager: WorkspaceManager,
): OpenCodeUpdateService {
  const binaryResolver = new BinaryResolver(settings)
  return new OpenCodeUpdateService({
    resolveBinary: (binaryPath) => binaryPath
      ? { path: binaryPath, label: binaryPath }
      : binaryResolver.resolveDefault(),
    probeBinary: probeBinaryVersion,
    findReadyInstanceId: (binaryPath) => workspaceManager.findReadyInstanceIdByBinary(binaryPath),
    fetchLatestVersion: fetchLatestOpenCodeVersion,
    upgradeInstance: async (instanceId, target) => {
      const client = createInstanceClient(workspaceManager, instanceId)
      if (!client) {
        throw new OpenCodeUpdateError("no_ready_instance", "OpenCode instance is not ready")
      }
      const { data } = await client.global.upgrade({ target }, { throwOnError: true })
      return data
    },
  })
}
