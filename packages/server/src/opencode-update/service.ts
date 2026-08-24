import { spawn } from "node:child_process"
import { fetch } from "undici"
import type { OpenCodeUpdateResponse, OpenCodeUpdateStatus } from "../api-types"
import type { SettingsService } from "../settings/service"
import { BinaryResolver, type ResolvedBinary } from "../settings/binaries"
import type { WorkspaceManager } from "../workspaces/manager"
import { probeBinaryVersion } from "../workspaces/spawn"
import { compareVersionStrings, stripTagPrefix } from "../releases/release-monitor"

const OPENCODE_PACKAGE_NAME = "@opencode-ai/cli"
const OPENCODE_REGISTRY_URL = "https://registry.npmjs.org/-/package/%40opencode-ai%2Fcli/dist-tags"
export const TARGET_OPENCODE_CHANNEL = "beta"
const inFlightUpgrades = new Map<string, Promise<OpenCodeUpdateResponse>>()

type UpgradeResult = { success: true; version: string } | { success: false; error: string }

export interface OpenCodeUpdateServiceDeps {
  resolveBinary: () => ResolvedBinary
  probeBinary: typeof probeBinaryVersion
  resolveLatestVersion: () => Promise<string>
  canUpgradeBinary: (binary: ResolvedBinary) => boolean
  upgradeBinary: (binary: ResolvedBinary, target: string) => Promise<UpgradeResult>
}

export class OpenCodeUpdateError extends Error {
  constructor(
    readonly code:
      | "binary_unavailable"
      | "unsupported_binary"
      | "update_check_failed"
      | "upgrade_failed"
      | "upgrade_verification_failed",
    message: string,
  ) {
    super(message)
    this.name = "OpenCodeUpdateError"
  }
}

export class OpenCodeUpdateService {
  constructor(private readonly deps: OpenCodeUpdateServiceDeps) {}

  async getStatus(): Promise<OpenCodeUpdateStatus> {
    const binary = this.deps.resolveBinary()
    const currentVersion = this.readCurrentVersion(binary.path)
    const latestVersion = await this.readLatestVersion()
    const updateAvailable = compareOpenCodeVersionStrings(latestVersion, currentVersion) > 0
    const canUpgrade = this.deps.canUpgradeBinary(binary)

    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      canUpgrade: updateAvailable && canUpgrade,
    }
  }

  upgrade(): Promise<OpenCodeUpdateResponse> {
    const binary = this.deps.resolveBinary()
    const existing = inFlightUpgrades.get(binary.path)
    if (existing) return existing

    const pending = this.performUpgrade(binary).finally(() => {
      if (inFlightUpgrades.get(binary.path) === pending) inFlightUpgrades.delete(binary.path)
    })
    inFlightUpgrades.set(binary.path, pending)
    return pending
  }

  private async performUpgrade(binary: ResolvedBinary): Promise<OpenCodeUpdateResponse> {
    const currentVersion = this.readCurrentVersion(binary.path)
    const latestVersion = await this.readLatestVersion()

    if (compareOpenCodeVersionStrings(latestVersion, currentVersion) <= 0) {
      return { success: true, version: currentVersion }
    }

    if (!this.deps.canUpgradeBinary(binary)) {
      throw new OpenCodeUpdateError(
        "unsupported_binary",
        "Automatic updates are only available for the managed opencode2 command",
      )
    }

    try {
      const result = await this.deps.upgradeBinary(binary, latestVersion)
      if (!result.success) {
        throw new OpenCodeUpdateError("upgrade_failed", result.error)
      }
      const installedVersion = this.readCurrentVersion(binary.path)
      if (installedVersion !== latestVersion) {
        throw new OpenCodeUpdateError(
          "upgrade_verification_failed",
          `OpenCode reported ${result.version}, but the configured binary is ${installedVersion} instead of ${latestVersion}`,
        )
      }
      return { success: true, version: installedVersion }
    } catch (error) {
      if (error instanceof OpenCodeUpdateError) throw error
      throw new OpenCodeUpdateError(
        "upgrade_failed",
        error instanceof Error ? error.message : "OpenCode upgrade failed",
      )
    }
  }

  private readCurrentVersion(binaryPath: string): string {
    if (process.platform === "win32" && /["\r\n]/.test(binaryPath)) {
      throw new OpenCodeUpdateError("binary_unavailable", "The configured OpenCode binary path is invalid")
    }
    const result = this.deps.probeBinary(binaryPath)
    const version = stripTagPrefix(result.version)
    if (!result.valid || !version) {
      throw new OpenCodeUpdateError("binary_unavailable", result.error ?? "Unable to read OpenCode version")
    }
    return version
  }

  private async readLatestVersion(): Promise<string> {
    try {
      const version = stripTagPrefix(await this.deps.resolveLatestVersion())
      if (!version) throw new Error(`The ${TARGET_OPENCODE_CHANNEL} channel did not resolve to a version`)
      return version
    } catch (error) {
      throw new OpenCodeUpdateError(
        "update_check_failed",
        error instanceof Error ? error.message : "Unable to resolve the latest OpenCode beta",
      )
    }
  }
}

