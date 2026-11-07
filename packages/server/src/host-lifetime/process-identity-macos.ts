import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { ProcessState } from "./process-identity"

export const macosIdentityHelper = () => fileURLToPath(new URL("../../dist/host-lifetime/process-identity-macos", import.meta.url))

export function lookupMacosProcess(pid: number, helper = macosIdentityHelper()): Promise<ProcessState> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve({ state: "unknown" })
  // console-window: macOS only.
  return new Promise(resolve => execFile(helper, ["identity", String(pid)], { timeout: 3000, maxBuffer: 1024 }, (error, stdout) => {
    try {
      if (error) throw error
      const value = JSON.parse(stdout)
      if (value.state === "dead" || value.state === "unknown") return resolve({ state: value.state })
      if (value.state === "live" && /^darwin:\d+:\d+$/.test(value.startIdentity)) return resolve(value)
    } catch { /* Missing helper or incomplete native evidence stays unknown. */ }
    resolve({ state: "unknown" })
  }))
}
