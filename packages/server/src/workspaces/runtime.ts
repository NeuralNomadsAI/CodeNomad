import { ChildProcess, spawn, spawnSync } from "child_process"
import { existsSync, statSync } from "fs"
import path from "path"
import { EventBus } from "../events/bus"
import { LogLevel, WorkspaceLogEntry } from "../api-types"
import { Logger } from "../logger"

export const WINDOWS_CMD_EXTENSIONS = new Set([".cmd", ".bat"])
export const WINDOWS_POWERSHELL_EXTENSIONS = new Set([".ps1"])

export function buildSpawnSpec(binaryPath: string, args: string[]) {
  if (process.platform !== "win32") {
    return { command: binaryPath, args, options: {} as const }
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
      options: { windowsVerbatimArguments: true } as const,
    }
  }

  if (WINDOWS_POWERSHELL_EXTENSIONS.has(extension)) {
    // powershell.exe ships with Windows. (pwsh may not.)
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", binaryPath, ...args],
      options: {} as const,
    }
  }

  return { command: binaryPath, args, options: {} as const }
}

const SENSITIVE_ENV_KEY = /(PASSWORD|TOKEN|SECRET)/i

function redactEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const redacted: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      redacted[key] = value
      continue
    }
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "[REDACTED]" : value
  }
  return redacted
}

interface LaunchOptions {
  workspaceId: string
  folder: string
  binaryPath: string
  environment?: Record<string, string>
  onExit?: (info: ProcessExitInfo) => void
}

export interface ProcessExitInfo {
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

