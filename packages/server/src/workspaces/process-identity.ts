import type { SpawnSyncReturns, spawnSync } from "node:child_process"

export interface ProcessIdentity {
  pid: number
  parentPid: number
  groupId: number
  startTime: string
  bootId?: string
  startOrder?: string
}

export type ProcessSnapshot =
  | { ok: true; processes: Map<number, ProcessIdentity> }
  | { ok: false; error: string }

export interface GuardedSignalRequest {
  leader?: ProcessIdentity
  groupId?: number
  members: ProcessIdentity[]
  signal: NodeJS.Signals
}

export type GuardedSignalResult =
  | { ok: true; matched: boolean; signalSent: boolean; signaled: ProcessIdentity[]; cutoff?: string }
  | { ok: false; error: string; observed?: ProcessIdentity[] }

type SpawnCommand = typeof spawnSync

const LINUX_SNAPSHOT_SCRIPT = String.raw`
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || exit 1
test -n "$boot" || exit 1
for stat in /proc/[0-9]*/stat; do
  line=$(cat "$stat" 2>/dev/null) || continue
  pid=$(printf '%s\n' "$line" | cut -d' ' -f1)
  rest=$(printf '%s\n' "$line" | sed 's/^.*) //')
  set -- $rest
  printf '%s|%s|%s|%s|%s|%s\n' "$pid" "$2" "$3" "$20" "$boot" "$20"
done
`

const LINUX_GUARDED_SIGNAL_SCRIPT = String.raw`
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || exit 20
read_stat() {
  line=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat_pid=$(printf '%s\n' "$line" | cut -d' ' -f1); rest=$(printf '%s\n' "$line" | sed 's/^.*) //'); set -- $rest
  stat_ppid=$2; stat_group=$3; stat_start=$20
}
emit_target() {
  printf 'CODENOMAD_TARGET|%s|%s|%s|%s|%s|%s\n' "$stat_pid" "$stat_ppid" "$stat_group" "$stat_start" "$boot" "$stat_start"
}
leader_pid=$1; leader_start=$2; leader_boot=$3; expected_group=$4; requested_signal=$5
shift 5
matched=0; cutoff=; signal_sent=0
if read_stat "$leader_pid" && test "$boot" = "$leader_boot" && test "$stat_start" = "$leader_start" && test "$stat_group" = "$expected_group"; then
  matched=1
  for stat in /proc/[0-9]*/stat; do
    candidate=$(basename "$(dirname "$stat")")
    if read_stat "$candidate" && test "$stat_group" = "$expected_group"; then emit_target; fi
  done
  if kill "-$requested_signal" -- "-$expected_group" 2>/dev/null; then
    signal_sent=1
    hz=$(getconf CLK_TCK 2>/dev/null) || exit 21
    uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null) || exit 21
    cutoff=$(awk -v uptime="$uptime" -v hz="$hz" 'BEGIN { printf "%.0f", uptime * hz }')
  fi
else
  while test "$#" -ge 3; do
    expected_pid=$1; expected_start=$2; expected_boot=$3; shift 3
    if read_stat "$expected_pid" && test "$boot" = "$expected_boot" && test "$stat_start" = "$expected_start"; then
      emit_target
      if kill "-$requested_signal" "$expected_pid" 2>/dev/null; then signal_sent=1; fi
    fi
  done
fi
printf 'CODENOMAD_RESULT|%s|%s|%s\n' "$matched" "$cutoff" "$signal_sent"
`

const POSIX_SNAPSHOT_SCRIPT = String.raw`
encode() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
for pid in $(ps -eo pid= 2>/dev/null); do
  meta=$(ps -p "$pid" -o ppid= -o pgid= -o lstart= 2>/dev/null) || continue
  command=$(ps -p "$pid" -o command= 2>/dev/null) || continue
  verify=$(ps -p "$pid" -o ppid= -o pgid= -o lstart= 2>/dev/null) || continue
  test "$meta" = "$verify" || continue
  set -- $meta
  test "$#" -ge 7 || continue
  ppid=$1; pgid=$2; shift 2
  start="$1 $2 $3 $4 $5"
  printf 'CODENOMAD_B64|%s|%s|%s|' "$pid" "$ppid" "$pgid"
  encode "$start"; printf '|'; encode "$command"; printf '\n'
done
`

