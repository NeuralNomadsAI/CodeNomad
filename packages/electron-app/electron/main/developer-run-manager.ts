import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  captureInitialProcessTree,
  captureProcessTree,
  forceCapturedProcessTree,
  mergeCapturedProcessTrees,
  type CapturedProcessTree,
} from "./process-stop"

export type DeveloperRunTarget = "electron" | "tauri"

export interface DeveloperRunStatus {
  state: "stopped" | "starting" | "ready" | "stopping" | "error"
  runId?: string
  target?: DeveloperRunTarget
  executable?: string
  profilePath?: string
  pid?: number
  cdpUrl?: string
  targetId?: string
  targetTitle?: string
  targetUrl?: string
  error?: string
}

export interface DeveloperRunLog {
  runId: string
  timestamp: number
  stream: "system" | "stdout" | "stderr"
  message: string
}

export interface DeveloperRunStartOptions {
  target: DeveloperRunTarget
  executable: string
  tempRoot?: string
  timeoutMs?: number
}

interface RunChild {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: "error", listener: (error: Error) => void): unknown
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

interface RunningProcess {
  child: RunChild
  generation: number
  profilePath: string
  initialTree: Promise<{ tree?: CapturedProcessTree; rootStartIdentity?: string }>
}

interface ReusableRun {
  runId: string
  port: number
  profilePath: string
}

export interface DeveloperRunManagerDependencies {
  spawn?: (executablePath: string, args: string[], options: Parameters<typeof spawn>[2]) => RunChild
  fetch?: typeof globalThis.fetch
  allocatePort?: () => Promise<number>
  stopTree?: (run: RunningProcess) => Promise<void>
  runId?: () => string
}

const LOOPBACK = "127.0.0.1"
const LOG_LIMIT = 1_000
const LOG_MESSAGE_LIMIT = 512
const DEFAULT_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate developer debugging port")))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function stopProcessTree(run: RunningProcess): Promise<void> {
  const pid = run.child.pid
  if (!pid) return
  const deadlineAt = Date.now() + STOP_TIMEOUT_MS
  const initial = await run.initialTree
  const latest = await captureProcessTree(pid, process.platform, undefined, Math.max(0, Math.min(1_500, deadlineAt - Date.now())))
  let tree = mergeCapturedProcessTrees(initial.tree, latest, pid, initial.rootStartIdentity)
  if (!tree && initial.rootStartIdentity) {
    tree = { platform: process.platform, members: [{ pid, startIdentity: initial.rootStartIdentity }] }
  }
  if (!tree || !await forceCapturedProcessTree(tree, undefined, undefined, process.kill, { deadlineAt })) {
    throw new Error(`Developer process tree termination was not confirmed (pid=${pid})`)
  }
}

export class DeveloperRunManager extends EventEmitter {
  private currentStatus: DeveloperRunStatus = { state: "stopped" }
  private entries: DeveloperRunLog[] = []
  private running?: RunningProcess
  private generation = 0
  private queue: Promise<void> = Promise.resolve()
  private pendingStart?: AbortController
  private readonly spawnProcess: NonNullable<DeveloperRunManagerDependencies["spawn"]>
  private readonly fetchUrl: typeof globalThis.fetch
  private readonly allocatePort: () => Promise<number>
  private readonly stopTree: (run: RunningProcess) => Promise<void>
  private readonly createRunId: () => string

  constructor(dependencies: DeveloperRunManagerDependencies = {}) {
    super()
    this.spawnProcess = dependencies.spawn ?? ((command, args, options) => spawn(command, args, options))
    this.fetchUrl = dependencies.fetch ?? globalThis.fetch
    this.allocatePort = dependencies.allocatePort ?? allocateLoopbackPort
    this.stopTree = dependencies.stopTree ?? stopProcessTree
    this.createRunId = dependencies.runId ?? randomUUID
  }

  status(): DeveloperRunStatus {
    return { ...this.currentStatus }
  }

