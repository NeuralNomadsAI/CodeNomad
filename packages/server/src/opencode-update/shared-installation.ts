import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundledNpm, executeInstaller } from "./npm-runtime"
import { isRetiredInstallation } from "./retired-installation"
import { registerUserPath } from "./user-path"
import { probeBinaryVersion, probeBinaryVersionAsync, buildSpawnSpec } from "../workspaces/spawn"
import { assertSupportedOpenCode, isBelowOpenCodeMinimum } from "../opencode/runtime-support"
import { compareVersionStrings } from "../releases/release-monitor"
import { assertExecutableWritable, InstallationBusyError, withInstallationLock } from "./installation-lock"
import { upgradeSharedOpenCode } from "./native-upgrade"
import { isIncompleteWindowsNpmShim } from "./incomplete-installation"
import { LEGACY_NPM_PACKAGE, legacyNpmInstallation, legacyNpmPackageRoot, wingetInstallation, type LegacyNpmInstallation } from "./legacy-installation"

type VersionProbe = { valid: boolean; version?: string }

export interface InstallationHost {
  home?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Synchronous `--version` probe of a non-npm PATH command. */
  probeForeign?: (command: string) => VersionProbe
}

/** A PATH OpenCode that CodeNomad never modifies but no longer prefers. */
export interface ForeignOpenCode {
  command: string
  version?: string
  source: "winget" | "other"
  packageId?: string
}

export interface SharedInstallationPlan {
  /** Writable npm prefix where `@opencode/cli` is installed or updated. */
  prefix?: string
  /** OpenCode 1.x npm package that must be removed from `prefix` first, with explicit consent. */
  legacy?: LegacyNpmInstallation
  foreign?: ForeignOpenCode
}

export class LegacyReplacementError extends Error {
  constructor(readonly code: "legacy_replacement_required" | "legacy_removed_install_failed", message: string) {
    super(message)
  }
}

export function userNpmPrefix(host: InstallationHost = {}): string {
  const home = host.home ?? os.homedir()
  const env = host.env ?? process.env
  const configured = Object.entries(env).find(([key]) => key.toLowerCase() === "npm_config_prefix")?.[1]
  if (configured && path.isAbsolute(configured)) return configured
  return (host.platform ?? process.platform) === "win32"
    ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "npm") : path.join(home, ".local")
}

export function npmCommandDirectory(prefix: string, platform = process.platform): string {
  return platform === "win32" ? prefix : path.join(prefix, "bin")
}

export function npmExecutable(prefix: string, platform = process.platform): string {
  return path.join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules", "@opencode", "cli", "bin", "opencode.exe")
}

function npmPackage(prefix: string, platform: NodeJS.Platform) {
  try {
    const file = path.join(path.dirname(npmExecutable(prefix, platform)), "..", "package.json")
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { name?: string; bin?: Record<string, string> }
    return manifest.name === "@opencode/cli" ? manifest : undefined
  } catch { return undefined }
}

function npmLauncher(command: string, prefix: string, platform: NodeJS.Platform): string | undefined {
  const manifest = npmPackage(prefix, platform)
  if (!manifest?.bin) return undefined
  const name = path.basename(command).replace(platform === "win32" ? /\.cmd$/i : /$^/, "")
  const relative = manifest.bin[name]
  if (typeof relative !== "string" || !/^\.\/bin\/[^/\\]+\.exe$/.test(relative)) return undefined
  const packageRoot = path.join(path.dirname(npmExecutable(prefix, platform)), "..")
  const binary = path.resolve(packageRoot, relative)
  try {
    if (!statSync(binary).isFile()) return undefined
    const resolved = platform === "win32" ? buildSpawnSpec(command, [], { platform }).command : realpathSync(command)
    return realpathSync(resolved) === realpathSync(binary) ? binary : undefined
  } catch { return undefined }
}

