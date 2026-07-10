import type { SpawnSyncReturns, spawnSync } from "node:child_process"

import type { ProcessIdentity, ProcessSnapshot } from "./process-identity"

export const LAUNCH_CLEANUP_TOKEN_ENV = "CODENOMAD_LAUNCH_CLEANUP_TOKEN"

type SpawnCommand = typeof spawnSync

export interface TokenSignalResult {
  ok: boolean
  signalSent: boolean
  targets: ProcessIdentity[]
  error?: string
}

const LINUX_TOKEN_PROBE_SCRIPT = String.raw`
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || exit 20
key=$1; expected=$2
matches_token() {
  test -r "/proc/$1/environ" || return 1
  tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | grep -Fqx -- "$key=$expected"
}
read_stat() {
  line=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat_pid=$(printf '%s\n' "$line" | cut -d' ' -f1); rest=$(printf '%s\n' "$line" | sed 's/^.*) //'); set -- $rest
  stat_ppid=$2; stat_group=$3; stat_start=$20
}
for environ in /proc/[0-9]*/environ; do
  pid=$(basename "$(dirname "$environ")")
  if matches_token "$pid" && read_stat "$pid"; then
    printf '%s|%s|%s|%s|%s|%s\n' "$stat_pid" "$stat_ppid" "$stat_group" "$stat_start" "$boot" "$stat_start"
  fi
done
`

const LINUX_TOKEN_SIGNAL_SCRIPT = String.raw`
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || exit 20
key=$1; expected=$2; requested_signal=$3
matches_token() {
  test -r "/proc/$1/environ" || return 1
  tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | grep -Fqx -- "$key=$expected"
}
read_stat() {
  line=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat_pid=$(printf '%s\n' "$line" | cut -d' ' -f1); rest=$(printf '%s\n' "$line" | sed 's/^.*) //'); set -- $rest
  stat_ppid=$2; stat_group=$3; stat_start=$20
}
signal_sent=0
# Repeat inside the one bounded adapter so children forked by a signaled parent are selected too.
for pass in 1 2 3; do
  for environ in /proc/[0-9]*/environ; do
    pid=$(basename "$(dirname "$environ")")
    if matches_token "$pid" && read_stat "$pid"; then
      printf 'CODENOMAD_TARGET|%s|%s|%s|%s|%s|%s\n' "$stat_pid" "$stat_ppid" "$stat_group" "$stat_start" "$boot" "$stat_start"
      if matches_token "$pid" && read_stat "$pid" && kill "-$requested_signal" "$pid" 2>/dev/null; then signal_sent=1; fi
    fi
  done
done
printf 'CODENOMAD_RESULT|%s\n' "$signal_sent"
`

function failure(result: SpawnSyncReturns<string>, token?: string): string {
  const message = result.error?.message || `launch cleanup command failed with exit code ${result.status}`
  return token ? redactToken(message, token) : message
}

function redactToken(value: string, token: string): string {
  return value.split(token).join("[REDACTED]")
}

function parseIdentity(line: string): ProcessIdentity | null {
  const fields = line.split("|")
  if (fields.length !== 6) return null
  const [pidText = "", parentPidText = "", groupIdText = "", startTime = "", bootId = "", startOrder = ""] = fields
  if (!/^\d+$/.test(pidText) || !/^\d+$/.test(parentPidText) || !/^\d+$/.test(groupIdText) ||
    !startTime || !bootId || !/^\d+$/.test(startOrder)) return null
  const pid = Number.parseInt(pidText, 10)
  const parentPid = Number.parseInt(parentPidText, 10)
  const groupId = Number.parseInt(groupIdText, 10)
  if (pid <= 0 || parentPid < 0 || groupId <= 0) return null
  return { pid, parentPid, groupId, startTime, bootId, startOrder }
}

function runLinux(
  spawnCommand: SpawnCommand,
  script: string,
  args: string[],
  timeoutMs: number,
  distro?: string,
): SpawnSyncReturns<string> {
  return distro
    ? spawnCommand("wsl.exe", ["--distribution", distro, "--exec", "sh", "-c", script, "codenomad-token-cleanup", ...args], {
        encoding: "utf8",
        timeout: timeoutMs,
      })
    : spawnCommand("sh", ["-c", script, "codenomad-token-cleanup", ...args], { encoding: "utf8", timeout: timeoutMs })
}

export function probeLaunchCleanupToken(
  spawnCommand: SpawnCommand,
  token: string,
  timeoutMs: number,
  distro?: string,
): ProcessSnapshot {
  try {
    const result = runLinux(spawnCommand, LINUX_TOKEN_PROBE_SCRIPT, [LAUNCH_CLEANUP_TOKEN_ENV, token], timeoutMs, distro)
    if (result.status !== 0) return { ok: false, error: failure(result, token) }
    const processes = new Map<number, ProcessIdentity>()
    for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
      if (!line) continue
      const identity = parseIdentity(line)
      if (!identity) return { ok: false, error: "launch cleanup probe returned a malformed identity record" }
      processes.set(identity.pid, identity)
    }
    return { ok: true, processes }
  } catch (error) {
    return { ok: false, error: redactToken(error instanceof Error ? error.message : String(error), token) }
  }
}

