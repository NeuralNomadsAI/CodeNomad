import { randomUUID } from "node:crypto"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Agent, fetch as undiciFetch } from "undici"
import type { EventBus } from "../../events/bus"
import type { WorkspaceEventPayload } from "../../api-types"
import type { Logger } from "../../logger"
import type { NativeParent } from "../../native-parent"
import { BrowserPage } from "../../automation/browser-page"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { locationRequestOptions } from "../compatibility/location"
import { createRuntimeTransport } from "../compatibility/transport"
import { PreviewTab, type PreviewHost } from "./commands"

/** OpenCode's desktop browser contract (`@opencode/plugin-browser/rpc`). */
export const BROWSER_CONTROL_EVENT = "rpc.experimental.browser.control"
const RPC_ID = "experimental.browser", VERSION = 4
/** A view renews its hold well within this; a closed or crashed view releases the session after it. */
const HOLD_MS = 45_000
const RETRY_MS = 2_000, UNAVAILABLE_RETRY_MS = 15_000, MAX_SESSIONS = 16

type Location = { directory: string; workspaceID?: string }
type Control = { type: "attached" | "command" | "cancel"; connectionID: string; requestID?: string }

/**
 * Attaches CodeNomad's session preview to OpenCode's native browser tools while a local view holds
 * the session. OpenCode then lists `tools.browser.*` and its `browser` skill to that session's agents
 * and dispatches their calls here, where the guarded native preview channel runs them.
 */
export class NativeBrowserAttachments {
  private readonly holds = new Map<string, { workspaceID: string; sessionID: string; expires: number }>()
  /** One attachment per session: OpenCode keeps a single desktop attachment and replaces older ones. */
  private readonly sessions = new Map<string, SessionAttachment>()
  private readonly attachClients = new WeakMap<ServiceConnection, OpenCodeClient>()
  private readonly attachAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
  private readonly page: BrowserPage
  private readonly sweep: NodeJS.Timeout
  private readonly unsubscribe: () => void
  private closed = false

  constructor(private readonly deps: { workspaceManager: WorkspaceManager; eventBus: EventBus; nativeParent: NativeParent; logger: Logger }) {
    // OpenCode's refs are `e<number>`; this table is separate from codenomad.inspect's.
    this.page = new BrowserPage(deps.nativeParent, "e")
    const onEvent = (event: Extract<WorkspaceEventPayload, { type: "instance.event" }>) => {
      if (event.event.type !== BROWSER_CONTROL_EVENT) return
      const control = (event.event as { data?: Partial<Control> }).data
      if (typeof control?.connectionID !== "string" || !control.type) return
      for (const session of this.sessions.values()) if (session.connectionID === control.connectionID) session.control(control as Control)
    }
    deps.eventBus.on("instance.event", onEvent)
    this.unsubscribe = () => deps.eventBus.off("instance.event", onEvent)
    this.sweep = setInterval(() => this.expire(), 5_000)
    this.sweep.unref()
  }

  get available(): boolean { return this.deps.nativeParent.available && !this.deps.nativeParent.browserAutomationUnavailable }

  /** Creates or renews one view's hold on a session. */
  hold(holdID: string, workspaceID: string, sessionID: string): void {
    if (this.closed || !this.available) throw new Error("Browser automation is unavailable in this host")
    if (!this.sessions.has(sessionID) && this.sessions.size >= MAX_SESSIONS) throw new Error("Too many attached browser sessions")
    this.holds.set(holdID, { workspaceID, sessionID, expires: Date.now() + HOLD_MS })
    if (!this.sessions.has(sessionID)) this.attach(workspaceID, sessionID)
  }

  release(holdID: string): void {
    this.holds.delete(holdID)
    this.expire()
  }

  private attach(workspaceID: string, sessionID: string): void {
    const session = new SessionAttachment(workspaceID, sessionID, this.host(workspaceID, sessionID),
      connection => this.attachClient(connection), this.deps.workspaceManager, this.deps.logger)
    this.sessions.set(sessionID, session)
    session.start()
  }

