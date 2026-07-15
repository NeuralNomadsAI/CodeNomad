import { spawnSync } from "node:child_process"

export const CLI_SHUTDOWN_COMMAND = "codenomad:shutdown\n"
export const CLI_STOP_DEADLINE_MS = 30_000

interface ExitTrackedChild {
  stdin?: {
    destroyed?: boolean
    writable?: boolean
    end(chunk: string, callback: (error?: Error | null) => void): unknown
  } | null
  once(event: "exit", listener: () => void): unknown
  off?(event: "exit", listener: () => void): unknown
}

interface StopManagedChildOptions {
  child: ExitTrackedChild
  isExited(): boolean
  force(): boolean
  requestGracefulStop?(): void
  useStdinShutdown?: boolean
  deadlineMs?: number
  forceRetryMs?: number
  warn?(message: string, error?: unknown): void
}

interface PosixProcessRow {
  pid: number
  parentPid: number
  groupId: number
}

export function forcePosixProcessTree(
  rootPid: number,
  runPs: typeof spawnSync = spawnSync,
  kill: typeof process.kill = process.kill,
): boolean {
  const result = runPs("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
    encoding: "utf8",
    timeout: 1_500,
  })
  if (result.status !== 0) return false

  const rows = String(result.stdout ?? "").split(/\r?\n/).flatMap((line): PosixProcessRow[] => {
    const [pidText, parentPidText, groupIdText] = line.trim().split(/\s+/)
    const pid = Number(pidText), parentPid = Number(parentPidText), groupId = Number(groupIdText)
    return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && Number.isInteger(groupId)
      ? [{ pid, parentPid, groupId }]
      : []
  })
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!descendants.has(row.parentPid) || descendants.has(row.pid)) continue
      descendants.add(row.pid)
      changed = true
    }
  }

  const targets = rows.filter((row) => descendants.has(row.pid))
  const groups = new Set(targets.map((row) => row.groupId).filter((groupId) => descendants.has(groupId)))
  let confirmed = true
  const signal = (pid: number) => {
    try {
      kill(pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") confirmed = false
    }
  }
  for (const groupId of groups) signal(-groupId)
  for (const row of targets) signal(row.pid)
  if (!targets.some((row) => row.pid === rootPid)) signal(rootPid)
  return confirmed
}

export function forceWindowsProcessTree(
  rootPid: number,
  runTaskkill: typeof spawnSync = spawnSync,
): boolean {
  const result = runTaskkill("taskkill", ["/PID", String(rootPid), "/T", "/F"], {
    encoding: "utf8",
    timeout: 1_500,
    windowsHide: true,
  })
  return result.status === 0
}

export function stopManagedChild(options: StopManagedChildOptions): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      options.child.off?.("exit", finish)
      resolve()
    }

    options.child.once("exit", finish)
    if (options.isExited()) {
      finish()
      return
    }

    const deadlineMs = options.deadlineMs ?? CLI_STOP_DEADLINE_MS
    const force = () => {
      deadline = undefined
      if (settled) return
      options.warn?.(`CLI cleanup timed out after ${deadlineMs}ms; forcing process tree termination`)
      try {
        if (!options.force()) {
          options.warn?.("CLI process tree termination was not confirmed; still waiting for confirmed exit")
          deadline = setTimeout(force, options.forceRetryMs ?? 1_000)
        }
      } catch (error) {
        options.warn?.("Failed to force CLI process tree termination; still waiting for confirmed exit", error)
        deadline = setTimeout(force, options.forceRetryMs ?? 1_000)
      }
    }
    deadline = setTimeout(force, deadlineMs)

    if (options.useStdinShutdown === false) {
      try {
        options.requestGracefulStop?.()
      } catch (error) {
        options.warn?.("Failed to request graceful CLI termination; waiting until the force deadline", error)
      }
      return
    }

    const stdin = options.child.stdin
    if (!stdin || stdin.destroyed || stdin.writable === false) {
      options.warn?.("CLI stdin is not writable; waiting until the force deadline")
      return
    }
    try {
      stdin.end(CLI_SHUTDOWN_COMMAND, (error) => {
        if (error) options.warn?.("Failed to send the CLI graceful shutdown command; waiting until the force deadline", error)
      })
    } catch (error) {
      options.warn?.("Failed to send the CLI graceful shutdown command; waiting until the force deadline", error)
    }
  })
}
