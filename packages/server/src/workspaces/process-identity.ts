import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"

export type ProcessNamespace = { kind: "host" } | { kind: "wsl"; distro: string }

export interface ProcessIdentity {
  namespace: ProcessNamespace
  pid: number
  start: string
}

export type ProcessIdentityProbe =
  | { status: "found"; identity: ProcessIdentity }
  | { status: "missing" }
  | { status: "unknown" }

export type ProcessIdentityRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>

const runCommand: ProcessIdentityRunner = (command, args, timeoutMs) => new Promise((resolve) => {
  execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
    resolve({ code: error ? typeof error.code === "number" ? error.code : null : 0, stdout })
  })
})

export async function probeProcessStartIdentity(
  pid: number,
  timeoutMs: number,
  namespace: ProcessNamespace = { kind: "host" },
  runner: ProcessIdentityRunner = runCommand,
): Promise<ProcessIdentityProbe> {
  if (!Number.isInteger(pid) || pid <= 0 || timeoutMs <= 0) return { status: "unknown" }
  if (namespace.kind === "wsl") {
    const result = await runner("wsl.exe", [
      "--distribution", namespace.distro,
      "--exec", "sh", "-c",
      'test -r "/proc/$1/stat" || exit 3; cat "/proc/$1/stat"; cat /proc/sys/kernel/random/boot_id',
      "codenomad-process-probe", String(pid),
    ], timeoutMs).catch(() => ({ code: null, stdout: "" }))
    if (result.code === 3) return { status: "missing" }
    const [stat, bootId] = result.stdout.trim().split(/\r?\n/)
    const start = result.code === 0 && stat && bootId ? linuxStart(stat, bootId) : undefined
    return start
      ? { status: "found", identity: { namespace, pid, start } }
      : { status: "unknown" }
  }

  try {
    if (process.platform === "linux") {
      const signal = AbortSignal.timeout(timeoutMs)
      const stat = await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal })
      const bootId = (await readFile("/proc/sys/kernel/random/boot_id", { encoding: "utf8", signal })).trim()
      const start = linuxStart(stat, bootId)
      return start ? { status: "found", identity: { namespace, pid, start } } : { status: "unknown" }
    }
    if (process.platform === "darwin") {
      return commandProbe(runner, "ps", ["-p", String(pid), "-o", "lstart="], namespace, pid, timeoutMs)
    }
    if (process.platform === "win32") {
      return commandProbe(runner, "powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; if (!$p) { exit 3 }; $p.CreationDate.ToUniversalTime().Ticks`,
      ], namespace, pid, timeoutMs)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
  }
  return { status: "unknown" }
}

export async function getProcessStartIdentity(
  pid: number,
  timeoutMs: number,
  namespace: ProcessNamespace = { kind: "host" },
  runner?: ProcessIdentityRunner,
): Promise<ProcessIdentity | undefined> {
  const probe = await probeProcessStartIdentity(pid, timeoutMs, namespace, runner)
  return probe.status === "found" ? probe.identity : undefined
}

function linuxStart(stat: string, bootId: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")")
  const startTicks = commandEnd < 0 ? undefined : stat.slice(commandEnd + 1).trim().split(/\s+/)[19]
  return startTicks && bootId ? `${bootId}:${startTicks}` : undefined
}

async function commandProbe(
  runner: ProcessIdentityRunner,
  command: string,
  args: string[],
  namespace: ProcessNamespace,
  pid: number,
  timeoutMs: number,
): Promise<ProcessIdentityProbe> {
  const result = await runner(command, args, timeoutMs).catch(() => ({ code: null, stdout: "" }))
  if (result.code === 3) return { status: "missing" }
  const start = result.code === 0 ? result.stdout.trim() : ""
  return start ? { status: "found", identity: { namespace, pid, start } } : { status: "unknown" }
}
