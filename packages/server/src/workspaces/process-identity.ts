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
  allowLeaderlessGroup?: boolean
  cleanupToken?: string
}

export interface PosixProcessFilter {
  pids?: readonly number[]
  groupId?: number
}

export type GuardedSignalResult =
  | { ok: true; matched: boolean; signalSent: boolean; signaled: ProcessIdentity[]; cutoff?: string }
  | { ok: false; error: string; observed?: ProcessIdentity[] }

export type TokenSignalResult = { ok: boolean; signalSent: boolean; targets: ProcessIdentity[]; error?: string }

export const LAUNCH_CLEANUP_TOKEN_ENV = "CODENOMAD_LAUNCH_CLEANUP_TOKEN"

type SpawnCommand = typeof spawnSync
const SHELL_DOLLAR = "$"

const LINUX_IDENTITY_FUNCTIONS = String.raw`
IFS= read -r boot 2>/dev/null < /proc/sys/kernel/random/boot_id || exit 20
read_stat() {
  line=
  while IFS= read -r chunk || test -n "$chunk"; do line=$line$chunk; done 2>/dev/null < "/proc/$1/stat"
  test -n "$line" || return 1
  stat_pid=$1; rest=${SHELL_DOLLAR}{line##*) }; set -- $rest
  test "$#" -ge 20 || return 1
  stat_ppid=$2; stat_group=$3; shift 19; stat_start=$1
}
emit_linux() {
  test -n "$1" && printf '%s|' "$1"
  printf '%s|%s|%s|%s|%s|%s\n' "$stat_pid" "$stat_ppid" "$stat_group" "$stat_start" "$boot" "$stat_start"
}
`

const LINUX_SNAPSHOT_SCRIPT = String.raw`${LINUX_IDENTITY_FUNCTIONS}
for stat in /proc/[0-9]*/stat; do
  directory=${SHELL_DOLLAR}{stat%/stat}; pid=${SHELL_DOLLAR}{directory##*/}; read_stat "$pid" && emit_linux ""
done
exit 0
`

const LINUX_LAUNCH_GROUP_SNAPSHOT_SCRIPT = String.raw`${LINUX_IDENTITY_FUNCTIONS}
leader_pid=$1; read_stat "$leader_pid" || exit 22; expected_group=$stat_group; emit_linux ""
for stat in /proc/[0-9]*/stat; do
  directory=${SHELL_DOLLAR}{stat%/stat}; pid=${SHELL_DOLLAR}{directory##*/}; test "$pid" = "$leader_pid" && continue
  read_stat "$pid" && test "$stat_group" = "$expected_group" && emit_linux ""
done
exit 0
`

const LINUX_GUARDED_SIGNAL_SCRIPT = String.raw`${LINUX_IDENTITY_FUNCTIONS}
leader_pid=$1; leader_start=$2; leader_boot=$3; expected_group=$4; requested_signal=$5
shift 5; matched=0; cutoff=; signal_sent=0
if read_stat "$leader_pid" && test "$boot" = "$leader_boot" && test "$stat_start" = "$leader_start" && test "$stat_group" = "$expected_group"; then
  matched=1
  for stat in /proc/[0-9]*/stat; do
    directory=${SHELL_DOLLAR}{stat%/stat}; candidate=${SHELL_DOLLAR}{directory##*/}; read_stat "$candidate" && test "$stat_group" = "$expected_group" && emit_linux CODENOMAD_TARGET
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
      emit_linux CODENOMAD_TARGET
      if kill "-$requested_signal" "$expected_pid" 2>/dev/null; then signal_sent=1; fi
    fi
  done
fi
printf 'CODENOMAD_RESULT|%s|%s|%s\n' "$matched" "$cutoff" "$signal_sent"
`

