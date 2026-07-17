import { execFile } from "node:child_process"
import { getProcessStartIdentityAsync, type AsyncProcessStartIdentityLookup } from "./client-state-process-identity"

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
  force(deadlineAt?: number): Promise<boolean> | boolean
  isCleanupComplete?(): boolean
  deadlineMs?: number
  deadlineAt?: number
  forceReserveMs?: number
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

interface AsyncCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

type AsyncCommandRunner = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv },
) => Promise<AsyncCommandResult> | AsyncCommandResult

interface ForceCapturedProcessTreeOptions {
  deadlineAt?: number
  now?: () => number
  revalidateIdentity?: AsyncProcessStartIdentityLookup
}

export function mergeCapturedProcessTrees(
  captured: CapturedProcessTree | undefined,
  latest: CapturedProcessTree | undefined,
  rootPid: number,
  expectedRootIdentity?: string,
): CapturedProcessTree | undefined {
  if (!latest || (captured && latest.platform !== captured.platform)) return captured
  const capturedRoot = captured?.members.find((member) => member.pid === rootPid)
  const latestRoot = latest.members.find((member) => member.pid === rootPid)
  const rootIdentity = capturedRoot?.startIdentity ?? expectedRootIdentity
  if (!rootIdentity || !latestRoot || rootIdentity !== latestRoot.startIdentity) return captured
  if (!captured) return latest

  const identityKey = (member: { pid: number; startIdentity: string }) => `${member.pid}\0${member.startIdentity}`
  const members = new Map(captured.members.map((member) => [identityKey(member), member]))
  for (const member of latest.members) {
    members.set(identityKey(member), member)
  }
  return { platform: captured.platform, members: [...members.values()] }
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv },
): Promise<AsyncCommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({ status: error ? null : 0, stdout, stderr, error: error ?? undefined })
    })
  })
}

async function captureProcessRows(
  platform: NodeJS.Platform,
  runList: AsyncCommandRunner,
  timeoutMs: number,
): Promise<ProcessRow[] | undefined> {
  if (timeoutMs <= 0) return undefined
  const result = platform === "win32"
    ? await runList("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|win32:{2}' -f $_.ProcessId, $_.ParentProcessId, ([datetime]$_.CreationDate).ToUniversalTime().Ticks }"],
        { encoding: "utf8", timeout: timeoutMs, windowsHide: true })
    : platform === "linux"
      ? await runList("sh", ["-c", `boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1
for stat in /proc/[0-9]*/stat; do
  line=$(cat "$stat" 2>/dev/null) || continue
  pid=$(printf '%s\n' "$line" | cut -d' ' -f1); rest=$(printf '%s\n' "$line" | sed 's/^.*) //'); set -- $rest
  ppid=$2; shift 19; printf '%s|%s|linux:%s:%s\n' "$pid" "$ppid" "$boot" "$1"
done`], { encoding: "utf8", timeout: timeoutMs })
      : await runList("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: timeoutMs,
          env: { ...process.env, LC_ALL: "C", LANG: "C" } })
  if (result.status !== 0 || result.error) return undefined

  const rows: ProcessRow[] = []
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue
    if (platform === "darwin" ? /^0(?:\s|$)/.test(line.trim()) : /^0(?:\||$)/.test(line.trim())) continue
    const fields = platform === "darwin"
      ? line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)?.slice(1)
      : line.trim().split("|")
    if (!fields || fields.length !== 3) return undefined
    const [pidText, parentPidText, rawIdentity] = fields
    const pid = Number(pidText), parentPid = Number(parentPidText)
    const startIdentity = platform === "darwin" ? `darwin:${rawIdentity}` : rawIdentity
    const validIdentity = platform === "win32"
      ? /^win32:\d+$/.test(startIdentity)
      : platform === "linux"
        ? /^linux:[^:]+:\d+$/.test(startIdentity)
        : Boolean(rawIdentity.trim())
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || !validIdentity) return undefined
    rows.push({ pid, parentPid, startIdentity })
  }
  return rows
}

function processTreeFromRows(rootPid: number, platform: NodeJS.Platform, rows: ProcessRow[]): CapturedProcessTree | undefined {
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
  return members.some((member) => member.pid === rootPid) ? { platform, members } : undefined
}

export async function captureProcessTree(
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
  runList: AsyncCommandRunner = runCommand,
  timeoutMs = 1_500,
): Promise<CapturedProcessTree | undefined> {
  const rows = await captureProcessRows(platform, runList, timeoutMs)
  return rows ? processTreeFromRows(rootPid, platform, rows) : undefined
}

export async function captureInitialProcessTree(
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
  runList: AsyncCommandRunner = runCommand,
  lookup: AsyncProcessStartIdentityLookup = (pid, timeoutMs) => getProcessStartIdentityAsync(pid, timeoutMs, platform),
  deadlineAt = Date.now() + 3_000,
): Promise<{ tree?: CapturedProcessTree; rootStartIdentity?: string }> {
  const fallbackIdentity = Promise.resolve(lookup(rootPid, Math.min(1_500, deadlineAt - Date.now())))
  const captured = await captureProcessTree(rootPid, platform, runList, Math.min(1_500, deadlineAt - Date.now()))
  const rootStartIdentity = await fallbackIdentity
  const tree = rootStartIdentity
    ? mergeCapturedProcessTrees(undefined, captured, rootPid, rootStartIdentity)
    : undefined
  return { tree, rootStartIdentity }
}