function retiredNpmAlias(command: string, prefix: string, platform: NodeJS.Platform): boolean {
  const name = platform === "win32" ? path.basename(command).replace(/\.cmd$/i, "") : path.basename(command)
  const relative = npmPackage(prefix, platform)?.bin?.[name]
  if (typeof relative !== "string" || !/^\.\/bin\/[^/\\]+\.cjs$/.test(relative)) return false
  try {
    const target = path.resolve(path.dirname(npmExecutable(prefix, platform)), "..", relative)
    if (platform === "win32") {
      const script = readFileSync(command, "utf8")
      if (script.length > 64 * 1024) return false
      const escaped = path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      return statSync(target).isFile() && new RegExp(`["'](?:%dp0%|%~dp0)[\\\\/]node_modules[\\\\/]@opencode[\\\\/]cli[\\\\/]bin[\\\\/]${escaped}["']\\s+%\\*`, "i").test(script)
    }
    return realpathSync(command) === realpathSync(target)
  } catch { return false }
}

function npmCommand(prefix: string, platform: NodeJS.Platform): { command: string; binary: string } | undefined {
  const directory = npmCommandDirectory(prefix, platform)
  for (const name of ["opencode2", "opencode"]) {
    const command = path.join(directory, platform === "win32" ? `${name}.cmd` : name)
    const binary = npmLauncher(command, prefix, platform)
    if (binary) return { command, binary }
  }
}

