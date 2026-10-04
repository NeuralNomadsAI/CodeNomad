import { createServer, type ServerResponse } from "node:http"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { BackendProcess, type BackendLaunch } from "./backend"
import { HostStorage } from "./storage"
import { lookupProcess, type ProcessLookup } from "./process-identity"
import { HostError, MAX_BYTES, TIMEOUT_MS, type Attachment, type NativeCall, type Registration } from "./protocol"
import { readBody } from "./transport"
import { NativeRuntimeCapability } from "./native-runtime"

const PRIVATE_FIXTURE = Symbol("unqualified-private-manager-fixture")

interface QueuedNativeCall extends NativeCall { requestToken: string }
interface WindowCapability { secret: string; expires: number; queue: QueuedNativeCall[] }
interface PendingNative {
  windowId: string; capability: string; call: QueuedNativeCall; delivered: boolean
  resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout
}
export interface ManagerOptions {
  storage: HostStorage
  backend: BackendLaunch
  lookup?: ProcessLookup
  /** Opaque, native-binding-minted owner/Job/outside-service authority. Windows
   * requires this; callbacks, environment and renderer JSON cannot qualify it. */
  runtime?: NativeRuntimeCapability
  /** Must launch official service starter outside backend containment. */
  startService?: (params: unknown, deadline: number) => Promise<unknown>
}
export class HostLifetimeManager {
  readonly generation: string
  private readonly secret = randomBytes(32).toString("hex")
  private readonly windows = new Map<string, WindowCapability>()
  private readonly pending = new Map<string, PendingNative>()
  private backend?: BackendProcess
  private registration?: Registration
  private stopping = false
  private draining = false
  private stopOperation?: Promise<{ stopped: true }>
  private claimed = false
  private requests = 0
  private leaseTimer?: NodeJS.Timeout
  private readonly fixture: boolean
  private runtimeFinalized = false
  private readonly server = createServer((request, response) => {
    if (this.draining) {
      response.setHeader("connection", "close")
      this.reply(response, 503, { code: "host-not-ready" })
      return
    }
    if (this.requests >= 64) { this.reply(response, 503, { code: "host-capacity" }); return }
    this.requests++
    const finish = () => { this.requests--; response.off("close", finish) }
    response.once("close", finish)
    void (async () => {
      try {
        const supplied = request.headers.authorization
        const expected = `Bearer ${this.secret}`
        if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.origin || request.method !== "POST"
          || typeof supplied !== "string" || supplied.length !== expected.length
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
          || request.headers["x-host-scope"] !== this.options.storage.scope.key
          || request.headers["x-host-generation"] !== this.generation) throw new HostError("host-auth-required")
        if (!this.registration || (this.stopping && request.url !== "/stop")) throw new HostError("host-not-ready")
        const body = await readBody(request) as Record<string, unknown>
        if (!body || Array.isArray(body) || typeof body !== "object") throw new HostError("invalid-request")
        // Stop observers settle in four seconds, before the client's five-second
        // wire deadline. Only this route gets a longer inactivity allowance.
        if (request.url === "/stop") request.socket.setTimeout(TIMEOUT_MS + 1_000)
        const result = await this.dispatch(request.url!, body)
        this.reply(response, 200, result)
        if (request.url === "/stop") this.drainControlServer()
      } catch (error) {
        this.reply(response, 503, { code: error instanceof HostError ? error.code : "host-request-failed" })
      }
    })()
  })
  constructor(private readonly options: ManagerOptions, privateFixtureToken?: symbol) {
    this.fixture = privateFixtureToken === PRIVATE_FIXTURE
    if (options.runtime) NativeRuntimeCapability.assert(options.runtime, this.fixture)
    if (process.platform === "win32" && !this.fixture && !options.runtime) throw new HostError("native-runtime-capability-required")
    if (options.runtime && options.startService) throw new HostError("native-runtime-service-override-forbidden")
    this.generation = options.runtime?.launch.generation ?? randomUUID()
    this.server.requestTimeout = 5_000
    this.server.headersTimeout = 5_000
    this.server.timeout = 5_000
    this.server.maxHeadersCount = 16
  }
  async start(): Promise<boolean> {
    const lookup = this.options.lookup ?? lookupProcess
    await this.options.storage.initialize()
    const identity = await lookup(process.pid)
    if (identity.state !== "live") throw new HostError("manager-identity-unavailable")
    const runtime = this.options.runtime
    if (runtime) {
      runtime.assertFor(this.options.storage.scope, this.generation, identity.startIdentity, this.fixture)
      runtime.assertLaunch(this.options.storage.directory, this.options.backend)
      runtime.onLoss(() => { if (!this.runtimeFinalized) this.failRuntime("owner-lost") })
    }
    const owner = { pid: process.pid, startIdentity: identity.startIdentity }
    this.claimed = await this.options.storage.claim(owner, this.generation, lookup)
    if (!this.claimed) {
      if (runtime) this.finalizeRuntime("election-lost")
      return false
    }
    try {
      // No await/spawn occurs between this fresh native no-breakaway/sole-owner
      // query and Node.spawn. Containment exists at creation by OS inheritance.
      if (runtime) await runtime.beforeSpawn()
      this.backend = new BackendProcess(this.options.backend, call => this.route(call), lookup, runtime)
      this.backend.child.once("exit", () => {
        if (!this.stopping) {
          this.failRuntime("backend-exit")
        }
      })
      const ready = await this.backend.ready
      if (this.stopping) throw new HostError("host-not-ready")
      await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve) })
      if (this.stopping) throw new HostError("host-not-ready")
      const address = this.server.address()
      if (!address || typeof address === "string") throw new HostError("control-listen-failed")
      this.registration = { v: 1, scope: this.options.storage.scope, generation: this.generation, owner,
        backend: { pid: ready.pid, startIdentity: ready.startIdentity }, origin: ready.origin,
        controlOrigin: `http://127.0.0.1:${address.port}` }
      await this.options.storage.atomic(`${this.generation}.secret`, this.secret)
      if (this.stopping) throw new HostError("host-not-ready")
      await this.options.storage.atomic("host.json", this.registration)
      if (this.stopping) throw new HostError("host-not-ready")
      this.leaseTimer = setInterval(() => this.expire(), 1_000)
      this.leaseTimer.unref()
      return true
    } catch (error) {
      this.stopping = true
      clearInterval(this.leaseTimer)
      this.server.close(); this.server.closeAllConnections()
      // Do not publish/release an unconfirmed child. Disconnect invokes its guard.
      this.backend?.child.stdin?.destroy()
      if (this.backend?.child.connected) this.backend.child.disconnect()
      if (runtime) this.finalizeRuntime("startup-failed")
      throw error
    }
  }
  private reply(response: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body)
    if (Buffer.byteLength(data) > MAX_BYTES) { response.writeHead(503).end('{"code":"response-too-large"}'); return }
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(data)
  }
  private drainControlServer(): void {
    if (this.draining) return
    this.draining = true
    // Reject new admission immediately, but preserve authenticated observers
    // already reading their body. They share the completed Stop and release.
    const deadline = setTimeout(() => this.server.closeAllConnections(), TIMEOUT_MS)
    this.server.close(() => {
      clearTimeout(deadline)
      // Only actual HTTP close, after complete B close + matching generation
      // release and Stop response drain, authorizes S to close its runtime Job.
      if (this.options.runtime && !this.runtimeFinalized) {
        this.runtimeFinalized = true
        void this.options.runtime.stopDrained().catch(() => { if (!this.fixture) process.exit(1) })
      }
    })
  }
  private failRuntime(reason: "backend-exit" | "owner-lost"): void {
    this.stopping = true; this.revokeAll(); clearInterval(this.leaseTimer)
    this.server.close(); this.server.closeAllConnections()
    if (this.options.runtime) this.finalizeRuntime(reason)
  }
  private finalizeRuntime(reason: "backend-exit" | "owner-lost" | "startup-failed" | "election-lost"): void {
    if (this.runtimeFinalized || !this.options.runtime) return
    this.runtimeFinalized = true
    void this.options.runtime.fatal(reason).catch(() => undefined).finally(() => {
      // This is an explicit native fatal/exit path, never a silence watchdog,
      // replacement launch or PID kill. S watches the retained exact M handle.
      if (!this.fixture) process.exit(reason === "election-lost" ? 0 : 1)
    })
  }
  private async dispatch(route: string, body: Record<string, unknown>): Promise<unknown> {
    // Repeat admission after reading the body: stop may have begun meanwhile.
    if (this.stopping && route !== "/stop") throw new HostError("host-not-ready")
    if (route === "/status") {
      this.expire()
      return { generation: this.generation, managerPid: process.pid, backendPid: this.registration!.backend.pid,
        origin: this.registration!.origin, automationAvailable: this.windows.size > 0 ? "attached-window" : false }
    }
    if (route === "/attach") {
      this.expire()
      const windowId = body.windowId
      if (typeof windowId !== "string" || !/^[a-f0-9-]{36}$/.test(windowId)
        || typeof body.clientNonce !== "string" || !/^[a-f0-9]{64}$/.test(body.clientNonce)) throw new HostError("invalid-attachment")
      if (this.windows.size >= 32 || this.windows.has(windowId)) throw new HostError("attachment-conflict")
      const capability = randomBytes(32).toString("hex")
      this.windows.set(windowId, { secret: capability, expires: Date.now() + 10_000, queue: [] })
      try {
        const bootstrapProof = await this.backend!.request("proof", windowId)
        if (typeof bootstrapProof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(bootstrapProof)) throw new HostError("invalid-bootstrap-proof")
        if (this.stopping || this.windows.get(windowId)?.secret !== capability) {
          void this.backend!.request("revoke", windowId).catch(() => undefined)
          throw new HostError("window-capability-revoked")
        }
        return { generation: this.generation, managerPid: process.pid, backendPid: this.registration!.backend.pid,
          origin: this.registration!.origin, windowId, capability, bootstrapProof } satisfies Attachment
      } catch (error) { this.revoke(windowId); throw error }
    }
    if (route === "/stop") {
      if (body.intent !== "stop-profile-backend") throw new HostError("explicit-stop-intent-required")
      if (!this.stopping) { this.stopping = true; this.revokeAll() }
      if (!this.stopOperation) {
        const operation = this.finishStop()
        this.stopOperation = operation
        // A failed observer may be retried, but stopping fences never reopen.
        // BackendProcess retains the one command and its actual completion.
        void operation.catch(() => { if (this.stopOperation === operation) this.stopOperation = undefined })
      }
      return this.stopOperation
    }
    this.expire()
    const windowId = body.windowId
    const window = typeof windowId === "string" ? this.windows.get(windowId) : undefined
    if (!window || typeof body.capability !== "string" || window.secret !== body.capability) throw new HostError("window-capability-revoked")
    window.expires = Date.now() + 10_000
    if (route === "/detach") {
      this.revoke(windowId as string)
      await this.backend!.request("revoke", windowId as string)
      return { detached: true }
    }
    if (route === "/poll") {
      const calls = window.queue.splice(0).filter(call => {
        const pending = this.pending.get(call.id)
        if (!pending || pending.call !== call || pending.capability !== window.secret) return false
        if (call.deadline <= Date.now()) { this.cancelNative(call.id, pending, "native-expired"); return false }
        pending.delivered = true
        return true
      })
      return { calls }
    }
    if (route === "/result") {
      if (typeof body.id !== "string") throw new HostError("invalid-native-result")
      const pending = this.pending.get(body.id)
      if (!pending || pending.windowId !== windowId || pending.capability !== window.secret || !pending.delivered
        || pending.call.requestToken !== body.requestToken) throw new HostError("native-request-revoked")
      if (pending.call.deadline <= Date.now()) {
        this.cancelNative(body.id, pending, "native-expired")
        throw new HostError("native-request-revoked")
      }
      this.pending.delete(body.id); clearTimeout(pending.timer)
      if (body.ok === true) pending.resolve(body.result); else pending.reject(new HostError("window-native-failed"))
      return { accepted: true }
    }
    throw new HostError("unknown-route")
  }
  private async finishStop(): Promise<{ stopped: true }> {
    await this.backend!.stop()
    await this.options.storage.release(this.generation)
    clearInterval(this.leaseTimer)
    return { stopped: true }
  }
  private route(call: NativeCall): Promise<unknown> {
    if (this.stopping || this.pending.size >= 32) return Promise.reject(new HostError("host-unavailable"))
    const deadline = Math.min(call.deadline, Date.now() + 30_000)
    const remaining = deadline - Date.now()
    if (remaining <= 0) return Promise.reject(new HostError("native-expired"))
    if (call.method === "opencode.service.start") {
      // No renderer/control route can request service start. Backend pipe only.
      if (this.options.runtime) return this.options.runtime.startService(call.params, deadline)
      // Preserve the existing explicit POSIX host-owned service capability.
      // Windows cannot reach this in production; never spawn a fallback from M.
      return this.options.startService?.(call.params, deadline) ?? Promise.reject(new HostError("persistent-service-capability-required"))
    }
    if (!/^(browser|developer)\./.test(call.method)) return Promise.reject(new HostError("native-method-unavailable"))
    this.expire()
    const params = call.params as { windowId?: string } | null
    const windowId = call.windowId ?? params?.windowId
    const window = windowId ? this.windows.get(windowId) : undefined
    if (!window || !windowId) return Promise.reject(new HostError("no-attached-native-window"))
    if (this.pending.has(call.id)) return Promise.reject(new HostError("duplicate-native-request"))
    return new Promise((resolve, reject) => {
      const queued = { ...call, deadline, requestToken: randomBytes(32).toString("hex") }
      const pending: PendingNative = { windowId, capability: window.secret, call: queued, delivered: false,
        resolve, reject, timer: setTimeout(() => this.cancelNative(call.id, pending, "native-expired"), remaining) }
      this.pending.set(call.id, pending)
      window.queue.push(queued)
    })
  }
  private cancelNative(id: string, pending: PendingNative, code: string): void {
    // A canceled/reused ID must never let an old timer erase its replacement.
    if (this.pending.get(id) !== pending) return
    clearTimeout(pending.timer); this.pending.delete(id)
    const window = this.windows.get(pending.windowId)
    if (window?.secret === pending.capability) window.queue = window.queue.filter(call => call !== pending.call)
    pending.reject(new HostError(code))
  }
  private expire(): void {
    for (const [id, window] of this.windows) if (window.expires <= Date.now()) {
      this.revoke(id); void this.backend?.request("revoke", id).catch(() => undefined)
    }
  }
  private revoke(windowId: string): void {
    for (const [id, pending] of this.pending) if (pending.windowId === windowId) {
      this.cancelNative(id, pending, "window-capability-revoked")
    }
    this.windows.delete(windowId)
  }
  private revokeAll(): void { for (const id of this.windows.keys()) {
    this.revoke(id)
    void this.backend?.request("revoke", id).catch(() => undefined)
  } }
}
/** @internal Lower-level private fixtures only, explicitly unqualified. Never
 * import this constructor from a packaged host/manager entry. It confers no
 * native independent-launch, Job, private-storage or service authority. */
export function createHostLifetimeManagerForPrivateFixture(options: ManagerOptions): HostLifetimeManager {
  return new HostLifetimeManager(options, PRIVATE_FIXTURE)
}
