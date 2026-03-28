import { spawn, spawnSync, type ChildProcess } from "child_process"
import { app, utilityProcess, type UtilityProcess } from "electron"
import { createRequire } from "module"
import { EventEmitter } from "events"
import { existsSync, readFileSync } from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { parse as parseYaml } from "yaml"
import { buildUserShellCommand, getUserShellEnv, supportsUserShell } from "./user-shell"

const nodeRequire = createRequire(import.meta.url)
const mainFilename = fileURLToPath(import.meta.url)
const mainDirname = path.dirname(mainFilename)

const BOOTSTRAP_TOKEN_PREFIX = "CODENOMAD_BOOTSTRAP_TOKEN:"

type CliState = "starting" | "ready" | "error" | "stopped"
type ListeningMode = "local" | "all"

export interface CliStatus {
  state: CliState
  pid?: number
  port?: number
  url?: string
  error?: string
}

export interface CliLogEntry {
  stream: "stdout" | "stderr"
  message: string
}

interface StartOptions {
  dev: boolean
}

interface CliEntryResolution {
  entry: string
  runner: "node" | "tsx"
  runnerPath?: string
}

type ManagedChild = ChildProcess | UtilityProcess
type ChildLaunchMode = "spawn" | "utility"

const DEFAULT_CONFIG_PATH = "~/.config/codenomad/config.json"

function isYamlPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith(".yaml") || lower.endsWith(".yml")
}

function isJsonPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".json")
}

function resolveConfigPaths(raw?: string): { configYamlPath: string; legacyJsonPath: string } {
  const target = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_CONFIG_PATH
  const resolved = resolveConfigPath(target)

  if (isYamlPath(resolved)) {
    const baseDir = path.dirname(resolved)
    return { configYamlPath: resolved, legacyJsonPath: path.join(baseDir, "config.json") }
  }

  if (isJsonPath(resolved)) {
    const baseDir = path.dirname(resolved)
    return { configYamlPath: path.join(baseDir, "config.yaml"), legacyJsonPath: resolved }
  }

  // Treat as directory.
  return {
    configYamlPath: path.join(resolved, "config.yaml"),
    legacyJsonPath: path.join(resolved, "config.json"),
  }
}

function resolveConfigPath(configPath?: string): string {
  const target = configPath && configPath.trim().length > 0 ? configPath : DEFAULT_CONFIG_PATH
  if (target.startsWith("~/")) {
    return path.join(os.homedir(), target.slice(2))
  }
  return path.resolve(target)
}

function resolveHostForMode(mode: ListeningMode): string {
  return mode === "local" ? "127.0.0.1" : "0.0.0.0"
}

function readListeningModeFromConfig(): ListeningMode {
  try {
    const { configYamlPath, legacyJsonPath } = resolveConfigPaths(process.env.CLI_CONFIG)

    let parsed: any = null
    if (existsSync(configYamlPath)) {
      const content = readFileSync(configYamlPath, "utf-8")
      parsed = parseYaml(content)
    } else if (existsSync(legacyJsonPath)) {
      const content = readFileSync(legacyJsonPath, "utf-8")
      parsed = JSON.parse(content)
    } else {
      return "local"
    }

    const mode = parsed?.server?.listeningMode ?? parsed?.preferences?.listeningMode
    if (mode === "local" || mode === "all") {
      return mode
    }
  } catch (error) {
    console.warn("[cli] failed to read listening mode from config", error)
  }
  return "local"
}