const POSIX_IDENTITY_FUNCTIONS = String.raw`
LC_ALL=C; export LC_ALL; set -f
encode() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
read_identity() {
  current_meta=$(ps -p "$1" -o ppid= -o pgid= -o lstart= -o comm= 2>/dev/null) || return 1
  current_verify=$(ps -p "$1" -o ppid= -o pgid= -o lstart= -o comm= 2>/dev/null) || return 1
  test "$current_meta" = "$current_verify" || return 1
  set -- $current_meta; test "$#" -ge 7 || return 1
  current_ppid=$1; current_group=$2; shift 2; current_start="$1 $2 $3 $4 $5"
  shift 5; current_command="$*"; test -n "$current_command" || return 1
  current_identity=$(printf '%s\t%s' "$current_start" "$current_command")
}
emit_target() {
  printf 'CODENOMAD_TARGET_B64|%s|%s|%s|' "$current_pid" "$current_ppid" "$current_group"
  encode "$current_start"; printf '|'; encode "$current_command"; printf '\n'
}
group_pids() { ps -axo pid=,pgid= 2>/dev/null | awk -v group="$1" '$2 == group { print $1 }'; }
has_cleanup_token() {
  test -n "$cleanup_token" || return 1
  ps eww -p "$1" -o command= 2>/dev/null | tr ' ' '\n' | grep -Fqx -- "${LAUNCH_CLEANUP_TOKEN_ENV}=$cleanup_token"
}
`

const LINUX_TOKEN_SCRIPT = String.raw`${LINUX_IDENTITY_FUNCTIONS}
key=$1; expected=$2; requested_signal=$3
matches_token() { test -r "/proc/$1/environ" && tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | grep -Fqx -- "$key=$expected"; }
signal_sent=0; passes=1; test -n "$requested_signal" && passes=3
pass=0
while test "$pass" -lt "$passes"; do
  pass=$((pass + 1))
  for environ in /proc/[0-9]*/environ; do
    directory=${SHELL_DOLLAR}{environ%/environ}; pid=${SHELL_DOLLAR}{directory##*/}
    if matches_token "$pid" && read_stat "$pid"; then
      test -n "$requested_signal" && prefix=CODENOMAD_TARGET || prefix=CODENOMAD_PROCESS
      emit_linux "$prefix"
      if test -n "$requested_signal" && matches_token "$pid" && read_stat "$pid" && kill "-$requested_signal" "$pid" 2>/dev/null; then signal_sent=1; fi
    fi
  done
done
if test -n "$requested_signal"; then printf 'CODENOMAD_RESULT|%s\n' "$signal_sent"; fi
exit 0
`

const POSIX_GUARDED_SIGNAL_SCRIPT = String.raw`${POSIX_IDENTITY_FUNCTIONS}
leader_pid=$1; leader_start=$2; expected_group=$3; requested_signal=$4; allow_leaderless=$5; cleanup_token=$6; shift 6
matched=0; signal_sent=0
if read_identity "$leader_pid" && test "$current_group" = "$expected_group" && test "$current_identity" = "$leader_start"; then
  matched=1
  for current_pid in $(group_pids "$expected_group"); do
    read_identity "$current_pid" && test "$current_group" = "$expected_group" && emit_target
  done
  if kill "-$requested_signal" -- "-$expected_group" 2>/dev/null; then signal_sent=1; fi
elif test "$allow_leaderless" = 1 && ! read_identity "$expected_group"; then
  anchor=0
  while test "$#" -ge 2; do
    expected_pid=$1; expected_start=$2; shift 2; current_pid=$expected_pid
    if read_identity "$expected_pid" && test "$current_group" = "$expected_group" && test "$current_identity" = "$expected_start"; then anchor=1; fi
  done
  if test "$anchor" = 0; then
    for current_pid in $(group_pids "$expected_group"); do
      if has_cleanup_token "$current_pid" && read_identity "$current_pid" && test "$current_group" = "$expected_group"; then anchor=1; break; fi
    done
  fi
  if test "$anchor" = 1; then
    matched=1
    for current_pid in $(group_pids "$expected_group"); do
      read_identity "$current_pid" && test "$current_group" = "$expected_group" && emit_target
    done
    if kill "-$requested_signal" -- "-$expected_group" 2>/dev/null; then signal_sent=1; fi
  fi
else
  while test "$#" -ge 2; do
    expected_pid=$1; expected_start=$2; shift 2; current_pid=$expected_pid
    if read_identity "$expected_pid" && test "$current_group" = "$expected_group" && test "$current_identity" = "$expected_start"; then
      emit_target; if kill "-$requested_signal" "$expected_pid" 2>/dev/null; then signal_sent=1; fi
    fi
  done
fi
printf 'CODENOMAD_RESULT|%s||%s\n' "$matched" "$signal_sent"
`