const POSIX_GUARDED_SIGNAL_SCRIPT = String.raw`
encode() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
read_identity() {
  current_meta=$(ps -p "$1" -o ppid= -o pgid= -o lstart= 2>/dev/null) || return 1
  current_command=$(ps -p "$1" -o command= 2>/dev/null) || return 1
  current_verify=$(ps -p "$1" -o ppid= -o pgid= -o lstart= 2>/dev/null) || return 1
  test "$current_meta" = "$current_verify" || return 1
  set -- $current_meta
  test "$#" -ge 7 || return 1
  current_ppid=$1; current_group=$2; shift 2
  current_start="$1 $2 $3 $4 $5"
  current_identity=$(printf '%s\t%s' "$current_start" "$current_command")
}
emit_target() {
  printf 'CODENOMAD_TARGET_B64|%s|%s|%s|' "$current_pid" "$current_ppid" "$current_group"
  encode "$current_start"; printf '|'; encode "$current_command"; printf '\n'
}
leader_pid=$1; leader_start=$2; expected_group=$3; requested_signal=$4; shift 4
matched=0; signal_sent=0
if read_identity "$leader_pid" && test "$current_group" = "$expected_group" && test "$current_identity" = "$leader_start"; then
  matched=1
  for current_pid in $(ps -eo pid= 2>/dev/null); do
    if read_identity "$current_pid" && test "$current_group" = "$expected_group"; then emit_target; fi
  done
  if kill "-$requested_signal" -- "-$expected_group" 2>/dev/null; then signal_sent=1; fi
else
  while test "$#" -ge 2; do
    expected_pid=$1; expected_start=$2; shift 2
    current_pid=$expected_pid
    if read_identity "$expected_pid" && test "$current_identity" = "$expected_start"; then
      emit_target
      if kill "-$requested_signal" "$expected_pid" 2>/dev/null; then signal_sent=1; fi
    fi
  done
fi
printf 'CODENOMAD_RESULT|%s||%s\n' "$matched" "$signal_sent"
`

const POSIX_OWNED_GROUP_SIGNAL_SCRIPT = String.raw`
encode() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
read_identity() {
  current_meta=$(ps -p "$1" -o ppid= -o pgid= -o lstart= 2>/dev/null) || return 1
  current_command=$(ps -p "$1" -o command= 2>/dev/null) || return 1
  current_verify=$(ps -p "$1" -o ppid= -o pgid= -o lstart= 2>/dev/null) || return 1
  test "$current_meta" = "$current_verify" || return 1
  set -- $current_meta
  test "$#" -ge 7 || return 1
  current_ppid=$1; current_group=$2; shift 2
  current_start="$1 $2 $3 $4 $5"
  current_identity=$(printf '%s\t%s' "$current_start" "$current_command")
}
emit_target() {
  printf 'CODENOMAD_TARGET_B64|%s|%s|%s|' "$current_pid" "$current_ppid" "$current_group"
  encode "$current_start"; printf '|'; encode "$current_command"; printf '\n'
}
root_pid=$1; requested_signal=$2; matched=0; signal_sent=0
if read_identity "$root_pid" && test "$current_group" = "$root_pid"; then
  matched=1
  for current_pid in $(ps -eo pid= 2>/dev/null); do
    if read_identity "$current_pid" && test "$current_group" = "$root_pid"; then emit_target; fi
  done
  if kill "-$requested_signal" -- "-$root_pid" 2>/dev/null; then signal_sent=1; fi
  for current_pid in $(ps -eo pid= 2>/dev/null); do
    if read_identity "$current_pid" && test "$current_group" = "$root_pid"; then emit_target; fi
  done
fi
printf 'CODENOMAD_RESULT|%s||%s\n' "$matched" "$signal_sent"
`

function commandError(result: SpawnSyncReturns<string>): string {
  return result.error?.message || String(result.stderr ?? result.stdout ?? "").trim() || `exit code ${result.status}`
}

