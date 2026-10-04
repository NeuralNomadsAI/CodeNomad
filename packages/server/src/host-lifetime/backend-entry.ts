import { pathToFileURL } from "node:url"
import path from "node:path"
import { installBackendChannelGuard } from "./backend"
import { HostError } from "./protocol"
import { randomBytes } from "node:crypto"
import { NativeDeadline } from "./native-deadline"

// Stable manager child entry. The full backend installs its auth/readiness hook;
// this guard is installed before importing any backend initialization code.
try {
  installBackendChannelGuard()
  let admittedUntil: NativeDeadline | undefined
  if (process.env.CODENOMAD_RUNTIME_ADMISSION === "1") {
    const nonce = randomBytes(32).toString("hex")
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new HostError("native-runtime-admission-timeout")), 10_000)
      const onMessage = (input: unknown) => {
        const value = input as { hostRuntimeAdmission?: number; nonce?: string; admitted?: boolean; deadline?: number }
        if (!value || value.hostRuntimeAdmission !== 1 || value.nonce !== nonce || value.admitted !== true) return
        try {
          if (!Number.isSafeInteger(value.deadline)) throw new HostError("native-runtime-admission-denied")
          admittedUntil = new NativeDeadline(10_000, value.deadline)
        } catch {
          clearTimeout(timeout); process.off("message", onMessage); reject(new HostError("native-runtime-admission-denied")); return
        }
        clearTimeout(timeout); process.off("message", onMessage); resolve()
      }
      process.on("message", onMessage)
      process.send!({ hostRuntimeAdmission: 1, nonce }, undefined, undefined,
        (error: Error | null) => { if (error) reject(new HostError("native-runtime-admission-denied")) })
    })
  }
  const entry = process.env.CODENOMAD_HOST_BACKEND_ENTRY
  admittedUntil?.check()
  // bin.js is a spawning CLI launcher, not an importable backend. Older managed
  // entrypoints must not accidentally launch an unmanaged descendant on import.
  if (!entry || !path.isAbsolute(entry) || !/^index\.(js|ts)$/.test(path.basename(entry))) throw new HostError("unsupported-backend-entry")
  const backend = await import(pathToFileURL(entry).href)
  admittedUntil?.check()
  if (backend.HOST_BACKEND_ENTRY_VERSION !== 1 || typeof backend.runBackendMain !== "function")
    throw new HostError("unsupported-backend-entry")
  await backend.runBackendMain(process.argv.slice(2))
} catch {
  // Do not print module/config/auth/environment failures over host logs.
  process.exit(1)
}