  async launch(options: LaunchOptions): Promise<{ pid: number; port: number; exitPromise: Promise<ProcessExitInfo>; getLastOutput: () => string }> {
    this.validateFolder(options.folder)

    const args = ["serve", "--port", "0", "--print-logs", "--log-level", "DEBUG"]
    const env = { ...process.env, ...(options.environment ?? {}) }

    let exitResolve: ((info: ProcessExitInfo) => void) | null = null
    const exitPromise = new Promise<ProcessExitInfo>((resolveExit) => {
      exitResolve = resolveExit
    })

    // Store recent output for debugging - keep last 50 lines from each stream
    const MAX_OUTPUT_LINES = 50
    const recentStdout: string[] = []
    const recentStderr: string[] = []
    const getLastOutput = () => {
      const combined: string[] = []
      if (recentStderr.length > 0) {
        combined.push("Error Stream")
        combined.push(...recentStderr.slice(-10))
      }
      if (recentStdout.length > 0) {
        combined.push("Output Stream")
        combined.push(...recentStdout.slice(-10))
      }
      return combined.join("\n")
    }

    return new Promise((resolve, reject) => {
      const spec = buildSpawnSpec(options.binaryPath, args)
      const commandLine = [spec.command, ...spec.args].join(" ")
      this.logger.info(
        {
          workspaceId: options.workspaceId,
          folder: options.folder,
          binary: options.binaryPath,
          spawnCommand: spec.command,
          commandLine,
        },
        "Launching OpenCode process",
      )

      this.logger.debug(
        {
          workspaceId: options.workspaceId,
          spawnArgs: spec.args,
        },
        "OpenCode spawn args",
      )

      this.logger.trace(
        {
          workspaceId: options.workspaceId,
          env: redactEnvironment(env),
        },
        "OpenCode spawn environment",
      )
      const detached = process.platform !== "win32"
      const child = spawn(spec.command, spec.args, {
        cwd: options.folder,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached,
        ...spec.options,
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
        const exitInfo: ProcessExitInfo = {
          workspaceId: options.workspaceId,
          code,
          signal,
          requested: managed.requestedStop,
        }
        if (exitResolve) {
          exitResolve(exitInfo)
          exitResolve = null
        }
        if (!portFound) {
          const recentOutput = getLastOutput().trim()
          const reason = recentOutput || stderrBuffer || `Process exited with code ${code}`
          reject(new Error(reason))
        } else {
          options.onExit?.(exitInfo)
        }
      }

      const handleError = (error: Error) => {
        cleanupStreams()
        child.removeListener("exit", handleExit)
        this.processes.delete(options.workspaceId)
        this.logger.error({ workspaceId: options.workspaceId, err: error }, "Workspace runtime error")
        if (exitResolve) {
          exitResolve({ workspaceId: options.workspaceId, code: null, signal: null, requested: managed.requestedStop })
          exitResolve = null
        }
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
          const trimmed = line.trim()
          if (!trimmed) continue

          recentStdout.push(trimmed)
          if (recentStdout.length > MAX_OUTPUT_LINES) {
            recentStdout.shift()
          }

          this.emitLog(options.workspaceId, "info", line)

          if (!portFound) {
            const portMatch = line.match(/opencode server listening on http:\/\/.+:(\d+)/i)
            if (portMatch) {
              portFound = true
              stopWarningTimer()
              child.removeListener("error", handleError)
              const port = parseInt(portMatch[1], 10)
              this.logger.info({ workspaceId: options.workspaceId, port }, "Workspace runtime allocated port")
              resolve({ pid: child.pid!, port, exitPromise, getLastOutput })
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
          const trimmed = line.trim()
          if (!trimmed) continue

          recentStderr.push(trimmed)
          if (recentStderr.length > MAX_OUTPUT_LINES) {
            recentStderr.shift()
          }

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

    const pid = child.pid
    if (!pid) {
      this.logger.warn({ workspaceId }, "Workspace process missing PID; cannot stop")
      return
    }

    const isAlreadyExited = () => child.exitCode !== null || child.signalCode !== null

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
        this.logger.debug({ workspaceId, pid, err }, "Failed to signal POSIX process group")
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
        this.logger.debug({ workspaceId, pid, err }, "Failed to signal workspace PID")
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
        if (combined.includes("not found") || combined.includes("no running instance") || combined.includes("process") && combined.includes("not")) {
          return true
        }
        this.logger.debug({ workspaceId, pid, exitCode, stderr: result.stderr, stdout: result.stdout }, "taskkill failed")
        return false
      } catch (error) {
        this.logger.debug({ workspaceId, pid, err: error }, "taskkill failed to execute")
        return false
      }
    }

    const sendStopSignal = (signal: NodeJS.Signals) => {
      if (process.platform === "win32") {
        // Best-effort: terminate the whole process tree rooted at pid.
        // Use /F only for escalation.
        tryTaskkill(signal === "SIGKILL")
        return
      }

      // Prefer process-group signaling so wrapper launchers (bun/node) don't orphan the real server.
      const groupOk = tryKillPosixGroup(signal)
      if (!groupOk) {
        // Fallback to direct PID kill.
        tryKillSinglePid(signal)
      }
    }

    await new Promise<void>((resolve, reject) => {
      let escalationTimer: NodeJS.Timeout | null = null

      const cleanup = () => {
        child.removeListener("exit", onExit)
        child.removeListener("error", onError)
        if (escalationTimer) {
          clearTimeout(escalationTimer)
          escalationTimer = null
        }
      }

      const onExit = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      if (isAlreadyExited()) {
        this.logger.debug({ workspaceId, exitCode: child.exitCode, signal: child.signalCode }, "Process already exited")
        cleanup()
        resolve()
        return
      }

      child.once("exit", onExit)
      child.once("error", onError)

      this.logger.debug(
        { workspaceId, pid, detached: process.platform !== "win32" },
        "Sending SIGTERM to workspace process (tree/group)",
      )
      sendStopSignal("SIGTERM")

      escalationTimer = setTimeout(() => {
        escalationTimer = null
        if (isAlreadyExited()) {
          this.logger.debug({ workspaceId, pid }, "Workspace exited before SIGKILL escalation")
          return
        }
        this.logger.warn({ workspaceId, pid }, "Process did not stop after SIGTERM, escalating")
        sendStopSignal("SIGKILL")
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
