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
  /** The events that feed a console entry, for counting losses; a lost network event loses its request. */
  messageEvents: ["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"],
  /** The events that end a request: losing one leaves the request unable to finish. */
  endingEvents: ["Network.loadingFinished", "Network.loadingFailed", "Network.webSocketClosed",
    "Network.webSocketHandshakeResponseReceived", "Network.webSocketFrameError"],
  /** Retained events and their UTF-8 JSON size per class (network events, and the others): the oldest of a class go
   * first, so a console flood never evicts a request's lifecycle. */
  maxEvents: 2_000,
  maxBytes: 4 * 1024 * 1024,
  /** Console text kept from an event too large to retain whole, as OpenCode's browser keeps an entry's text. */
  maxText: 2_000,
  /** One read returns at most this many events and bytes; `more` asks for another. */
  maxRead: 1_000,
  maxReadBytes: 2 * 1024 * 1024,
  /** Live execution contexts kept per preview; a page that creates more drops the oldest. */
  maxContexts: 512,
}

/** `session` names the out-of-process frame an event came from; the top-level document has none.
 * `timestampMs` records host capture time for events whose protocol payload carries no timestamp (WebSocket creation). */
export interface DiagnosticEvent { method: string; params: Record<string, unknown>; session?: string; timestampMs?: number }
/** Events the host evicted before any read returned them, counted for this epoch by the readout they would feed. */
export interface DiagnosticLoss { messages: number; requests: number }
/** A live execution context and whether it is a page world (a frame's default context). */
export interface DiagnosticContext { session?: string; id: number; page: boolean }
/** One read: the events after `after`, the buffer epoch (another buffer, or a document replacing this one's, gives
 * another epoch), the epoch's losses so far and the live execution contexts, which outlast both epochs and
 * evictions. */
export interface DiagnosticRead {
  epoch: string; events: DiagnosticEvent[]; next: number; lost: DiagnosticLoss; more: boolean; contexts: DiagnosticContext[]
  /** The requests (`${session}:${requestId}`, or `${session}:*` for every request of a detached frame) whose ending
   * event this epoch evicted unread: their readout cannot finish them. */
  lostRequests: string[]
}

/** The raw event buffer of one preview, restarted for each new document. */
export class DiagnosticEventBuffer {
  private readonly instance = randomUUID()
  private readonly events: Array<{ sequence: number; method: string; params: Record<string, unknown>; session?: string; timestampMs?: number; bytes: number }> = []
  private readonly contexts = new Map<string, DiagnosticContext>()
  private epoch = 0
  private sequence = 0
  /** The last sequence a read returned: evicting it or anything before it loses nothing. */
  private delivered = 0
  private lost: DiagnosticLoss = { messages: 0, requests: 0 }
  /** Requests this epoch lost an unread event of: the readout cannot finish them. */
  private readonly lostRequests = new Set<string>()
  /** Requests whose ending event was lost (or whose frame's detach was): they can no longer finish. */
  private readonly endedRequests = new Set<string>()
  private readonly classes = { network: { count: 0, bytes: 0 }, page: { count: 0, bytes: 0 } }

  record(method: string, params: unknown, session?: string): void {
    if (!DIAGNOSTICS.events.includes(method) || !params || typeof params !== "object") return
    this.track(method, params as Record<string, any>, session)
    let kept = params as Record<string, unknown>
    let bytes = Buffer.byteLength(JSON.stringify(kept))
    if (bytes > DIAGNOSTICS.maxReadBytes) {
      kept = shrink(method, kept)
      bytes = Buffer.byteLength(JSON.stringify(kept))
      if (bytes > DIAGNOSTICS.maxReadBytes) return this.lose(method, kept, session)
    }
    const kind = classOf(method)
    const timestampMs = method === "Network.webSocketCreated" ? Date.now() : undefined
    this.events.push({ sequence: ++this.sequence, method, params: kept, ...(session ? { session } : {}), ...(timestampMs !== undefined ? { timestampMs } : {}), bytes })
    const tally = this.classes[kind]
    tally.count++
    tally.bytes += bytes
    while (tally.count > DIAGNOSTICS.maxEvents || tally.bytes > DIAGNOSTICS.maxBytes) {
      const index = this.events.findIndex(event => classOf(event.method) === kind)
      const [evicted] = this.events.splice(index, 1)
      tally.count--
      tally.bytes -= evicted.bytes
      if (evicted.sequence > this.delivered) this.lose(evicted.method, evicted.params, evicted.session)
    }
  }

  private remember(set: Set<string>, key: string): boolean {
    if (set.has(key)) return false
    if (set.size >= DIAGNOSTICS.maxEvents) set.delete(set.values().next().value!)
    set.add(key)
    return true
  }

  private lose(method: string, params: Record<string, unknown>, session: string | undefined): void {
    if (DIAGNOSTICS.messageEvents.includes(method)) return void this.lost.messages++
    // A lost detach ends every request of its frame; a lost ending event ends its request. Other lost events only
    // leave a request incomplete, which the loss count reports. Both sets stay bounded, evicting the oldest so
    // newer ending losses remain tracked past maxEvents distinct losses.
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.remember(this.endedRequests, `${params.sessionId}:*`)
      return
    }
    if (classOf(method) !== "network" || typeof params.requestId !== "string") return
    const key = `${session ?? ""}:${params.requestId}`
    if (this.remember(this.lostRequests, key)) this.lost.requests++
    if (DIAGNOSTICS.endingEvents.includes(method)) this.remember(this.endedRequests, key)
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
    this.classes.network = { count: 0, bytes: 0 }
    this.classes.page = { count: 0, bytes: 0 }
    this.lostRequests.clear()
    this.endedRequests.clear()
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
      events.push({ method: event.method, params: event.params, ...(event.session ? { session: event.session } : {}), ...(event.timestampMs !== undefined ? { timestampMs: event.timestampMs } : {}) })
      bytes += event.bytes
      next = event.sequence
    }
    this.delivered = Math.max(this.delivered, next)
    return { epoch: `${this.instance}:${this.epoch}`, events, next, lost: { ...this.lost }, more: next < this.sequence,
      contexts: [...this.contexts.values()], lostRequests: [...this.endedRequests] }
  }
}

/** A frame's detach ends its requests, so it belongs with them: a console flood never evicts it. */
const classOf = (method: string): "network" | "page" => method.startsWith("Network.") || method === "Target.detachedFromTarget" ? "network" : "page"

/** An event too large to keep whole keeps its console text cut to `maxText`; other events stay as they are. */
function shrink(method: string, params: Record<string, any>): Record<string, unknown> {
  // One character more than the readout keeps, so it still reports the text as truncated.
  const cut = (value: unknown) => typeof value === "string" ? value.slice(0, DIAGNOSTICS.maxText + 1) : value
  if (method === "Runtime.consoleAPICalled" && Array.isArray(params.args))
    return { ...params, args: params.args.map((arg: Record<string, unknown>) => ({ ...arg, value: cut(arg.value), description: cut(arg.description), preview: undefined })) }
  if (method === "Runtime.exceptionThrown" && params.exceptionDetails) {
    const details = params.exceptionDetails
    return { ...params, exceptionDetails: { ...details, text: cut(details.text), exception: details.exception && { ...details.exception, description: cut(details.exception.description), preview: undefined } } }
  }
  if (method === "Log.entryAdded" && params.entry) return { ...params, entry: { ...params.entry, text: cut(params.entry.text) } }
  return params
}