export type OpenCodePackageManager = "npm" | "pnpm" | "bun" | "yarn"

export function compareOpenCodeVersionStrings(left: string, right: string): number {
  const leftBeta = stripTagPrefix(left)?.match(/^0\.0\.0-beta-(\d+)$/)
  const rightBeta = stripTagPrefix(right)?.match(/^0\.0\.0-beta-(\d+)$/)
  if (leftBeta && rightBeta) return Number(leftBeta[1]) - Number(rightBeta[1])
  return compareVersionStrings(left, right)
}

export function detectOpenCodePackageManager(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenCodePackageManager {
  const pathSource = binaryPath.toLowerCase()
  const launchSource = `${env.npm_config_user_agent ?? ""}\n${env.npm_execpath ?? ""}`.toLowerCase()
  if (pathSource.includes("pnpm")) return "pnpm"
  if (/[\\/]\.bun[\\/]/.test(pathSource)) return "bun"
  if (pathSource.includes("yarn")) return "yarn"
  if (/[\\/]npm[\\/]/.test(pathSource)) return "npm"
  if (launchSource.includes("pnpm")) return "pnpm"
  if (/(^|[\s/])bun(?:$|[\s/])/.test(launchSource)) return "bun"
  if (launchSource.includes("yarn")) return "yarn"
  return "npm"
}

export function buildOpenCodeUpgradeCommand(
  version: string,
  packageManager: OpenCodePackageManager,
): { command: string; args: string[] } {
  const packageSpec = `${OPENCODE_PACKAGE_NAME}@${version}`
  if (packageManager === "pnpm") {
    return { command: "pnpm", args: ["add", "-g", `--allow-build=${OPENCODE_PACKAGE_NAME}`, packageSpec] }
  }
  if (packageManager === "bun") {
    return { command: "bun", args: ["install", "-g", "--trust", packageSpec] }
  }
  if (packageManager === "yarn") {
    return { command: "yarn", args: ["global", "add", packageSpec] }
  }
  return { command: "npm", args: ["install", "-g", packageSpec] }
}

export function installOpenCodeCli(
  binary: ResolvedBinary,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpgradeResult> {
  const upgrade = buildOpenCodeUpgradeCommand(version, detectOpenCodePackageManager(binary.path, env))
  return new Promise((resolve) => {
    const child = spawn(upgrade.command, upgrade.args, {
      env,
      shell: process.platform === "win32",
      stdio: "ignore",
      windowsHide: true,
    })
    child.once("error", (error) => resolve({ success: false, error: error.message }))
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve({ success: false, error: `OpenCode update stopped by signal ${signal}` })
        return
      }
      if (code !== 0) {
        resolve({ success: false, error: `OpenCode update exited with code ${code ?? "unknown"}` })
        return
      }
      resolve({ success: true, version })
    })
  })
}

type RegistryFetch = (
  url: string,
  init: Parameters<typeof fetch>[1],
) => Promise<Pick<Awaited<ReturnType<typeof fetch>>, "ok" | "status" | "json">>

export async function resolveLatestOpenCodeVersion(fetchRegistry: RegistryFetch = fetch): Promise<string> {
  const response = await fetchRegistry(OPENCODE_REGISTRY_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`OpenCode registry responded with ${response.status}`)

  const metadata = (await response.json()) as Record<string, unknown>
  const version = metadata[TARGET_OPENCODE_CHANNEL]
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`The ${TARGET_OPENCODE_CHANNEL} channel did not resolve to a valid version`)
  }
  return version
}

export function createOpenCodeUpdateService(
  settings: SettingsService,
  workspaceManager: WorkspaceManager,
): OpenCodeUpdateService {
  const binaryResolver = new BinaryResolver(settings)
  return new OpenCodeUpdateService({
    resolveBinary: () => {
      const binary = binaryResolver.resolveDefault()
      return { ...binary, path: workspaceManager.resolveBinaryPath(binary.path) }
    },
    probeBinary: probeBinaryVersion,
    resolveLatestVersion: resolveLatestOpenCodeVersion,
    canUpgradeBinary: () => binaryResolver.resolveDefault().path === "opencode2",
    upgradeBinary: installOpenCodeCli,
  })
}