  logs(): DeveloperRunLog[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  start(options: DeveloperRunStartOptions): Promise<DeveloperRunStatus> {
    return this.enqueue(() => this.startNow(options))
  }

  stop(): Promise<void> {
    this.pendingStart?.abort()
    return this.enqueue(() => this.stopNow())
  }

  restart(): Promise<DeveloperRunStatus> {
    return this.enqueue(async () => {
      const run = this.running
      const status = this.currentStatus
      const port = status.cdpUrl ? Number(new URL(status.cdpUrl).port) : NaN
      if (!run || !status.runId || !status.target || !status.executable || !Number.isInteger(port)) {
        throw new Error("Developer Automation is not running")
      }
      this.pushLog("system", "Restarting developer build")
      await this.stopRun(run, false, false)
      return this.startNow(
        { target: status.target, executable: status.executable },
        { runId: status.runId, port, profilePath: run.profilePath },
      )
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.queue.catch(() => {}).then(operation)
    this.queue = queued.then(() => {}, () => {})
    return queued
  }

  private async startNow(options: DeveloperRunStartOptions, reusable?: ReusableRun): Promise<DeveloperRunStatus> {
    if (this.running) await this.stopNow()

    const runId = reusable?.runId ?? this.createRunId()
    const port = reusable?.port ?? await this.allocatePort()
    const profilePath = reusable?.profilePath ?? join(options.tempRoot ?? join(tmpdir(), "codenomad-developer-runs"), runId)
    await mkdir(profilePath, { recursive: true, mode: 0o700 })

    const generation = ++this.generation
    const cdpUrl = `http://${LOOPBACK}:${port}`
    const args = options.target === "electron"
      ? [`--remote-debugging-address=${LOOPBACK}`, `--remote-debugging-port=${port}`, `--user-data-dir=${profilePath}`, "--enable-logging"]
      : []
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODENOMAD_UPDATE_CHANNEL: `developer-automation-${runId}`,
      CLI_CONFIG: join(profilePath, "config.yaml"),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--enable-source-maps"].filter(Boolean).join(" "),
      ...(options.target === "tauri" ? {
        WEBVIEW2_USER_DATA_FOLDER: join(profilePath, "webview2"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
          process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS?.split(/\s+/)
            .filter((value) => value && !value.startsWith("--remote-debugging-address=") && !value.startsWith("--remote-debugging-port="))
            .join(" "),
          `--remote-debugging-address=${LOOPBACK} --remote-debugging-port=${port}`,
        ].filter(Boolean).join(" "),
        RUST_BACKTRACE: "1",
      } : {}),
    }
    if (!reusable) this.entries = []
    this.setStatus({ state: "starting", runId, target: options.target, executable: options.executable, profilePath, cdpUrl })
    this.pushLog("system", `Starting ${options.target} developer build`)
    let child: RunChild
    try {
      child = this.spawnProcess(options.executable, args, {
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
        detached: process.platform !== "win32",
      })
    } catch (error) {
      await rm(profilePath, { recursive: true, force: true })
      this.setStatus({ ...this.currentStatus, state: "error", error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    const initialTree = child.pid
      ? captureInitialProcessTree(child.pid, process.platform).catch(() => ({}))
      : Promise.resolve({})
    const run: RunningProcess = { child, generation, profilePath, initialTree }
    this.running = run
    this.setStatus({ ...this.currentStatus, pid: child.pid })

    const buffers = {
      stdout: { message: "", truncated: false },
      stderr: { message: "", truncated: false },
    }
    const append = (stream: "stdout" | "stderr", message: string) => {
      const buffer = buffers[stream]
      const remaining = LOG_MESSAGE_LIMIT - 3 - buffer.message.length
      if (remaining > 0) buffer.message += message.slice(0, remaining)
      if (message.length > remaining) buffer.truncated = true
    }
    const flush = (stream: "stdout" | "stderr") => {
      const buffer = buffers[stream]
      if (buffer.message || buffer.truncated) this.pushLog(stream, `${buffer.message}${buffer.truncated ? "..." : ""}`)
      buffer.message = ""
      buffer.truncated = false
    }
    const pipe = (stream: "stdout" | "stderr", chunk: unknown) => {
      if (this.running !== run || generation !== this.generation) return
      const lines = String(chunk).split(/\r?\n/)
      append(stream, lines.shift() ?? "")
      while (lines.length) {
        flush(stream)
        append(stream, lines.shift() ?? "")
      }
    }
    child.stdout?.on("data", (chunk) => pipe("stdout", chunk))
    child.stderr?.on("data", (chunk) => pipe("stderr", chunk))
    child.on("error", (error) => {
      if (this.running !== run || generation !== this.generation) return
      this.pushLog("system", error.message)
      this.setStatus({ ...this.currentStatus, state: "error", error: error.message })
    })
    child.once("exit", (code, signal) => {
      if (this.running !== run || generation !== this.generation) return
      for (const stream of ["stdout", "stderr"] as const) flush(stream)
      const error = `Developer process exited before stop (code=${code ?? "null"}, signal=${signal ?? "null"})`
      this.pushLog("system", error)
      this.setStatus({ ...this.currentStatus, state: "error", pid: undefined, error })
    })

    const controller = new AbortController()
    this.pendingStart = controller
    try {
      const page = await this.waitUntilReady(run, port, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, controller.signal)
      this.pushLog("system", `Connected to ${page.title || page.url}`)
      this.setStatus({
        ...this.currentStatus,
        state: "ready",
        targetId: page.id,
        targetTitle: page.title,
        targetUrl: page.url,
      })
      return this.status()
    } catch (error) {
      if (this.running === run) {
        const message = error instanceof Error ? error.message : String(error)
        this.pushLog("system", message)
        this.setStatus({ ...this.currentStatus, state: "error", error: message })
        await this.stopRun(run, false)
      }
      throw error
    } finally {
      if (this.pendingStart === controller) this.pendingStart = undefined
    }
  }

  private async waitUntilReady(run: RunningProcess, port: number, timeoutMs: number, signal: AbortSignal): Promise<{ id: string; title: string; url: string }> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Developer run startup interrupted")
      if (this.running !== run || run.generation !== this.generation) throw new Error("Developer run superseded")
      if (this.currentStatus.state === "error") throw new Error(this.currentStatus.error ?? "Developer process failed")
      try {
        const base = `http://${LOOPBACK}:${port}`
        const version = await this.fetchUrl(`${base}/json/version`, { signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))) })
        if (version.ok && await version.json()) {
          const targets = await this.fetchUrl(`${base}/json/list`, { signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))) })
          if (targets.ok) {
            const page = (await targets.json() as Array<Record<string, unknown>>).find((target) =>
              target.type === "page" && typeof target.url === "string" && target.url !== "about:blank"
              && !new URL(target.url).pathname.endsWith("/loading.html")
              && typeof target.id === "string" && typeof target.title === "string"
              && typeof target.webSocketDebuggerUrl === "string")
            if (page) return { id: page.id as string, title: page.title as string, url: page.url as string }
          }
        }
      } catch (error) {
        if (signal.aborted) throw new Error("Developer run startup interrupted")
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
    }
    throw new Error(`Developer run did not expose a top-level debug page within ${timeoutMs}ms`)
  }

  private async stopNow(): Promise<void> {
    const run = this.running
    if (!run) {
      this.setStatus({ state: "stopped" })
      return
    }
    this.setStatus({ ...this.currentStatus, state: "stopping" })
    await this.stopRun(run, true)
  }

  private async stopRun(run: RunningProcess, updateStatus: boolean, removeProfile = true): Promise<void> {
    if (this.running === run) ++this.generation
    await this.stopTree(run)
    if (removeProfile) await rm(run.profilePath, { recursive: true, force: true })
    if (this.running === run) this.running = undefined
    if (updateStatus) {
      this.pushLog("system", "Developer build stopped")
      this.setStatus({ state: "stopped" })
    }
  }

  private setStatus(status: DeveloperRunStatus): void {
    this.currentStatus = status
    this.emit("status", this.status())
  }

  private pushLog(stream: DeveloperRunLog["stream"], message: string): void {
    const runId = this.currentStatus.runId
    if (!runId) return
    const entry = {
      runId,
      timestamp: Date.now(),
      stream,
      message: message.length > LOG_MESSAGE_LIMIT ? `${message.slice(0, LOG_MESSAGE_LIMIT - 3)}...` : message,
    }
    this.entries.push(entry)
    if (this.entries.length > LOG_LIMIT) this.entries.splice(0, this.entries.length - LOG_LIMIT)
    this.emit("log", { ...entry })
  }
}

export async function handleNativeDeveloperRunRequest(
  manager: DeveloperRunManager,
  method: string,
): Promise<unknown> {
  if (method === "developer.status") return { status: manager.status(), logs: manager.logs() }
  if (method === "developer.restart") return manager.restart()
  throw new Error(`Unsupported native developer request: ${method}`)
}
