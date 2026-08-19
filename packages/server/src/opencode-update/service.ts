import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import type { OpenCodeUpdateResponse, OpenCodeUpdateStatus } from "../api-types"
import type { SettingsService } from "../settings/service"
import { BinaryResolver, type ResolvedBinary } from "../settings/binaries"
import type { WorkspaceManager } from "../workspaces/manager"
import { probeBinaryVersion } from "../workspaces/spawn"
import { compareVersionStrings, stripTagPrefix } from "../releases/release-monitor"

const OPENCODE_PACKAGE_NAME = "@opencode-ai/cli"
const require = createRequire(import.meta.url)
const packageJson = require("../../package.json") as { dependencies: { "@opencode-ai/client": string } }
export const TARGET_OPENCODE_VERSION = packageJson.dependencies["@opencode-ai/client"]
const inFlightUpgrades = new Map<string, Promise<OpenCodeUpdateResponse>>()

type UpgradeResult = { success: true; version: string } | { success: false; error: string }

export interface OpenCodeUpdateServiceDeps {
  resolveBinary: () => ResolvedBinary
  probeBinary: typeof probeBinaryVersion
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
    const latestVersion = TARGET_OPENCODE_VERSION
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
    const latestVersion = TARGET_OPENCODE_VERSION

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
      if (compareOpenCodeVersionStrings(installedVersion, latestVersion) !== 0) {
        throw new OpenCodeUpdateError(
          "upgrade_verification_failed",
          `OpenCode reported ${result.version}, but the configured binary is still ${installedVersion}`,
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
    canUpgradeBinary: () => binaryResolver.resolveDefault().path === "opencode2",
    upgradeBinary: installOpenCodeCli,
  })
}
