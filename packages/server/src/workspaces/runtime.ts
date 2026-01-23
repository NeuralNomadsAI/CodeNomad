import { ChildProcess, spawn, execSync, spawnSync } from "child_process"
import { existsSync, statSync } from "fs"
import path from "path"
import os from "os"
import { EventBus } from "../events/bus"
import { LogLevel, WorkspaceLogEntry } from "../api-types"
import { Logger } from "../logger"
import { registerWorkspacePid, unregisterWorkspacePid } from "./pid-registry"
import { EraConfigService, type EraLaunchConfig } from "../era"

/**
 * Kill a process and all its children (process tree)
 * This ensures that child processes spawned by node wrappers are also killed
 */
function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM", logger?: Logger): void {
  try {
    if (process.platform === "win32") {
      // Windows: use taskkill with /T flag to kill tree
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" })
    } else {
      // Unix: First try to kill children, then parent
      // Get child PIDs using pgrep
      try {
        const children = execSync(`pgrep -P ${pid}`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean)
        for (const childPid of children) {
          const childPidNum = parseInt(childPid, 10)
          if (!isNaN(childPidNum)) {
            logger?.debug({ pid: childPidNum, parentPid: pid }, "Killing child process")
            try {
              process.kill(childPidNum, signal)
            } catch {
              // Child may have already exited
            }
          }
        }
      } catch {
        // No children or pgrep failed - that's fine
      }
      // Kill the parent process
      process.kill(pid, signal)
    }
  } catch (error) {
    logger?.debug({ pid, error }, "Error during process tree kill (process may have already exited)")
  }
}

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
  eraConfig?: EraLaunchConfig
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

/**
 * Check if a binary path is era-code
 */
function isEraCodeBinary(binaryPath: string): boolean {
  const basename = path.basename(binaryPath).toLowerCase()
  return basename.startsWith("era-code") || basename === "era-code.js"
}

/**
 * Check if folder is user's home directory (era-code init should not run there)
 */
function isHomeDirectory(folder: string): boolean {
  const home = os.homedir()
  const resolved = path.resolve(folder)
  return resolved === home
}

export class WorkspaceRuntime {
  private processes = new Map<string, ManagedProcess>()
  private eraConfigService: EraConfigService | null = null

  constructor(private readonly eventBus: EventBus, private readonly logger: Logger) {}

  /**
   * Set the Era config service for era-enabled launches
   */
  setEraConfigService(service: EraConfigService): void {
    this.eraConfigService = service
  }

  async launch(options: LaunchOptions): Promise<{ pid: number; port: number }> {
    this.validateFolder(options.folder)

    const useEraCode = isEraCodeBinary(options.binaryPath)
    const isHome = isHomeDirectory(options.folder)

    // Build environment with optional era config
    let env = { ...process.env, ...(options.environment ?? {}) }

    // Apply era environment variables if era config is provided
    if (options.eraConfig?.enabled && this.eraConfigService) {
      const eraEnv = this.eraConfigService.getLaunchEnvironment(options.eraConfig)
      env = { ...env, ...eraEnv }
      this.logger.info(
        {
          workspaceId: options.workspaceId,
          eraAssets: options.eraConfig.assetsPath,
          agentCount: options.eraConfig.agents.length,
          commandCount: options.eraConfig.commands.length,
        },
        "Launching with Era Code assets"
      )
    }

    // For era-code: run init first (unless in home directory)
    if (useEraCode && !isHome) {
      this.logger.info(
        { workspaceId: options.workspaceId, folder: options.folder },
        "Running era-code init --quiet"
      )
      try {
        const initSpec = buildSpawnSpec(options.binaryPath, ["init", "--quiet"])
        const initResult = spawnSync(initSpec.command, initSpec.args, {
          cwd: options.folder,
          env,
          encoding: "utf-8",
          timeout: 30000, // 30 second timeout for init
          ...initSpec.options,
        })
        if (initResult.error) {
          this.logger.warn(
            { workspaceId: options.workspaceId, error: initResult.error.message },
            "era-code init failed, continuing anyway"
          )
        } else if (initResult.status !== 0) {
          this.logger.warn(
            { workspaceId: options.workspaceId, status: initResult.status, stderr: initResult.stderr },
            "era-code init exited with non-zero status, continuing anyway"
          )
        } else {
          this.logger.info(
            { workspaceId: options.workspaceId },
            "era-code init completed successfully"
          )
        }
      } catch (error) {
        this.logger.warn(
          { workspaceId: options.workspaceId, error },
          "era-code init threw exception, continuing anyway"
        )
      }
    }

    // Build the command args based on binary type
    let args: string[]
    if (useEraCode) {
      // era-code start --quiet -- serve --port 0 --print-logs --log-level DEBUG
      args = ["start", "--quiet", "--", "serve", "--port", "0", "--print-logs", "--log-level", "DEBUG"]
    } else {
      // opencode serve --port 0 --print-logs --log-level DEBUG
      args = ["serve", "--port", "0", "--print-logs", "--log-level", "DEBUG"]
    }

    return new Promise((resolve, reject) => {
      const spec = buildSpawnSpec(options.binaryPath, args)
      const commandLine = [spec.command, ...spec.args].join(" ")
      this.logger.info(
        {
          workspaceId: options.workspaceId,
          folder: options.folder,
          binary: options.binaryPath,
          useEraCode,
          eraEnabled: options.eraConfig?.enabled ?? false,
          spawnCommand: spec.command,
          spawnArgs: spec.args,
          commandLine,
          env: redactEnvironment(env),
        },
        "Launching OpenCode process",
      )
      const child = spawn(spec.command, spec.args, {
        cwd: options.folder,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Ensure child processes are in the same process group for proper cleanup
        detached: false,
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
        // Unregister workspace PID from registry
        unregisterWorkspacePid(options.workspaceId, this.logger)
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
              // Register workspace PID for orphan cleanup
              registerWorkspacePid(options.workspaceId, child.pid!, options.folder, this.logger)
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

      const pid = child.pid
      if (!pid) {
        this.logger.warn({ workspaceId }, "No PID available for process, using child.kill()")
        child.kill("SIGTERM")
        return
      }

      this.logger.debug({ workspaceId, pid }, "Sending SIGTERM to workspace process tree")
      killProcessTree(pid, "SIGTERM", this.logger)

      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.logger.warn({ workspaceId, pid }, "Process tree did not stop after SIGTERM, force killing")
          killProcessTree(pid, "SIGKILL", this.logger)
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