const POSIX_OWNED_GROUP_SIGNAL_SCRIPT = String.raw`${POSIX_IDENTITY_FUNCTIONS}
root_pid=$1; requested_signal=$2; matched=0; signal_sent=0
if read_identity "$root_pid" && test "$current_group" = "$root_pid"; then
  matched=1
  for current_pid in $(group_pids "$root_pid"); do
    read_identity "$current_pid" && test "$current_group" = "$root_pid" && emit_target
  done
  if kill "-$requested_signal" -- "-$root_pid" 2>/dev/null; then signal_sent=1; fi
  for current_pid in $(group_pids "$root_pid"); do
    read_identity "$current_pid" && test "$current_group" = "$root_pid" && emit_target
  done
fi
printf 'CODENOMAD_RESULT|%s||%s\n' "$matched" "$signal_sent"
`

const commandError = (result: SpawnSyncReturns<string>): string =>
  result.error?.message || String(result.stderr ?? result.stdout ?? "").trim() || `exit code ${result.status}`

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
    processes.set(pid, { pid, parentPid, groupId: Number.isInteger(groupId) && groupId > 0 ? groupId : pid, startTime,
      ...(bootId ? { bootId } : {}), ...(startOrder ? { startOrder } : {}) })
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

function parsePortablePosixSnapshot(output: string, filter?: PosixProcessFilter): Map<number, ProcessIdentity> | null {
  const processes = new Map<number, ProcessIdentity>()
  const requestedPids = filter?.pids ? new Set(filter.pids) : undefined
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)
    if (!match) {
      const numeric = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+/)
      if (!filter || !numeric || requestedPids?.has(Number(numeric[1])) || Number(numeric[3]) === filter.groupId) return null
      continue
    }
    const [, pidText = "", parentPidText = "", groupIdText = "", start = "", command = ""] = match
    const pid = Number.parseInt(pidText, 10)
    const parentPid = Number.parseInt(parentPidText, 10)
    const groupId = Number.parseInt(groupIdText, 10)
    if (pid <= 0 || parentPid < 0 || groupId <= 0) return null
    if (filter && !requestedPids?.has(pid) && groupId !== filter.groupId) continue
    processes.set(pid, { pid, parentPid, groupId, startTime: `${start}\t${command}` })
  }
  return processes
}

function querySnapshot(
  run: () => SpawnSyncReturns<string>,
  parse: (output: string) => Map<number, ProcessIdentity> | null,
  options: { allowEmpty?: boolean; malformedError?: string; redact?: (error: string) => string } = {},
): ProcessSnapshot {
  const sanitize = options.redact ?? ((error: string) => error)
  try {
    const result = run()
    if (result.status !== 0) return { ok: false, error: sanitize(commandError(result)) }
    const processes = parse(String(result.stdout ?? ""))
    if (processes && (options.allowEmpty || processes.size > 0)) return { ok: true, processes }
    return { ok: false, error: options.malformedError ?? "process identity query returned no parseable processes" }
  } catch (error) {
    return { ok: false, error: sanitize(error instanceof Error ? error.message : String(error)) }
  }
}

function parsePrefixedSnapshot(output: string, prefix: string): Map<number, ProcessIdentity> | null {
  const records: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    if (!line.startsWith(prefix)) return null
    records.push(line.slice(prefix.length))
  }
  return parseDelimitedSnapshot(records.join("\n"), true)
}

