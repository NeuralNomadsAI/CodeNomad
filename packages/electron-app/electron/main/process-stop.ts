import { spawnSync } from "node:child_process"
import { getProcessStartIdentity, type ProcessStartIdentityLookup } from "./client-state-process-identity"

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
  isCleanupComplete?(): boolean
  deadlineMs?: number
  forceRetryMs?: number
  forceAttempts?: number
  warn?(message: string, error?: unknown): void
}

interface ProcessRow {
  pid: number
  parentPid: number
  startIdentity: string
}

export interface CapturedProcessTree {
  platform: NodeJS.Platform
  members: Array<{ pid: number; startIdentity: string }>
}

export function captureProcessTree(
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
  runList: typeof spawnSync = spawnSync,
): CapturedProcessTree | undefined {
  const result = platform === "win32"
    ? runList("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|win32:{2}' -f $_.ProcessId, $_.ParentProcessId, ([datetime]$_.CreationDate).ToUniversalTime().Ticks }"],
        { encoding: "utf8", timeout: 1_500, windowsHide: true })
    : platform === "linux"
      ? runList("sh", ["-c", `boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1
for stat in /proc/[0-9]*/stat; do
  line=$(cat "$stat" 2>/dev/null) || continue
  pid=$(printf '%s\n' "$line" | cut -d' ' -f1); rest=$(printf '%s\n' "$line" | sed 's/^.*) //'); set -- $rest
  ppid=$2; shift 19; printf '%s|%s|linux:%s:%s\n' "$pid" "$ppid" "$boot" "$1"
done`], { encoding: "utf8", timeout: 1_500 })
      : runList("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 1_500,
          env: { ...process.env, LC_ALL: "C", LANG: "C" } })
  if (result.status !== 0 || result.error) return undefined

  const rows: ProcessRow[] = []
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = platform === "darwin"
      ? line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)?.slice(1)
      : line.trim().split("|")
    if (!fields || fields.length !== 3) return undefined
    const [pidText, parentPidText, rawIdentity] = fields
    const pid = Number(pidText), parentPid = Number(parentPidText)
    const startIdentity = platform === "darwin" ? `darwin:${rawIdentity}` : rawIdentity
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || !startIdentity) return undefined
    rows.push({ pid, parentPid, startIdentity })
  }
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

  const members = rows.filter((row) => descendants.has(row.pid))
    .map(({ pid, startIdentity }) => ({ pid, startIdentity }))
  if (!members.some((member) => member.pid === rootPid)) return undefined
  return { platform, members }
}

export function forceCapturedProcessTree(
  tree: CapturedProcessTree,
  lookup: ProcessStartIdentityLookup = getProcessStartIdentity,
  runTaskkill: typeof spawnSync = spawnSync,
  kill: typeof process.kill = process.kill,
): boolean {
  let confirmed = true
  const isGone = (pid: number) => {
    try {
      kill(pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
    }
  }
  for (const member of [...tree.members].reverse()) {
    const currentIdentity = lookup(member.pid)
    if (!currentIdentity) {
      if (!isGone(member.pid)) confirmed = false
      continue
    }
    if (currentIdentity !== member.startIdentity) continue
    if (tree.platform === "win32") {
      const result = runTaskkill("taskkill", ["/PID", String(member.pid), "/F"], {
        encoding: "utf8",
        timeout: 1_500,
        windowsHide: true,
      })
      if (result.status !== 0) {
        const remainingIdentity = lookup(member.pid)
        if (remainingIdentity === member.startIdentity || (!remainingIdentity && !isGone(member.pid))) confirmed = false
      }
      continue
    }
    try {
      kill(member.pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") confirmed = false
    }
  }
  for (const member of tree.members) {
    const remainingIdentity = lookup(member.pid)
    if (remainingIdentity === member.startIdentity || (!remainingIdentity && !isGone(member.pid))) confirmed = false
  }
  return confirmed
}

export function stopManagedChild(options: StopManagedChildOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const cleanupComplete = options.isCleanupComplete ?? (() => true)
    const removeListener = () => options.child.off?.("exit", onExit)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      removeListener()
      if (error) reject(error)
      else resolve()
    }
    const force = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (settled) return
      attempts += 1
      try {
        if (options.force()) {
          finish()
          return
        }
      } catch (error) {
        options.warn?.("Failed to force CLI process tree termination", error)
      }
      const maxAttempts = options.forceAttempts ?? 3
      if (attempts >= maxAttempts) {
        finish(new Error(`CLI process tree termination was not confirmed after ${attempts} attempts`))
        return
      }
      options.warn?.("CLI process tree termination was not confirmed; retrying")
      timer = setTimeout(force, options.forceRetryMs ?? 1_000)
    }
    function onExit() {
      if (cleanupComplete()) finish()
      else force()
    }

    options.child.once("exit", onExit)
    if (options.isExited()) {
      onExit()
      return
    }

    const deadlineMs = options.deadlineMs ?? CLI_STOP_DEADLINE_MS
    timer = setTimeout(() => {
      options.warn?.(`CLI cleanup timed out after ${deadlineMs}ms; forcing process tree termination`)
      force()
    }, deadlineMs)

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