function parseDelimitedSnapshot(output: string, requireBootId = false): Map<number, ProcessIdentity> | null {
  const processes = new Map<number, ProcessIdentity>()
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    const fields = line.split("|")
    if (fields.length !== 6) return null
    const [pidText, parentPidText, groupIdText, startTime = "", bootId = "", startOrder = ""] = fields
    const pid = Number.parseInt(pidText ?? "", 10)
    const parentPid = Number.parseInt(parentPidText ?? "", 10)
    const groupId = Number.parseInt(groupIdText ?? "", 10)
    if (!/^\d+$/.test(pidText ?? "") || !/^\d+$/.test(parentPidText ?? "") || !/^\d+$/.test(groupIdText ?? "") ||
      !Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || !startTime || (requireBootId && !bootId)) return null
    processes.set(pid, {
      pid,
      parentPid,
      groupId: Number.isInteger(groupId) && groupId > 0 ? groupId : pid,
      startTime,
      ...(bootId ? { bootId } : {}),
      ...(startOrder ? { startOrder } : {}),
    })
  }
  return processes
}

function decodeBase64Field(value: string): string | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null
  }
  try {
    const bytes = Buffer.from(value, "base64")
    if (bytes.toString("base64") !== value) return null
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function parseBase64Snapshot(output: string, prefix = "CODENOMAD_B64|"): Map<number, ProcessIdentity> | null {
  const processes = new Map<number, ProcessIdentity>()
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    if (!line.startsWith(prefix)) return null
    const fields = line.slice(prefix.length).split("|")
    if (fields.length !== 5) return null
    const [pidText = "", parentPidText = "", groupIdText = "", startEncoded = "", commandEncoded = ""] = fields
    if (!/^\d+$/.test(pidText) || !/^\d+$/.test(parentPidText) || !/^\d+$/.test(groupIdText)) return null
    const pid = Number.parseInt(pidText, 10)
    const parentPid = Number.parseInt(parentPidText, 10)
    const groupId = Number.parseInt(groupIdText, 10)
    const start = decodeBase64Field(startEncoded)
    const command = decodeBase64Field(commandEncoded)
    if (pid <= 0 || parentPid < 0 || groupId <= 0 || start === null || command === null) return null
    processes.set(pid, { pid, parentPid, groupId, startTime: `${start}\t${command}` })
  }
  return processes
}

function snapshotOrFailure(processes: Map<number, ProcessIdentity> | null): ProcessSnapshot {
  return processes && processes.size > 0
    ? { ok: true, processes }
    : { ok: false, error: "process identity query returned no parseable processes" }
}

function parseGuardedResult(result: SpawnSyncReturns<string>): GuardedSignalResult {
  const signaled = new Map<number, ProcessIdentity>()
  const failure = (error: string): GuardedSignalResult => ({
    ok: false,
    error,
    ...(signaled.size > 0 ? { observed: Array.from(signaled.values()) } : {}),
  })
  let matched: boolean | undefined
  let signalSent = false
  let cutoff: string | undefined
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith("CODENOMAD_TARGET|")) {
      const parsed = parseDelimitedSnapshot(line.slice("CODENOMAD_TARGET|".length))
      if (!parsed) return failure("guarded signal command returned a malformed target record")
      for (const identity of parsed.values()) signaled.set(identity.pid, identity)
      continue
    }
    if (line.startsWith("CODENOMAD_TARGET_B64|")) {
      const parsed = parseBase64Snapshot(line, "CODENOMAD_TARGET_B64|")
      if (!parsed) return failure("guarded signal command returned a malformed target record")
      for (const identity of parsed.values()) signaled.set(identity.pid, identity)
      continue
    }
    if (line.startsWith("CODENOMAD_RESULT|")) {
      const fields = line.split("|")
      if (fields.length !== 4 || !/^[01]$/.test(fields[1] ?? "") || !/^[01]$/.test(fields[3] ?? "")) {
        return failure("guarded signal command returned a malformed result record")
      }
      const [, matchedText, cutoffText, signalSentText] = fields
      matched = matchedText === "1"
      cutoff = cutoffText || undefined
      signalSent = signalSentText === "1"
      continue
    }
    if (line) return failure("guarded signal command returned unexpected output")
  }
  if (result.status !== 0) return failure(commandError(result))
  return matched === undefined
    ? failure("guarded signal command returned no structured result")
    : { ok: true, matched, signalSent, signaled: Array.from(signaled.values()), ...(cutoff ? { cutoff } : {}) }
}