export function findPathOpenCode(host: InstallationHost = {}): string | undefined {
  const env = host.env ?? process.env
  const platform = host.platform ?? process.platform
  const key = Object.keys(env).find(key => key.toLowerCase() === "path")
  const extensions = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";") : [""]
  for (const entry of (env[key ?? "PATH"] || "").split(platform === "win32" ? ";" : ":")) {
    const directory = entry.replace(/^"|"$/g, "")
    if (!directory || !path.isAbsolute(directory)) continue
    const prefix = platform === "win32" ? directory : path.dirname(directory)
    const inNpmBin = path.resolve(directory) === path.resolve(npmCommandDirectory(prefix, platform))
    for (const name of ["opencode2", "opencode"]) for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`)
      try {
        if (!statSync(candidate).isFile()) continue
        if (isRetiredInstallation(candidate)) continue
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK)
        if (inNpmBin && npmPackage(prefix, platform)) {
          if (retiredNpmAlias(candidate, prefix, platform)) continue
        }
        return candidate
      } catch { /* Continue in PATH order. */ }
    }
  }
}

export function resolveDefaultInstallation(host: InstallationHost = {}): { path: string; source?: "path" | "user" | "managed" } {
  const platform = host.platform ?? process.platform
  const prefix = userNpmPrefix(host)
  const managed = npmCommand(prefix, platform)
  const binary = managed?.binary ?? npmExecutable(prefix, platform)
  const command = findPathOpenCode(host)
  if (command) {
    if (platform === "win32" && isIncompleteWindowsNpmShim(command, prefix, binary)) return { path: binary, source: "user" }
    // A verified user npm `@opencode/cli` wins only over an OpenCode 1.x npm
    // shim or a foreign command that is below the minimum or cannot run.
    if (managed && supersededPathCommand(command, host)) return { path: managed.binary, source: "managed" }
    return { path: command, source: "path" }
  }
  if (existsSync(binary) && !isRetiredInstallation(binary)) return { path: binary, source: "user" }
  return { path: "opencode2" }
}

const foreignProbes = new Map<string, { key: string; result: VersionProbe }>()

/** Version probes of a foreign command are cached by its file identity. */
function probeForeignCommand(command: string): VersionProbe {
  let key = ""
  try { const stat = statSync(realpathSync(command)); key = `${stat.mtimeMs}:${stat.size}` } catch { /* Probe uncached. */ }
  const cached = foreignProbes.get(command)
  if (key && cached?.key === key) return cached.result
  const result = probeBinaryVersion(command)
  if (key) foreignProbes.set(command, { key, result })
  return result
}

/** Foreign commands are superseded only when they cannot run or report a
 * comparable version below the minimum; valid and custom-labelled builds keep
 * PATH precedence. */
function supersededForeign(command: string, host: InstallationHost): ForeignOpenCode | undefined {
  const platform = host.platform ?? process.platform
  const result = (host.probeForeign ?? probeForeignCommand)(command)
  const version = result.valid ? result.version?.trim() || undefined : undefined
  if (result.valid && !(version && /^(?:\d+\.\d+\.\d+|0\.0\.0-beta-\d+)$/.test(version) && isBelowOpenCodeMinimum(version))) return undefined
  const winget = wingetInstallation(command, host.env ?? process.env, platform)
  return { command, ...(version ? { version } : {}), source: winget ? "winget" : "other", ...(winget?.packageId ? { packageId: winget.packageId } : {}) }
}

function commandPrefix(command: string, platform: NodeJS.Platform) {
  return platform === "win32" ? path.dirname(command) : path.dirname(path.dirname(command))
}

function supersededPathCommand(command: string, host: InstallationHost): boolean {
  const platform = host.platform ?? process.platform
  const prefix = commandPrefix(command, platform)
  if (npmLauncher(command, prefix, platform)) return false
  if (legacyNpmInstallation(command, prefix, npmCommandDirectory(prefix, platform), platform)) return true
  return Boolean(supersededForeign(command, host))
}

function writable(prefix: string, allowMissing = false): boolean {
  try { accessSync(prefix, constants.W_OK); return true }
  catch (error) { return allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT" }
}

/** npm-managed OpenCode in `prefix` that CodeNomad may update, repair or (with consent) replace. */
function npmTarget(command: string, prefix: string, userPrefix: string, platform: NodeJS.Platform): SharedInstallationPlan | undefined {
  if (npmLauncher(command, prefix, platform)
    || (platform === "win32" && isIncompleteWindowsNpmShim(command, userPrefix, npmExecutable(userPrefix, platform)))) {
    return writable(prefix) ? { prefix } : {}
  }
  const legacy = legacyNpmInstallation(command, prefix, npmCommandDirectory(prefix, platform), platform)
  return legacy && writable(prefix) ? { prefix, legacy } : undefined
}

/** A verified `@opencode/cli` npm installation may be updated via npm. An
 * OpenCode 1.x `opencode-ai` npm shim in the same prefix may be replaced only
 * with explicit consent. Below-minimum or unusable foreign commands (winget,
 * Homebrew, curl, manual) are never modified: OpenCode 2 is installed in the
 * user npm prefix beside them. Valid foreign installations and explicit custom
 * executables retain their own installation authority. */
export function sharedInstallationPlan(host: InstallationHost = {}): SharedInstallationPlan {
  const platform = host.platform ?? process.platform
  const userPrefix = userNpmPrefix(host)
  if (isRetiredInstallation(userPrefix)) return {}
  const command = findPathOpenCode(host)
  const userCommand = findPathOpenCode({ ...host, env: { PATH: npmCommandDirectory(userPrefix, platform), PATHEXT: ".EXE;.CMD;.BAT" } })
  if (!command) return userCommand ? npmTarget(userCommand, userPrefix, userPrefix, platform) ?? {} : { prefix: userPrefix }
  const target = npmTarget(command, commandPrefix(command, platform), userPrefix, platform)
  if (target) return target
  const foreign = supersededForeign(command, host)
  if (!foreign) return {}
  if (!userCommand) return writable(userPrefix, true) ? { prefix: userPrefix, foreign } : { foreign }
  return { ...npmTarget(userCommand, userPrefix, userPrefix, platform), foreign }
}

export function sharedInstallPrefix(host: InstallationHost = {}): string | undefined {
  return sharedInstallationPlan(host).prefix
}

export async function installSharedOpenCode(version: string, options: InstallationHost & {
  node?: string; npm?: string
  execute?: typeof executeInstaller
  probe?: typeof probeBinaryVersionAsync
  registerPath?: (directory: string) => Promise<void>
  /** Explicit consent to remove an OpenCode 1.x npm package from the target prefix. */
  replaceLegacy?: boolean
} = {}): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Installation requires an exact stable OpenCode version")
  assertSupportedOpenCode(version)
  const platform = options.platform ?? process.platform
  const plan = sharedInstallationPlan(options)
  if (!plan.prefix) throw new Error("The PATH executable is not a writable npm installation")
  const prefix: string = plan.prefix
  if (plan.legacy && !options.replaceLegacy) {
    throw new LegacyReplacementError("legacy_replacement_required", "Replacing OpenCode 1.x requires explicit confirmation")
  }
  const node = options.node ?? process.execPath
  const bundled = options.npm ?? bundledNpm(node)
  if (!bundled) throw new Error("npm is unavailable beside the CodeNomad Node runtime")
  const npm: string = bundled
  const binary = npmExecutable(prefix, platform)
  const probe = options.probe ?? probeBinaryVersionAsync
  const npmEnvironment = () => {
    const env = { ...(options.env ?? process.env) }
    const key = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH"
    env[key] = `${path.dirname(node)}${platform === "win32" ? ";" : ":"}${env[key] || ""}`
    return env
  }
  return withInstallationLock(prefix, async () => {
    const current = sharedInstallationPlan(options)
    if (current.prefix !== prefix) throw new Error("The OpenCode installation changed; check its status again")
    if (!current.legacy) return install()
    if (!options.replaceLegacy) throw new LegacyReplacementError("legacy_replacement_required", "Replacing OpenCode 1.x requires explicit confirmation")
    // Windows cannot remove a running image: defer before npm changes anything.
    await assertExecutableWritable(current.legacy.binary, platform)
    await (options.execute ?? executeInstaller)(node, [npm, "uninstall", "--global", "--prefix", prefix,
      "--no-audit", "--no-fund", LEGACY_NPM_PACKAGE], npmEnvironment())
    if (existsSync(legacyNpmPackageRoot(prefix, platform))) throw new Error("npm did not remove the OpenCode 1.x package")
    try { return await install() }
    catch (error) {
      // An interrupted installer retains its lock and diagnosis unchanged.
      if (error instanceof InstallationBusyError) throw error
      throw new LegacyReplacementError("legacy_removed_install_failed",
        `OpenCode 1.x was removed, but installing OpenCode 2 failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  async function install(): Promise<string> {
    const oldBinary = npmCommand(prefix, platform)?.binary ?? binary
    const existing = await probe(oldBinary)
    if (existing.valid && (!existing.version || !/^(?:\d+\.\d+\.\d+|0\.0\.0-beta-\d+)$/.test(existing.version))) {
      throw new Error("Cannot replace an unverified OpenCode version automatically")
    }
    const target = existing.valid && existing.version && /^\d+\.\d+\.\d+$/.test(existing.version) && compareVersionStrings(existing.version, version) > 0 ? existing.version : version
    const directory = npmCommandDirectory(prefix, platform)
    const commandHost = { ...options, env: { PATH: directory, PATHEXT: ".EXE;.CMD;.BAT" } }
    if (!existing.valid || existing.version !== target || !npmCommand(prefix, platform) || oldBinary !== binary) {
      // 2.0.15 -> 2.0.16 is qualified with a live Windows service. Older
      // installers and same-version launcher repair keep the npm preflight.
      if (existing.valid && existing.version && /^\d+\.\d+\.\d+$/.test(existing.version)
        && compareVersionStrings(existing.version, "2.0.15") >= 0 && existing.version !== target
        && npmCommand(prefix, platform)) {
        const env = { ...(options.env ?? process.env) }
        await upgradeSharedOpenCode({ binary: oldBinary, version: target, prefix, node, npm, env, platform, execute: options.execute })
      } else {
        await assertExecutableWritable(oldBinary, platform)
        await (options.execute ?? executeInstaller)(node, [npm, "install", "--global", "--prefix", prefix,
          "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `@opencode/cli@${target}`], npmEnvironment())
      }
    }
    const result = await probe(binary)
    if (!result.valid || !result.version || !/^\d+\.\d+\.\d+$/.test(result.version) || compareVersionStrings(result.version, target) < 0) {
      throw new Error("Installed OpenCode version verification failed")
    }
    if (!findPathOpenCode(commandHost) || sharedInstallPrefix(commandHost) !== prefix) {
      throw new Error("npm did not publish the verified OpenCode terminal command")
    }
    await (options.registerPath ?? (directory => registerUserPath(directory, options)))(directory)
    return binary
  }
}