export async function forceCapturedProcessTree(
  tree: CapturedProcessTree,
  lookup?: AsyncProcessStartIdentityLookup,
  runTerminate: AsyncCommandRunner = runCommand,
  kill: typeof process.kill = process.kill,
  options: ForceCapturedProcessTreeOptions = {},
): Promise<boolean> {
  const now = options.now ?? Date.now
  const remainingMs = () => options.deadlineAt === undefined ? 1_500 : options.deadlineAt - now()
  const currentIdentity = options.revalidateIdentity ?? lookup
    ?? ((pid, timeoutMs) => getProcessStartIdentityAsync(pid, timeoutMs, tree.platform))
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
    if (remainingMs() <= 0) return false
    if (tree.platform === "win32") {
      const expectedTicks = member.startIdentity.match(/^win32:(\d+)$/)?.[1]
      if (!expectedTicks) {
        confirmed = false
        continue
      }
      const timeout = Math.min(1_500, remainingMs())
      if (timeout <= 0) return false
      const script = `$source = @'
using System;
using System.Runtime.InteropServices;
public static class CodeNomadProcessHandle {
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
Add-Type -TypeDefinition $source
$handle = [CodeNomadProcessHandle]::OpenProcess(0x1001, $false, ${member.pid})
if ($handle -eq [IntPtr]::Zero) { exit 3 }
try {
  $creation = [CodeNomadProcessHandle+FileTime]::new()
  $exit = [CodeNomadProcessHandle+FileTime]::new()
  $kernel = [CodeNomadProcessHandle+FileTime]::new()
  $user = [CodeNomadProcessHandle+FileTime]::new()
  if (-not [CodeNomadProcessHandle]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { exit 4 }
  $fileTime = ([long]$creation.High -shl 32) -bor $creation.Low
  if ([DateTime]::FromFileTimeUtc($fileTime).Ticks -ne [long]::Parse('${expectedTicks}')) { 'mismatch'; exit 0 }
  if (-not [CodeNomadProcessHandle]::TerminateProcess($handle, 1)) { exit 5 }
  'terminated'
} finally {
  [void][CodeNomadProcessHandle]::CloseHandle($handle)
}`
      const result = await runTerminate("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout,
        windowsHide: true,
      })
      const outcome = result.status === 0 ? result.stdout.trim() : ""
      if (outcome === "mismatch") continue
      if (outcome !== "terminated" && !isGone(member.pid)) confirmed = false
      continue
    }
    const identity = await currentIdentity(member.pid, Math.min(1_500, remainingMs()))
    if (!identity) {
      if (!isGone(member.pid)) confirmed = false
      continue
    }
    if (identity !== member.startIdentity) continue
    try {
      kill(member.pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") confirmed = false
    }
  }
  if (remainingMs() <= 0) return false
  for (const member of tree.members) {
    if (remainingMs() <= 0) return false
    const remainingIdentity = await currentIdentity(member.pid, Math.min(1_500, remainingMs()))
    if (remainingIdentity === member.startIdentity) confirmed = false
    else if (!remainingIdentity && !isGone(member.pid)) confirmed = false
  }
  return confirmed
}

export function stopManagedChild(options: StopManagedChildOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const deadlineMs = options.deadlineMs ?? CLI_STOP_DEADLINE_MS
    const deadlineAt = options.deadlineAt ?? Date.now() + deadlineMs
    const cleanupComplete = options.isCleanupComplete ?? (() => true)
    const removeListener = () => options.child.off?.("exit", onExit)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (hardTimer) clearTimeout(hardTimer)
      removeListener()
      if (error) reject(error)
      else resolve()
    }
    let forcing = false
    const force = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (settled) return
      if (forcing) return
      if (Date.now() >= deadlineAt) {
        finish(new Error("CLI process tree termination exceeded its overall deadline"))
        return
      }
      attempts += 1
      forcing = true
      void Promise.resolve().then(() => options.force(deadlineAt)).then((confirmed) => {
        forcing = false
        if (settled) return
        if (Date.now() > deadlineAt) {
          finish(new Error("CLI process tree termination exceeded its overall deadline"))
          return
        }
        if (confirmed) {
          finish()
          return
        }
        retry()
      }, (error) => {
        forcing = false
        options.warn?.("Failed to force CLI process tree termination", error)
        retry()
      })
    }
    const retry = () => {
      const maxAttempts = options.forceAttempts ?? 3
      if (attempts >= maxAttempts) {
        finish(new Error(`CLI process tree termination was not confirmed after ${attempts} attempts`))
        return
      }
      options.warn?.("CLI process tree termination was not confirmed; retrying")
      const retryMs = options.forceRetryMs ?? 1_000
      timer = setTimeout(force, Math.min(retryMs, Math.max(0, deadlineAt - Date.now())))
    }
    function onExit() {
      if (cleanupComplete()) finish()
      else force()
    }

    options.child.once("exit", onExit)
    hardTimer = setTimeout(() => {
      finish(new Error("CLI process tree termination exceeded its overall deadline"))
    }, Math.max(0, deadlineAt - Date.now()))
    if (options.isExited()) {
      onExit()
      return
    }

    const forceAt = deadlineAt - (options.forceReserveMs ?? Math.min(1_500, deadlineMs / 2))
    timer = setTimeout(() => {
      options.warn?.("CLI cleanup reached its final enforcement window; forcing process tree termination")
      force()
    }, Math.max(0, forceAt - Date.now()))
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
