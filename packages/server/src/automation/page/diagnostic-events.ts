import { randomUUID } from "node:crypto"

/** Console and network diagnostics of a native preview: the protocol domains a host enables on the
 * preview's own attachment and the raw events it keeps, bounded, for the backend to read. */
export const DIAGNOSTICS = {
  enable: [
    ["Runtime.enable", {}],
    ["Log.enable", {}],
    ["Network.enable", { maxTotalBufferSize: 5 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024, maxPostDataSize: 20_000 }],
    // Out-of-process frames attach as child sessions, paused until they get the same domains, as in OpenCode's
    // browser. Chromium pauses every child worker under this flag, so workers attach too and the host resumes them.
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: "iframe", exclude: false }, { type: "worker", exclude: false }, { exclude: true }] }],
  ] as [string, Record<string, unknown>][],
  events: [
    "Runtime.consoleAPICalled", "Runtime.exceptionThrown",
    "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
    "Log.entryAdded",
    "Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo", "Network.responseReceived", "Network.responseReceivedExtraInfo",
    "Network.loadingFinished", "Network.loadingFailed",
    "Network.webSocketCreated", "Network.webSocketWillSendHandshakeRequest", "Network.webSocketHandshakeResponseReceived",
    "Network.webSocketFrameError", "Network.webSocketClosed", "Target.detachedFromTarget",
  ],
  /** The events that feed a console entry or a request, for counting losses. */
  messageEvents: ["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"],
  requestEvents: ["Network.requestWillBeSent", "Network.webSocketCreated"],
  /** Retained events and their UTF-8 JSON size; the oldest go first. */
  maxEvents: 4_000,
  maxBytes: 8 * 1024 * 1024,
  /** One read returns at most this many events and bytes; `more` asks for another. */
  maxRead: 1_000,
  maxReadBytes: 2 * 1024 * 1024,
  /** Live execution contexts kept per preview; a page that creates more drops the oldest. */
  maxContexts: 512,
}

/** `session` names the out-of-process frame an event came from; the top-level document has none. */
export interface DiagnosticEvent { method: string; params: Record<string, unknown>; session?: string }
/** Events the host evicted before any read returned them, counted for this epoch by the readout they would feed. */
export interface DiagnosticLoss { messages: number; requests: number }
/** A live execution context and whether it is a page world (a frame's default context). */
export interface DiagnosticContext { session?: string; id: number; page: boolean }
/** One read: the events after `after`, the buffer epoch (another buffer, or a document replacing this one's, gives
 * another epoch), the epoch's losses so far and the live execution contexts, which outlast both epochs and
 * evictions. */
export interface DiagnosticRead {
  epoch: string; events: DiagnosticEvent[]; next: number; lost: DiagnosticLoss; more: boolean; contexts: DiagnosticContext[]
}

/** The raw event buffer of one preview, restarted for each new document. */
export class DiagnosticEventBuffer {
  private readonly instance = randomUUID()
  private readonly events: Array<{ sequence: number; method: string; params: Record<string, unknown>; session?: string; bytes: number }> = []
  private readonly contexts = new Map<string, DiagnosticContext>()
  private epoch = 0
  private sequence = 0
  /** The last sequence a read returned: evicting it or anything before it loses nothing. */
  private delivered = 0
  private lost: DiagnosticLoss = { messages: 0, requests: 0 }
  private bytes = 0

  record(method: string, params: unknown, session?: string): void {
    if (!DIAGNOSTICS.events.includes(method) || !params || typeof params !== "object") return
    this.track(method, params as Record<string, any>, session)
    const bytes = Buffer.byteLength(JSON.stringify(params))
    if (bytes > DIAGNOSTICS.maxReadBytes) return
    this.events.push({ sequence: ++this.sequence, method, params: params as Record<string, unknown>, ...(session ? { session } : {}), bytes })
    this.bytes += bytes
    while (this.events.length > DIAGNOSTICS.maxEvents || this.bytes > DIAGNOSTICS.maxBytes) {
      const evicted = this.events.shift()!
      this.bytes -= evicted.bytes
      if (evicted.sequence <= this.delivered) continue
      if (DIAGNOSTICS.messageEvents.includes(evicted.method)) this.lost.messages++
      else if (DIAGNOSTICS.requestEvents.includes(evicted.method)) this.lost.requests++
    }
  }

  /** Execution contexts live across documents: document.open() keeps the page's, and a read may come after their
   * creation was evicted. */
  private track(method: string, params: Record<string, any>, session: string | undefined): void {
    const scope = `${session ?? ""}:`
    const drop = (prefix: string) => { for (const key of this.contexts.keys()) if (key.startsWith(prefix)) this.contexts.delete(key) }
    if (method === "Runtime.executionContextCreated" && typeof params.context?.id === "number") {
      const aux = params.context.auxData as { frameId?: unknown; isDefault?: unknown } | undefined
      this.contexts.set(`${scope}${params.context.id}`, { ...(session ? { session } : {}), id: params.context.id,
        page: typeof aux?.frameId === "string" && aux.isDefault === true })
      if (this.contexts.size > DIAGNOSTICS.maxContexts) this.contexts.delete(this.contexts.keys().next().value!)
    } else if (method === "Runtime.executionContextDestroyed") this.contexts.delete(`${scope}${params.executionContextId}`)
    else if (method === "Runtime.executionContextsCleared") drop(scope)
    else if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") drop(`${params.sessionId}:`)
  }

  restart(): void {
    this.events.length = 0
    this.bytes = 0
    this.epoch++
    this.delivered = this.sequence
    this.lost = { messages: 0, requests: 0 }
  }

  read(after: number): DiagnosticRead {
    const first = this.events[0]?.sequence ?? this.sequence + 1
    const events: DiagnosticEvent[] = []
    let bytes = 0, next = Math.max(after, first - 1)
    for (const event of this.events) {
      if (event.sequence <= after) continue
      if (events.length >= DIAGNOSTICS.maxRead || bytes + event.bytes > DIAGNOSTICS.maxReadBytes) break
      events.push({ method: event.method, params: event.params, ...(event.session ? { session: event.session } : {}) })
      bytes += event.bytes
      next = event.sequence
    }
    this.delivered = Math.max(this.delivered, next)
    return { epoch: `${this.instance}:${this.epoch}`, events, next, lost: { ...this.lost }, more: next < this.sequence,
      contexts: [...this.contexts.values()] }
  }
}