// Self-contained (Node built-ins only) so Electron main, tests and tsx-loaded
// scripts share one process-tree rule.
import { execFile } from "node:child_process"

export interface ProcessTreeRow {
  pid: number
  parentPid: number
  /** Comparable creation time on one host clock; undefined when unreadable. */
  startedAt?: bigint
}

/**
 * The root and its descendants, in row order. A process keeps the numeric ID of a parent
 * that exited, and Windows reuses that ID, so a row counts as a child only when it started
 * no earlier than the process now holding its parent ID. Unknown start times are rejected.
 */
export function processTreeRows<T extends ProcessTreeRow>(rootPid: number, rows: readonly T[]): T[] {
  // The first row of a PID is authoritative; a later duplicate is a scan race.
  const byPid = new Map<number, T>()
  const children = new Map<number, T[]>()
  for (const row of rows) {
    if (byPid.has(row.pid)) continue
    byPid.set(row.pid, row)
    if (row.parentPid === row.pid) continue
    const siblings = children.get(row.parentPid)
    if (siblings) siblings.push(row)
    else children.set(row.parentPid, [row])
  }
  const root = byPid.get(rootPid)
  if (!root) return []
  const members = new Set<T>([root])
  const queue = [root]
  for (let next = 0; next < queue.length; next += 1) {
    const parent = queue[next]
    for (const row of children.get(parent.pid) ?? []) {
      if (members.has(row) || row.startedAt === undefined || parent.startedAt === undefined || row.startedAt < parent.startedAt) continue
      members.add(row)
      queue.push(row)
    }
  }
  return rows.filter(row => members.has(row))
}

/** .NET ticks (100 ns since 0001-01-01 UTC) of a JavaScript time. */
export function dotNetTicks(milliseconds: number): bigint {
  return (BigInt(Math.trunc(milliseconds)) + 62_135_596_800_000n) * 10_000n
}

// Some system processes report no creation date; they can never be tree members.
const WINDOWS_PROCESS_ROWS = "$ErrorActionPreference = 'Stop'; foreach ($row in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate) { "
  + "if ($null -ne $row.CreationDate) { '{0}|{1}|{2}' -f $row.ProcessId, $row.ParentProcessId, $row.CreationDate.ToUniversalTime().Ticks } }"

export function parseWindowsProcessRows(stdout: string): ProcessTreeRow[] {
  const rows: ProcessTreeRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\|(\d+)\|(\d+)$/)
    if (match) rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: BigInt(match[3]) })
  }
  return rows
}

/**
 * Members of `rootPid`'s tree to stop, deepest last in row order, or none when the process now
 * holding `rootPid` started after `rootStartedBy` (the root exited and its ID was reused).
 */
export function windowsTreeStopTargets(rootPid: number, rows: readonly ProcessTreeRow[], rootStartedBy: Date): ProcessTreeRow[] {
  const members = processTreeRows(rootPid, rows)
  const root = members.find(row => row.pid === rootPid)
  // CIM truncates creation times to microseconds; the spawn time has millisecond resolution.
  if (root?.startedAt === undefined || root.startedAt > dotNetTicks(rootStartedBy.getTime() + 1)) return []
  return members
}

function windowsStopScript(targets: readonly ProcessTreeRow[]): string {
  const list = targets.map(({ pid, startedAt }) => `@{ Id = ${pid}; Ticks = ${startedAt} }`).join(",")
  // Each Process object binds its handle before the creation-time check, so the stop cannot
  // reach a process that took the ID after the listing.
  return `$ErrorActionPreference = 'Continue'
$failed = @()
foreach ($target in @(${list})) {
  $process = Get-Process -Id $target.Id -ErrorAction SilentlyContinue
  if ($null -eq $process) { continue }
  try {
    $null = $process.Handle
    $ticks = $process.StartTime.ToUniversalTime().Ticks
    if (($ticks - $ticks % 10) -ne [long]$target.Ticks) { continue }
    Stop-Process -InputObject $process -Force -ErrorAction Stop
    if (!$process.WaitForExit(2000)) { throw "Process $($target.Id) still running" }
  } catch {
    $message = $_.Exception.Message
    try { if ($process.HasExited) { continue } } catch {}
    $failed += "$($target.Id): $message"
  }
}
if ($failed.Count) { Write-Error ($failed -join "; "); exit 1 }
exit 0`
}

function powershell(script: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? undefined : stdout)
      })
  })
}

/**
 * Force-stops a Windows process tree that this process spawned at or before `rootStartedBy`,
 * without `taskkill /T`, which follows recorded parent IDs and so reaches unrelated processes
 * whose dead parent's ID was reused. Resolves to the number of processes it tried to stop; 0 when
 * the listing failed or the root ID was reused, so a caller holding the root's handle can stop it.
 * WMI and PowerShell start slowly on a cold host, hence the generous default budget.
 */
export async function stopWindowsProcessTree(rootPid: number, rootStartedBy: Date, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  const listing = await powershell(WINDOWS_PROCESS_ROWS, timeoutMs)
  if (listing === undefined) return 0
  const targets = windowsTreeStopTargets(rootPid, parseWindowsProcessRows(listing), rootStartedBy)
  if (targets.length === 0 || deadline - Date.now() <= 0) return 0
  const stopped = await powershell(windowsStopScript([...targets].reverse()), deadline - Date.now())
  if (stopped === undefined) return 0
  return targets.length
}
