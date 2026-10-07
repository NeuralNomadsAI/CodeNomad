import { randomBytes, randomUUID } from "node:crypto"
import { HostStorage } from "./storage"
import { lookupProcess, ownerState, type ProcessLookup } from "./process-identity"
import { HostError, type Attachment, type NativeCall, type Registration } from "./protocol"
import { hostRequest } from "./transport"

type CorrelatedNativeCall = NativeCall & { requestToken: string }
export interface AttachOptions {
  storage: HostStorage
  /** Native launcher must start the packaged manager independently of UI lifetime.
   * Called only after authoritative owner validation; no secret in argv. */
  launch(): Promise<void>
  lookup?: ProcessLookup
  windowId?: string
  deadlineMs?: number
}
export class HostLifetimeClient {
  private closed = false
  private detachment?: Promise<void>
  private polling = false
  constructor(private readonly registration: Registration, private readonly secret: string, readonly attachment: Attachment) {}
  private request<T>(route: string, body: unknown): Promise<T> {
    return hostRequest(this.registration.controlOrigin, this.secret, this.registration.scope.key, this.registration.generation, route, body)
  }
  status(): Promise<{ generation: string; backendPid: number; automationAvailable: false | "attached-window" }> {
    return this.request("/status", {})
  }
  detach(): Promise<void> {
    if (!this.detachment) {
      // Fence local polling immediately, but retain the actual ACK/failure for
      // every observer. An uncertain detach is never replayed or called success.
      this.closed = true
      this.detachment = Promise.resolve().then(() => this.request<{ detached: true }>("/detach", this.windowBody())).then(result => {
        if (result?.detached !== true) throw new HostError("host-detach-unconfirmed")
      })
    }
    return this.detachment
  }
  stopAuthority(): Promise<{ stopped: true }> { return this.request("/stop", { intent: "stop-profile-backend" }) }
  /** Native desktop only. Abort/detach fences replies; no UI cookie is involved. */
  async serveNative(handler: (call: NativeCall) => Promise<unknown>, signal: AbortSignal): Promise<void> {
    if (this.polling) throw new HostError("native-poll-already-running")
    this.polling = true
    try {
      while (!this.closed && !signal.aborted) {
        const result = await this.request<{ calls: CorrelatedNativeCall[] }>("/poll", this.windowBody())
        for (const call of result.calls) {
          if (this.closed || signal.aborted) break
          if (call.deadline <= Date.now() || typeof call.requestToken !== "string" || !/^[a-f0-9]{64}$/.test(call.requestToken)) continue
          // Do not let a slow native handler prevent heartbeat or other requests.
          void Promise.resolve().then(() => {
            if (this.closed || signal.aborted || call.deadline <= Date.now()) throw new HostError("native-expired")
            return handler(call)
          }).then(value => this.returnResult(call, true, value, signal), () => this.returnResult(call, false, undefined, signal))
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } finally { this.polling = false }
  }
  private async returnResult(call: CorrelatedNativeCall, ok: boolean, result: unknown, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted || call.deadline <= Date.now()) return
    await this.request("/result", { ...this.windowBody(), id: call.id, requestToken: call.requestToken, ok, result }).catch(() => undefined)
  }
  private windowBody(): object { return { windowId: this.attachment.windowId, capability: this.attachment.capability } }
  static async attach(options: AttachOptions): Promise<HostLifetimeClient> {
    const storage = options.storage
    const lookup = options.lookup ?? lookupProcess
    await storage.initialize()
    const deadline = Date.now() + (options.deadlineMs ?? 20_000)
    let launched = false
    while (Date.now() < deadline) {
      const registration = await storage.registration()
      if (registration !== undefined) {
        const state = await ownerState(registration.owner, lookup)
        if (state === "unknown") throw new HostError("unknown-owner")
        if (state === "live") {
          const secret = await storage.secret(registration.generation)
          // Live/unreachable/authentication failure NEVER becomes election.
          const attachment = await hostRequest<Attachment>(registration.controlOrigin, secret, storage.scope.key,
            registration.generation, "/attach", { windowId: options.windowId ?? randomUUID(), clientNonce: randomBytes(32).toString("hex") })
          if (attachment.generation !== registration.generation || attachment.managerPid !== registration.owner.pid
            || attachment.backendPid !== registration.backend.pid || attachment.origin !== registration.origin)
            throw new HostError("host-identity-mismatch")
          return new HostLifetimeClient(registration, secret, attachment)
        }
      }
      const owner = await storage.ownerRecord()
      if (owner !== undefined) {
        const state = await ownerState(owner.owner, lookup)
        if (state === "unknown") throw new HostError("unknown-owner")
        // Live owner may still be initializing: wait, do not launch a rival.
        if (state === "live") { await delay(50); continue }
      }
      if (!launched) { launched = true; await options.launch() }
      await delay(50)
    }
    throw new HostError("host-readiness-timeout")
  }
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
