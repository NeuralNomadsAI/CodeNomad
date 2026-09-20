import { fetch } from "undici"
import type { OpenCodeUpdateResponse, OpenCodeUpdateStatus } from "../api-types"
import type { SettingsService } from "../settings/service"
import { BinaryResolver, type ResolvedBinary } from "../settings/binaries"
import type { WorkspaceManager } from "../workspaces/manager"
import { probeBinaryVersion, probeBinaryVersionAsync } from "../workspaces/spawn"
import { compareVersionStrings, stripTagPrefix } from "../releases/release-monitor"
import { assertSupportedOpenCode, isBelowOpenCodeMinimum, MINIMUM_OPENCODE_VERSION, RECOMMENDED_OPENCODE_VERSION, UnsupportedOpenCodeError } from "../opencode/runtime-support"
import { contractProfile, runtimeIdentity } from "../opencode/compatibility/runtime"
import { createRuntimeTransport } from "../opencode/compatibility/transport"
import type { Endpoint } from "@opencode/client/service"
import { bundledNpm, installManagedOpenCode } from "./managed-installation"
import type { OpenCodeServiceLifecycle } from "../workspaces/opencode-service"
import { parseWslUncPath } from "../workspaces/spawn"

const OPENCODE_REGISTRY_URL = "https://registry.npmjs.org/-/package/%40opencode%2Fcli/dist-tags"
export const TARGET_OPENCODE_CHANNEL = "latest"
const inFlightUpgrades = new Map<string, Promise<OpenCodeUpdateResponse>>()
type ServiceAction = "start" | "restart" | "reload"

type UpgradeResult = { success: true; version: string } | { success: false; error: string }

export interface OpenCodeUpdateServiceDeps {
  resolveBinary: () => ResolvedBinary
  probeBinary: (path: string) => ReturnType<typeof probeBinaryVersion> | Promise<ReturnType<typeof probeBinaryVersion>>
  resolveLatestVersion: () => Promise<string>
  canUpgradeBinary: (binary: ResolvedBinary) => boolean
  upgradeBinary: (binary: ResolvedBinary, target: string) => Promise<UpgradeResult>
  lifecycle?: (binary: ResolvedBinary) => Promise<OpenCodeServiceLifecycle>
  reconnect?: (binary: ResolvedBinary) => Promise<void>
  admitActivation?: (binary: ResolvedBinary) => void
  reload?: (binary: ResolvedBinary, assertCurrent: () => void) => Promise<void>
  inspectRuntime?: (endpoint: Endpoint) => Promise<{ reload: boolean }>
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
  private activation?: { binaryPath: string; action: ServiceAction; pending: Promise<OpenCodeUpdateStatus> }

  constructor(private readonly deps: OpenCodeUpdateServiceDeps) {}

