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
  private readonly holds = new Map<string, { key: string; expires: number }>()
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
    const key = `${workspaceID}\0${sessionID}`
    this.holds.set(holdID, { key, expires: Date.now() + HOLD_MS })
    if (this.sessions.has(key)) return
    if (this.sessions.size >= MAX_SESSIONS) throw new Error("Too many attached browser sessions")
    const session = new SessionAttachment(workspaceID, sessionID, this.host(workspaceID),
      connection => this.attachClient(connection), this.deps.workspaceManager, this.deps.logger)
    this.sessions.set(key, session)
    session.start()
  }

  release(holdID: string): void {
    this.holds.delete(holdID)
    this.expire()
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
    const now = Date.now(), held = new Set<string>()
    for (const [id, hold] of this.holds) {
      if (hold.expires <= now) this.holds.delete(id)
      else held.add(hold.key)
    }
    for (const [key, session] of this.sessions) {
      if (held.has(key)) continue
      session.stop()
      this.sessions.delete(key)
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

  private host(workspaceID: string): PreviewHost {
    const native = this.deps.nativeParent
    return {
      probe: async (sessionID, deadline) => {
        const result = await native.request<{ available?: boolean; target?: string }>("browser.probe", { sessionID }, { deadline })
        return result?.available === true && typeof result.target === "string" ? result.target : undefined
      },
      // The view that holds the session is in this workspace's project tab.
      open: (sessionID, url, deadline) => native.request("browser.execute", { sessionID, command: { action: "open", url }, workspaceIDs: [workspaceID] }, { deadline }),
      navigate: (sessionID, url, target, deadline) => native.request("browser.execute", { sessionID, command: { action: "navigate", url }, target }, { deadline }),
      back: (sessionID, target, deadline) => native.request("browser.execute", { sessionID, command: { action: "back" }, target }, { deadline }),
      forward: (sessionID, target, deadline) => native.request("browser.execute", { sessionID, command: { action: "forward" }, target }, { deadline }),
      reload: (sessionID, target, deadline) => native.request("browser.execute", { sessionID, command: { action: "reload" }, target }, { deadline }),
      screenshot: (sessionID, target, deadline) => native.request("browser.execute", { sessionID, command: { action: "screenshot" }, target }, { deadline }),
      page: (sessionID, action, target, deadline, signal) => this.page.execute(sessionID, action, signal, target, deadline),
    }
  }
}

class SessionAttachment {
  connectionID: string | undefined
  private readonly stopping = new AbortController()
  private readonly requests = new Map<string, AbortController>()
  private readonly tab: PreviewTab
  private connection: ServiceConnection | undefined
  private location: Location | undefined

  constructor(private readonly workspaceID: string, private readonly sessionID: string, host: PreviewHost,
    private readonly attachClient: (connection: ServiceConnection) => OpenCodeClient,
    private readonly workspaceManager: WorkspaceManager, private readonly logger: Logger) {
    this.tab = new PreviewTab(host, sessionID)
  }

  start(): void { void this.loop() }

  stop(): void {
    this.stopping.abort()
    for (const request of this.requests.values()) request.abort()
    this.requests.clear()
  }

  control(control: Control): void {
    if (control.type === "attached") void this.publish().catch(error => this.warn("Browser state publication failed", error))
    else if (control.type === "command" && control.requestID) void this.command(control.requestID)
    else if (control.type === "cancel" && control.requestID) this.requests.get(control.requestID)?.abort()
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
        if (outcome === "replaced") return
      } catch (error) {
        // A runtime with `-opencode.browser` or a Location still loading its plugins answers rpc.unavailable.
        if ((error as { type?: unknown })?.type === "rpc.unavailable") { if (++unavailable > 5) wait = UNAVAILABLE_RETRY_MS }
        else if (!signal.aborted) this.warn("OpenCode browser attachment ended", error)
      }
      this.connectionID = undefined
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
