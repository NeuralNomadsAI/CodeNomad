import { execFile, spawnSync } from "node:child_process"
import { readFile as readFileAsync } from "node:fs/promises"
import { readFileSync, readlinkSync } from "node:fs"
import { basename, resolve } from "node:path"

export type ProcessStartIdentityLookup = (pid: number) => string | undefined
export type AsyncProcessStartIdentityLookup = (pid: number, timeoutMs: number) => Promise<string | undefined> | string | undefined
export type ExpectedProcessLookup = (pid: number) => boolean | undefined

function readLinuxProcessStartIdentity(pid: number): string | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  const commandEnd = stat.lastIndexOf(")")
  if (commandEnd < 0) return undefined

  // Fields after the command begin with field 3; process start time is field 22.
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/)
  const startTicks = fields[19]
  if (!startTicks) return undefined

  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  return bootId ? `linux:${bootId}:${startTicks}` : undefined
}

function readCommandIdentity(command: string, args: string[], prefix: string): string | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    })
    if (result.status === 0 && !result.error) {
      const value = result.stdout.trim()
      if (value) return `${prefix}:${value}`
    }
  }
  return undefined
}

function readCommandIdentityAsync(command: string, args: string[], prefix: string, timeoutMs: number): Promise<string | undefined> {
  if (timeoutMs <= 0) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      const value = error ? "" : stdout.trim()
      resolve(value ? `${prefix}:${value}` : undefined)
    })
  })
}

export function getProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined

  try {
    if (process.platform === "linux") {
      return readLinuxProcessStartIdentity(pid)
    }
    if (process.platform === "darwin") {
      return readCommandIdentity("ps", ["-p", String(pid), "-o", "lstart="], "darwin")
    }
    if (process.platform === "win32") {
      return readCommandIdentity(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop).CreationDate.ToUniversalTime().Ticks`,
        ],
        "win32",
      )
    }
  } catch {
    // Identity lookup is best-effort; callers preserve election safety when it is unavailable.
  }

  return undefined
}

export async function getProcessStartIdentityAsync(
  pid: number,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0 || timeoutMs <= 0) return undefined
  try {
    if (platform === "linux") {
      const signal = AbortSignal.timeout(timeoutMs)
      const stat = await readFileAsync(`/proc/${pid}/stat`, { encoding: "utf8", signal })
      const commandEnd = stat.lastIndexOf(")")
      const startTicks = commandEnd < 0 ? undefined : stat.slice(commandEnd + 1).trim().split(/\s+/)[19]
      if (!startTicks) return undefined
      const bootId = (await readFileAsync("/proc/sys/kernel/random/boot_id", { encoding: "utf8", signal })).trim()
      return bootId ? `linux:${bootId}:${startTicks}` : undefined
    }
    if (platform === "darwin") {
      return readCommandIdentityAsync("ps", ["-p", String(pid), "-o", "lstart="], "darwin", timeoutMs)
    }
    if (platform === "win32") {
      return readCommandIdentityAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop).CreationDate.ToUniversalTime().Ticks`,
      ], "win32", timeoutMs)
    }
  } catch {
    // Identity lookup is best-effort; callers refuse destructive actions when it is unavailable.
  }
  return undefined
}

export function isExpectedTauriProcess(pid: number): boolean | undefined {
  try {
    const executable = process.platform === "linux"
      ? readlinkSync(`/proc/${pid}/exe`)
      : readCommandIdentity(
          process.platform === "win32" ? "powershell.exe" : "ps",
          process.platform === "win32"
            ? ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).Path`]
            : ["-p", String(pid), "-o", "comm="],
          "path",
        )?.slice(5)
    if (!executable) return undefined
    if (resolve(executable).toLowerCase() === resolve(process.execPath).toLowerCase()) return false
    return ["codenomad", "codenomad.exe", "codenomad-tauri", "codenomad-tauri.exe"]
      .includes(basename(executable).toLowerCase())
  } catch {
    return undefined
  }
}
