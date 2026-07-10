import { ChildProcess, spawn, spawnSync } from "child_process"
import { randomBytes } from "crypto"
import { existsSync, statSync } from "fs"
import path from "path"
import { EventBus } from "../events/bus"
import { LogLevel, WorkspaceLogEntry } from "../api-types"
import { Logger } from "../logger"
import { buildSpawnSpec } from "./spawn"
import {
  descendantsOf,
  probePosixProcesses,
  probeWindowsProcesses,
  probeWslProcesses,
  sameProcess,
  signalPosixProcesses,
  signalOwnedPosixProcessGroup,
  signalWindowsProcesses,
  signalWslProcesses,
  startedNoLaterThan,
  type GuardedSignalResult,
  type ProcessIdentity,
  type ProcessSnapshot,
} from "./process-identity"
import {
  LAUNCH_CLEANUP_TOKEN_ENV,
  probeLaunchCleanupToken,
  signalLaunchCleanupToken,
  signalOwnedWindowsProcessTree,
} from "./launch-cleanup"

const SENSITIVE_ENV_KEY = /(PASSWORD|TOKEN|SECRET)/i
const WSL_PID_MARKER = "__CODENOMAD_WSL_PID__:"

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
  logLevel?: string
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
  cleanupToken: string
  identityCaptureFailed?: boolean
  requestedStop: boolean
  stopPromise?: Promise<void>
  cancelWaits?: () => void
  finalizeExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  targets?: {
    leader?: ProcessIdentity
    groupId?: number
    dispatchCutoff?: string
    members: Map<number, ProcessIdentity>
  }
  wsl?: {
    distro: string
    linuxPid: number | null
    linuxPgid: number | null
    leaderStartTime: string | null
    bootId: string | null
    dispatchCutoff?: string
    members: Map<number, ProcessIdentity>
  }
}

type RuntimeTimeout = ReturnType<typeof setTimeout>

export interface WorkspaceRuntimeOptions {
  gracefulStopTimeoutMs?: number
  forcedStopTimeoutMs?: number
  stopCommandTimeoutMs?: number
  platform?: NodeJS.Platform
  spawn?: typeof spawn
  spawnSync?: typeof spawnSync
  setTimeout?: (callback: () => void, delayMs: number) => RuntimeTimeout
  clearTimeout?: (timer: RuntimeTimeout) => void
}

export class WorkspaceStopTimeoutError extends Error {
  readonly code = "WORKSPACE_STOP_TIMEOUT"
  readonly retryable = true

  constructor(workspaceId: string, pid: number | undefined, timeoutMs: number, liveness: string, failures: string[]) {
    const failureDetails = failures.length > 0 ? ` Stop failures: ${failures.join("; ")}.` : ""
    super(
      `Workspace ${workspaceId} process ${pid ?? "with unknown PID"} did not stop within ${timeoutMs}ms; ${liveness}.` +
        `${failureDetails} The stop can be retried.`,
    )
    this.name = "WorkspaceStopTimeoutError"
  }
}

