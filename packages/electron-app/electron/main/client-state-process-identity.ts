import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

export type ProcessStartIdentityLookup = (pid: number) => string | undefined

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
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        "win32",
      )
    }
  } catch {
    // Identity lookup is best-effort; callers preserve election safety when it is unavailable.
  }

  return undefined
}