function parseGuardedResult(result: SpawnSyncReturns<string>): GuardedSignalResult {
  const signaled = new Map<number, ProcessIdentity>()
  const failure = (error: string): GuardedSignalResult => ({ ok: false, error,
    ...(signaled.size > 0 ? { observed: Array.from(signaled.values()) } : {}) })
  let matched: boolean | undefined
  let signalSent = false
  let cutoff: string | undefined
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith("CODENOMAD_TARGET|") || line.startsWith("CODENOMAD_TARGET_B64|")) {
      const parsed = line.startsWith("CODENOMAD_TARGET_B64|")
        ? parseBase64Snapshot(line, "CODENOMAD_TARGET_B64|")
        : parseDelimitedSnapshot(line.slice("CODENOMAD_TARGET|".length))
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

function runGuardedCommand(run: () => SpawnSyncReturns<string>): GuardedSignalResult {
  try {
    return parseGuardedResult(run())
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const signalName = (signal: NodeJS.Signals): "TERM" | "KILL" => signal === "SIGKILL" ? "KILL" : "TERM"

function runLinuxScript(spawnCommand: SpawnCommand, script: string, args: string[], timeoutMs: number,
  label: string, distro?: string): SpawnSyncReturns<string> {
  return distro
    ? spawnCommand("wsl.exe", ["--distribution", distro, "--exec", "sh", "-c", script, label, ...args], { encoding: "utf8", timeout: timeoutMs })
    : spawnCommand("sh", ["-c", script, label, ...args], { encoding: "utf8", timeout: timeoutMs })
}

const redactToken = (value: string, token: string): string => value.split(token).join("[REDACTED]")

function shellGuardArgs(request: GuardedSignalRequest, linux: boolean): string[] {
  const leader = request.leader
  const args = linux
    ? [String(leader?.pid ?? 0), leader?.startTime ?? "", leader?.bootId ?? "", String(request.groupId ?? 0), signalName(request.signal)]
    : [String(leader?.pid ?? 0), leader?.startTime ?? "", String(request.groupId ?? 0), signalName(request.signal),
        request.allowLeaderlessGroup ? "1" : "0", request.cleanupToken ?? ""]
  for (const member of request.members) {
    args.push(String(member.pid), member.startTime)
    if (linux) args.push(member.bootId ?? "")
  }
  return args
}

const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`

function buildWindowsGuardedScript(request: GuardedSignalRequest): string {
  const leaderPid = request.leader?.pid ?? 0
  const leaderStart = quotePowerShell(request.leader?.startTime ?? "")
  const expected = request.members.map(
    (identity) => `@{ Pid = ${identity.pid}; Start = ${quotePowerShell(identity.startTime)} }`,
  ).join(", ")
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
  return Boolean(left && right && left.pid === right.pid && left.startTime === right.startTime &&
    (!left.bootId || !right.bootId || left.bootId === right.bootId))
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

export function probePosixProcesses(spawnCommand: SpawnCommand, timeoutMs: number,
  platform: NodeJS.Platform = process.platform, filter?: PosixProcessFilter): ProcessSnapshot {
  if (platform === "linux") {
    const pids = filter?.pids?.filter((pid) => Number.isInteger(pid) && pid > 0).map(String) ?? []
    const launchGroupProbe = pids.length === 1 && filter?.groupId === Number(pids[0])
    return querySnapshot(
      () => runLinuxScript(spawnCommand, launchGroupProbe ? LINUX_LAUNCH_GROUP_SNAPSHOT_SCRIPT : LINUX_SNAPSHOT_SCRIPT,
        launchGroupProbe ? pids : [], timeoutMs, "codenomad-posix-identity"),
      (output) => parseDelimitedSnapshot(output, true),
      { allowEmpty: Boolean(filter) },
    )
  }
  // POSIX has no portable pidfd/start ticks; collect one coherent table instead of probing every PID.
  return querySnapshot(
    () => spawnCommand("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,comm="], {
      encoding: "utf8", timeout: timeoutMs, env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }),
    (output) => parsePortablePosixSnapshot(output, filter),
    { allowEmpty: Boolean(filter) },
  )
}

export function probeWindowsProcesses(spawnCommand: SpawnCommand, timeoutMs: number): ProcessSnapshot {
  const script = [
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$all | Where-Object { [int]$_.ProcessId -gt 0 } | ForEach-Object { $start = ([datetime]$_.CreationDate).ToUniversalTime().Ticks.ToString(); '{0}|{1}|0|{2}||{2}' -f [int]$_.ProcessId, [int]$_.ParentProcessId, $start }",
  ].join("; ")
  return querySnapshot(
    () => spawnCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: timeoutMs }),
    parseDelimitedSnapshot,
  )
}

export function probeWslProcesses(spawnCommand: SpawnCommand, distro: string, timeoutMs: number): ProcessSnapshot {
  return querySnapshot(
    () => runLinuxScript(spawnCommand, LINUX_SNAPSHOT_SCRIPT, [], timeoutMs, "codenomad-wsl-identity", distro),
    (output) => parseDelimitedSnapshot(output, true),
  )
}

export function signalPosixProcesses(spawnCommand: SpawnCommand, request: GuardedSignalRequest,
  timeoutMs: number, platform: NodeJS.Platform): GuardedSignalResult {
  const linux = platform === "linux"
  return runGuardedCommand(() => spawnCommand(
    "sh",
    ["-c", linux ? LINUX_GUARDED_SIGNAL_SCRIPT : POSIX_GUARDED_SIGNAL_SCRIPT, "codenomad-guarded-signal", ...shellGuardArgs(request, linux)],
    { encoding: "utf8", timeout: timeoutMs },
  ))
}

export function signalOwnedPosixProcessGroup(spawnCommand: SpawnCommand, rootPid: number,
  signal: NodeJS.Signals, timeoutMs: number): GuardedSignalResult {
  return runGuardedCommand(() => spawnCommand(
    "sh",
    ["-c", POSIX_OWNED_GROUP_SIGNAL_SCRIPT, "codenomad-owned-group-cleanup", String(rootPid), signalName(signal)],
    { encoding: "utf8", timeout: timeoutMs },
  ))
}

export function signalWslProcesses(spawnCommand: SpawnCommand, distro: string,
  request: GuardedSignalRequest, timeoutMs: number): GuardedSignalResult {
  return runGuardedCommand(() => runLinuxScript(
      spawnCommand,
      LINUX_GUARDED_SIGNAL_SCRIPT,
      shellGuardArgs(request, true),
      timeoutMs,
      "codenomad-wsl-guarded-signal",
      distro,
  ))
}

export function signalWindowsProcesses(spawnCommand: SpawnCommand, request: GuardedSignalRequest,
  timeoutMs: number): GuardedSignalResult {
  return runGuardedCommand(() => spawnCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", buildWindowsGuardedScript(request)],
    { encoding: "utf8", timeout: timeoutMs },
  ))
}

export function probeLaunchCleanupToken(spawnCommand: SpawnCommand, token: string,
  timeoutMs: number, distro?: string): ProcessSnapshot {
  return querySnapshot(
    () => runLinuxScript(
      spawnCommand,
      LINUX_TOKEN_SCRIPT,
      [LAUNCH_CLEANUP_TOKEN_ENV, token, ""],
      timeoutMs,
      "codenomad-token-cleanup",
      distro,
    ),
    (output) => parsePrefixedSnapshot(output, "CODENOMAD_PROCESS|"),
    {
      allowEmpty: true,
      malformedError: "launch cleanup probe returned malformed or unexpected output",
      redact: (error) => redactToken(error, token),
    },
  )
}

export function signalLaunchCleanupToken(spawnCommand: SpawnCommand, token: string,
  signal: NodeJS.Signals, timeoutMs: number, distro?: string): TokenSignalResult {
  const failed = (error: string): TokenSignalResult => ({ ok: false, signalSent: false, targets: [], error })
  try {
    const result = runLinuxScript(
      spawnCommand,
      LINUX_TOKEN_SCRIPT,
      [LAUNCH_CLEANUP_TOKEN_ENV, token, signalName(signal)],
      timeoutMs,
      "codenomad-token-cleanup",
      distro,
    )
    if (result.status !== 0) return failed(redactToken(commandError(result), token))
    const lines = String(result.stdout ?? "").split(/\r?\n/).filter(Boolean)
    const resultLines = lines.filter((line) => line.startsWith("CODENOMAD_RESULT|"))
    if (resultLines.length !== 1 || !/^CODENOMAD_RESULT\|[01]$/.test(resultLines[0] ?? "")) {
      return failed("launch cleanup signal returned no valid structured result")
    }
    const targets = parsePrefixedSnapshot(
      lines.filter((line) => !line.startsWith("CODENOMAD_RESULT|")).join("\n"),
      "CODENOMAD_TARGET|",
    )
    return targets
      ? { ok: true, signalSent: resultLines[0]!.endsWith("1"), targets: Array.from(targets.values()) }
      : failed("launch cleanup signal returned malformed or unexpected output")
  } catch (error) {
    return failed(redactToken(error instanceof Error ? error.message : String(error), token))
  }
}