export declare interface CliProcessManager {
  on(event: "status", listener: (status: CliStatus) => void): this
  on(event: "ready", listener: (status: CliStatus) => void): this
  on(event: "bootstrapToken", listener: (token: string) => void): this
  on(event: "log", listener: (entry: CliLogEntry) => void): this
  on(event: "exit", listener: (status: CliStatus) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

export class CliProcessManager extends EventEmitter {
  private child?: ManagedChild
  private childLaunchMode: ChildLaunchMode = "spawn"
  private status: CliStatus = { state: "stopped" }
  private stdoutBuffer = ""
  private stderrBuffer = ""
  private bootstrapToken: string | null = null
  private requestedStop = false

  async start(options: StartOptions): Promise<CliStatus> {
    if (this.child) {
      await this.stop()
    }

    this.stdoutBuffer = ""
    this.stderrBuffer = ""
    this.bootstrapToken = null
    this.requestedStop = false
    this.updateStatus({ state: "starting", port: undefined, pid: undefined, url: undefined, error: undefined })

    const listeningMode = this.resolveListeningMode()
    const host = resolveHostForMode(listeningMode)
    const args = this.buildCliArgs(options, host)

    let child: ManagedChild

    if (this.shouldUsePackagedShellSupervisor(options)) {
      const runtimePath = this.resolveShellNodeCommand()
      const entryPath = this.resolveBundledProdEntry()
      const supervisorPath = this.resolveCliSupervisorPath()
      const shellEnv = supportsUserShell() ? getUserShellEnv() : { ...process.env }
      const shellCommand = buildUserShellCommand(`exec ${this.buildExecutableCommand(runtimePath, [entryPath, ...args])}`)
      const supervisorPayload = JSON.stringify({
        command: shellCommand.command,
        args: shellCommand.args,
        cwd: process.cwd(),
      })

      console.info(
        `[cli] launching CodeNomad CLI (${options.dev ? "dev" : "prod"}) via utility supervisor using node at ${runtimePath} (host=${host})`,
      )
      console.info(`[cli] utility supervisor: ${supervisorPath}`)
      console.info(`[cli] shell command: ${shellCommand.command} ${shellCommand.args.join(" ")}`)

      child = utilityProcess.fork(supervisorPath, [supervisorPayload], {
        env: shellEnv,
        stdio: "pipe",
        serviceName: "CodeNomad CLI Supervisor",
      })
      this.childLaunchMode = "utility"
    } else {
      const cliEntry = this.resolveCliEntry(options)
      console.info(
        `[cli] launching CodeNomad CLI (${options.dev ? "dev" : "prod"}) using ${cliEntry.runner} at ${cliEntry.entry} (host=${host})`,
      )

      const env = supportsUserShell() ? getUserShellEnv() : { ...process.env }
      env.ELECTRON_RUN_AS_NODE = "1"

      const spawnDetails = supportsUserShell()
        ? buildUserShellCommand(`ELECTRON_RUN_AS_NODE=1 exec ${this.buildCommand(cliEntry, args)}`)
        : this.buildDirectSpawn(cliEntry, args)

      const detached = process.platform !== "win32"
      child = spawn(spawnDetails.command, spawnDetails.args, {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env,
        shell: false,
        detached,
      })

      console.info(`[cli] spawn command: ${spawnDetails.command} ${spawnDetails.args.join(" ")}`)
      this.childLaunchMode = "spawn"
    }

    if (this.childLaunchMode === "spawn" && !child.pid) {
      console.error("[cli] spawn failed: no pid")
    }

    this.child = child
    this.updateStatus({ pid: child.pid ?? undefined })

    child.stdout?.on("data", (data: Buffer) => {
      this.handleStream(data.toString(), "stdout")
    })

    child.stderr?.on("data", (data: Buffer) => {
      this.handleStream(data.toString(), "stderr")
    })

    if (this.childLaunchMode === "utility") {
      const utilityChild = child as UtilityProcess

      utilityChild.on("error", (error) => {
        const message = this.describeUtilityProcessError(error)
        console.error("[cli] utility supervisor failed:", error)
        this.updateStatus({ state: "error", error: message })
        this.emit("error", new Error(message))
      })

      utilityChild.on("exit", (code) => {
        const failed = this.status.state !== "ready"
        const error = failed ? this.status.error ?? `CLI exited with code ${code ?? 0}` : undefined
        console.info(`[cli] exit (code=${code ?? ""})${error ? ` error=${error}` : ""}`)
        this.updateStatus({ state: failed ? "error" : "stopped", error })
        if (failed && error) {
          this.emit("error", new Error(error))
        }
        this.emit("exit", this.status)
        this.child = undefined
      })
    } else {
      const spawnedChild = child as ChildProcess

      spawnedChild.on("error", (error) => {
        console.error("[cli] failed to start CLI:", error)
        this.updateStatus({ state: "error", error: error.message })
        this.emit("error", error)
      })

      spawnedChild.on("exit", (code, signal) => {
        const failed = this.status.state !== "ready"
        const error = failed ? this.status.error ?? `CLI exited with code ${code ?? 0}${signal ? ` (${signal})` : ""}` : undefined
        console.info(`[cli] exit (code=${code}, signal=${signal || ""})${error ? ` error=${error}` : ""}`)
        this.updateStatus({ state: failed ? "error" : "stopped", error })
        if (failed && error) {
          this.emit("error", new Error(error))
        }
        this.emit("exit", this.status)
        this.child = undefined
      })
    }

    return new Promise<CliStatus>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.handleTimeout()
        reject(new Error("CLI startup timeout"))
      }, 60000)

      this.once("ready", (status) => {
        clearTimeout(timeout)
        resolve(status)
      })

      this.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) {
      this.updateStatus({ state: "stopped" })
      return
    }