  /** The workspaces whose views hold a session, most recent hold last. */
  private holders(sessionID: string): string[] {
    return [...new Set([...this.holds.values()].filter(hold => hold.sessionID === sessionID).map(hold => hold.workspaceID))]
  }

  close(): void {
    this.closed = true
    clearInterval(this.sweep)
    this.unsubscribe()
    for (const session of this.sessions.values()) session.stop()
    this.sessions.clear()
    this.page.close()
    void this.attachAgent.close().catch(() => undefined)
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, hold] of this.holds) if (hold.expires <= now) this.holds.delete(id)
    for (const [sessionID, session] of this.sessions) {
      const holders = this.holders(sessionID)
      if (holders.includes(session.workspaceID)) continue
      session.stop()
      this.sessions.delete(sessionID)
      // Another workspace's view still shows the session: it takes the attachment over.
      if (holders.length && !this.closed) this.attach(holders.at(-1)!, sessionID)
    }
  }

  // `attach` holds its HTTP response open without headers for the attachment's lifetime;
  // an undici dispatcher with headersTimeout: 0 prevents the default five-minute drop.
  private attachClient(connection: ServiceConnection): OpenCodeClient {
    const existing = this.attachClients.get(connection)
    if (existing) return existing
    const transport = createRuntimeTransport(connection.endpoint, (input, init) => {
      connection.assertCurrent()
      return undiciFetch(input as string | URL, { ...(init as Record<string, unknown>), dispatcher: this.attachAgent }) as unknown as Promise<Response>
    })
    const client = OpenCode.make({
      baseUrl: connection.endpoint.url,
      headers: Service.headers(connection.endpoint),
      fetch: (input, init) => {
        connection.assertCurrent()
        return transport.fetch(input, init)
      },
    })
    this.attachClients.set(connection, client)
    return client
  }

  private host(workspaceID: string, sessionID: string): PreviewHost {
    // A sent native request cannot be recalled: a cancelled command never sends one and stops waiting for it.
    const native = <T>(method: string, params: Record<string, unknown>, deadline: number, signal: AbortSignal): Promise<T> => {
      signal.throwIfAborted()
      return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(signal.reason)
        signal.addEventListener("abort", aborted, { once: true })
        this.deps.nativeParent.request<T>(method, { sessionID, ...params }, { deadline })
          .then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
      })
    }
    const execute = (command: Record<string, unknown>, target: string, deadline: number, signal: AbortSignal) =>
      native<{ url: string }>("browser.execute", { command, target }, deadline, signal)
    return {
      probe: async (deadline, signal) => {
        const result = await native<{ available?: boolean; target?: string; loading?: boolean }>("browser.probe", {}, deadline, signal)
        return result?.available === true && typeof result.target === "string" ? { target: result.target, loading: result.loading === true } : undefined
      },
      // The views that show the session are in these workspaces' project tabs.
      open: (url, deadline, signal) => native("browser.execute", { command: { action: "open", url }, workspaceIDs: this.holders(sessionID).length ? this.holders(sessionID) : [workspaceID] }, deadline, signal),
      navigate: (url, target, deadline, signal) => execute({ action: "navigate", url }, target, deadline, signal),
      back: (target, deadline, signal) => execute({ action: "back" }, target, deadline, signal),
      forward: (target, deadline, signal) => execute({ action: "forward" }, target, deadline, signal),
      reload: (target, deadline, signal) => execute({ action: "reload" }, target, deadline, signal),
      screenshot: (target, deadline, signal) => native("browser.execute", { command: { action: "screenshot" }, target }, deadline, signal),
      page: (action, target, deadline, signal) => this.page.execute(sessionID, action, signal, target, deadline),
    }
  }
}

class SessionAttachment {
  connectionID: string | undefined
  private readonly stopping = new AbortController()
  private readonly requests = new Map<string, AbortController>()
  /** Request IDs already taken: the relay can deliver one control event once per owning workspace. */
  private readonly taken = new Set<string>()
  private readonly tab: PreviewTab
  private connection: ServiceConnection | undefined
  private location: Location | undefined