  async getStatus(): Promise<OpenCodeUpdateStatus> {
    const binary = this.deps.resolveBinary()
    let currentVersion: string | null = null
    let missing = false
    let invalid = false
    const probe = await this.deps.probeBinary(binary.path)
    try { currentVersion = await this.readCurrentVersion(binary.path, probe) }
    catch { missing = probe.missing === true; invalid = !missing }
    let latestVersion: string | null = null
    try { latestVersion = await this.readLatestVersion() } catch { /* Local admission remains available offline. */ }
    const state = invalid ? "error" : missing ? "missing"
      : currentVersion && !isBelowOpenCodeMinimum(currentVersion) ? "ready" : "update_required"
    const updateAvailable = latestVersion && (!currentVersion || comparableVersion(currentVersion))
      ? !currentVersion || compareOpenCodeVersionStrings(latestVersion, currentVersion) > 0 : null
    const status: OpenCodeUpdateStatus = {
      currentVersion, latestVersion, updateAvailable,
      canUpgrade: !invalid && Boolean(updateAvailable) && Boolean(latestVersion && !isBelowOpenCodeMinimum(latestVersion)) && this.deps.canUpgradeBinary(binary),
      minimumVersion: MINIMUM_OPENCODE_VERSION, recommendedVersion: RECOMMENDED_OPENCODE_VERSION,
      versionAssessment: "untested", state, binaryPath: binary.path,
      target: parseWslUncPath(binary.path) ? "wsl" : "host", canRestart: false,
      ...(!latestVersion ? { checkError: "update_check_failed" as const } : {}),
    }
    if (!missing && !invalid && this.deps.lifecycle) {
      try {
        const lifecycle = await this.deps.lifecycle(binary)
        const endpoint = await lifecycle.discover()
        const identity = endpoint && runtimeIdentity(endpoint)
        status.daemonVersion = identity?.version
        const olderDaemon = identity && currentVersion && comparableVersion(identity.version) && comparableVersion(currentVersion)
          && compareOpenCodeVersionStrings(currentVersion, identity.version) > 0
        status.serviceState = "stopped"
        if (endpoint) {
          try {
            const capabilities = await this.inspectRuntime(endpoint)
            status.serviceState = olderDaemon ? "restart_available" : "ready"
            // The running daemon, not an older discovery CLI, serves requests.
            status.state = "ready"
            status.canReload = Boolean(this.deps.reload) && capabilities.reload
          } catch (error) {
            if (!(error instanceof UnsupportedOpenCodeError)) throw error
            status.incompatibilityReason = error.reason
            status.serviceState = olderDaemon ? "restart_required" : "incompatible"
          }
        }
        status.canRestart = Boolean(lifecycle.restart) && state === "ready"
          && (status.serviceState === "restart_required" || status.serviceState === "restart_available")
      } catch { status.serviceState = "error"; status.serviceError = "service_check_failed" }
    }
    const effectiveVersion = status.daemonVersion ?? currentVersion
    if (!status.incompatibilityReason && effectiveVersion && isBelowOpenCodeMinimum(effectiveVersion)) status.incompatibilityReason = "step_timestamp"
    status.versionAssessment = status.incompatibilityReason ? "incompatible"
      : effectiveVersion === RECOMMENDED_OPENCODE_VERSION ? "tested" : "untested"
    return status
  }

  private async inspectRuntime(endpoint: Endpoint): Promise<{ reload: boolean }> {
    const identity = runtimeIdentity(endpoint)
    if (!identity) throw new Error("OpenCode did not report an authenticated runtime version")
    assertSupportedOpenCode(identity.version)
    if (this.deps.inspectRuntime) return this.deps.inspectRuntime(endpoint)
    await createRuntimeTransport(endpoint).profile()
    return { reload: identity.contract?.reload ?? contractProfile(identity) === "modern" }
  }

  start(restart = false): Promise<OpenCodeUpdateStatus> {
    return this.runServiceAction(restart ? "restart" : "start")
  }

  reload(): Promise<OpenCodeUpdateStatus> {
    return this.runServiceAction("reload")
  }

  private runServiceAction(action: ServiceAction): Promise<OpenCodeUpdateStatus> {
    const binary = this.deps.resolveBinary()
    // One updater owns one manager/shared-service authority. Executable selection
    // is mutable and cannot be the lock key for daemon-wide operations.
    const existing = this.activation
    if (existing) return existing.action === action && existing.binaryPath === binary.path
      ? existing.pending : Promise.reject(new Error("Another OpenCode service action is in progress"))
    const pending = this.activate(binary, action).finally(() => {
      if (this.activation?.pending === pending) this.activation = undefined
    })
    this.activation = { binaryPath: binary.path, action, pending }
    return pending
  }

