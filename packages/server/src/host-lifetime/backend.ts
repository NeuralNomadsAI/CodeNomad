import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { HostError, localOrigin, MAX_BYTES, TIMEOUT_MS, type NativeCall } from "./protocol"
import { lookupProcess, type ProcessLookup } from "./process-identity"
import type { BootstrapProofs } from "./bootstrap"
import type { NativeRuntimeCapability } from "./native-runtime"
import { NativeDeadline } from "./native-deadline"

export interface BackendChannelGuard {
  beginShutdown(): void
  close(): void
}
let channelGuard: BackendChannelGuard | undefined
/** One guard shared by the import wrapper and the initialized backend. Unexpected
 * manager loss remains fatal throughout initialization and graceful cleanup. */
export function installBackendChannelGuard(): BackendChannelGuard {
  if (channelGuard) return channelGuard
  if (!process.send || !process.connected || process.env.CODENOMAD_HOST_CHILD !== "1"
    || process.env.CODENOMAD_NATIVE_PARENT !== "1") throw new HostError("manager-channel-required")
  let shuttingDown = false
  const disconnected = () => process.exit(1)
  const ended = () => { if (!shuttingDown) process.exit(1) }
  process.once("disconnect", disconnected)
  process.stdin.once("end", ended)
  channelGuard = {
    beginShutdown() { shuttingDown = true },
    close() {
      shuttingDown = true
      process.off("disconnect", disconnected)
      process.stdin.off("end", ended)
      if (process.connected) process.disconnect()
    },
  }
  return channelGuard
}
/** Integration installs this BEFORE backend readiness, passing attachment proof
 * bookkeeping over the same AuthManager used by its existing bootstrap route. */
