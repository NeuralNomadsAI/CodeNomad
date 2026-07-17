import { spawn, type ChildProcess } from "child_process"
import { app } from "electron"
import { createRequire } from "module"
import { EventEmitter } from "events"
import { existsSync, readFileSync } from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { parse as parseYaml } from "yaml"
import { ensureManagedNodeBinary } from "./managed-node"
import { getProcessStartIdentity } from "./client-state-process-identity"
import {
  CLI_STOP_DEADLINE_MS,
  captureProcessTree,
  forceCapturedProcessTree,
  mergeCapturedProcessTrees,
  stopManagedChild,
} from "./process-stop"
import { SerializedLifecycle } from "./serialized-lifecycle"
import { buildUserShellCommand, getUserShellEnv, supportsUserShell } from "./user-shell"

const nodeRequire = createRequire(import.meta.url)
const mainFilename = fileURLToPath(import.meta.url)
const mainDirname = path.dirname(mainFilename)

const BOOTSTRAP_TOKEN_PREFIX = "CODENOMAD_BOOTSTRAP_TOKEN:"
const SERVER_SHUTDOWN_COMPLETE = "CODENOMAD_SHUTDOWN_STATUS:complete"
const SERVER_SHUTDOWN_INCOMPLETE = "CODENOMAD_SHUTDOWN_STATUS:incomplete"
const SESSION_COOKIE_NAME_PREFIX = "codenomad_session"
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
  nodeBinaryPath: string
  nodeArgs?: string[]
}

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
  private child?: ChildProcess
  private status: CliStatus = { state: "stopped" }
  private stdoutBuffer = ""
  private stderrBuffer = ""
  private bootstrapToken: string | null = null
  private authCookieName = `${SESSION_COOKIE_NAME_PREFIX}_${process.pid}_${Date.now()}`
  private requestedStop = false
  private shutdownStatus: "complete" | "incomplete" | null = null
  private lifecycle = new SerializedLifecycle()

  start(options: StartOptions): Promise<CliStatus> {
    return this.lifecycle.enqueue(() => this.startNow(options))
  }

  restart(options: StartOptions): Promise<CliStatus> {
    return this.lifecycle.enqueue(async () => {
      await this.stopNow()
      if (this.lifecycle.stopped) throw new Error("CLI process manager is shutting down")
      return this.startNow(options)
    })
  }

  stop(): Promise<void> {
    return this.lifecycle.enqueue(() => this.stopNow())
  }

  shutdown(): Promise<void> {
    return this.lifecycle.stop(() => this.stopNow())
  }

  private async startNow(options: StartOptions): Promise<CliStatus> {
    if (this.lifecycle.stopped) throw new Error("CLI process manager is shutting down")
    if (this.child) {
      await this.stopNow()
      if (this.child) throw new Error("CLI process did not exit before restart")
    }

    this.stdoutBuffer = ""
    this.stderrBuffer = ""
    this.bootstrapToken = null
    this.authCookieName = `${SESSION_COOKIE_NAME_PREFIX}_${process.pid}_${Date.now()}`
    this.requestedStop = false
    this.shutdownStatus = null
    this.updateStatus({ state: "starting", port: undefined, pid: undefined, url: undefined, error: undefined })

    const listeningMode = this.resolveListeningMode()
    const host = resolveHostForMode(listeningMode)
    const args = this.buildCliArgs(options, host)
    const cliEntry = await this.resolveCliEntry(options)

    console.info(
      `[cli] launching CodeNomad CLI (${options.dev ? "dev" : "prod"}) using ${cliEntry.runner} at ${cliEntry.entry} (host=${host})`,
    )

    const env = supportsUserShell() ? getUserShellEnv() : { ...process.env }
    env.ELECTRON_RUN_AS_NODE = "1"

    const spawnDetails = supportsUserShell()
      ? buildUserShellCommand(`ELECTRON_RUN_AS_NODE=1 exec ${this.buildCommand(cliEntry, args)}`)
      : this.buildDirectSpawn(cliEntry, args)

    const child = spawn(spawnDetails.command, spawnDetails.args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: false,
      detached: process.platform !== "win32",
    })

    console.info(`[cli] spawn command: ${spawnDetails.command} ${spawnDetails.args.join(" ")}`)
    if (!child.pid) {
      console.error("[cli] spawn failed: no pid")
    }

    this.child = child
    this.updateStatus({ pid: child.pid ?? undefined })

    const stdout = child.stdout as NodeJS.ReadableStream | undefined
    const stderr = child.stderr as NodeJS.ReadableStream | undefined

    stdout?.on("data", (data: Buffer) => {
      this.handleStream(data.toString(), "stdout")
    })

    stderr?.on("data", (data: Buffer) => {
      this.handleStream(data.toString(), "stderr")
    })

    child.on("error", (error) => {
      console.error("[cli] failed to start CLI:", error)
      this.updateStatus({ state: "error", error: error.message })
      this.emit("error", error)
    })

    child.on("exit", (code, signal) => {
      if (this.child !== child) return
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

  private async stopNow(): Promise<void> {
    const child = this.child
    if (!child) {
      this.updateStatus({ state: "stopped" })
      return
    }

    const spawnedChild = child

    this.requestedStop = true

    const pid = spawnedChild.pid
    if (!pid) {
      this.child = undefined
      this.updateStatus({ state: "stopped" })
      return
    }

    const isAlreadyExited = () => spawnedChild.exitCode !== null || spawnedChild.signalCode !== null

    const rootStartIdentity = getProcessStartIdentity(pid)
    const initialCapture = captureProcessTree(pid)
    let processTree = rootStartIdentity
      ? mergeCapturedProcessTrees(undefined, initialCapture, pid, rootStartIdentity)
      : initialCapture
    const forceProcessTree = () => {
      const latest = captureProcessTree(pid)
      processTree = mergeCapturedProcessTrees(processTree, latest, pid, rootStartIdentity)
      return processTree ? forceCapturedProcessTree(processTree) : false
    }

    let forceConfirmed = false
    const enforceIncompleteCleanup = () => {
      try {
        forceConfirmed = forceProcessTree()
      } catch (error) {
        console.warn(`[cli] immediate enforcement after incomplete cleanup failed (pid=${pid})`, error)
        forceConfirmed = false
      }
      if (!forceConfirmed) console.warn(`[cli] immediate enforcement after incomplete cleanup was not confirmed (pid=${pid})`)
    }
    this.once("shutdownIncomplete", enforceIncompleteCleanup)

    try {
      await stopManagedChild({
        child: spawnedChild,
        isExited: isAlreadyExited,
        force: () => forceConfirmed || forceProcessTree(),
        isCleanupComplete: () => this.shutdownStatus === "complete",
        deadlineMs: CLI_STOP_DEADLINE_MS,
        warn: (message, error) => console.warn(`[cli] ${message} (pid=${pid})`, error ?? ""),
      })
    } finally {
      this.off("shutdownIncomplete", enforceIncompleteCleanup)
    }
    if (this.shutdownStatus !== "complete") {
      console.warn(`[cli] CLI exited without a complete graceful-shutdown handshake (status=${this.shutdownStatus ?? "missing"})`)
    }
    console.info("[cli] CLI process exited")
    if (this.child === spawnedChild) {
      this.child = undefined
      this.updateStatus({ state: "stopped" })
    }
  }

  getStatus(): CliStatus {
    return { ...this.status }
  }

  getAuthCookieName(): string {
    return this.authCookieName
  }

  private resolveListeningMode(): ListeningMode {
    return readListeningModeFromConfig()
  }

  private handleTimeout() {
    if (this.child) {
      const pid = this.child.pid
      if (pid) {
        const processTree = captureProcessTree(pid)
        const forced = processTree ? forceCapturedProcessTree(processTree) : false
        if (!forced) {
          console.warn(`[cli] startup-timeout process tree cleanup was not confirmed (pid=${pid})`)
        } else {
          this.child = undefined
        }
      }
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

      if (trimmed === SERVER_SHUTDOWN_COMPLETE) {
        this.shutdownStatus = "complete"
        console.info("[cli] server confirmed graceful shutdown")
        continue
      }
      if (trimmed === SERVER_SHUTDOWN_INCOMPLETE) {
        this.shutdownStatus = "incomplete"
        console.warn("[cli] server reported incomplete cleanup; requesting final process-tree enforcement")
        this.emit("shutdownIncomplete")
        continue
      }
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
    const args = ["serve", "--host", host, "--generate-token", "--auth-cookie-name", this.authCookieName, "--unrestricted-root"]

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
    const parts = [JSON.stringify(cliEntry.nodeBinaryPath)]
    for (const nodeArg of cliEntry.nodeArgs ?? []) {
      parts.push(JSON.stringify(nodeArg))
    }
    if (cliEntry.runner === "tsx" && cliEntry.runnerPath) {
      parts.push(JSON.stringify(cliEntry.runnerPath))
    }
    parts.push(JSON.stringify(cliEntry.entry))
    args.forEach((arg) => parts.push(JSON.stringify(arg)))
    return parts.join(" ")
  }

  private buildDirectSpawn(cliEntry: CliEntryResolution, args: string[]) {
    if (cliEntry.runner === "tsx") {
      return { command: cliEntry.nodeBinaryPath, args: [...(cliEntry.nodeArgs ?? []), cliEntry.runnerPath!, cliEntry.entry, ...args] }
    }

    return { command: cliEntry.nodeBinaryPath, args: [...(cliEntry.nodeArgs ?? []), cliEntry.entry, ...args] }
  }

  private async resolveCliEntry(options: StartOptions): Promise<CliEntryResolution> {
    if (options.dev) {
      const tsxPath = this.resolveTsx()
      if (!tsxPath) {
        throw new Error("tsx is required to run the CLI in development mode. Please install dependencies.")
      }
      const devEntry = this.resolveDevEntry()
      return { entry: devEntry, runner: "tsx", runnerPath: tsxPath, nodeBinaryPath: process.execPath }
    }

    return {
      entry: this.resolveProdEntry(),
      runner: "node",
      nodeBinaryPath: await ensureManagedNodeBinary(),
      nodeArgs: ["--experimental-specifier-resolution=node"],
    }
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
    const candidates = [
      path.join(process.resourcesPath, "server", "dist", "bin.js"),
      path.join(mainDirname, "../resources/server/dist/bin.js"),
      path.resolve(process.cwd(), "..", "server", "dist", "bin.js"),
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }

    throw new Error("Unable to locate the packaged CodeNomad server entrypoint (dist/bin.js). Rebuild the desktop bundle.")
  }

}
