import { constants, existsSync } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LoginStartResponse } from "../api-types"
import { BinaryResolver } from "../settings/binaries"
import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import { buildSpawnSpec, parseWslUncPath } from "../workspaces/spawn"
import { WindowsLoginStart } from "./opencode-login-start-windows"
import { LINUX_SYSTEMCTL, LinuxLoginStart, MacosLoginStart } from "./opencode-login-start-posix"
import { legacySupervision, type LegacySupervision } from "./opencode-login-start-legacy"

export type LoginStartErrorCode = "unavailable" | "unsupported-binary" | "failed"
export class LoginStartError extends Error {
  constructor(readonly code: LoginStartErrorCode) { super(`login-start-${code}`) }
}

/** The exact program the OS starts at login: `opencode serve --service`, or the
 * same through `wsl.exe` for a Windows-to-WSL selection. Never a shell command.
 * On macOS and Linux, `environment` carries only the server's PATH; a Windows task
 * inherits the session environment. */
export interface LoginStartLaunch { command: string; args: string[]; environment?: { PATH: string } }

/** One OS artifact per account: a Windows logon task, a macOS LaunchAgent or a
 * systemd user unit. Its presence is the preference; there is no other store. */
export interface LoginStartPlatform {
  installed(): Promise<boolean>
  /** Idempotent; replaces only an artifact this platform owns. */
  install(launch: LoginStartLaunch): Promise<void>
  /** Idempotent; removes only the owned artifact and never stops OpenCode. */
  remove(): Promise<void>
}

export const SERVE_ARGS = ["serve", "--service"]

export async function resolveLoginStartLaunch(selected: string, platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env): Promise<LoginStartLaunch> {
  const unsupported = () => new LoginStartError("unsupported-binary")
  if (platform !== "win32") {
    if (!path.posix.isAbsolute(selected)) throw unsupported()
    await assertExecutable(selected, true)
    const environment = loginStartEnvironment(env)
    return { command: selected, args: [...SERVE_ARGS], ...(environment ? { environment } : {}) }
  }
  if (parseWslUncPath(selected)?.linuxPath === "/") throw unsupported()
  let spec: ReturnType<typeof buildSpawnSpec>
  try { spec = buildSpawnSpec(selected, SERVE_ARGS, { env, platform }) } catch { throw unsupported() }
  if (spec.command === "wsl.exe") {
    const system = env.SystemRoot
    if (!system || !path.win32.isAbsolute(system)) throw unsupported()
    return { command: path.win32.join(system, "System32", "wsl.exe"), args: spec.args }
  }
  // Command wrappers (.cmd, .ps1) and bare names stay unsupported: Task Scheduler
  // receives only the native image that CodeNomad itself would start.
  if (spec.options.windowsVerbatimArguments || !path.win32.isAbsolute(spec.command)
    || path.win32.extname(spec.command).toLowerCase() !== ".exe") throw unsupported()
  await assertExecutable(spec.command, false)
  return { command: spec.command, args: spec.args }
}

/** launchd and the systemd user manager get only the server's PATH, as it is at the
 * last ON or refresh; nothing else from the server environment is persisted. */
export function loginStartEnvironment(env: NodeJS.ProcessEnv): { PATH: string } | undefined {
  return env.PATH ? { PATH: env.PATH } : undefined
}

/** The artifact keeps the selected path, not its link target: package managers
 * (Homebrew, Scoop, WinGet) link a stable path to a versioned one they replace. */
async function assertExecutable(file: string, posix: boolean) {
  const target = await realpath(file).catch(() => undefined)
  const info = target ? await stat(target).catch(() => undefined) : undefined
  if (!info?.isFile() || posix && await access(target!, constants.X_OK).then(() => false, () => true))
    throw new LoginStartError("unsupported-binary")
}

export function loginStartPlatform(): LoginStartPlatform | undefined {
  if (process.platform === "win32") return new WindowsLoginStart()
  if (process.platform === "darwin") return new MacosLoginStart()
  // A server running inside WSL starts with its distribution, not at Windows login.
  if (process.platform === "linux" && !process.env.WSL_DISTRO_NAME && !/microsoft/i.test(os.release())
    && existsSync(LINUX_SYSTEMCTL)) return new LinuxLoginStart()
  return undefined
}

/** Voluntary, off by default. Reads, changes and the replacement of the former
 * supervision run one at a time; they only write or remove the OS artifact. */
export class OpenCodeLoginStart {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: { platform?: LoginStartPlatform; launch(): Promise<LoginStartLaunch>; legacy?: LegacySupervision }) {}

  read(): Promise<LoginStartResponse> {
    return this.serial(async () => {
      // A former ON whose replacement is refused still starts OpenCode at login.
      const formerOn = await this.migrate()
      const status = await this.status()
      return formerOn && status.state === "off" ? { state: "on" } : status
    })
  }

  set(enabled: boolean): Promise<LoginStartResponse> {
    return this.serial(async () => {
      const platform = this.deps.platform
      if (!platform) throw new LoginStartError("unavailable")
      await this.migrate(enabled)
      if (enabled) await this.install(platform)
      else await platform.remove().catch(() => { throw new LoginStartError("failed") })
      return this.status()
    })
  }

  /** After an explicit executable change: an installed artifact follows it. */
  refresh(): Promise<void> {
    return this.serial(async () => {
      const platform = this.deps.platform
      if (platform && await platform.installed()) await this.install(platform)
    })
  }

  private async status(): Promise<LoginStartResponse> {
    const platform = this.deps.platform
    if (!platform) return { state: "unavailable" }
    return { state: await platform.installed().catch(() => { throw new LoginStartError("failed") }) ? "on" : "off" }
  }

  private async install(platform: LoginStartPlatform) {
    const launch = await this.deps.launch()
    await platform.install(launch).catch(() => { throw new LoginStartError("failed") })
  }

  /** A former supervision ON keeps a login start: the new artifact is installed
   * first and the old resources are retired only once it exists. An explicit OFF
   * retires them without installing. Returns whether a former ON stays in place. */
  private async migrate(enabled?: boolean): Promise<boolean> {
    const { platform, legacy } = this.deps
    if (!platform || !legacy) return false
    const found = await legacy.scan().catch(() => undefined)
    if (!found?.present) return false
    if (found.on && enabled !== false && !await platform.installed().catch(() => false)) {
      try { await this.install(platform) } catch { return true }
    }
    await legacy.retire().catch(() => { /* Incomplete steps are retried on the next pass. */ })
    // An explicit OFF must not leave a former ON that the next read would turn back on.
    if (enabled === false && found.on && (await legacy.scan().catch(() => found)).on) throw new LoginStartError("failed")
    return false
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }
}

export function createOpenCodeLoginStart(settings: SettingsService, manager: Pick<WorkspaceManager, "resolveBinaryPath">) {
  const resolver = new BinaryResolver(settings)
  const loginStart = new OpenCodeLoginStart({ platform: loginStartPlatform(), legacy: legacySupervision(),
    launch: () => resolveLoginStartLaunch(manager.resolveBinaryPath(resolver.resolveDefault().path)) })
  // Replace a former supervision even while Preferences stay closed.
  void loginStart.read().catch(() => {})
  return loginStart
}