  constructor(readonly workspaceID: string, private readonly sessionID: string, host: PreviewHost,
    private readonly attachClient: (connection: ServiceConnection) => OpenCodeClient,
    private readonly workspaceManager: WorkspaceManager, private readonly logger: Logger) {
    this.tab = new PreviewTab(host)
  }

  start(): void { void this.loop() }

  stop(): void {
    this.stopping.abort()
    this.cancelRequests()
  }

  control(control: Control): void {
    if (control.type === "attached") void this.publish().catch(error => this.warn("Browser state publication failed", error))
    else if (control.type === "command" && control.requestID) {
      if (this.taken.has(control.requestID)) return
      this.taken.add(control.requestID)
      if (this.taken.size > 256) this.taken.delete(this.taken.values().next().value!)
      void this.command(control.requestID)
    } else if (control.type === "cancel" && control.requestID) this.requests.get(control.requestID)?.abort()
  }

  /** OpenCode settles an ended attachment's requests itself; their work stops here too. */
  private cancelRequests(): void {
    for (const request of this.requests.values()) request.abort()
    this.requests.clear()
  }

  private async loop(): Promise<void> {
    const signal = this.stopping.signal
    let unavailable = 0
    while (!signal.aborted) {
      let wait = RETRY_MS
      try {
        const connection = await this.workspaceManager.getSharedServiceConnection(this.workspaceID)
        if (!connection) throw new Error("OpenCode is unavailable")
        const session = await connection.client.session.get({ sessionID: this.sessionID }, { signal })
        const location = session.location as Location
        if (!await this.workspaceManager.ownsLocation(this.workspaceID, location, undefined, { signal })) return
        this.connection = connection
        this.location = location
        this.connectionID = randomUUID()
        const outcome = await this.rpc("attach", { version: VERSION }, signal, this.attachClient(connection))
        // Another desktop took the session over: this one attaches again once every view has released it.
        if (outcome === "replaced") { this.connectionID = undefined; this.cancelRequests(); return }
      } catch (error) {
        // A runtime with `-opencode.browser` or a Location still loading its plugins answers rpc.unavailable.
        if ((error as { type?: unknown })?.type === "rpc.unavailable") { if (++unavailable > 5) wait = UNAVAILABLE_RETRY_MS }
        else if (!signal.aborted) this.warn("OpenCode browser attachment ended", error)
      }
      this.connectionID = undefined
      this.cancelRequests()
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }

  private async command(requestID: string): Promise<void> {
    const connectionID = this.connectionID
    const controller = new AbortController()
    this.requests.set(requestID, controller)
    const signal = AbortSignal.any([controller.signal, this.stopping.signal])
    try {
      const command = await this.rpc("command", { requestID }, signal) as { action: Record<string, unknown> & { type: string }; generation?: number; inspect?: boolean }
      const outcome = command.inspect
        ? { type: "failure" as const, code: "unsupported", message: "Target inspection is unavailable in the CodeNomad browser." }
        : await this.tab.run(command.action, command.generation, signal)
      if (connectionID !== this.connectionID) return
      // The server reads tabs from the published inventory, so it precedes every result.
      await this.publish(signal)
      await this.rpc("result", { requestID, outcome }, signal)
    } catch (error) {
      if (!signal.aborted) this.warn("OpenCode browser command failed", error)
    } finally { this.requests.delete(requestID) }
  }

  private async publish(signal = this.stopping.signal): Promise<void> {
    await this.tab.refresh(Date.now() + 5_000, signal)
    await this.rpc("state", { state: this.tab.state() }, signal)
  }

  private async rpc(method: string, input: Record<string, unknown>, signal: AbortSignal, client = this.connection?.client): Promise<unknown> {
    const location = this.location
    if (!client || !location || !this.connectionID) throw new Error("Browser attachment is unavailable")
    const response = await client.rpc.call({ rpcID: RPC_ID, method, location: { directory: location.directory },
      input: { sessionID: this.sessionID, connectionID: this.connectionID, ...input } },
      { ...locationRequestOptions(location), signal })
    return response.output
  }

  private warn(message: string, error: unknown): void {
    this.logger.warn({ sessionID: this.sessionID, error: error instanceof Error ? error.message : String(error) }, message)
  }
}