export function signalLaunchCleanupToken(
  spawnCommand: SpawnCommand,
  token: string,
  signal: NodeJS.Signals,
  timeoutMs: number,
  distro?: string,
): TokenSignalResult {
  try {
    const signalName = signal === "SIGKILL" ? "KILL" : "TERM"
    const result = runLinux(
      spawnCommand,
      LINUX_TOKEN_SIGNAL_SCRIPT,
      [LAUNCH_CLEANUP_TOKEN_ENV, token, signalName],
      timeoutMs,
      distro,
    )
    if (result.status !== 0) return { ok: false, signalSent: false, targets: [], error: failure(result, token) }
    const targets = new Map<number, ProcessIdentity>()
    let signalSent: boolean | undefined
    for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
      if (!line) continue
      if (line.startsWith("CODENOMAD_TARGET|")) {
        const identity = parseIdentity(line.slice("CODENOMAD_TARGET|".length))
        if (!identity) return { ok: false, signalSent: false, targets: [], error: "launch cleanup signal returned a malformed target record" }
        targets.set(identity.pid, identity)
        continue
      }
      if (line === "CODENOMAD_RESULT|0" || line === "CODENOMAD_RESULT|1") {
        signalSent = line.endsWith("1")
        continue
      }
      return { ok: false, signalSent: false, targets: [], error: "launch cleanup signal returned unexpected output" }
    }
    return signalSent === undefined
      ? { ok: false, signalSent: false, targets: [], error: "launch cleanup signal returned no structured result" }
      : { ok: true, signalSent, targets: Array.from(targets.values()) }
  } catch (error) {
    return {
      ok: false,
      signalSent: false,
      targets: [],
      error: redactToken(error instanceof Error ? error.message : String(error), token),
    }
  }
}

export function signalOwnedWindowsProcessTree(
  spawnCommand: SpawnCommand,
  rootPid: number,
  timeoutMs: number,
): TokenSignalResult {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = ${rootPid}`,
    "function Get-CodeNomadStart($process) { return ([datetime]$process.CreationDate).ToUniversalTime().Ticks.ToString() }",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$ids = @($rootPid); $changed = $true",
    "while ($changed) { $changed = $false; foreach ($process in $all) { if ($ids -contains [int]$process.ParentProcessId -and $ids -notcontains [int]$process.ProcessId) { $ids += [int]$process.ProcessId; $changed = $true } } }",
    "$selected = @($all | Where-Object { $ids -contains [int]$_.ProcessId } | Sort-Object ProcessId -Descending)",
    "foreach ($process in $selected) { $start = Get-CodeNomadStart $process; 'CODENOMAD_TARGET|{0}|{1}|0|{2}||{2}' -f [int]$process.ProcessId, [int]$process.ParentProcessId, $start; Invoke-CimMethod -InputObject $process -MethodName Terminate -Arguments @{ Reason = 1 } -ErrorAction Stop | Out-Null }",
    "'CODENOMAD_RESULT|' + ($(if ($selected.Count -gt 0) { '1' } else { '0' }))",
  ].join("; ")
  try {
    const result = spawnCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: timeoutMs,
    })
    if (result.status !== 0) return { ok: false, signalSent: false, targets: [], error: failure(result) }
    const targets = new Map<number, ProcessIdentity>()
    let signalSent: boolean | undefined
    for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
      if (!line) continue
      if (line.startsWith("CODENOMAD_TARGET|")) {
        const fields = line.slice("CODENOMAD_TARGET|".length).split("|")
        if (fields.length !== 6) return { ok: false, signalSent: false, targets: [], error: "Windows cleanup returned a malformed target record" }
        const [pidText = "", parentPidText = "", , startTime = "", , startOrder = ""] = fields
        if (!/^\d+$/.test(pidText) || !/^\d+$/.test(parentPidText) || !startTime || !/^\d+$/.test(startOrder)) {
          return { ok: false, signalSent: false, targets: [], error: "Windows cleanup returned a malformed target record" }
        }
        const pid = Number.parseInt(pidText, 10)
        targets.set(pid, { pid, parentPid: Number.parseInt(parentPidText, 10), groupId: pid, startTime, startOrder })
        continue
      }
      if (line === "CODENOMAD_RESULT|0" || line === "CODENOMAD_RESULT|1") {
        signalSent = line.endsWith("1")
        continue
      }
      return { ok: false, signalSent: false, targets: [], error: "Windows cleanup returned unexpected output" }
    }
    return signalSent === undefined
      ? { ok: false, signalSent: false, targets: [], error: "Windows cleanup returned no structured result" }
      : { ok: true, signalSent, targets: Array.from(targets.values()) }
  } catch (error) {
    return { ok: false, signalSent: false, targets: [], error: error instanceof Error ? error.message : String(error) }
  }
}
