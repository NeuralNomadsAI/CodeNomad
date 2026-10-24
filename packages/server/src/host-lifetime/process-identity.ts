import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { validateOwner, type Owner } from "./protocol"

export type ProcessState = { state: "live"; startIdentity: string } | { state: "dead" | "unknown" }
export type ProcessLookup = (pid: number) => Promise<ProcessState>
/** Same native start-time shape as Electron, but absence and lookup failure are distinct. */
export const lookupProcess: ProcessLookup = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" }
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8")
      const ticks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]
      const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
      return ticks && boot ? { state: "live", startIdentity: `linux:${boot}:${ticks}` } : { state: "unknown" }
    } catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "dead" : "unknown" } }
  }
  if (process.platform === "win32") {
    // Absence is a specific native lookup result, not any suppressed lookup
    // error. Permission/host failures cannot authorize replacing an owner.
    const script = `try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); try { 'LIVE:' + $p.StartTime.ToUniversalTime().Ticks } catch { 'UNKNOWN' } } catch [System.ArgumentException] { 'DEAD' } catch { 'UNKNOWN' }`
    return command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], "win32")
  }
  // ps lstart has only second resolution. It is not a production identity gate.
  return { state: "unknown" }
}
function command(file: string, args: string[], prefix: string): Promise<ProcessState> {
  return new Promise(resolve => execFile(file, args, { timeout: 3_000, windowsHide: true, maxBuffer: 4096 }, (error, stdout) => {
    const result = error ? "UNKNOWN" : stdout.trim()
    resolve(result === "DEAD" ? { state: "dead" } : /^LIVE:\d+$/.test(result)
      ? { state: "live", startIdentity: `${prefix}:${result.slice(5)}` } : { state: "unknown" })
  }))
}
export async function ownerState(owner: Owner, lookup: ProcessLookup): Promise<"live" | "dead" | "unknown"> {
  validateOwner(owner)
  const found = await lookup(owner.pid)
  return found.state === "live" ? found.startIdentity === owner.startIdentity ? "live" : "dead" : found.state
}
