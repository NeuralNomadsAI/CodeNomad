import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
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
import { MINIMUM_OPENCODE_VERSION } from "../runtime-support"
import { compareVersionStrings } from "../../releases/release-monitor"
import { PreviewTab, type BrowserOutcome, type PreviewHost } from "./commands"

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
    const session = this.sessions.get(sessionID)
    if (session) session.renew()
    else this.attach(sessionID)
  }

  release(holdID: string): void {
    this.holds.delete(holdID)
    this.expire()
  }

  private attach(sessionID: string): void {
    const session: SessionAttachment = new SessionAttachment(sessionID, () => this.holders(sessionID),
      this.host(sessionID, () => session.owners), connection => this.attachClient(connection), this.deps.workspaceManager, this.deps.logger)
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
      if (!holders.length) {
        session.stop()
        this.sessions.delete(sessionID)
      } else if (session.workspaceID && !holders.includes(session.workspaceID)) {
        // Another workspace's view still shows the session: it attaches again through an owner among them.
        session.retarget()
      }
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

  /** `owners` names the holding workspaces verified to own the session for the running command. */
  private host(sessionID: string, owners: () => string[]): PreviewHost {
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
      native<{ url: string; registration?: string }>("browser.execute", { command, target }, deadline, signal)
    return {
      // Only a view in a verified owner's project tab is the session's preview for its agents.
      probe: async (deadline, signal) => {
        const result = await native<{ available?: boolean; target?: string; loading?: boolean; registration?: string }>("browser.probe", { workspaceIDs: owners() }, deadline, signal)
        return result?.available === true && typeof result.target === "string"
          ? { target: result.target, loading: result.loading === true, ...(typeof result.registration === "string" ? { registration: result.registration } : {}) }
          : undefined
      },
      // The views that show the session are in these workspaces' project tabs.
      open: (url, deadline, signal) => native("browser.execute", { command: { action: "open", url }, workspaceIDs: owners() }, deadline, signal),
      navigate: (url, target, deadline, signal) => execute({ action: "navigate", url }, target, deadline, signal),
      back: (target, deadline, signal) => execute({ action: "back" }, target, deadline, signal),
      forward: (target, deadline, signal) => execute({ action: "forward" }, target, deadline, signal),
      reload: (target, deadline, signal) => execute({ action: "reload" }, target, deadline, signal),
      screenshot: (target, deadline, signal) => native("browser.execute", { command: { action: "screenshot" }, target }, deadline, signal),
      page: (action, target, deadline, signal) => this.page.execute(sessionID, action, signal, target, deadline),
    }
  }
}

function current(connection: ServiceConnection): boolean {
  try { connection.assertCurrent(); return true } catch { return false }
}

class SessionAttachment {
  connectionID: string | undefined
  /** The holding workspace whose ownership the current attachment uses. */
  workspaceID: string | undefined
  /** Holding workspaces verified to own the session, for the running command. */
  owners: string[] = []
  private readonly stopping = new AbortController()
  private attachment = new AbortController()
  private readonly requests = new Map<string, AbortController>()
  private publishing: Promise<void> = Promise.resolve()
  /** Aborted when the connection the queued publications target ends. */
  private publications = new AbortController()
  /** Request IDs already taken: the relay can deliver one control event once per owning workspace. */
  private readonly taken = new Set<string>()
  private readonly tab: PreviewTab
  private connection: ServiceConnection | undefined
  private location: Location | undefined

  constructor(private readonly sessionID: string, private readonly holders: () => string[], host: PreviewHost,
    private readonly attachClient: (connection: ServiceConnection) => OpenCodeClient,
    private readonly workspaceManager: WorkspaceManager, private readonly logger: Logger) {
    this.tab = new PreviewTab(host)
  }

  start(): void { void this.loop() }

  stop(): void {
    this.stopping.abort()
    this.attachment.abort()
    this.cancelRequests()
  }

  /** Ends the current attachment; the loop attaches again through a current owner. */
  retarget(): void { this.attachment.abort() }