    if (this.childLaunchMode === "utility") {
      return this.stopUtilityChild(child as UtilityProcess)
    }

    const spawnedChild = child as ChildProcess

    this.requestedStop = true

    const pid = spawnedChild.pid
    if (!pid) {
      this.child = undefined
      this.updateStatus({ state: "stopped" })
      return
    }

    const isAlreadyExited = () => spawnedChild.exitCode !== null || spawnedChild.signalCode !== null

    const tryKillPosixGroup = (signal: NodeJS.Signals) => {
      try {
        // Negative PID targets the process group (POSIX).
        process.kill(-pid, signal)
        return true
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err?.code === "ESRCH") {
          return true
        }
        return false
      }
    }

    const tryKillSinglePid = (signal: NodeJS.Signals) => {
      try {
        process.kill(pid, signal)
        return true
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err?.code === "ESRCH") {
          return true
        }
        return false
      }
    }

    const tryTaskkill = (force: boolean) => {
      const args = ["/PID", String(pid), "/T"]
      if (force) {
        args.push("/F")
      }

      try {
        const result = spawnSync("taskkill", args, { encoding: "utf8" })
        const exitCode = result.status
        if (exitCode === 0) {
          return true
        }

        // If the PID is already gone, treat it as success.
        const stderr = (result.stderr ?? "").toString().toLowerCase()
        const stdout = (result.stdout ?? "").toString().toLowerCase()
        const combined = `${stdout}\n${stderr}`
        if (combined.includes("not found") || combined.includes("no running instance")) {
          return true
        }
        return false
      } catch {
        return false
      }
    }

    const sendStopSignal = (signal: NodeJS.Signals) => {
      if (process.platform === "win32") {
        tryTaskkill(signal === "SIGKILL")
        return
      }

      // Prefer process-group signaling so wrapper launchers (shell/tsx) don't outlive Electron.
      const groupOk = tryKillPosixGroup(signal)
      if (!groupOk) {
        tryKillSinglePid(signal)
      }
    }

    return new Promise((resolve) => {
      const killTimeout = setTimeout(() => {
        console.warn(
          `[cli] stop timed out after 30000ms; sending SIGKILL (pid=${child.pid ?? "unknown"})`,
        )
        sendStopSignal("SIGKILL")
      }, 30000)

      spawnedChild.on("exit", () => {
        clearTimeout(killTimeout)
        this.child = undefined
        console.info("[cli] CLI process exited")
        this.updateStatus({ state: "stopped" })
        resolve()
      })

      if (isAlreadyExited()) {
        clearTimeout(killTimeout)
        this.child = undefined
        this.updateStatus({ state: "stopped" })
        resolve()
        return
      }

      sendStopSignal("SIGTERM")
    })
  }

  private stopUtilityChild(child: UtilityProcess): Promise<void> {
    this.requestedStop = true

    const pid = child.pid
    if (!pid) {
      this.child = undefined
      this.updateStatus({ state: "stopped" })
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const killTimeout = setTimeout(() => {
        console.warn(`[cli] stop timed out after 30000ms; sending SIGKILL (pid=${pid})`)
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // no-op
        }
      }, 30000)

      child.once("exit", () => {
        clearTimeout(killTimeout)
        this.child = undefined
        console.info("[cli] CLI process exited")
        this.updateStatus({ state: "stopped" })
        resolve()
      })

      if (child.pid === undefined) {
        clearTimeout(killTimeout)
        this.child = undefined
        this.updateStatus({ state: "stopped" })
        resolve()
        return
      }

      child.kill()
    })
  }

  getStatus(): CliStatus {
    return { ...this.status }
  }

  private resolveListeningMode(): ListeningMode {
    return readListeningModeFromConfig()
  }

  private handleTimeout() {
    if (this.child) {
      const pid = this.child.pid
      if (this.childLaunchMode === "utility") {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            // no-op
          }
        }
      } else if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          ;(this.child as ChildProcess).kill("SIGKILL")
        }
      } else {
        ;(this.child as ChildProcess).kill("SIGKILL")
      }
      this.child = undefined
    }
    this.updateStatus({ state: "error", error: "CLI did not start in time" })
    this.emit("error", new Error("CLI did not start in time"))
  }

  private handleStream(chunk: string, stream: "stdout" | "stderr") {
    if (stream === "stdout") {
      this.stdoutBuffer += chunk
      this.processBuffer("stdout")
    } else {
      this.stderrBuffer += chunk
      this.processBuffer("stderr")
    }
  }

  private processBuffer(stream: "stdout" | "stderr") {
    const buffer = stream === "stdout" ? this.stdoutBuffer : this.stderrBuffer
    const lines = buffer.split("\n")
    const trailing = lines.pop() ?? ""

    if (stream === "stdout") {
      this.stdoutBuffer = trailing
    } else {
      this.stderrBuffer = trailing
    }

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      if (trimmed.startsWith(BOOTSTRAP_TOKEN_PREFIX)) {
        const token = trimmed.slice(BOOTSTRAP_TOKEN_PREFIX.length).trim()
        if (token && !this.bootstrapToken) {
          this.bootstrapToken = token
          this.emit("bootstrapToken", token)
        }
        continue
      }

      console.info(`[cli][${stream}] ${trimmed}`)
      this.emit("log", { stream, message: trimmed })

      const localUrl = this.extractLocalUrl(trimmed)
      if (localUrl && this.status.state === "starting") {
        let port: number | undefined
        try {
          port = Number(new URL(localUrl).port) || undefined
        } catch {
          port = undefined
        }
        console.info(`[cli] ready on ${localUrl}`)
        this.updateStatus({ state: "ready", port, url: localUrl })
        this.emit("ready", this.status)
      }
    }
  }

  private extractLocalUrl(line: string): string | null {
    const match = line.match(/^Local\s+Connection\s+URL\s*:\s*(https?:\/\/\S+)\s*$/i)
    if (!match) {
      return null
    }
    return match[1] ?? null
  }

  private updateStatus(patch: Partial<CliStatus>) {
    this.status = { ...this.status, ...patch }
    this.emit("status", this.status)
  }

  private buildCliArgs(options: StartOptions, host: string): string[] {
    const args = ["serve", "--host", host, "--generate-token"]

    if (options.dev) {
      // Dev: run plain HTTP + Vite dev server proxy.
      args.push("--https", "false", "--http", "true")
      // Avoid collisions with an already-running server (and dual-stack ::/0.0.0.0 quirks)
      // by forcing an ephemeral port in dev.
      args.push("--http-port", "0")
    } else {
      // Prod desktop: always keep loopback HTTP enabled.
      args.push("--https", "true", "--http", "true")
    }

    if (options.dev) {
      const devServer = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL || "http://localhost:3000"
      const rawLogLevel = (process.env.CLI_LOG_LEVEL ?? "info").trim()
      const logLevel = rawLogLevel.length > 0 ? rawLogLevel.toLowerCase() : "info"
      args.push("--ui-dev-server", devServer, "--log-level", logLevel)
    }

    return args
  }

  private buildCommand(cliEntry: CliEntryResolution, args: string[]): string {
    const parts = [JSON.stringify(process.execPath)]
    if (cliEntry.runner === "tsx" && cliEntry.runnerPath) {
      parts.push(JSON.stringify(cliEntry.runnerPath))
    }
    parts.push(JSON.stringify(cliEntry.entry))
    args.forEach((arg) => parts.push(JSON.stringify(arg)))
    return parts.join(" ")
  }

  private buildExecutableCommand(command: string, args: string[]): string {
    return [JSON.stringify(command), ...args.map((arg) => JSON.stringify(arg))].join(" ")
  }

  private buildDirectSpawn(cliEntry: CliEntryResolution, args: string[]) {
    if (cliEntry.runner === "tsx") {
      return { command: process.execPath, args: [cliEntry.runnerPath!, cliEntry.entry, ...args] }
    }

    return { command: process.execPath, args: [cliEntry.entry, ...args] }
  }

  private resolveCliEntry(options: StartOptions): CliEntryResolution {
    if (options.dev) {
      const tsxPath = this.resolveTsx()
      if (!tsxPath) {
        throw new Error("tsx is required to run the CLI in development mode. Please install dependencies.")
      }
      const devEntry = this.resolveDevEntry()
      return { entry: devEntry, runner: "tsx", runnerPath: tsxPath }
    }
 
    const distEntry = this.resolveProdEntry()
    return { entry: distEntry, runner: "node" }
  }
 
  private resolveTsx(): string | null {
    const candidates: Array<string | (() => string)> = [
      () => nodeRequire.resolve("tsx/cli"),
      () => nodeRequire.resolve("tsx/dist/cli.mjs"),
      () => nodeRequire.resolve("tsx/dist/cli.cjs"),
      path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.cjs"),
      path.resolve(process.cwd(), "..", "node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve(process.cwd(), "..", "node_modules", "tsx", "dist", "cli.cjs"),
      path.resolve(process.cwd(), "..", "..", "node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve(process.cwd(), "..", "..", "node_modules", "tsx", "dist", "cli.cjs"),
      path.resolve(app.getAppPath(), "..", "node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve(app.getAppPath(), "..", "node_modules", "tsx", "dist", "cli.cjs"),
    ]
 
    for (const candidate of candidates) {
      try {
        const resolved = typeof candidate === "function" ? candidate() : candidate
        if (resolved && existsSync(resolved)) {
          return resolved
        }
      } catch {
        continue
      }
    }
 
    return null
  }
 
  private resolveDevEntry(): string {
    const entry = path.resolve(process.cwd(), "..", "server", "src", "index.ts")
    if (!existsSync(entry)) {
      throw new Error(`Dev CLI entry not found at ${entry}. Run npm run dev:electron from the repository root after installing dependencies.`)
    }
    return entry
  }
 
  private resolveProdEntry(): string {
    try {
      const entry = nodeRequire.resolve("@neuralnomads/codenomad/dist/bin.js")
      if (existsSync(entry)) {
        return entry
      }
    } catch {
      // fall through to error below
    }
    throw new Error("Unable to locate CodeNomad CLI build (dist/bin.js). Run npm run build --workspace @neuralnomads/codenomad.")
  }

  private shouldUsePackagedShellSupervisor(options: StartOptions): boolean {
    return !options.dev && app.isPackaged && process.platform === "darwin"
  }

  private resolveCliSupervisorPath(): string {
    const candidates = [
      path.join(process.resourcesPath, "cli-supervisor.cjs"),
      path.join(mainDirname, "../resources/cli-supervisor.cjs"),
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }

    throw new Error("Unable to locate CodeNomad CLI supervisor script.")
  }

  private resolveShellNodeCommand(): string {
    const configured = process.env.NODE_BINARY?.trim()
    return configured && configured.length > 0 ? configured : "node"
  }

  private resolveBundledProdEntry(): string {
    const candidates = [
      path.join(process.resourcesPath, "server", "dist", "bin.js"),
      path.join(mainDirname, "../resources/server/dist/bin.js"),
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }

    throw new Error("Unable to locate bundled CodeNomad CLI build in app resources.")
  }

  private describeUtilityProcessError(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message
    }

    if (error && typeof error === "object") {
      const typed = error as { type?: unknown; location?: unknown }
      if (typeof typed.type === "string") {
        return typeof typed.location === "string" ? `${typed.type} at ${typed.location}` : typed.type
      }
    }

    return String(error)
  }
}
