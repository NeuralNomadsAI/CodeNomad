import { spawnSync } from "child_process"
import path from "path"

export const WINDOWS_CMD_EXTENSIONS = new Set([".cmd", ".bat"])
export const WINDOWS_POWERSHELL_EXTENSIONS = new Set([".ps1"])

const VERSION_REGEX = /([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+)/
const WSL_UNC_PATH_REGEX = /^\\\\wsl(?:\.localhost|\$)\\([^\\/]+)(?:[\\/](.*))?$/i
const CODENOMAD_PLUGIN_PACKAGE_NAME = "@codenomad/codenomad-opencode-plugin"
const WSL_PLUGIN_PATH_ENV = "CODENOMAD_OPENCODE_PLUGIN_WSL_PATH"
const WSL_PLUGIN_PATH_PLACEHOLDER = "__CODENOMAD_OPENCODE_PLUGIN_WSL_PATH__"
const CODENOMAD_PLUGIN_FILE_SPEC_REGEX = new RegExp(
  `(${escapeRegex(CODENOMAD_PLUGIN_PACKAGE_NAME)}@file:)([A-Za-z]:[^"\\r\\n]+?\\.tgz)`,
)
const WSL_PATH_ENV_KEYS = new Set(["NODE_EXTRA_CA_CERTS", WSL_PLUGIN_PATH_ENV])

export interface SpawnSpec {
  command: string
  args: string[]
  options: {
    windowsVerbatimArguments?: boolean
  }
  cwd?: string
  env?: NodeJS.ProcessEnv
  wsl?: {
    distro: string
    pidMarker?: string
  }
}

interface BuildSpawnSpecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  propagateEnvKeys?: string[]
  wslPidMarker?: string
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

  const extension = path.extname(binaryPath).toLowerCase()

  if (WINDOWS_CMD_EXTENSIONS.has(extension)) {
    const comspec = process.env.ComSpec || "cmd.exe"
    // cmd.exe requires the full command as a single string.
    // Using the ""<script> <args>"" pattern ensures paths with spaces are handled.
    const commandLine = `""${binaryPath}" ${args.join(" ")}"`

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
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", binaryPath, ...args],
      options: {},
      cwd: options.cwd,
      env: options.env,
    }
  }

  return {
    command: binaryPath,
    args,
    options: {},
    cwd: options.cwd,
    env: options.env,
  }
}

export function buildSpawnSpec(binaryPath: string, args: string[], options: BuildSpawnSpecOptions = {}): SpawnSpec {
  if (process.platform !== "win32") {
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

export function buildWslSignalSpec(distro: string, linuxPid: number, signal: NodeJS.Signals): SpawnSpec {
  return {
    command: "wsl.exe",
    args: ["--distribution", distro, "--exec", "kill", signal === "SIGKILL" ? "-KILL" : "-TERM", String(linuxPid)],
    options: {},
    wsl: { distro },
  }
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
  const env = buildWslEnvironment(options.env, options.propagateEnvKeys)
  const shouldTranslatePluginPath = Boolean(env?.[WSL_PLUGIN_PATH_ENV])
  if (options.cwd && !workingDirectory) {
    throw new Error(
      `Unable to translate workspace folder for WSL binary in distro "${wslPath.distro}": ${options.cwd}`,
    )
  }

  const wslArgs = ["--distribution", wslPath.distro]
  const shouldWrapWithShell = Boolean(options.wslPidMarker) || workingDirectory?.kind === "windows" || shouldTranslatePluginPath

  if (!shouldWrapWithShell && workingDirectory?.kind === "linux") {
    wslArgs.push("--cd", workingDirectory.path)
  }

  if (shouldWrapWithShell) {
    const launchScript = buildWslLaunchScript(workingDirectory ?? undefined, options.wslPidMarker, shouldTranslatePluginPath)
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
    env,
    wsl: { distro: wslPath.distro, pidMarker: options.wslPidMarker },
  }
}

function buildWslLaunchScript(
  workingDirectory: WslWorkingDirectory | undefined,
  pidMarker: string | undefined,
  translatePluginPath: boolean,
): string {
  const steps: string[] = []

  if (pidMarker) {
    steps.push(`printf '%s%s\\n' '${pidMarker}' "$$"`)
  }

  if (workingDirectory?.kind === "linux") {
    steps.push('cd "$1"')
    steps.push("shift")
  } else if (workingDirectory?.kind === "windows") {
    steps.push('cd "$(wslpath -au "$1")"')
    steps.push("shift")
  }

  if (translatePluginPath) {
    steps.push(
      `if [ -n "$${WSL_PLUGIN_PATH_ENV}" ] && [ -n "$OPENCODE_CONFIG_CONTENT" ]; then escaped_plugin_path=$(printf '%s' "$${WSL_PLUGIN_PATH_ENV}" | sed 's/[\\&|]/\\\\&/g'); OPENCODE_CONFIG_CONTENT=$(printf '%s' "$OPENCODE_CONFIG_CONTENT" | sed "s|${WSL_PLUGIN_PATH_PLACEHOLDER}|$escaped_plugin_path|g"); export OPENCODE_CONFIG_CONTENT; unset ${WSL_PLUGIN_PATH_ENV}; fi`,
    )
  }

  steps.push('exec "$@"')
  return steps.join(" && ")
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

function buildWslEnvironment(env: NodeJS.ProcessEnv | undefined, propagateEnvKeys: string[] | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) {
    return env
  }

  const next = { ...env }
  rewriteOpencodePluginPathForWsl(next)

  const keysToPropagate = Array.from(
    new Set([
      ...(propagateEnvKeys ?? []).filter((key) => next[key] !== undefined),
      ...Array.from(WSL_PATH_ENV_KEYS).filter((key) => next[key] !== undefined),
    ]),
  )
  if (keysToPropagate.length === 0) {
    return next
  }

  const entries = (next.WSLENV ?? "").split(":").filter((entry) => entry.length > 0)
  const byName = new Map(entries.map((entry) => [entry.split("/")[0] ?? entry, entry]))

  for (const key of keysToPropagate) {
    const existingEntry = byName.get(key)
    if (existingEntry) {
      byName.set(key, ensureWslenvEntry(existingEntry, WSL_PATH_ENV_KEYS.has(key)))
      continue
    }
    byName.set(key, WSL_PATH_ENV_KEYS.has(key) ? `${key}/p` : key)
  }

  next.WSLENV = Array.from(byName.values()).join(":")
  return next
}

function rewriteOpencodePluginPathForWsl(env: NodeJS.ProcessEnv) {
  const content = env.OPENCODE_CONFIG_CONTENT
  if (!content) {
    return
  }

  const match = content.match(CODENOMAD_PLUGIN_FILE_SPEC_REGEX)
  const hostPath = match?.[2]
  if (!hostPath) {
    return
  }

  env.OPENCODE_CONFIG_CONTENT = content.replace(hostPath, WSL_PLUGIN_PATH_PLACEHOLDER)
  env[WSL_PLUGIN_PATH_ENV] = path.win32.normalize(hostPath)
}

function ensureWslenvEntry(entry: string, requiresPathTranslation: boolean): string {
  if (!requiresPathTranslation) {
    return entry
  }

  const [name, rawFlags = ""] = entry.split("/")
  if (rawFlags.includes("p")) {
    return entry
  }

  return rawFlags.length > 0 ? `${name}/${rawFlags}p` : `${name}/p`
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