  private async activate(binary: ResolvedBinary, action: ServiceAction): Promise<OpenCodeUpdateStatus> {
    const restart = action === "restart"
    const installedVersion = await this.readCurrentVersion(binary.path)
    const lifecycle = await this.deps.lifecycle?.(binary)
    if (!lifecycle) throw new Error("OpenCode service lifecycle unavailable")
    const previous = await lifecycle.discover()
    if (!previous || restart) assertSupportedOpenCode(installedVersion)
    if (restart && previous) {
      const identity = runtimeIdentity(previous)
      if (!identity || !comparableVersion(identity.version) || !comparableVersion(installedVersion)
        || compareOpenCodeVersionStrings(installedVersion, identity.version) <= 0) {
        throw new Error("The shared daemon is not an older runtime eligible for this update")
      }
    }
    const assertCurrent = () => {
      if (this.deps.resolveBinary().path !== binary.path) throw new Error("OpenCode selection changed during activation")
      this.deps.admitActivation?.(binary)
    }
    assertCurrent()
    if (action === "reload") {
      const identity = previous && runtimeIdentity(previous)
      if (!identity || !this.deps.reload) throw new Error("OpenCode configuration reload unavailable")
      const capabilities = await this.inspectRuntime(previous!)
      if (!capabilities.reload) throw new Error("OpenCode does not expose configuration reload")
      assertCurrent()
      // Explicit daemon-wide mutation: never use this as an automatic watcher
      // fallback, because native reload cancels pending Forms and permissions.
      await this.deps.reload(binary, assertCurrent)
      assertCurrent()
      return this.getStatus()
    }
    const endpoint = restart && previous ? await lifecycle.restart?.() : previous ?? await lifecycle.ensure()
    const identity = endpoint && runtimeIdentity(endpoint)
    if (!identity) throw new Error("OpenCode did not report an authenticated runtime version")
    await this.inspectRuntime(endpoint!)
    if (this.deps.resolveBinary().path !== binary.path) throw new Error("OpenCode selection changed during activation")
    await this.deps.reconnect?.(binary)
    return this.getStatus()
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
    const probe = await this.deps.probeBinary(binary.path)
    const currentVersion = probe.missing ? null : await this.readCurrentVersion(binary.path, probe)
    const latestVersion = await this.readLatestVersion()
    assertSupportedOpenCode(latestVersion)

    if (currentVersion && !comparableVersion(currentVersion)) {
      throw new OpenCodeUpdateError("unsupported_binary", "Cannot order this custom OpenCode version for an automatic update")
    }

    if (currentVersion && compareOpenCodeVersionStrings(latestVersion, currentVersion) <= 0) {
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
      const installedVersion = await this.readCurrentVersion(this.deps.resolveBinary().path)
      if (isBelowOpenCodeMinimum(installedVersion) || !/^\d+\.\d+\.\d+$/.test(installedVersion) || compareOpenCodeVersionStrings(installedVersion, latestVersion) < 0) {
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

  private async readCurrentVersion(binaryPath: string, probe?: ReturnType<typeof probeBinaryVersion>): Promise<string> {
    if (process.platform === "win32" && /["\r\n]/.test(binaryPath)) {
      throw new OpenCodeUpdateError("binary_unavailable", "The configured OpenCode binary path is invalid")
    }
    const result = probe ?? await this.deps.probeBinary(binaryPath)
    if (!result.valid) {
      throw new OpenCodeUpdateError("binary_unavailable", result.error ?? "Unable to read OpenCode version")
    }
    // Successful unknown/empty labels are diagnostic information. Admission is
    // established against the authenticated daemon, not inferred from this label.
    return result.version?.trim() || "unknown"
  }

  private async readLatestVersion(): Promise<string> {
    try {
      const version = stripTagPrefix(await this.deps.resolveLatestVersion())
      if (!version) throw new Error(`The ${TARGET_OPENCODE_CHANNEL} channel did not resolve to a version`)
      return version
    } catch (error) {
      throw new OpenCodeUpdateError(
        "update_check_failed",
        error instanceof Error ? error.message : "Unable to resolve the latest stable OpenCode release",
      )
    }
  }
}

export function compareOpenCodeVersionStrings(left: string, right: string): number {
  const leftBeta = stripTagPrefix(left)?.match(/^0\.0\.0-beta-(\d+)$/)
  const rightBeta = stripTagPrefix(right)?.match(/^0\.0\.0-beta-(\d+)$/)
  if (leftBeta && rightBeta) return Number(leftBeta[1]) - Number(rightBeta[1])
  return compareVersionStrings(left, right)
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
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
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
    probeBinary: probeBinaryVersionAsync,
    resolveLatestVersion: resolveLatestOpenCodeVersion,
    canUpgradeBinary: () => {
      const configured = settings.getOwner("config", "server").opencodeBinary
      return (!configured || configured === "opencode" || configured === "opencode2") && Boolean(bundledNpm())
    },
    upgradeBinary: async (_binary, version) => {
      await installManagedOpenCode(version)
      return { success: true, version }
    },
    lifecycle: binary => workspaceManager.setupServiceOptions(binary.path).then(options => options.lifecycle),
    reconnect: binary => workspaceManager.reconnectAfterSetup(binary.path),
    admitActivation: binary => workspaceManager.assertSetupExecutionHost(binary.path),
    reload: (binary, assertCurrent) => workspaceManager.reloadConfigurationAfterSetup(binary.path, assertCurrent),
  })
}

function comparableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version) || /^0\.0\.0-beta-\d+$/.test(version)
}