  /** A replaced service connection (a reconnect to OpenCode) ends the attachment made on it. */
  renew(): void {
    if (this.connection && !current(this.connection)) this.retarget()
  }

  control(control: Control): void {
    if (control.type === "attached") void this.publish().catch(error => {
      if ((error as Error)?.name !== "AbortError") this.warn("Browser state publication failed", error)
    })
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
    // A publication stalled on the ended connection must not hold the next one's queue.
    this.publications.abort()
    this.publications = new AbortController()
    this.publishing = Promise.resolve()
  }

  /** The holding workspaces that own the session's location now. */
  private async verifiedOwners(location: Location, signal: AbortSignal): Promise<string[]> {
    const owners: string[] = []
    for (const workspaceID of this.holders().reverse()) {
      if (await this.workspaceManager.ownsLocation(workspaceID, location, undefined, { signal }).catch(() => false)) owners.push(workspaceID)
    }
    return owners
  }

  private async loop(): Promise<void> {
    let unavailable = 0
    while (!this.stopping.signal.aborted) {
      let wait = RETRY_MS
      if (this.attachment.signal.aborted) this.attachment = new AbortController()
      const signal = AbortSignal.any([this.stopping.signal, this.attachment.signal])
      try {
        const reader = this.holders().at(-1)
        const readConnection = reader && await this.workspaceManager.getSharedServiceConnection(reader)
        if (!readConnection) throw new Error("OpenCode is unavailable")
        const session = await readConnection.client.session.get({ sessionID: this.sessionID }, { signal })
        const location = session.location as Location
        // A holder that does not own the session never attaches it; a later owner's hold does.
        const owners = await this.verifiedOwners(location, signal)
        const [owner] = owners
        this.owners = owners
        const connection = owner && await this.workspaceManager.getSharedServiceConnection(owner)
        const client = connection ? this.attachClient(connection) : undefined
        // 2.3 accepts this attachment, but its blanket browser grant overrides a configured `browser` deny.
        // The daemon about to receive `attach` must report a numbered 2.4 release; a custom label never attaches.
        if (client && compareVersionStrings((await client.server.info({ signal })).version ?? "", MINIMUM_OPENCODE_VERSION) < 0) {
          wait = UNAVAILABLE_RETRY_MS
        } else if (connection) {
          this.workspaceID = owner
          this.connection = connection
          this.location = location
          this.connectionID = randomUUID()
          const outcome = await this.rpc("attach", { version: VERSION }, signal, client)
          // Another desktop took the session over: this one attaches again once every view has released it.
          if (outcome === "replaced") { this.connectionID = undefined; this.cancelRequests(); return }
        }
      } catch (error) {
        // A runtime with `-opencode.browser` or a Location still loading its plugins answers rpc.unavailable.
        if ((error as { type?: unknown })?.type === "rpc.unavailable") { if (++unavailable > 5) wait = UNAVAILABLE_RETRY_MS }
        else if (!signal.aborted) this.warn("OpenCode browser attachment ended", error)
      }
      this.connectionID = undefined
      this.workspaceID = undefined
      this.cancelRequests()
      if (this.stopping.signal.aborted) return
      // Closing the registry ends the wait, so a retry never holds the process open.
      if (!this.attachment.signal.aborted) await sleep(wait, undefined, { signal: AbortSignal.any([this.stopping.signal, this.attachment.signal]) }).catch(() => undefined)
    }
  }