function runGuardedCommand(
  spawnCommand: SpawnCommand,
  command: string,
  args: string[],
  timeoutMs: number,
): GuardedSignalResult {
  try {
    return parseGuardedResult(spawnCommand(command, args, { encoding: "utf8", timeout: timeoutMs }))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function signalName(signal: NodeJS.Signals): "TERM" | "KILL" {
  return signal === "SIGKILL" ? "KILL" : "TERM"
}

function shellGuardArgs(request: GuardedSignalRequest, linux: boolean): string[] {
  const leader = request.leader
  const args = linux
    ? [String(leader?.pid ?? 0), leader?.startTime ?? "", leader?.bootId ?? "", String(request.groupId ?? 0), signalName(request.signal)]
    : [String(leader?.pid ?? 0), leader?.startTime ?? "", String(request.groupId ?? 0), signalName(request.signal)]
  for (const member of request.members) {
    args.push(String(member.pid), member.startTime)
    if (linux) args.push(member.bootId ?? "")
  }
  return args
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function buildWindowsGuardedScript(request: GuardedSignalRequest): string {
  const leaderPid = request.leader?.pid ?? 0
  const leaderStart = quotePowerShell(request.leader?.startTime ?? "")
  const expected = request.members
    .map((identity) => `@{ Pid = ${identity.pid}; Start = ${quotePowerShell(identity.startTime)} }`)
    .join(", ")
  return [
    "$ErrorActionPreference = 'Stop'",
    `$leaderPid = ${leaderPid}`,
    `$leaderStart = ${leaderStart}`,
    `$expected = @(${expected})`,
    "function Get-CodeNomadStart($process) { return ([datetime]$process.CreationDate).ToUniversalTime().Ticks.ToString() }",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$byPid = @{}; $all | ForEach-Object { $byPid[[int]$_.ProcessId] = $_ }",
    "$leader = $byPid[$leaderPid]",
    "$matched = $null -ne $leader -and (Get-CodeNomadStart $leader) -eq $leaderStart",
    "$selected = @()",
    "if ($matched) {",
    "  $ids = @($leaderPid); $changed = $true",
    "  while ($changed) { $changed = $false; foreach ($process in $all) { if ($ids -contains [int]$process.ParentProcessId -and $ids -notcontains [int]$process.ProcessId) { $ids += [int]$process.ProcessId; $changed = $true } } }",
    "  $selected = @($all | Where-Object { $ids -contains [int]$_.ProcessId } | Sort-Object ProcessId -Descending)",
    "} else {",
    "  foreach ($item in $expected) { $process = $byPid[[int]$item.Pid]; if ($null -ne $process -and (Get-CodeNomadStart $process) -eq [string]$item.Start) { $selected += $process } }",
    "}",
    "foreach ($process in $selected) {",
    "  $start = Get-CodeNomadStart $process",
    "  '{0}|{1}|0|{2}||{2}' -f [int]$process.ProcessId, [int]$process.ParentProcessId, $start | ForEach-Object { 'CODENOMAD_TARGET|' + $_ }",
    "}",
    "foreach ($process in $selected) {",
    "  Invoke-CimMethod -InputObject $process -MethodName Terminate -Arguments @{ Reason = 1 } -ErrorAction Stop | Out-Null",
    "}",
    "'CODENOMAD_RESULT|' + ($(if ($matched) { '1' } else { '0' })) + '||' + ($(if ($selected.Count -gt 0) { '1' } else { '0' }))",
  ].join("; ")
}

export function sameProcess(left: ProcessIdentity | undefined, right: ProcessIdentity | undefined): boolean {
  return Boolean(
    left && right && left.pid === right.pid && left.startTime === right.startTime &&
    (!left.bootId || !right.bootId || left.bootId === right.bootId),
  )
}

export function startedNoLaterThan(identity: ProcessIdentity, cutoff: string): boolean {
  const startOrder = identity.startOrder ?? identity.startTime
  if (!/^\d+$/.test(startOrder) || !/^\d+$/.test(cutoff)) return false
  try {
    return BigInt(startOrder) <= BigInt(cutoff)
  } catch {
    return false
  }
}

export function descendantsOf(processes: Map<number, ProcessIdentity>, rootPid: number): ProcessIdentity[] {
  const descendants: ProcessIdentity[] = []
  const pending = [rootPid]
  const seen = new Set(pending)
  while (pending.length > 0) {
    const parentPid = pending.shift()!
    for (const process of processes.values()) {
      if (process.parentPid !== parentPid || seen.has(process.pid)) continue
      seen.add(process.pid)
      pending.push(process.pid)
      descendants.push(process)
    }
  }
  return descendants
}

export function probePosixProcesses(
  spawnCommand: SpawnCommand,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): ProcessSnapshot {
  try {
    if (platform === "linux") {
      const result = spawnCommand("sh", ["-c", LINUX_SNAPSHOT_SCRIPT, "codenomad-posix-identity"], {
        encoding: "utf8",
        timeout: timeoutMs,
      })
      if (result.status !== 0) return { ok: false, error: commandError(result) }
      return snapshotOrFailure(parseDelimitedSnapshot(String(result.stdout ?? ""), true))
    }

    // POSIX has no portable pidfd/start ticks; bind lstart to a base64-encoded full command fingerprint.
    const result = spawnCommand("sh", ["-c", POSIX_SNAPSHOT_SCRIPT, "codenomad-posix-identity"], {
      encoding: "utf8",
      timeout: timeoutMs,
    })
    if (result.status !== 0) return { ok: false, error: commandError(result) }
    return snapshotOrFailure(parseBase64Snapshot(String(result.stdout ?? "")))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function probeWindowsProcesses(spawnCommand: SpawnCommand, timeoutMs: number): ProcessSnapshot {
  const script = [
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$all | ForEach-Object { $start = ([datetime]$_.CreationDate).ToUniversalTime().Ticks.ToString(); '{0}|{1}|0|{2}||{2}' -f [int]$_.ProcessId, [int]$_.ParentProcessId, $start }",
  ].join("; ")
  try {
    const result = spawnCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: timeoutMs,
    })
    if (result.status !== 0) return { ok: false, error: commandError(result) }
    return snapshotOrFailure(parseDelimitedSnapshot(String(result.stdout ?? "")))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function probeWslProcesses(spawnCommand: SpawnCommand, distro: string, timeoutMs: number): ProcessSnapshot {
  try {
    const result = spawnCommand(
      "wsl.exe",
      ["--distribution", distro, "--exec", "sh", "-c", LINUX_SNAPSHOT_SCRIPT, "codenomad-wsl-identity"],
      { encoding: "utf8", timeout: timeoutMs },
    )
    if (result.status !== 0) return { ok: false, error: commandError(result) }
    return snapshotOrFailure(parseDelimitedSnapshot(String(result.stdout ?? ""), true))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function signalPosixProcesses(
  spawnCommand: SpawnCommand,
  request: GuardedSignalRequest,
  timeoutMs: number,
  platform: NodeJS.Platform,
): GuardedSignalResult {
  const linux = platform === "linux"
  return runGuardedCommand(
    spawnCommand,
    "sh",
    ["-c", linux ? LINUX_GUARDED_SIGNAL_SCRIPT : POSIX_GUARDED_SIGNAL_SCRIPT, "codenomad-guarded-signal", ...shellGuardArgs(request, linux)],
    timeoutMs,
  )
}

export function signalOwnedPosixProcessGroup(
  spawnCommand: SpawnCommand,
  rootPid: number,
  signal: NodeJS.Signals,
  timeoutMs: number,
): GuardedSignalResult {
  return runGuardedCommand(
    spawnCommand,
    "sh",
    ["-c", POSIX_OWNED_GROUP_SIGNAL_SCRIPT, "codenomad-owned-group-cleanup", String(rootPid), signalName(signal)],
    timeoutMs,
  )
}

export function signalWslProcesses(
  spawnCommand: SpawnCommand,
  distro: string,
  request: GuardedSignalRequest,
  timeoutMs: number,
): GuardedSignalResult {
  return runGuardedCommand(
    spawnCommand,
    "wsl.exe",
    ["--distribution", distro, "--exec", "sh", "-c", LINUX_GUARDED_SIGNAL_SCRIPT, "codenomad-wsl-guarded-signal", ...shellGuardArgs(request, true)],
    timeoutMs,
  )
}

export function signalWindowsProcesses(
  spawnCommand: SpawnCommand,
  request: GuardedSignalRequest,
  timeoutMs: number,
): GuardedSignalResult {
  return runGuardedCommand(
    spawnCommand,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", buildWindowsGuardedScript(request)],
    timeoutMs,
  )
}
