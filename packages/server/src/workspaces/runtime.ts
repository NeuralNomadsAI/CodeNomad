import { ChildProcess, spawn, spawnSync } from "child_process"
import { randomBytes } from "crypto"
import { existsSync, statSync } from "fs"
import path from "path"
import { EventBus } from "../events/bus"
import { LogLevel, WorkspaceLogEntry } from "../api-types"
import { Logger } from "../logger"
import { buildSpawnSpec, type SpawnProcessKind } from "./spawn"
import {
  descendantsOf,
  LAUNCH_CLEANUP_TOKEN_ENV,
  probeLaunchCleanupToken,
  probePosixProcesses,
  probeWindowsProcesses,
  probeWslProcesses,
  sameProcess,
  signalPosixProcesses,
  signalOwnedPosixProcessGroup,
  signalLaunchCleanupToken,
  signalWindowsProcesses,
  signalWslProcesses,
  startedNoLaterThan,
  type GuardedSignalResult,
  type ProcessIdentity,
  type ProcessSnapshot,
} from "./process-identity"

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
  signal?: AbortSignal
  cleanupToken?: string
  persistProcessIdentities?: (identities: ProcessIdentity[]) => Promise<void>
}

export interface ProcessExitInfo {
  workspaceId: string
  code: number | null
  signal: NodeJS.Signals | null
  requested: boolean
}

interface TrackedProcesses {
  leader?: ProcessIdentity
  groupId?: number
  dispatchCutoff?: string
  groupOwnershipRetained?: boolean
  groupGoneConfirmed?: boolean
  groupOwnershipUncertain?: boolean
  members: Map<number, ProcessIdentity>
}

