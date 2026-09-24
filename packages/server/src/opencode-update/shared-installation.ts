import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundledNpm, executeInstaller } from "./npm-runtime"
import { isRetiredInstallation } from "./retired-installation"
import { registerUserPath } from "./user-path"
import { probeBinaryVersionAsync, buildSpawnSpec } from "../workspaces/spawn"
import { assertSupportedOpenCode } from "../opencode/runtime-support"
import { compareVersionStrings } from "../releases/release-monitor"
import { assertExecutableWritable, withInstallationLock } from "./installation-lock"

export interface InstallationHost {
  home?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
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

export function resolveDefaultInstallation(host: InstallationHost = {}): { path: string; source?: "path" | "user" } {
  const command = findPathOpenCode(host)
  if (command) return { path: command, source: "path" }
  const prefix = userNpmPrefix(host)
  const binary = npmCommand(prefix, host.platform ?? process.platform)?.binary ?? npmExecutable(prefix, host.platform)
  if (existsSync(binary) && !isRetiredInstallation(binary)) return { path: binary, source: "user" }
  return { path: "opencode2" }
}

/** Only a verified npm installation may be updated via npm. Homebrew/curl and
 * explicit custom executable choices retain their own installation authority. */
export function sharedInstallPrefix(host: InstallationHost = {}): string | undefined {
  const platform = host.platform ?? process.platform
  const userPrefix = userNpmPrefix(host)
  if (isRetiredInstallation(userPrefix)) return undefined
  const command = findPathOpenCode(host) ?? findPathOpenCode({ ...host,
    env: { PATH: npmCommandDirectory(userPrefix, platform), PATHEXT: ".EXE;.CMD;.BAT" } })
  if (!command) return userPrefix
  const prefix = platform === "win32" ? path.dirname(command) : path.dirname(path.dirname(command))
  try {
    if (!npmLauncher(command, prefix, platform)) return undefined
    accessSync(prefix, constants.W_OK)
    return prefix
  } catch { return undefined }
}

export async function installSharedOpenCode(version: string, options: InstallationHost & {
  node?: string; npm?: string
  execute?: typeof executeInstaller
  probe?: typeof probeBinaryVersionAsync
  registerPath?: (directory: string) => Promise<void>
} = {}): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Installation requires an exact stable OpenCode version")
  assertSupportedOpenCode(version)
  const platform = options.platform ?? process.platform
  const prefix = sharedInstallPrefix(options)
  if (!prefix) throw new Error("The PATH executable is not a writable npm installation")
  const node = options.node ?? process.execPath
  const npm = options.npm ?? bundledNpm(node)
  if (!npm) throw new Error("npm is unavailable beside the CodeNomad Node runtime")
  const binary = npmExecutable(prefix, platform)
  const probe = options.probe ?? probeBinaryVersionAsync
  return withInstallationLock(prefix, async () => {
    const oldBinary = npmCommand(prefix, platform)?.binary ?? binary
    const existing = await probe(oldBinary)
    if (existing.valid && (!existing.version || !/^(?:\d+\.\d+\.\d+|0\.0\.0-beta-\d+)$/.test(existing.version))) {
      throw new Error("Cannot replace an unverified OpenCode version automatically")
    }
    const target = existing.valid && existing.version && /^\d+\.\d+\.\d+$/.test(existing.version) && compareVersionStrings(existing.version, version) > 0 ? existing.version : version
    const directory = npmCommandDirectory(prefix, platform)
    const commandHost = { ...options, env: { PATH: directory, PATHEXT: ".EXE;.CMD;.BAT" } }
    if (!existing.valid || existing.version !== target || !npmCommand(prefix, platform) || oldBinary !== binary) {
      await assertExecutableWritable(oldBinary, platform)
      const env = { ...(options.env ?? process.env) }
      const key = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH"
      env[key] = `${path.dirname(node)}${platform === "win32" ? ";" : ":"}${env[key] || ""}`
      await (options.execute ?? executeInstaller)(node, [npm, "install", "--global", "--prefix", prefix,
        "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `@opencode/cli@${target}`], env)
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
  })
}
