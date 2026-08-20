import { spawnSync } from "child_process"
import { readFileSync, statSync } from "fs"
import path from "path"

export const WINDOWS_CMD_EXTENSIONS = new Set([".cmd", ".bat"])
export const WINDOWS_POWERSHELL_EXTENSIONS = new Set([".ps1"])

const VERSION_REGEX = /([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+)/
const WSL_UNC_PATH_REGEX = /^\\\\wsl(?:\.localhost|\$)\\([^\\/]+)(?:[\\/](.*))?$/i
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD"

export interface SpawnSpec {
  command: string
  args: string[]
  options: {
    windowsVerbatimArguments?: boolean
  }
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type ServiceLaunchSpec =
  | { kind: "host"; binary: string; platform: NodeJS.Platform }
  | { kind: "wsl"; distro: string; binary: string }

interface BuildSpawnSpecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

interface WslPath {
  distro: string
  linuxPath: string
}

export type WslWorkingDirectory =
  | { kind: "linux"; path: string }
  | { kind: "windows"; path: string }

export function parseWslUncPath(input: string): WslPath | null {
  const normalized = input.trim().replace(/\//g, "\\")
  const match = normalized.match(WSL_UNC_PATH_REGEX)
  if (!match) {
    return null
  }

  const distro = match[1] ?? ""
  const remainder = match[2] ?? ""
  const segments = remainder.split(/\\+/).filter((segment) => segment.length > 0)

  return {
    distro,
    linuxPath: segments.length > 0 ? `/${segments.join("/")}` : "/",
  }
}

export function resolveWslWorkingDirectory(folder: string, distro: string): WslWorkingDirectory | null {
  const wslFolder = parseWslUncPath(folder)
  if (wslFolder) {
    return wslFolder.distro.toLowerCase() === distro.toLowerCase() ? { kind: "linux", path: wslFolder.linuxPath } : null
  }

  const windowsFolder = normalizeWindowsPath(folder)
  return windowsFolder ? { kind: "windows", path: windowsFolder } : null
}

export function buildWindowsSpawnSpec(binaryPath: string, args: string[], options: BuildSpawnSpecOptions = {}): SpawnSpec {
  const wslPath = parseWslUncPath(binaryPath)
  if (wslPath) {
    return buildWslSpawnSpec(wslPath, args, options)
  }

  const resolvedCommand = resolveBareWindowsCommand(binaryPath, options) ?? binaryPath
  const resolvedBinaryPath = resolveWindowsNpmExecutable(resolvedCommand) ?? resolvedCommand
  const extension = path.win32.extname(resolvedBinaryPath).toLowerCase()

  if (WINDOWS_CMD_EXTENSIONS.has(extension)) {
    const comspec = getWindowsEnvironmentValue(options.env, "COMSPEC") ??
      getWindowsEnvironmentValue(process.env, "COMSPEC") ??
      "cmd.exe"
    // cmd.exe requires the full command as a single string.
    // Using the ""<script> <args>"" pattern ensures paths with spaces are handled.
    const commandLine = `""${resolvedBinaryPath}" ${args.join(" ")}"`

    return {
      command: comspec,
      args: ["/d", "/s", "/c", commandLine],
      options: { windowsVerbatimArguments: true },
      cwd: options.cwd,
      env: options.env,
    }
  }

  if (WINDOWS_POWERSHELL_EXTENSIONS.has(extension)) {
    // powershell.exe ships with Windows. (pwsh may not.)
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedBinaryPath, ...args],
      options: {},
      cwd: options.cwd,
      env: options.env,
    }
  }

  return {
    command: resolvedBinaryPath,
    args,
    options: {},
    cwd: options.cwd,
    env: options.env,
  }
}

export function buildSpawnSpec(binaryPath: string, args: string[], options: BuildSpawnSpecOptions = {}): SpawnSpec {
  if ((options.platform ?? process.platform) !== "win32") {
    return {
      command: binaryPath,
      args,
      options: {},
      cwd: options.cwd,
      env: options.env,
    }
  }

  return buildWindowsSpawnSpec(binaryPath, args, options)
}

export function resolveWslServiceDirectory(
  folder: string,
  distro: string,
  translateWindowsPath: (folder: string, distro: string, timeoutMs: number) => string | undefined = (windowsFolder, wslDistro, timeoutMs) => {
    const result = spawnSync("wsl.exe", ["--distribution", wslDistro, "--exec", "wslpath", "-au", windowsFolder], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    })
    return result.status === 0 ? result.stdout.trim() : undefined
  },
  timeoutMs = 5_000,
): string | null {
  const directory = resolveWslWorkingDirectory(folder, distro)
  if (!directory) return null
  if (directory.kind === "linux") return directory.path
  return translateWindowsPath(directory.path, distro, Math.max(1, timeoutMs))?.trim() || null
}

export function resolveWslHostDirectory(
  folder: string,
  distro: string,
  translateLinuxPath: (folder: string, distro: string, timeoutMs: number) => string | undefined = (linuxFolder, wslDistro, timeoutMs) => {
    const result = spawnSync("wsl.exe", ["--distribution", wslDistro, "--exec", "wslpath", "-aw", linuxFolder], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    })
    return result.status === 0 ? result.stdout.trim() : undefined
  },
  timeoutMs = 5_000,
): string | null {
  if (!path.posix.isAbsolute(folder)) return null
  return translateLinuxPath(folder, distro, Math.max(1, timeoutMs))?.trim() || null
}