interface ManagedProcess {
  child: ChildProcess
  cleanupToken: string
  processKind: SpawnProcessKind
  windowsTreeCleanupConfirmed?: boolean
  windowsTreeCleanupFailures?: string[]
  identityCaptureFailed?: boolean
  requestedStop: boolean
  stopPromise?: Promise<void>
  cancelLaunch?: () => void
  finalizeExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  targets?: TrackedProcesses
  wsl?: TrackedProcesses & {
    distro: string
    linuxPid: number | null
    linuxPgid: number | null
    leaderStartTime: string | null
    bootId: string | null
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

export class WorkspaceWindowsTreeCleanupIncompleteError extends Error {
  readonly code = "WORKSPACE_WINDOWS_TREE_CLEANUP_INCOMPLETE"
  readonly retryable = true

  constructor(workspaceId: string, pid: number | undefined, failures: string[]) {
    const failureDetails = failures.length > 0 ? ` Stop failures: ${failures.join("; ")}.` : ""
    super(
      `Workspace ${workspaceId} Windows wrapper ${pid ?? "with unknown PID"} exited before taskkill confirmed process-tree cleanup.` +
        `${failureDetails} The workspace record was retained because cleanup is incomplete.`,
    )
    this.name = "WorkspaceWindowsTreeCleanupIncompleteError"
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
    getLastOutput: () => string
    processIdentity?: ProcessIdentity
  }> {
    options.signal?.throwIfAborted()
    this.validateFolder(options.folder)

    const logLevel = typeof options.logLevel === "string" ? options.logLevel.toUpperCase() : "DEBUG"
    const args = ["serve", "--port", "0", "--print-logs", "--log-level", logLevel]
    const cleanupToken = options.cleanupToken ?? randomBytes(32).toString("hex")
    const env = { ...process.env, ...(options.environment ?? {}), [LAUNCH_CLEANUP_TOKEN_ENV]: cleanupToken }

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
      const propagatedEnvKeys = [...Object.keys(options.environment ?? {}), LAUNCH_CLEANUP_TOKEN_ENV]
      const spec = buildSpawnSpec(options.binaryPath, args, {
        cwd: options.folder,
        env,
        propagateEnvKeys: propagatedEnvKeys,
        wslPidMarker: WSL_PID_MARKER,
        platform: this.platform,
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
      const handleEarlyError = (error: Error) => {
        this.logger.error({ workspaceId: options.workspaceId, err: error }, "Workspace runtime failed before launch handlers were ready")
      }
      child.on("error", handleEarlyError)

      const managed: ManagedProcess = {
        child,
        cleanupToken,
        processKind: spec.processKind,
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
      if (spec.processKind === "posix" || spec.processKind === "wsl" || spec.processKind === "windows-direct" || spec.processKind === "windows-wrapper") {
        const launchSnapshot = child.pid
          ? this.platform === "win32"
            ? probeWindowsProcesses(this.spawnCommand, this.stopCommandTimeoutMs)
            : probePosixProcesses(
                this.spawnCommand,
                this.stopCommandTimeoutMs,
                this.platform,
                { pids: [child.pid], groupId: child.pid },
              )
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
        managed.targets!.groupOwnershipRetained = this.platform !== "linux" && this.platform !== "win32" &&
          launchLeader.groupId === launchLeader.pid
        for (const identity of launchSnapshot.ok ? launchSnapshot.processes.values() : [launchLeader]) {
          if (identity.groupId === launchLeader.groupId) managed.targets!.members.set(identity.pid, identity)
        }
        if (this.platform === "win32" && launchSnapshot.ok) {
          for (const identity of descendantsOf(launchSnapshot.processes, launchLeader.pid)) {
            managed.targets!.members.set(identity.pid, identity)
          }
        }
      }

      let stdoutBuffer = ""
      let stderrBuffer = ""
      let portFound = false
      let pendingPort: number | null = null
      let launchSettled = false
      let launchPersistenceStarted = false
      const cancelLaunch = () => {
        if (launchSettled) return
        launchSettled = true
        stopWarningTimer()
        reject(options.signal?.reason ?? new Error(`Workspace ${options.workspaceId} runtime launch was cancelled`))
      }
      managed.cancelLaunch = cancelLaunch

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

      options.signal?.addEventListener("abort", cancelLaunch, { once: true })
      if (options.signal?.aborted) cancelLaunch()

      const cleanupStreams = () => {
        stopWarningTimer()
        child.stdout?.removeAllListeners()
        child.stderr?.removeAllListeners()
      }

      let finalized = false
      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (finalized) return
        finalized = true
        const cleanupRequired = !managed.requestedStop
        this.logger.info({ workspaceId: options.workspaceId, code, signal }, "OpenCode process exited")
        cleanupStreams()
        options.signal?.removeEventListener("abort", cancelLaunch)
        managed.cancelLaunch = undefined
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
        if (cleanupRequired && this.processes.get(options.workspaceId) === managed) {
          void this.stop(options.workspaceId).catch((error) => {
            this.logger.warn({ workspaceId: options.workspaceId, err: error }, "Unexpected workspace exit cleanup remains pending")
          })
        }
      }
      managed.finalizeExit = handleExit

      const handleError = (error: Error) => {
        const cleanupRequired = !managed.requestedStop
        cleanupStreams()
        options.signal?.removeEventListener("abort", cancelLaunch)
        managed.cancelLaunch = undefined
        child.removeListener("exit", handleExit)
        this.logger.error({ workspaceId: options.workspaceId, err: error }, "Workspace runtime error")
        if (exitResolve) {
          exitResolve({ workspaceId: options.workspaceId, code: null, signal: null, requested: managed.requestedStop })
          exitResolve = null
        }
        if (!launchSettled) {
          launchSettled = true
          reject(error)
        }
        if (cleanupRequired && this.processes.get(options.workspaceId) === managed) {
          void this.stop(options.workspaceId).catch((stopError) => {
            this.logger.warn({ workspaceId: options.workspaceId, err: stopError }, "Workspace error cleanup remains pending")
          })
        }
      }

      child.removeListener("error", handleEarlyError)
      child.on("error", handleError)
      child.on("exit", handleExit)

      const resolveLaunchIfIdentified = async () => {
        if (launchSettled || launchPersistenceStarted || pendingPort === null) return
        if (managed.wsl && (!managed.wsl.linuxPid || !managed.wsl.linuxPgid || !managed.wsl.leaderStartTime || !managed.wsl.bootId)) {
          return
        }
        launchPersistenceStarted = true
        portFound = true
        stopWarningTimer()
        if (this.platform === "win32" && managed.targets?.leader) {
          const snapshot = probeWindowsProcesses(this.spawnCommand, this.stopCommandTimeoutMs)
          const currentLeader = snapshot.ok ? snapshot.processes.get(managed.targets.leader.pid) : undefined
          if (!snapshot.ok || !currentLeader || !sameProcess(managed.targets.leader, currentLeader)) {
            launchSettled = true
            const detail = !snapshot.ok
              ? `readiness-time Windows identity discovery failed: ${snapshot.error}`
              : `spawned PID ${managed.targets.leader.pid} changed or disappeared before readiness-time identity capture`
            this.beginFailedLaunchCleanup(options.workspaceId, managed)
            reject(new WorkspaceRuntimeIdentityCaptureError(options.workspaceId, detail))
            return
          }
          managed.targets.members.clear()
          managed.targets.members.set(currentLeader.pid, currentLeader)
          for (const identity of descendantsOf(snapshot.processes, currentLeader.pid)) managed.targets.members.set(identity.pid, identity)
        }
        try {
          await options.persistProcessIdentities?.([...managed.targets!.members.values()])
        } catch (error) {
          launchSettled = true
          this.beginFailedLaunchCleanup(options.workspaceId, managed)
          reject(new WorkspaceRuntimeIdentityCaptureError(
            options.workspaceId,
            `launch-tree identity persistence failed: ${error instanceof Error ? error.message : String(error)}`,
          ))
          return
        }
        if (launchSettled) return
        launchSettled = true
        options.signal?.removeEventListener("abort", cancelLaunch)
        managed.cancelLaunch = undefined
        child.removeListener("error", handleError)
        this.logger.info({ workspaceId: options.workspaceId, port: pendingPort }, "Workspace runtime allocated port")
        resolve({ pid: child.pid!, port: pendingPort, exitPromise, getLastOutput, processIdentity: managed.targets?.leader })
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
              void resolveLaunchIfIdentified()
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
                void resolveLaunchIfIdentified()
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
    managed.identityCaptureFailed = true
    void this.stop(workspaceId).catch((error) => {
      this.logger.warn({ workspaceId, err: error }, "Unpublished workspace cleanup remains pending")
    })
    if (managed.child.exitCode === null && managed.child.signalCode === null) {
      try {
        managed.child.kill("SIGTERM")
      } catch (error) {
        this.logger.debug({ workspaceId, err: error }, "Failed initial live-child cleanup signal")
      }
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
    void stopPromise.finally(() => {
      if (managed.stopPromise === stopPromise) managed.stopPromise = undefined
    }).catch(() => undefined)
    return stopPromise
  }

  private stopManagedProcess(workspaceId: string, managed: ManagedProcess): Promise<void> {
    managed.requestedStop = true
    managed.cancelLaunch?.()
    managed.cancelLaunch = undefined
    this.logger.info({ workspaceId }, "Stopping OpenCode process")
    if (managed.processKind === "windows-wrapper") return this.stopOwnedWindowsProcess(workspaceId, managed)

    const { child } = managed
    const pid = child.pid
    const failures: string[] = []
    const wrapperExited = () => child.exitCode !== null || child.signalCode !== null
    const hasWslIdentity = () => Boolean(
      managed.wsl?.linuxPid && managed.wsl.linuxPgid && managed.wsl.leaderStartTime && managed.wsl.bootId,
    )
    const trackedTarget = () => managed.wsl && hasWslIdentity() ? managed.wsl : managed.targets!
    const trackedLeader = (): ProcessIdentity | undefined => {
      if (!managed.wsl || !hasWslIdentity()) return managed.targets?.leader
      return {
        pid: managed.wsl.linuxPid!,
        parentPid: 0,
        groupId: managed.wsl.linuxPgid!,
        startTime: managed.wsl.leaderStartTime!,
        bootId: managed.wsl.bootId!,
        startOrder: managed.wsl.leaderStartTime!,
      }
    }

    const refreshTargets = () => {
      const target = trackedTarget()
      const leader = trackedLeader()
      const groupId = managed.wsl && hasWslIdentity() ? managed.wsl.linuxPgid! : target.groupId
      const portableGroupId = this.platform !== "linux" && this.platform !== "win32" &&
        target.groupOwnershipRetained && !target.groupGoneConfirmed ? groupId : undefined
      const snapshot = managed.wsl && hasWslIdentity()
        ? probeWslProcesses(this.spawnCommand, managed.wsl.distro, this.stopCommandTimeoutMs)
        : this.platform === "win32"
          ? probeWindowsProcesses(this.spawnCommand, this.stopCommandTimeoutMs)
          : probePosixProcesses(this.spawnCommand, this.stopCommandTimeoutMs, this.platform, this.platform === "linux"
              ? undefined
              : { pids: [leader?.pid, ...target.members.keys()].filter((value): value is number => Boolean(value)), groupId: portableGroupId })
      if (!snapshot.ok) {
        const platformName = managed.wsl && hasWslIdentity() ? "WSL" : this.platform === "win32" ? "Windows" : "POSIX"
        failures.push(`${platformName} identity discovery failed: ${snapshot.error}`)
        return { snapshot, aliveMembers: [] as ProcessIdentity[] }
      }

      const leaderMatches = sameProcess(leader, leader ? snapshot.processes.get(leader.pid) : undefined)
      const groupLeader = groupId ? snapshot.processes.get(groupId) : undefined
      const groupWasReused = Boolean(groupLeader && !sameProcess(leader, groupLeader))
      const retainedAnchorMatches = Boolean(portableGroupId && Array.from(target.members.values()).some((identity) =>
        sameProcess(identity, snapshot.processes.get(identity.pid)),
      ))
      if (portableGroupId && groupWasReused) {
        target.groupGoneConfirmed = true
        target.groupOwnershipUncertain = false
      }
      for (const process of snapshot.processes.values()) {
        const sameBoot = !leader?.bootId || process.bootId === leader.bootId
        const withinDispatch = (this.platform === "linux" || Boolean(managed.wsl)) && Boolean(
          target.dispatchCutoff && sameBoot && startedNoLaterThan(process, target.dispatchCutoff),
        )
        const withinRetainedPortableGroup = Boolean(portableGroupId && !groupWasReused && retainedAnchorMatches)
        if (groupId && process.groupId === groupId && (leaderMatches || withinRetainedPortableGroup || (!groupWasReused && withinDispatch))) {
          target.members.set(process.pid, process)
        }
      }
      if (portableGroupId && !groupWasReused) {
        const groupPresent = Array.from(snapshot.processes.values()).some((process) => process.groupId === portableGroupId)
        if (!groupPresent) {
          target.groupGoneConfirmed = true
          target.groupOwnershipUncertain = false
        } else if (!leaderMatches && !retainedAnchorMatches) {
          target.groupOwnershipUncertain = true
        }
      }
      if (this.platform === "win32" && !managed.wsl && leaderMatches && leader) {
        for (const descendant of descendantsOf(snapshot.processes, leader.pid)) target.members.set(descendant.pid, descendant)
        if (managed.processKind === "windows-direct") managed.identityCaptureFailed = false
      }
      const aliveMembers = Array.from(target.members.values()).filter((identity) =>
        sameProcess(identity, snapshot.processes.get(identity.pid)),
      )
      return { snapshot, aliveMembers }
    }

    const usesTokenCleanup = () => this.platform === "linux" || Boolean(managed.wsl)
    const refreshTokenTargets = (): ProcessSnapshot | undefined => {
      if (!usesTokenCleanup()) return
      const snapshot = probeLaunchCleanupToken(
        this.spawnCommand, managed.cleanupToken, this.stopCommandTimeoutMs, managed.wsl?.distro,
      )
      if (!snapshot.ok) failures.push(`${managed.wsl ? "WSL" : "Linux"} launch-token discovery failed: ${snapshot.error}`)
      else for (const identity of snapshot.processes.values()) trackedTarget().members.set(identity.pid, identity)
      return snapshot
    }
    const recordSignalResult = (result: GuardedSignalResult, target: TrackedProcesses, name: string, signal: NodeJS.Signals) => {
      const identities = result.ok ? result.signaled : (result.observed ?? [])
      for (const identity of identities) target.members.set(identity.pid, identity)
      if (!result.ok) failures.push(`${name} guarded ${signal} failed: ${result.error}`)
      else {
        if (result.matched && !result.signalSent) failures.push(`${name} guarded ${signal} matched but sent no signal`)
        if (result.cutoff) target.dispatchCutoff = result.cutoff
      }
    }

    const sendStopSignal = (signal: NodeJS.Signals) => {
      if (!pid) failures.push(`${signal} was not sent because the process PID is unavailable`)
      if (pid && wrapperExited() && this.platform !== "linux" && this.platform !== "win32") refreshTargets()
      if (pid && managed.identityCaptureFailed && this.platform === "win32" && !managed.wsl &&
        managed.processKind === "windows-direct") refreshTargets()
      let signaledOwnedGroup = false
      if (pid && managed.identityCaptureFailed && this.platform !== "linux" && this.platform !== "win32" && !wrapperExited()) {
        const result = signalOwnedPosixProcessGroup(this.spawnCommand, pid, signal, this.stopCommandTimeoutMs)
        recordSignalResult(result, managed.targets!, "owned POSIX group", signal)
        const leader = result.ok && result.matched ? result.signaled.find((identity) => identity.pid === pid) : undefined
        if (leader) Object.assign(managed.targets!, { leader, groupId: pid })
        refreshTargets()
        signaledOwnedGroup = true
      }
      if (pid && !signaledOwnedGroup) {
        const target = trackedTarget()
        const groupId = managed.wsl && hasWslIdentity() ? managed.wsl.linuxPgid! : target.groupId
        const request = {
          leader: trackedLeader(), groupId, members: [...target.members.values()], signal,
          allowLeaderlessGroup: this.platform !== "linux" && this.platform !== "win32" &&
            Boolean(target.groupOwnershipRetained && !target.groupGoneConfirmed && wrapperExited()),
          cleanupToken: this.platform !== "linux" && this.platform !== "win32" ? managed.cleanupToken : undefined,
        }
        const result = managed.wsl && hasWslIdentity()
          ? signalWslProcesses(this.spawnCommand, managed.wsl.distro, request, this.stopCommandTimeoutMs)
          : this.platform === "win32"
            ? signalWindowsProcesses(this.spawnCommand, request, this.stopCommandTimeoutMs)
            : signalPosixProcesses(this.spawnCommand, request, this.stopCommandTimeoutMs, this.platform)
        recordSignalResult(result, target, managed.wsl && hasWslIdentity() ? "WSL" : this.platform === "win32" ? "Windows" : "POSIX", signal)
        refreshTargets()
      }
      if (usesTokenCleanup()) {
        const result = signalLaunchCleanupToken(
          this.spawnCommand, managed.cleanupToken, signal, this.stopCommandTimeoutMs, managed.wsl?.distro,
        )
        const name = managed.wsl ? "WSL" : "Linux"
        if (!result.ok) failures.push(`${name} launch-token ${signal} failed: ${result.error}`)
        else {
          if (result.targets.length > 0 && !result.signalSent) failures.push(`${name} launch-token ${signal} matched but sent no signal`)
          for (const identity of result.targets) trackedTarget().members.set(identity.pid, identity)
        }
        refreshTokenTargets()
      }
    }

    const probeLiveness = () => {
      const refreshed = pid ? refreshTargets() : undefined
      const tokenSnapshot = refreshTokenTargets()
      if (tokenSnapshot && !tokenSnapshot.ok) {
        return { state: "unknown", detail: `${managed.wsl ? "WSL Linux" : "Linux"} launch-token cleanup could not be confirmed` } as const
      }
      if (refreshed && !refreshed.snapshot.ok && (managed.targets?.leader || !tokenSnapshot?.ok)) {
        const name = managed.wsl ? "WSL Linux" : this.platform === "win32" ? "Windows" : "POSIX"
        return { state: "unknown", detail: `${name} target identity could not be confirmed` } as const
      }
      if (managed.identityCaptureFailed && this.platform === "win32" && !managed.wsl) {
        return { state: "unknown", detail: "Windows cleanup cannot prove exact launch ownership without a Job Object" } as const
      }
      if (managed.identityCaptureFailed && managed.wsl && !managed.targets?.leader && !wrapperExited()) {
        return { state: "unknown", detail: "the unidentified Windows WSL wrapper is still alive" } as const
      }
      if (trackedTarget().groupOwnershipUncertain) {
        return { state: "unknown", detail: "the retained POSIX process group no longer has a verified identity anchor" } as const
      }
      if (trackedTarget().members.size === 0) {
        if (tokenSnapshot?.ok && tokenSnapshot.processes.size === 0) return { state: "gone", detail: "no process carries the unpublished launch token" } as const
        return { state: "unknown", detail: pid ? "the original process identity was not captured" : "the target PID is unavailable" } as const
      }
      if ((refreshed?.aliveMembers.length ?? 0) === 0 && (!tokenSnapshot?.ok || tokenSnapshot.processes.size === 0)) {
        return { state: "gone", detail: "all tracked original process identities are gone" } as const
      }
      const name = managed.wsl && hasWslIdentity() ? "WSL Linux process group" : this.platform === "win32" ? "Windows process tree" : "POSIX process group"
      return { state: "alive", detail: `the tracked original ${name} is still alive` } as const
    }
    const stopped = () => probeLiveness().state === "gone" ? true : undefined
    const totalTimeoutMs = this.gracefulStopTimeoutMs + this.forcedStopTimeoutMs
    return this.runBoundedStop(workspaceId, managed, {
      start: () => {
        this.logger.debug({ workspaceId, pid, detached: this.platform !== "win32" }, "Sending SIGTERM to workspace process (tree/group)")
        sendStopSignal("SIGTERM")
        return stopped()
      },
      exit: stopped,
      error: (error) => { failures.push(`child process error while stopping: ${error.message}`) },
      escalate: () => {
        const liveness = probeLiveness()
        if (liveness.state === "gone") return true
        this.logger.warn({ workspaceId, pid }, "Process did not stop after SIGTERM, escalating")
        sendStopSignal("SIGKILL")
      },
      deadline: () => {
        const liveness = probeLiveness()
        if (liveness.state === "gone") return true
        const prefix = wrapperExited() ? "the wrapper exited but " : ""
        return new WorkspaceStopTimeoutError(workspaceId, pid, totalTimeoutMs, `${prefix}${liveness.detail}`, failures)
      },
    })
  }

  private stopOwnedWindowsProcess(workspaceId: string, managed: ManagedProcess): Promise<void> {
    const { child } = managed
    const pid = child.pid
    const failures = (managed.windowsTreeCleanupFailures ??= [])
    const outcome = () => managed.windowsTreeCleanupConfirmed
      ? true
      : new WorkspaceWindowsTreeCleanupIncompleteError(workspaceId, pid, failures)
    const stopChild = (force: boolean) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (!pid) {
        failures.push(`${force ? "forced" : "graceful"} stop was not sent because the process PID is unavailable`)
        return
      }
      const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])]
      try {
        const result = this.spawnCommand("taskkill.exe", args, { encoding: "utf8", timeout: this.stopCommandTimeoutMs })
        if (result.status === 0) managed.windowsTreeCleanupConfirmed = true
        else {
          const detail = result.error?.message || String(result.stderr ?? result.stdout ?? "").trim() || `exit code ${result.status}`
          failures.push(`taskkill ${force ? "/T /F" : "/T"} failed: ${detail}`)
        }
      } catch (error) {
        failures.push(`taskkill ${force ? "/T /F" : "/T"} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const totalTimeoutMs = this.gracefulStopTimeoutMs + this.forcedStopTimeoutMs
    return this.runBoundedStop(workspaceId, managed, {
      start: () => {
        if (child.exitCode !== null || child.signalCode !== null) return outcome()
        this.logger.debug({ workspaceId, pid }, "Stopping owned Windows workspace wrapper tree")
        stopChild(false)
      },
      exit: outcome,
      error: (error) => {
        failures.push(`child process error while stopping: ${error.message}`)
        return error
      },
      escalate: () => {
        this.logger.warn({ workspaceId, pid }, "Owned Windows process did not stop after the graceful attempt, escalating")
        stopChild(true)
      },
      deadline: () => new WorkspaceStopTimeoutError(
        workspaceId, pid, totalTimeoutMs,
        child.exitCode !== null || child.signalCode !== null
          ? "taskkill did not confirm tree cleanup before the owned Windows wrapper exited"
          : "the owned Windows wrapper did not emit exit or error after tree termination",
        failures,
      ),
    })
  }

  private runBoundedStop(
    workspaceId: string,
    managed: ManagedProcess,
    actions: {
      start: () => true | Error | void
      exit: () => true | Error | void
      error: (error: Error) => true | Error | void
      escalate: () => true | Error | void
      deadline: () => true | Error
    },
  ): Promise<void> {
    const { child } = managed
    return new Promise((resolve, reject) => {
      let settled = false
      const timers: RuntimeTimeout[] = []
      const finish = (outcome: true | Error | void) => {
        if (settled || !outcome) return
        settled = true
        child.removeListener("exit", onExit)
        child.removeListener("error", onError)
        for (const timer of timers) this.cancelTimeout(timer)
        if (outcome instanceof Error) reject(outcome)
        else {
          if (this.processes.get(workspaceId) === managed) this.processes.delete(workspaceId)
          managed.finalizeExit?.(child.exitCode, child.signalCode)
          resolve()
        }
      }
      const onExit = () => finish(actions.exit())
      const onError = (error: Error) => finish(actions.error(error))
      child.once("exit", onExit)
      child.on("error", onError)
      timers.push(this.scheduleTimeout(() => finish(actions.escalate()), this.gracefulStopTimeoutMs))
      timers.push(this.scheduleTimeout(() => finish(actions.deadline()), this.gracefulStopTimeoutMs + this.forcedStopTimeoutMs))
      finish(actions.start())
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
