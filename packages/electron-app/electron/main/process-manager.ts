import { spawn, type ChildProcess } from "child_process"
import { app } from "electron"
import { createRequire } from "module"
import { EventEmitter } from "events"
import { existsSync } from "fs"
import path from "path"
import { buildUserShellCommand, getUserShellEnv, supportsUserShell } from "./user-shell"

const nodeRequire = createRequire(import.meta.url)


type CliState = "starting" | "ready" | "error" | "stopped"

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

export declare interface CliProcessManager {
  on(event: "status", listener: (status: CliStatus) => void): this
  on(event: "ready", listener: (status: CliStatus) => void): this
  on(event: "log", listener: (entry: CliLogEntry) => void): this
  on(event: "exit", listener: (status: CliStatus) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

export class CliProcessManager extends EventEmitter {
  private child?: ChildProcess
  private status: CliStatus = { state: "stopped" }
  private stdoutBuffer = ""
  private stderrBuffer = ""

  async start(options: StartOptions): Promise<CliStatus> {
    if (this.child) {
      await this.stop()
    }

    this.stdoutBuffer = ""
    this.stderrBuffer = ""
    this.updateStatus({ state: "starting", port: undefined, pid: undefined, url: undefined, error: undefined })

    const cliEntry = this.resolveCliEntry(options)
    const args = this.buildCliArgs(options)

    console.info(
      `[cli] launching CodeNomad CLI (${options.dev ? "dev" : "prod"}) using ${cliEntry.runner} at ${cliEntry.entry}`,
    )

    const env = supportsUserShell() ? getUserShellEnv() : { ...process.env }
    env.ELECTRON_RUN_AS_NODE = "1"

    const spawnDetails = supportsUserShell()
      ? buildUserShellCommand(`ELECTRON_RUN_AS_NODE=1 exec ${this.buildCommand(cliEntry, args)}`)
      : this.buildDirectSpawn(cliEntry, args)

    const child = spawn(spawnDetails.command, spawnDetails.args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: false,
    })

    console.info(`[cli] spawn command: ${spawnDetails.command} ${spawnDetails.args.join(" ")}`)
    if (!child.pid) {
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

    child.on("error", (error) => {
      console.error("[cli] failed to start CLI:", error)
      this.updateStatus({ state: "error", error: error.message })
      this.emit("error", error)
    })

    child.on("exit", (code, signal) => {
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
      }, 15000)

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

    return new Promise((resolve) => {
      const killTimeout = setTimeout(() => {
        child.kill("SIGKILL")
      }, 4000)

      child.on("exit", () => {
        clearTimeout(killTimeout)
        this.child = undefined
        console.info("[cli] CLI process exited")
        this.updateStatus({ state: "stopped" })
        resolve()
      })

      child.kill("SIGTERM")
    })
  }

  getStatus(): CliStatus {
    return { ...this.status }
  }

  private handleTimeout() {
    if (this.child) {
      this.child.kill("SIGKILL")
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
      if (!line.trim()) continue
      console.info(`[cli][${stream}] ${line}`)
      this.emit("log", { stream, message: line })

      const port = this.extractPort(line)
      if (port && this.status.state === "starting") {
        const url = `http://127.0.0.1:${port}`
        console.info(`[cli] ready on ${url}`)
        this.updateStatus({ state: "ready", port, url })
        this.emit("ready", this.status)
      }
    }
  }

  private extractPort(line: string): number | null {
    const readyMatch = line.match(/CodeNomad Server is ready at http:\/\/[^:]+:(\d+)/i)
    if (readyMatch) {
      return parseInt(readyMatch[1], 10)
    }

    if (line.toLowerCase().includes("http server listening")) {
      const httpMatch = line.match(/:(\d{2,5})(?!.*:\d)/)
      if (httpMatch) {
        return parseInt(httpMatch[1], 10)
      }
      try {
        const parsed = JSON.parse(line)
        if (typeof parsed.port === "number") {
          return parsed.port
        }
      } catch {
        // not JSON, ignore
      }
    }

    return null
  }

  private updateStatus(patch: Partial<CliStatus>) {
    this.status = { ...this.status, ...patch }
    this.emit("status", this.status)
  }

  private buildCliArgs(options: StartOptions): string[] {
    const args = ["serve", "--host", "127.0.0.1", "--port", "0"]

    if (options.dev) {
      args.push("--ui-dev-server", "http://localhost:3000", "--log-level", "debug")
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

  private buildDirectSpawn(cliEntry: CliEntryResolution, args: string[]) {
    if (cliEntry.runner === "tsx") {
      return { command: process.execPath, args: [cliEntry.runnerPath!, cliEntry.entry, ...args] }
    }

    return { command: process.execPath, args: [cliEntry.entry, ...args] }
  }

  private resolveCliEntry(options: StartOptions): CliEntryResolution {
    if (options.dev) {
      const tsxPath = this.resolveTsx()
      const sourceCandidates = [
        path.resolve(app.getAppPath(), "..", "server", "src", "index.ts"),
        path.resolve(app.getAppPath(), "..", "packages", "server", "src", "index.ts"),
        path.resolve(process.cwd(), "packages", "server", "src", "index.ts"),
      ]
      const sourceEntry = sourceCandidates.find((candidate) => existsSync(candidate))
      if (tsxPath && sourceEntry) {
        return { entry: sourceEntry, runner: "tsx", runnerPath: tsxPath }
      }
    }

    const dist = this.tryResolveDist()
    if (dist) {
      return { entry: dist, runner: "node" }
    }

    throw new Error("Unable to locate CodeNomad CLI build (dist/bin.js). Please build @neuralnomads/codenomad.")
  }

  private resolveTsx(): string | null {
    try {
      const resolved = nodeRequire.resolve("tsx/dist/cli.js")
      if (resolved && existsSync(resolved)) {
        return resolved
      }
    } catch {
      return null
    }
    return null
  }

  private tryResolveDist(): string | null {
    const candidates: Array<string | (() => string)> = [
      () => nodeRequire.resolve("@neuralnomads/codenomad/dist/bin.js"),
      () => nodeRequire.resolve("@neuralnomads/codenomad/dist/bin.js", { paths: [app.getAppPath()] }),
      path.join(app.getAppPath(), "node_modules", "@neuralnomads", "codenomad", "dist", "bin.js"),
      path.resolve(app.getAppPath(), "..", "server", "dist", "bin.js"),
      path.resolve(app.getAppPath(), "..", "packages", "server", "dist", "bin.js"),
      path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@neuralnomads", "codenomad", "dist", "bin.js"),
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
}