export function buildServiceLaunchSpec(
  binaryPath: string,
  options: BuildSpawnSpecOptions = {},
): ServiceLaunchSpec {
  const platform = options.platform ?? process.platform
  const wslPath = platform === "win32" ? parseWslUncPath(binaryPath) : null
  if (wslPath) return { kind: "wsl", distro: wslPath.distro, binary: wslPath.linuxPath }
  return { kind: "host", binary: binaryPath, platform }
}

export function probeBinaryVersion(binaryPath: string): {
  valid: boolean
  version?: string
  reported?: string
  error?: string
} {
  if (!binaryPath) {
    return { valid: false, error: "Missing binary path" }
  }

  try {
    const spec = buildSpawnSpec(binaryPath, ["--version"])
    const result = spawnSync(spec.command, spec.args, {
      encoding: "utf8",
      cwd: spec.cwd,
      env: spec.env,
      windowsVerbatimArguments: Boolean(spec.options.windowsVerbatimArguments),
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

    const stdoutLines = String(result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const stderrLines = String(result.stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    // Prefer stdout; fall back to stderr (some tools report version there).
    const reported = stdoutLines[0] ?? stderrLines[0]
    if (!reported) {
      return { valid: true }
    }

    const versionMatch = reported.match(VERSION_REGEX)
    const version = versionMatch?.[1]
    return { valid: true, version, reported }
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function buildWslSpawnSpec(wslPath: WslPath, args: string[], options: BuildSpawnSpecOptions): SpawnSpec {
  const workingDirectory = options.cwd ? resolveWslWorkingDirectory(options.cwd, wslPath.distro) : undefined
  if (options.cwd && !workingDirectory) {
    throw new Error(
      `Unable to translate workspace folder for WSL binary in distro "${wslPath.distro}": ${options.cwd}`,
    )
  }

  const wslArgs = ["--distribution", wslPath.distro]
  const shouldWrapWithShell = workingDirectory?.kind === "windows"

  if (!shouldWrapWithShell && workingDirectory?.kind === "linux") {
    wslArgs.push("--cd", workingDirectory.path)
  }

  if (shouldWrapWithShell) {
    const launchScript = buildWslLaunchScript(workingDirectory)
    wslArgs.push(
      "--exec",
      "sh",
      "-lc",
      launchScript,
      "codenomad-wsl-launch",
    )
    if (workingDirectory) {
      wslArgs.push(workingDirectory.path)
    }
    wslArgs.push(
      wslPath.linuxPath,
      ...args,
    )
  } else {
    wslArgs.push("--exec", wslPath.linuxPath, ...args)
  }

  return {
    command: "wsl.exe",
    args: wslArgs,
    options: {},
    env: options.env,
  }
}

function resolveBareWindowsCommand(binaryPath: string, options: BuildSpawnSpecOptions): string | null {
  if (!/^[^\\/:]+$/.test(binaryPath) || path.win32.extname(binaryPath)) return null

  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const pathEntries = (getWindowsEnvironmentValue(env, "PATH") ?? "")
    .split(";")
    .map(unquoteWindowsPathEntry)
  const extensions = (getWindowsEnvironmentValue(env, "PATHEXT") ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase())

  for (const entry of [cwd, ...pathEntries]) {
    const directory = entry
      ? path.win32.resolve(cwd, entry)
      : path.win32.resolve(cwd)
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${binaryPath}${extension}`)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Continue in Windows PATH/PATHEXT order.
      }
    }
  }

  return null
}

function getWindowsEnvironmentValue(env: NodeJS.ProcessEnv | undefined, key: string): string | undefined {
  if (!env) return undefined
  const match = Object.keys(env).reverse().find((candidate) => candidate.toUpperCase() === key)
  return match ? env[match] : undefined
}

function unquoteWindowsPathEntry(entry: string): string {
  const trimmed = entry.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
}

function buildWslLaunchScript(workingDirectory: WslWorkingDirectory | undefined): string {
  const steps: string[] = []

  if (workingDirectory?.kind === "linux") {
    steps.push('cd "$1"')
    steps.push("shift")
  } else if (workingDirectory?.kind === "windows") {
    steps.push('cd "$(wslpath -au "$1")"')
    steps.push("shift")
  }

  steps.push('exec "$@"')
  return steps.join(" && ")
}

function resolveWindowsNpmExecutable(command: string): string | null {
  if (!WINDOWS_CMD_EXTENSIONS.has(path.win32.extname(command).toLowerCase())) return null
  try {
    const script = readFileSync(command, "utf8")
    if (script.length > 64 * 1024) return null
    const match = script.match(/["'](?:%~dp0|%dp0%)[\\/]([^"'\r\n]+\.exe)["']\s+%\*/i)
    if (!match?.[1]) return null
    const executable = path.win32.resolve(path.win32.dirname(command), match[1])
    return statSync(executable).isFile() ? executable : null
  } catch {
    return null
  }
}

function normalizeWindowsPath(input: string): string | null {
  const normalized = path.win32.normalize(input.trim().replace(/\//g, "\\"))
  if (!normalized) {
    return null
  }

  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("\\\\")) {
    return normalized
  }

  return null
}