  private async command(requestID: string): Promise<void> {
    const connectionID = this.connectionID
    const controller = new AbortController()
    this.requests.set(requestID, controller)
    const signal = AbortSignal.any([controller.signal, this.stopping.signal])
    const failure = (message: string): BrowserOutcome => ({ type: "failure", code: "operation_failed", message: message.slice(0, 2_000) })
    const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
    let lost = false
    let settled = false
    const settle = async (outcome: BrowserOutcome) => {
      settled = true
      await this.rpc("result", { requestID, outcome }, signal)
    }
    try {
      const command = await this.rpc("command", { requestID }, signal) as { action: Record<string, unknown> & { type: string }; generation?: number; inspect?: boolean }
      // Ownership is checked again when each command's turn comes: a project can stop owning the session while
      // the command waits behind another.
      const admit = async (): Promise<BrowserOutcome | undefined> => {
        // The session's current location decides: a session moved elsewhere no longer belongs to this attachment.
        const session = this.connection && await this.connection.client.session.get({ sessionID: this.sessionID }, { signal })
        const location = session?.location as Location | undefined
        const moved = !location || !this.location || location.directory !== this.location.directory
          || location.workspaceID !== this.location.workspaceID
        this.owners = moved ? [] : await this.verifiedOwners(location, signal)
        lost = !this.workspaceID || !this.owners.includes(this.workspaceID)
        return lost ? failure("No project shown on this computer owns this conversation's browser.") : undefined
      }
      // OpenCode resolves tab IDs against the published inventory, so it is published and acknowledged before every
      // result and before the next command runs, as in its own desktop browser: a success whose inventory was refused
      // would name a tab OpenCode cannot use. A preview this desktop no longer owns is not read.
      const conclude = async (outcome: BrowserOutcome): Promise<BrowserOutcome> => {
        if (lost || connectionID !== this.connectionID) return outcome
        return this.publish(signal).then(() => outcome, error => {
          if (signal.aborted) throw error
          this.warn("Browser state publication failed", error)
          return outcome.type === "success"
            ? failure(`The action ran, but the browser tabs could not be published: ${reason(error)}. Call browser.tabs.list({}).`)
            : outcome
        })
      }
      const outcome: BrowserOutcome = command.inspect
        ? await conclude({ type: "failure", code: "unsupported", message: "Target inspection is unavailable in the CodeNomad browser." })
        : await this.tab.run(command.action, command.generation, signal, admit, conclude)
      if (connectionID !== this.connectionID) return
      await settle(outcome).catch(async error => {
        // A result OpenCode refuses (for example an oversized file) still settles the request.
        if (signal.aborted) throw error
        await settle(failure(`The browser result could not be delivered: ${reason(error)}`))
      })
    } catch (error) {
      if (signal.aborted) return
      this.warn("OpenCode browser command failed", error)
      // A command that failed before its result, while reading it or checking ownership, is still settled, as in
      // OpenCode's desktop browser: nothing waits for its timeout.
      if (!settled && connectionID === this.connectionID) await settle(failure(`The browser command failed: ${reason(error)}`)).catch(() => undefined)
    } finally {
      this.requests.delete(requestID)
      // The attachment no longer has an owner: it attaches again through a current one.
      if (lost) this.retarget()
    }
  }
  /** Publications run one at a time and each reads the tab when its turn comes: OpenCode replaces its inventory with
   * every one it receives, so an older one must never arrive last. */
  private async publish(caller = this.stopping.signal): Promise<void> {
    const signal = AbortSignal.any([caller, this.publications.signal])
    const turn = this.publishing.then(async () => {
      await this.tab.refresh(Date.now() + 5_000, signal)
      await this.rpc("state", { state: this.tab.state() }, signal)
    })
    this.publishing = turn.catch(() => undefined)
    await turn
  }

  private async rpc(method: string, input: Record<string, unknown>, signal: AbortSignal, client = this.connection?.client): Promise<unknown> {
    const location = this.location
    if (!client || !location || !this.connectionID) throw new Error("Browser attachment is unavailable")
    try {
      const response = await client.rpc.call({ rpcID: RPC_ID, method, location: { directory: location.directory },
        input: { sessionID: this.sessionID, connectionID: this.connectionID, ...input } },
        { ...locationRequestOptions(location), signal })
      return response.output
    } catch (error) {
      this.renew()
      throw error
    }
  }

  private warn(message: string, error: unknown): void {
    this.logger.warn({ sessionID: this.sessionID, error: error instanceof Error ? error.message : String(error) }, message)
  }
}
