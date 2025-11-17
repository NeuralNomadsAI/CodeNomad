import { ChildProcess, spawn } from "child_process"
import { existsSync, statSync } from "fs"
import path from "path"
import { EventBus } from "../events/bus"
import { LogLevel, WorkspaceLogEntry } from "../api-types"
import { Logger } from "../logger"

interface LaunchOptions {
  workspaceId: string
  folder: string
  binaryPath: string
  environment?: Record<string, string>
  onExit?: (info: ProcessExitInfo) => void
}

interface ProcessExitInfo {
  workspaceId: string
  code: number | null
  signal: NodeJS.Signals | null
  requested: boolean
}

interface ManagedProcess {
  child: ChildProcess
  requestedStop: boolean
}

export class WorkspaceRuntime {
  private processes = new Map<string, ManagedProcess>()

  constructor(private readonly eventBus: EventBus, private readonly logger: Logger) {}

  async launch(options: LaunchOptions): Promise<{ pid: number; port: number }> {
    this.validateFolder(options.folder)

    const args = ["serve", "--port", "0", "--print-logs", "--log-level", "DEBUG"]
    const env = { ...process.env, ...(options.environment ?? {}) }

    return new Promise((resolve, reject) => {
      this.logger.info({ workspaceId: options.workspaceId, folder: options.folder }, "Launching OpenCode process")
      const child = spawn(options.binaryPath, args, {
        cwd: options.folder,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })

      const managed: ManagedProcess = { child, requestedStop: false }
      this.processes.set(options.workspaceId, managed)

      let stdoutBuffer = ""
      let stderrBuffer = ""
      let portFound = false

      let warningTimer: NodeJS.Timeout | null = null

      const startWarningTimer = () => {
        warningTimer = setInterval(() => {
          this.logger.warn({ workspaceId: options.workspaceId }, "Workspace runtime has not reported a port yet")
        }, 10000)
      }

      const stopWarningTimer = () => {
        if (warningTimer) {
          clearInterval(warningTimer)
          warningTimer = null
        }
      }

      startWarningTimer()

      const cleanupStreams = () => {
        stopWarningTimer()
        child.stdout?.removeAllListeners()
        child.stderr?.removeAllListeners()
      }

      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        this.logger.info({ workspaceId: options.workspaceId, code, signal }, "OpenCode process exited")
        this.processes.delete(options.workspaceId)
        cleanupStreams()
        child.removeListener("error", handleError)
        child.removeListener("exit", handleExit)
        if (!portFound) {
          const reason = stderrBuffer || `Process exited with code ${code}`
          reject(new Error(reason))
        } else {
          options.onExit?.({ workspaceId: options.workspaceId, code, signal, requested: managed.requestedStop })
        }
      }

      const handleError = (error: Error) => {
        cleanupStreams()
        child.removeListener("exit", handleExit)
        this.processes.delete(options.workspaceId)
        this.logger.error({ workspaceId: options.workspaceId, err: error }, "Workspace runtime error")
        reject(error)
      }

      child.on("error", handleError)
      child.on("exit", handleExit)

      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString()
        stdoutBuffer += text
        const lines = stdoutBuffer.split("\n")
        stdoutBuffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.trim()) continue
          this.emitLog(options.workspaceId, "info", line)

          if (!portFound) {
            const portMatch = line.match(/opencode server listening on http:\/\/.+:(\d+)/i)
            if (portMatch) {
              portFound = true
              cleanupStreams()
              child.removeListener("error", handleError)
              const port = parseInt(portMatch[1], 10)
              this.logger.info({ workspaceId: options.workspaceId, port }, "Workspace runtime allocated port")
              resolve({ pid: child.pid!, port })
            }
          }
        }
      })

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString()
        stderrBuffer += text
        const lines = stderrBuffer.split("\n")
        stderrBuffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.trim()) continue
          this.emitLog(options.workspaceId, "error", line)
        }
      })
    })
  }

  async stop(workspaceId: string): Promise<void> {
    const managed = this.processes.get(workspaceId)
    if (!managed) return

    managed.requestedStop = true
    const child = managed.child
    this.logger.info({ workspaceId }, "Stopping OpenCode process")

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.removeListener("exit", onExit)
        child.removeListener("error", onError)
      }

      const onExit = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      const resolveIfAlreadyExited = () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          this.logger.debug({ workspaceId, exitCode: child.exitCode, signal: child.signalCode }, "Process already exited")
          cleanup()
          resolve()
          return true
        }
        return false
      }

      child.once("exit", onExit)
      child.once("error", onError)

      if (resolveIfAlreadyExited()) {
        return
      }

      this.logger.debug({ workspaceId }, "Sending SIGTERM to workspace process")
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!child.killed) {
          this.logger.warn({ workspaceId }, "Process did not stop after SIGTERM, force killing")
          child.kill("SIGKILL")
        } else {
          this.logger.debug({ workspaceId }, "Workspace process stopped gracefully before SIGKILL timeout")
        }
      }, 2000)
    })
  }

  private emitLog(workspaceId: string, level: LogLevel, message: string) {
    const entry: WorkspaceLogEntry = {
      workspaceId,
      timestamp: new Date().toISOString(),
      level,
      message: message.trim(),
    }

    this.eventBus.publish({ type: "workspace.log", entry })
  }

  private validateFolder(folder: string) {
    const resolved = path.resolve(folder)
    if (!existsSync(resolved)) {
      throw new Error(`Folder does not exist: ${resolved}`)
    }
    const stats = statSync(resolved)
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`)
    }
  }
}
