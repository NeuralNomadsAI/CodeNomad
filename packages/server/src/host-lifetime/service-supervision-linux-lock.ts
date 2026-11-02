import { spawn } from "node:child_process"
import { open } from "node:fs/promises"
import { SupervisionError } from "./service-supervision-contract"
import { privateStorage, type StoragePolicy } from "./storage"

/** flock owns an advisory descriptor, released even when this process crashes.
 * stdin EOF releases the helper; no PID/time-based abandoned-lock stealing. */
export async function withLinuxSupervisionLock<T>(file: string, run: () => Promise<T>, policy: StoragePolicy = privateStorage): Promise<T> {
  const handle = await open(file, "a", 0o600)
  await handle.close()
  await policy.verify(file, false)
  const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", file, "/bin/sh", "-c", "printf ready; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "C" } })
  child.stdin.on("error", () => {})
  const exited = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()) })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.stdin.end(); reject(new SupervisionError("busy")) }, 3000)
      child.once("error", () => { clearTimeout(timer); reject(new SupervisionError("busy")) })
      child.once("exit", () => { clearTimeout(timer); reject(new SupervisionError("busy")) })
      child.stdout.once("data", bytes => { clearTimeout(timer); bytes.toString() === "ready" ? resolve() : reject(new SupervisionError("busy")) })
    })
    return await run()
  } finally { child.stdin.end(); await exited }
}