export function installBackendHostLifetime(proofs: BootstrapProofs, origin: string): BackendChannelGuard {
  const guard = installBackendChannelGuard()
  localOrigin(origin)
  let accepting = true
  const onMessage = (message: unknown) => {
    const value = message as { host?: number; id?: string; method?: string; windowId?: string }
    if (!value || value.host !== 1 || typeof value.id !== "string" || value.id.length > 128
      || typeof value.windowId !== "string" || value.windowId.length > 128) return
    try {
      if (!accepting) throw new HostError("backend-shutting-down")
      if (value.method === "proof") process.send?.({ host: 1, id: value.id, result: proofs.issue(value.windowId) })
      else if (value.method === "revoke") { proofs.revoke(value.windowId); process.send?.({ host: 1, id: value.id, result: true }) }
    } catch { process.send?.({ host: 1, id: value.id, error: "bootstrap-unavailable" }) }
  }
  process.on("message", onMessage)
  process.send!({ host: 1, ready: true, origin: localOrigin(origin) })
  return {
    beginShutdown() { accepting = false; guard.beginShutdown() },
    close() { accepting = false; proofs.revokeAll(); process.off("message", onMessage); guard.close() },
  }
}
export interface BackendLaunch { file: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export class BackendProcess {
  readonly child: ChildProcess
  private buffer = ""
  private shutdownStatus: "complete" | "incomplete" | undefined
  private readonly closed: Promise<void>
  private stopCompletion?: Promise<void>
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  readonly ready: Promise<{ origin: string; pid: number; startIdentity: string }>
  constructor(launch: BackendLaunch, route: (call: NativeCall) => Promise<unknown>, lookup: ProcessLookup = lookupProcess,
    runtime?: NativeRuntimeCapability) {
    // One inherited runtime admission budget includes process lookup, S member
    // query, native verification, correlated Auth gate and readiness identity.
    const admissionBudget = runtime ? new NativeDeadline(TIMEOUT_MS) : undefined
    const readyBudget = new NativeDeadline(15_000, admissionBudget?.expires)
    this.child = spawn(launch.file, launch.args, { cwd: launch.cwd, env: { ...launch.env,
      CODENOMAD_NATIVE_PARENT: "1", CODENOMAD_HOST_CHILD: "1", CODENOMAD_RUNTIME_ADMISSION: runtime ? "1" : "0" },
      stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true, shell: false })
    const child = this.child
    const admission = new Promise<void>((resolve, reject) => {
      if (!runtime) { resolve(); return }
      child.once("error", () => reject(new HostError("native-runtime-backend-denied")))
      child.once("exit", () => reject(new HostError("native-runtime-backend-denied")))
      child.once("spawn", () => {
        void (async () => {
          const identity = await admissionBudget!.observe(() => lookup(child.pid!))
          if (identity.state !== "live") throw new HostError("backend-identity-unavailable")
          await runtime.admitBackend(child, identity.startIdentity, admissionBudget!.expires)
          admissionBudget!.check()
        })().then(resolve, () => reject(new HostError("native-runtime-backend-denied")))
      })
    })
    // The wrapper asks over real Node IPC BEFORE importing index/AuthManager.
    // This flag requests gating only; the authenticated native membership receipt
    // and exact child birth comparison, not a flag, authorize the reply.
    child.on("message", (input: unknown) => {
      const value = input as { hostRuntimeAdmission?: number; nonce?: string }
      if (!runtime || !value || value.hostRuntimeAdmission !== 1 || typeof value.nonce !== "string"
        || !/^[a-f0-9]{64}$/.test(value.nonce)) return
      void admission.then(() => {
        admissionBudget!.check()
        if (child.connected) child.send({ hostRuntimeAdmission: 1, nonce: value.nonce, admitted: true,
          deadline: admissionBudget!.expires }, () => undefined)
      }, () => { child.stdin?.destroy(); if (child.connected) child.disconnect() })
        .catch(() => { child.stdin?.destroy(); if (child.connected) child.disconnect() })
    })
    void admission.catch(() => { child.stdin?.destroy(); if (child.connected) child.disconnect() })
    this.closed = new Promise(resolve => child.once("close", () => resolve()))
    child.stdin?.on("error", () => undefined)
    // Deliberately no raw stdout/stderr logger: bootstrap/auth/environment output
    // is private. Integration may supply a separately redacted diagnostic sink.
    child.stderr?.resume()
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString()
      if (Buffer.byteLength(this.buffer) > MAX_BYTES) { child.stdout?.destroy(); child.stdin?.destroy(); return }
      let end: number
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1)
        if (line === "CODENOMAD_SHUTDOWN_STATUS:incomplete") { this.shutdownStatus = "incomplete"; continue }
        if (line === "CODENOMAD_SHUTDOWN_STATUS:complete") {
          if (this.shutdownStatus !== "incomplete") this.shutdownStatus = "complete"
          continue
        }
        if (!line.startsWith("CODENOMAD_NATIVE_REQUEST:")) continue
        try {
          const call = JSON.parse(line.slice("CODENOMAD_NATIVE_REQUEST:".length)) as NativeCall & { v: number }
          if (call.v !== 1 || typeof call.id !== "string" || typeof call.method !== "string" || !Number.isSafeInteger(call.deadline)) continue
          void route(call).then(result => this.respond(call.id, { ok: true, result }), error => this.respond(call.id,
            { ok: false, error: { code: error instanceof HostError ? error.code : "native-unavailable", message: "Native capability unavailable" } }))
        } catch { /* malformed control line never enters routing */ }
      }
    })
    child.on("message", (message: unknown) => {
      const value = message as { host?: number; id?: string; result?: unknown; error?: string }
      if (!value || value.host !== 1 || typeof value.id !== "string") return
      const pending = this.pending.get(value.id)
      if (!pending) return
      this.pending.delete(value.id); clearTimeout(pending.timer)
      if (value.error) pending.reject(new HostError("bootstrap-unavailable")); else pending.resolve(value.result)
    })
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HostError("backend-readiness-timeout")), Math.max(0, readyBudget.expires - Date.now()))
      const fail = () => { clearTimeout(timer); reject(new HostError("backend-exited")) }
      child.once("error", fail); child.once("exit", fail)
      const message = async (input: unknown) => {
        const value = input as { host?: number; ready?: boolean; origin?: string }
        if (!value || value.host !== 1 || value.ready !== true) return
        child.off("message", message)
        try {
          const origin = localOrigin(value.origin!)
          const identity = await readyBudget.observe(() => lookup(child.pid!))
          if (identity.state !== "live") throw new HostError("backend-identity-unavailable")
          await admission
          readyBudget.check()
          if (child.exitCode !== null || child.signalCode !== null) throw new HostError("backend-exited")
          clearTimeout(timer); child.off("error", fail); child.off("exit", fail)
          resolve({ origin, pid: child.pid!, startIdentity: identity.startIdentity })
        } catch { fail() }
      }
      child.on("message", message)
    })
    child.once("exit", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new HostError("backend-exited")) }
      this.pending.clear()
    })
  }
  request(method: "proof" | "revoke", windowId: string): Promise<unknown> {
    if (this.stopCompletion) return Promise.reject(new HostError("backend-shutting-down"))
    if (this.pending.size >= 128 || !this.child.connected) return Promise.reject(new HostError("backend-unavailable"))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HostError("backend-request-timeout")) }, TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.child.send({ host: 1, id, method, windowId }, error => {
        if (error) { this.pending.delete(id); clearTimeout(timer); reject(new HostError("backend-unavailable")) }
      })
    })
  }
  private respond(id: string, result: object): void {
    if (this.child.stdin?.writable) this.child.stdin.write(`CODENOMAD_NATIVE_RESPONSE:${JSON.stringify({ v: 1, id, ...result })}\n`)
  }
  async stop(observerMs = TIMEOUT_MS - 1_000): Promise<void> {
    if (!Number.isSafeInteger(observerMs) || observerMs <= 0 || observerMs > TIMEOUT_MS - 1_000)
      throw new HostError("invalid-stop-deadline")
    if (!this.stopCompletion) {
      // This completion survives observer timeouts. Close drains the private
      // stdout handshake; no retry or concurrent observer ever resends shutdown.
      this.stopCompletion = this.closed.then(() => this.confirmStop())
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin?.write("codenomad:shutdown\n")
    }
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HostError("backend-stop-unconfirmed")), observerMs)
    })
    try { await Promise.race([this.stopCompletion, timeout]) } finally { clearTimeout(timer) }
    // Never PID-kill or traverse descendants. Native containment owns forced cleanup.
  }
  private confirmStop(): void {
    if (this.child.exitCode !== 0 || this.child.signalCode !== null || this.shutdownStatus !== "complete")
      throw new HostError("backend-stop-unconfirmed")
  }
}
