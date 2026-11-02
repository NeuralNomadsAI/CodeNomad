import { execFile, spawn } from "node:child_process"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { SupervisionError } from "./service-supervision-contract"
import type { ProcessState } from "./process-identity"
import { privateStorage, type StoragePolicy } from "./storage"

export const macosNativeHelper = () => fileURLToPath(new URL("../../dist/host-lifetime/service-supervision-macos-native", import.meta.url))

export function lookupMacosProcess(pid: number, helper = macosNativeHelper()): Promise<ProcessState> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve({ state: "unknown" })
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

/** Descriptor ownership is released by the kernel after helper/caller death.
 * The file descriptor crosses spawn, never an unverified pathname reopen. */
export async function withMacosSupervisionLock<T>(file: string, run: () => Promise<T>, policy: StoragePolicy = privateStorage,
  helper = macosNativeHelper()): Promise<T> {
  const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    await policy.verify(file, false)
    const child = spawn(helper, ["lock", "3"], { stdio: ["pipe", "pipe", "ignore", handle.fd], env: { PATH: "/usr/bin:/bin" } })
    child.stdin!.on("error", () => {})
    const exited = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()) })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.stdin!.end(); reject(new SupervisionError("busy")) }, 3000)
        child.once("error", () => { clearTimeout(timer); reject(new SupervisionError("busy")) })
        child.once("exit", () => { clearTimeout(timer); reject(new SupervisionError("busy")) })
        child.stdout!.once("data", bytes => { clearTimeout(timer); bytes.toString() === "ready" ? resolve() : reject(new SupervisionError("busy")) })
      })
      return await run()
    } finally { child.stdin!.end(); await exited }
  } finally { await handle.close() }
}