export class WorkspaceRuntimeLaunchCancelledError extends Error {
  readonly code = "WORKSPACE_RUNTIME_LAUNCH_CANCELLED"

  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} runtime launch was cancelled`)
    this.name = "WorkspaceRuntimeLaunchCancelledError"
  }
}

export class WorkspaceRuntimeIdentityCaptureError extends Error {
  readonly code = "WORKSPACE_RUNTIME_IDENTITY_CAPTURE_FAILED"

  constructor(workspaceId: string, detail: string) {
    super(`Workspace ${workspaceId} process identity capture failed: ${detail}`)
    this.name = "WorkspaceRuntimeIdentityCaptureError"
  }
}

export class WorkspaceRuntime {
  private processes = new Map<string, ManagedProcess>()
  private readonly platform: NodeJS.Platform
  private readonly spawnProcess: typeof spawn
  private readonly spawnCommand: typeof spawnSync
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => RuntimeTimeout
  private readonly cancelTimeout: (timer: RuntimeTimeout) => void
  private readonly gracefulStopTimeoutMs: number
  private readonly forcedStopTimeoutMs: number
  private readonly stopCommandTimeoutMs: number

  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.platform = options.platform ?? process.platform
    this.spawnProcess = options.spawn ?? spawn
    this.spawnCommand = options.spawnSync ?? spawnSync
    this.scheduleTimeout = options.setTimeout ?? setTimeout
    this.cancelTimeout = options.clearTimeout ?? clearTimeout
    this.gracefulStopTimeoutMs = Math.max(0, options.gracefulStopTimeoutMs ?? 2000)
    this.forcedStopTimeoutMs = Math.max(0, options.forcedStopTimeoutMs ?? 2000)
    this.stopCommandTimeoutMs = Math.max(1, options.stopCommandTimeoutMs ?? 1000)
  }

  async launch(options: LaunchOptions): Promise<{
    pid: number
    port: number
    exitPromise: Promise<ProcessExitInfo>
    cancellationPromise: Promise<WorkspaceRuntimeLaunchCancelledError>
    getLastOutput: () => string
  }> {
    this.validateFolder(options.folder)

    const logLevel = typeof options.logLevel === "string" ? options.logLevel.toUpperCase() : "DEBUG"
    const args = ["serve", "--port", "0", "--print-logs", "--log-level", logLevel]
    const cleanupToken = randomBytes(32).toString("hex")
    const env = { ...process.env, ...(options.environment ?? {}), [LAUNCH_CLEANUP_TOKEN_ENV]: cleanupToken }

    let exitResolve: ((info: ProcessExitInfo) => void) | null = null
    const exitPromise = new Promise<ProcessExitInfo>((resolveExit) => {
      exitResolve = resolveExit
    })
    let cancellationResolve: ((error: WorkspaceRuntimeLaunchCancelledError) => void) | null = null
    const cancellationPromise = new Promise<WorkspaceRuntimeLaunchCancelledError>((resolveCancellation) => {
      cancellationResolve = resolveCancellation
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
      const propagatedEnvKeys = [...Object.keys(options.environment ?? {}), LAUNCH_CLEANUP_TOKEN_ENV]
      const spec = buildSpawnSpec(options.binaryPath, args, {
        cwd: options.folder,
        env,
        propagateEnvKeys: propagatedEnvKeys,
        wslPidMarker: WSL_PID_MARKER,
      })
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
      const detached = this.platform !== "win32"
      const child = this.spawnProcess(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached,
        ...spec.options,
      })

      const managed: ManagedProcess = {
        child,
        cleanupToken,
        requestedStop: false,
        targets: { members: new Map<number, ProcessIdentity>() },
        ...(spec.wsl
          ? {
              wsl: {
                distro: spec.wsl.distro,
                linuxPid: null,
                linuxPgid: null,
                leaderStartTime: null,
                bootId: null,
                members: new Map<number, ProcessIdentity>(),
              },
            }
          : {}),
      }
      this.processes.set(options.workspaceId, managed)
      const launchSnapshot = child.pid
        ? this.platform === "win32"
          ? probeWindowsProcesses(this.spawnCommand, this.stopCommandTimeoutMs)
          : probePosixProcesses(this.spawnCommand, this.stopCommandTimeoutMs, this.platform)
        : { ok: false as const, error: "spawned child did not expose a PID" }
      const launchLeader = launchSnapshot.ok && child.pid ? launchSnapshot.processes.get(child.pid) : undefined
      if (!launchLeader) {
        const detail = launchSnapshot.ok
          ? `spawned PID ${child.pid ?? "unknown"} was absent from the identity snapshot`
          : launchSnapshot.error
        this.beginFailedLaunchCleanup(options.workspaceId, managed)
        reject(new WorkspaceRuntimeIdentityCaptureError(options.workspaceId, detail))
        return
      }
      managed.targets!.leader = launchLeader
      managed.targets!.groupId = launchLeader.groupId
      managed.targets!.members.set(launchLeader.pid, launchLeader)

      let stdoutBuffer = ""
      let stderrBuffer = ""
      let portFound = false
      let pendingPort: number | null = null
      let launchSettled = false

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

      managed.cancelWaits = () => {
        const error = new WorkspaceRuntimeLaunchCancelledError(options.workspaceId)
        if (!launchSettled) {
          launchSettled = true
          stopWarningTimer()
          reject(error)
        }
        if (cancellationResolve) {
          cancellationResolve(error)
          cancellationResolve = null
        }
      }

      const cleanupStreams = () => {
        stopWarningTimer()
        child.stdout?.removeAllListeners()
        child.stderr?.removeAllListeners()
      }

      let finalized = false
      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (finalized) return
        finalized = true
        this.logger.info({ workspaceId: options.workspaceId, code, signal }, "OpenCode process exited")
        if (!managed.requestedStop && this.processes.get(options.workspaceId) === managed) {
          this.processes.delete(options.workspaceId)
        }
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
          if (!launchSettled) {
            launchSettled = true
            reject(new Error(reason))
          }
        } else {
          options.onExit?.(exitInfo)
        }
      }
      managed.finalizeExit = handleExit

      const handleError = (error: Error) => {
        cleanupStreams()
        child.removeListener("exit", handleExit)
        if (!managed.requestedStop && this.processes.get(options.workspaceId) === managed) {
          this.processes.delete(options.workspaceId)
        }
        this.logger.error({ workspaceId: options.workspaceId, err: error }, "Workspace runtime error")
        if (exitResolve) {
          exitResolve({ workspaceId: options.workspaceId, code: null, signal: null, requested: managed.requestedStop })
          exitResolve = null
        }
        if (!launchSettled) {
          launchSettled = true
          reject(error)
        }
      }

      child.on("error", handleError)
      child.on("exit", handleExit)

      const resolveLaunchIfIdentified = () => {
        if (launchSettled || pendingPort === null) return
        if (managed.wsl && (!managed.wsl.linuxPid || !managed.wsl.linuxPgid || !managed.wsl.leaderStartTime || !managed.wsl.bootId)) {
          return
        }
        portFound = true
        launchSettled = true
        stopWarningTimer()
        child.removeListener("error", handleError)
        this.logger.info({ workspaceId: options.workspaceId, port: pendingPort }, "Workspace runtime allocated port")
        resolve({ pid: child.pid!, port: pendingPort, exitPromise, cancellationPromise, getLastOutput })
      }

      const failWslIdentityCapture = (detail: string) => {
        if (launchSettled) return
        launchSettled = true
        managed.requestedStop = true
        cleanupStreams()
        this.beginFailedLaunchCleanup(options.workspaceId, managed)
        reject(new WorkspaceRuntimeIdentityCaptureError(options.workspaceId, detail))
      }

      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString()
        stdoutBuffer += text
        const lines = stdoutBuffer.split("\n")
        stdoutBuffer = lines.pop() ?? ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          if (managed.wsl && trimmed.startsWith(WSL_PID_MARKER)) {
            const [linuxPidText, linuxPgidText, linuxStartTime = "", bootId = ""] = trimmed.slice(WSL_PID_MARKER.length).split(":", 4)
            const linuxPid = Number.parseInt(linuxPidText ?? "", 10)
            const linuxPgid = Number.parseInt(linuxPgidText ?? "", 10)
            if (Number.isInteger(linuxPid) && linuxPid > 0 && Number.isInteger(linuxPgid) && linuxPgid > 0 && /^\d+$/.test(linuxStartTime) && bootId) {
              managed.wsl.linuxPid = linuxPid
              managed.wsl.linuxPgid = linuxPgid
              managed.wsl.leaderStartTime = linuxStartTime
              managed.wsl.bootId = bootId
              managed.wsl.members.set(linuxPid, {
                pid: linuxPid,
                parentPid: 0,
                groupId: linuxPgid,
                startTime: linuxStartTime,
                bootId,
                startOrder: linuxStartTime,
              })
              this.logger.debug(
                {
                  workspaceId: options.workspaceId,
                  linuxPid,
                  linuxPgid: managed.wsl.linuxPgid,
                  linuxStartTime: managed.wsl.leaderStartTime,
                },
                "Captured WSL OpenCode process identity",
              )
              resolveLaunchIfIdentified()
            } else {
              failWslIdentityCapture("WSL launcher returned an incomplete Linux PID identity")
            }
            continue
          }

          recentStdout.push(trimmed)
          if (recentStdout.length > MAX_OUTPUT_LINES) {
            recentStdout.shift()
          }

          this.emitLog(options.workspaceId, "info", line)

          if (!portFound) {
            const portMatch = line.match(/opencode server listening on http:\/\/.+:(\d+)/i)
            if (portMatch && !launchSettled) {
              pendingPort = parseInt(portMatch[1], 10)
              if (managed.wsl && (!managed.wsl.leaderStartTime || !managed.wsl.bootId)) {
                failWslIdentityCapture("WSL process reported a port before its Linux identity")
              } else {
                resolveLaunchIfIdentified()
              }
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

  private beginFailedLaunchCleanup(workspaceId: string, managed: ManagedProcess): void {
    const child = managed.child
    managed.identityCaptureFailed = true
    void this.stop(workspaceId).catch((error) => {
      this.logger.warn({ workspaceId, err: error }, "Unpublished workspace cleanup remains pending")
    })
    try {
      child.kill("SIGTERM")
    } catch (error) {
      this.logger.debug({ workspaceId, err: error }, "Failed initial live-child cleanup signal")
    }
  }

  stop(workspaceId: string): Promise<void> {
    const managed = this.processes.get(workspaceId)
    if (!managed) return Promise.resolve()

    if (managed.stopPromise) {
      return managed.stopPromise
    }

    const stopPromise = this.stopManagedProcess(workspaceId, managed)
    managed.stopPromise = stopPromise
    void stopPromise.then(
      () => {
        if (managed.stopPromise === stopPromise) managed.stopPromise = undefined
      },
      () => {
        if (managed.stopPromise === stopPromise) managed.stopPromise = undefined
      },
    )
    return stopPromise
  }

  private stopManagedProcess(workspaceId: string, managed: ManagedProcess): Promise<void> {
    managed.requestedStop = true
    managed.cancelWaits?.()
    managed.cancelWaits = undefined
    const child = managed.child
    this.logger.info({ workspaceId }, "Stopping OpenCode process")

    const pid = child.pid
    const failures: string[] = []

    type TargetLiveness = { state: "alive" | "gone" | "unknown"; detail: string }
    type RefreshedTargets = {
      snapshot: ProcessSnapshot
      leaderMatches: boolean
      aliveMembers: ProcessIdentity[]
    }

    const wrapperExited = () => child.exitCode !== null || child.signalCode !== null
    const rememberGroupMembers = (
      snapshot: ProcessSnapshot,
      targets: NonNullable<ManagedProcess["targets"]>,
    ): RefreshedTargets => {
      if (!snapshot.ok || !pid) return { snapshot, leaderMatches: false, aliveMembers: [] }
      const currentLeader = snapshot.processes.get(pid)
      const leaderMatches = sameProcess(targets.leader, currentLeader)
      const currentGroupLeader = targets.groupId ? snapshot.processes.get(targets.groupId) : undefined
      const groupWasReused = Boolean(currentGroupLeader && !sameProcess(targets.leader, currentGroupLeader))
      if (targets.groupId) {
        for (const process of snapshot.processes.values()) {
          const launchBootMatches = !targets.leader?.bootId || process.bootId === targets.leader.bootId
          const withinProvenLinuxDispatch = this.platform === "linux" && Boolean(
            targets.dispatchCutoff && launchBootMatches && startedNoLaterThan(process, targets.dispatchCutoff),
          )
          if (process.groupId === targets.groupId && (leaderMatches || (!groupWasReused && withinProvenLinuxDispatch))) {
            targets.members.set(process.pid, process)
          }
        }
      }
      return {
        snapshot,
        leaderMatches,
        aliveMembers: Array.from(targets.members.values()).filter((identity) =>
          sameProcess(identity, snapshot.processes.get(identity.pid)),
        ),
      }
    }

    const refreshHostTargets = (): RefreshedTargets => {
      const targets = managed.targets ?? { members: new Map<number, ProcessIdentity>() }
      managed.targets = targets
      const snapshot = this.platform === "win32"
        ? probeWindowsProcesses(this.spawnCommand, this.stopCommandTimeoutMs)
        : probePosixProcesses(this.spawnCommand, this.stopCommandTimeoutMs, this.platform)
      if (!snapshot.ok) {
        failures.push(`${this.platform === "win32" ? "Windows" : "POSIX"} identity discovery failed: ${snapshot.error}`)
        return { snapshot, leaderMatches: false, aliveMembers: [] }
      }

      const refreshed = rememberGroupMembers(snapshot, targets)
      if (this.platform === "win32" && refreshed.leaderMatches && targets.leader) {
        for (const descendant of descendantsOf(snapshot.processes, targets.leader.pid)) {
          targets.members.set(descendant.pid, descendant)
        }
        refreshed.aliveMembers = Array.from(targets.members.values()).filter((identity) =>
          sameProcess(identity, snapshot.processes.get(identity.pid)),
        )
      }
      return refreshed
    }

    const refreshWslTargets = (): RefreshedTargets => {
      const wsl = managed.wsl!
      const snapshot = probeWslProcesses(this.spawnCommand, wsl.distro, this.stopCommandTimeoutMs)
      if (!snapshot.ok) {
        failures.push(`WSL identity discovery failed: ${snapshot.error}`)
        return { snapshot, leaderMatches: false, aliveMembers: [] }
      }
      if (!wsl.linuxPid || !wsl.leaderStartTime) {
        return { snapshot, leaderMatches: false, aliveMembers: [] }
      }
      const leaderIdentity: ProcessIdentity = {
        pid: wsl.linuxPid,
        parentPid: 0,
        groupId: wsl.linuxPgid ?? wsl.linuxPid,
        startTime: wsl.leaderStartTime,
        ...(wsl.bootId ? { bootId: wsl.bootId } : {}),
        startOrder: wsl.leaderStartTime,
      }
      const currentLeader = snapshot.processes.get(wsl.linuxPid)
      const leaderMatches = sameProcess(leaderIdentity, currentLeader)
      const currentGroupLeader = wsl.linuxPgid ? snapshot.processes.get(wsl.linuxPgid) : undefined
      const groupWasReused = Boolean(currentGroupLeader && !sameProcess(leaderIdentity, currentGroupLeader))
      if (wsl.linuxPgid) {
        for (const process of snapshot.processes.values()) {
          const withinProvenDispatch = Boolean(
            wsl.dispatchCutoff && process.bootId === wsl.bootId && startedNoLaterThan(process, wsl.dispatchCutoff),
          )
          if (process.groupId === wsl.linuxPgid && (leaderMatches || (!groupWasReused && withinProvenDispatch))) {
            wsl.members.set(process.pid, process)
          }
        }
      }
      return {
        snapshot,
        leaderMatches,
        aliveMembers: Array.from(wsl.members.values()).filter((identity) =>
          sameProcess(identity, snapshot.processes.get(identity.pid)),
        ),
      }
    }

    const hasWslIdentity = () => Boolean(
      managed.wsl?.linuxPid && managed.wsl.linuxPgid && managed.wsl.leaderStartTime && managed.wsl.bootId,
    )

    const canUseTokenCleanup = () => this.platform === "linux" || Boolean(managed.wsl)
    const tokenTarget = () => managed.wsl ?? managed.targets!
    const refreshTokenTargets = (): ProcessSnapshot | undefined => {
      if (!canUseTokenCleanup()) return undefined
      const snapshot = probeLaunchCleanupToken(
        this.spawnCommand,
        managed.cleanupToken,
        this.stopCommandTimeoutMs,
        managed.wsl?.distro,
      )
      if (!snapshot.ok) {
        failures.push(`${managed.wsl ? "WSL" : "Linux"} launch-token discovery failed: ${snapshot.error}`)
        return snapshot
      }
      const target = tokenTarget()
      for (const identity of snapshot.processes.values()) target.members.set(identity.pid, identity)
      return snapshot
    }

    const recordSignalResult = (
      result: GuardedSignalResult,
      target: NonNullable<ManagedProcess["targets"]> | NonNullable<ManagedProcess["wsl"]>,
      platformName: string,
      signal: NodeJS.Signals,
    ) => {
      if (!result.ok) {
        failures.push(`${platformName} guarded ${signal} failed: ${result.error}`)
        return
      }
      if (result.matched && !result.signalSent) failures.push(`${platformName} guarded ${signal} matched but sent no signal`)
      for (const identity of result.signaled) target.members.set(identity.pid, identity)
      if (result.cutoff) target.dispatchCutoff = result.cutoff
    }

    const sendStopSignal = (signal: NodeJS.Signals) => {
      if (!pid) {
        failures.push(`${signal} was not sent because the process PID is unavailable`)
      }

      let ownedPosixHandled = false
      if (pid && managed.identityCaptureFailed && this.platform === "win32" && !managed.wsl && !wrapperExited()) {
        const cleanup = signalOwnedWindowsProcessTree(this.spawnCommand, pid, this.stopCommandTimeoutMs)
        if (!cleanup.ok) {
          failures.push(`Windows live-root cleanup failed: ${cleanup.error}`)
        } else {
          for (const identity of cleanup.targets) managed.targets!.members.set(identity.pid, identity)
        }
      } else if (pid && managed.identityCaptureFailed && this.platform !== "linux" && this.platform !== "win32" && !wrapperExited()) {
        const cleanup = signalOwnedPosixProcessGroup(this.spawnCommand, pid, signal, this.stopCommandTimeoutMs)
        recordSignalResult(cleanup, managed.targets!, "owned POSIX group", signal)
        if (cleanup.ok && cleanup.matched) {
          const leader = cleanup.signaled.find((identity) => identity.pid === pid)
          if (leader) {
            managed.targets!.leader = leader
            managed.targets!.groupId = pid
          }
        }
        refreshHostTargets()
        ownedPosixHandled = true
      }

      if (pid && managed.wsl && hasWslIdentity()) {
        const wsl = managed.wsl
        const leader: ProcessIdentity = {
          pid: wsl.linuxPid!,
          parentPid: 0,
          groupId: wsl.linuxPgid!,
          startTime: wsl.leaderStartTime!,
          bootId: wsl.bootId!,
          startOrder: wsl.leaderStartTime!,
        }
        const result = signalWslProcesses(this.spawnCommand, wsl.distro, {
          leader,
          groupId: wsl.linuxPgid!,
          members: Array.from(wsl.members.values()),
          signal,
        }, this.stopCommandTimeoutMs)
        recordSignalResult(result, wsl, "WSL", signal)
        refreshWslTargets()
      } else if (pid && !ownedPosixHandled) {
        const targets = managed.targets!
        const request = {
          leader: targets.leader,
          groupId: targets.groupId,
          members: Array.from(targets.members.values()),
          signal,
        }
        if (this.platform === "win32") {
          recordSignalResult(
            signalWindowsProcesses(this.spawnCommand, request, this.stopCommandTimeoutMs),
            targets,
            "Windows",
            signal,
          )
        } else {
          recordSignalResult(
            signalPosixProcesses(this.spawnCommand, request, this.stopCommandTimeoutMs, this.platform),
            targets,
            "POSIX",
            signal,
          )
        }
        refreshHostTargets()
      }

      if (canUseTokenCleanup()) {
        const tokenResult = signalLaunchCleanupToken(
          this.spawnCommand,
          managed.cleanupToken,
          signal,
          this.stopCommandTimeoutMs,
          managed.wsl?.distro,
        )
        if (!tokenResult.ok) {
          failures.push(`${managed.wsl ? "WSL" : "Linux"} launch-token ${signal} failed: ${tokenResult.error}`)
        } else {
          if (tokenResult.targets.length > 0 && !tokenResult.signalSent) {
            failures.push(`${managed.wsl ? "WSL" : "Linux"} launch-token ${signal} matched but sent no signal`)
          }
          const target = tokenTarget()
          for (const identity of tokenResult.targets) target.members.set(identity.pid, identity)
        }
        refreshTokenTargets()
      }
    }

    const probeTargetLiveness = (): TargetLiveness => {
      const refreshed = pid
        ? managed.wsl && hasWslIdentity() ? refreshWslTargets() : refreshHostTargets()
        : undefined
      const tokenSnapshot = refreshTokenTargets()
      if (tokenSnapshot && !tokenSnapshot.ok) {
        return { state: "unknown", detail: `${managed.wsl ? "WSL Linux" : "Linux"} launch-token cleanup could not be confirmed` }
      }
      if (refreshed && !refreshed.snapshot.ok && (managed.targets?.leader || !tokenSnapshot?.ok)) {
        const platformName = managed.wsl ? "WSL Linux" : this.platform === "win32" ? "Windows" : "POSIX"
        return { state: "unknown", detail: `${platformName} target identity could not be confirmed` }
      }
      const trackedCount = managed.wsl ? managed.wsl.members.size : (managed.targets?.members.size ?? 0)
      if (managed.identityCaptureFailed && this.platform === "win32" && !managed.wsl) {
        return { state: "unknown", detail: "Windows cleanup cannot prove exact launch ownership without a Job Object" }
      }
      if (managed.identityCaptureFailed && managed.wsl && !managed.targets?.leader && !wrapperExited()) {
        return { state: "unknown", detail: "the unidentified Windows WSL wrapper is still alive" }
      }
      if (trackedCount === 0) {
        if (tokenSnapshot?.ok && tokenSnapshot.processes.size === 0) {
          return { state: "gone", detail: "no process carries the unpublished launch token" }
        }
        return { state: "unknown", detail: pid ? "the original process identity was not captured" : "the target PID is unavailable" }
      }
      if ((refreshed?.aliveMembers.length ?? 0) === 0 && (!tokenSnapshot?.ok || tokenSnapshot.processes.size === 0)) {
        return { state: "gone", detail: "all tracked original process identities are gone" }
      }
      const targetName = managed.wsl && hasWslIdentity() ? "WSL Linux process group" : this.platform === "win32" ? "Windows process tree" : "POSIX process group"
      return { state: "alive", detail: `the tracked original ${targetName} is still alive` }
    }

    return new Promise<void>((resolve, reject) => {
      let escalationTimer: RuntimeTimeout | null = null
      let deadlineTimer: RuntimeTimeout | null = null
      let settled = false

      const cleanup = () => {
        child.removeListener("exit", onExit)
        child.removeListener("error", onError)
        if (escalationTimer) {
          this.cancelTimeout(escalationTimer)
          escalationTimer = null
        }
        if (deadlineTimer) {
          this.cancelTimeout(deadlineTimer)
          deadlineTimer = null
        }
      }

      const confirmTargetGone = () => {
        if (settled) return
        settled = true
        cleanup()
        if (this.processes.get(workspaceId) === managed) {
          this.processes.delete(workspaceId)
        }
        managed.finalizeExit?.(child.exitCode, child.signalCode)
        resolve()
      }
      const checkForConfirmedStop = () => {
        const liveness = probeTargetLiveness()
        if (liveness.state === "gone") {
          confirmTargetGone()
        }
        return liveness
      }
      const onExit = () => {
        checkForConfirmedStop()
      }
      const onError = (error: Error) => {
        failures.push(`child process error while stopping: ${error.message}`)
      }

      child.once("exit", onExit)
      child.on("error", onError)

      escalationTimer = this.scheduleTimeout(() => {
        escalationTimer = null
        if (settled) return
        const liveness = checkForConfirmedStop()
        if (settled) return
        this.logger.warn({ workspaceId, pid }, "Process did not stop after SIGTERM, escalating")
        sendStopSignal("SIGKILL")
        if (liveness.state === "unknown") {
          this.logger.debug({ workspaceId, pid }, "Escalating because target liveness could not be confirmed")
        }
      }, this.gracefulStopTimeoutMs)

      const totalTimeoutMs = this.gracefulStopTimeoutMs + this.forcedStopTimeoutMs
      deadlineTimer = this.scheduleTimeout(() => {
        deadlineTimer = null
        if (settled) return
        const liveness = checkForConfirmedStop()
        if (settled) return

        settled = true
        cleanup()
        const wrapperDetail = wrapperExited() ? "the wrapper exited but " : ""
        reject(new WorkspaceStopTimeoutError(workspaceId, pid, totalTimeoutMs, `${wrapperDetail}${liveness.detail}`, failures))
      }, totalTimeoutMs)

      this.logger.debug(
        { workspaceId, pid, detached: this.platform !== "win32" },
        "Sending SIGTERM to workspace process (tree/group)",
      )
      sendStopSignal("SIGTERM")
      checkForConfirmedStop()
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
