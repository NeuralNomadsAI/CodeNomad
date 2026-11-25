import { randomUUID } from "node:crypto"
import type { DiagnosticLoss, DiagnosticRead } from "../../automation/page/diagnostic-events"
import {
  evictHop, extensionSource, MAX_RETAINED_REQUESTS, MAX_STASHED_CHAINS, networkRequest, requestBody, responseBody, transitionChain,
  type Body, type Chain, type ChainEvent, type Headers, type Hop, type NetworkRequest, type RequestEvent, type ResourceType, type StackTrace,
} from "./diagnostics-machine"

// Console and network readouts of one preview, built like OpenCode's desktop browser
// (packages/gui-plugins/src/browser/diagnostics.ts, v2.4.1) from the raw events its host keeps.
// Copyright (c) 2025 opencode. MIT License: the full notice is in THIRD_PARTY_NOTICES.md.

const LEVELS = ["debug", "info", "warning", "error"] as const
type Level = (typeof LEVELS)[number]
const MAX_TEXT = 100_000, MAX_BODY_CHARS = 20_000
export interface ConsoleEntry {
  id: string; timestampMs: number; level: Level; text: string; textTruncated: boolean
  source?: { url: string; line: number; column: number }
}
type Params = Record<string, any>
/** Reads a retained response body by its protocol request ID; undefined when the browser no longer has it. */
export type FetchBody = (nativeID: string, session: string | undefined) => Promise<{ body?: unknown; base64Encoded?: unknown } | undefined>

export class PreviewDiagnostics {
  /** The native buffer read last, and the last sequence taken from it. */
  epoch: string | undefined
  cursor = 0
  private readonly messages: ConsoleEntry[] = []
  /** Every hop by its public ID, oldest first. */
  private readonly requests = new Map<string, Hop>()
  /** Hops per protocol session and request ID, keyed `${session}:${requestId}`. */
  private readonly chains = new Map<string, Chain>()
  /** Request IDs that hold only queued ExtraInfo, oldest first. */
  private readonly stashed = new Set<string>()
  /** Execution contexts per session, and whether each is a page world (a frame's default context); console calls
   * from other worlds or unknown contexts are not the page's, as in OpenCode's browser. */
  private readonly contexts = new Map<string, boolean>()
  private readonly scope = randomUUID()
  private sequence = 0
  private droppedMessages = 0
  private droppedRequests = 0
  private lost: DiagnosticLoss = { messages: 0, requests: 0 }

  /** Takes one read of the host's buffer. Another epoch means another document or buffer: it restarts from its start. */
  ingest(read: DiagnosticRead): boolean {
    if (read.epoch !== this.epoch) {
      const restart = this.epoch !== undefined && this.cursor > 0
      this.clear()
      this.epoch = read.epoch
      if (restart) return false
    }
    // The host counts each epoch's lost console entries and requests; only their growth is new.
    this.droppedMessages += Math.max(0, read.lost.messages - this.lost.messages)
    this.droppedRequests += Math.max(0, read.lost.requests - this.lost.requests)
    this.lost = { ...read.lost }
    // The host's live contexts cover those whose creation this readout never saw (an earlier epoch or an eviction).
    for (const context of read.contexts) this.contexts.set(`${context.session ?? ""}:${context.id}`, context.page)
    for (const event of read.events) this.apply(event.method, event.params as Params, event.session, event.timestampMs)
    // A request whose later events the host evicted unread would stay pending: it ends as failed, with the reason.
    for (const key of read.lostRequests ?? []) {
      // `${session}:*`: the frame's lost detach ends each of its requests, as a received one would.
      if (key.endsWith(":*")) {
        for (const chain of [...this.chains.keys()]) if (chain.startsWith(key.slice(0, -1))) this.transition(chain, { type: "detached" })
      } else if (this.chains.has(key)) this.transition(key, { type: "detached", failure: "The preview did not keep this request's later events." })
    }
    // Once the buffer is read up to now, the host's live set is exact: contexts it no longer has are gone.
    if (!read.more) {
      const live = new Set(read.contexts.map(context => `${context.session ?? ""}:${context.id}`))
      for (const key of this.contexts.keys()) if (!live.has(key)) this.contexts.delete(key)
    }
    this.cursor = read.next
    return true
  }

  console(input: { level?: Level; limit?: number }) {
    const matching = this.messages.filter(entry => LEVELS.indexOf(entry.level) >= LEVELS.indexOf(input.level ?? "info"))
    const messages = bounded(matching, input.limit ?? 100)
    return { messages, truncated: matching.length > messages.length, dropped: this.droppedMessages }
  }

  list(input: { urlContains?: string; resourceType?: ResourceType; limit?: number }) {
    const matching = [...this.requests.values()]
      .filter(hop => !hop.extension && (!input.urlContains || hop.url.includes(input.urlContains)) && (!input.resourceType || input.resourceType === hop.resourceType))
      .map(networkRequest)
    const requests = bounded(matching, input.limit ?? 100)
    return { requests, truncated: matching.length > requests.length, dropped: this.droppedRequests }
  }

  async get(input: { id: string; includeBody?: boolean; includeResponseBody?: boolean; maxBodyChars?: number }, fetch: FetchBody) {
    const hop = this.requests.get(input.id)
    if (!hop || hop.extension) throw new Error("Request ID is no longer retained in this tab or belongs to another tab. Call browser.network.list({tabID}) and copy a current id into browser.network.get with the same tabID. Do not reload or resend a request just to inspect it.")
    const max = Math.min(MAX_BODY_CHARS, input.maxBodyChars ?? MAX_BODY_CHARS)
    const fetchBody = async (): Promise<Body> => {
      const body = await fetch(hop.nativeID, hop.sessionID).catch(error => {
        // The page changed under the read: the request belongs to the previous document.
        if (/document changed|target is stale|no longer current/i.test(error instanceof Error ? error.message : String(error))) throw error
        return undefined
      })
      if (!body || typeof body.body !== "string") return { state: "unavailable", reason: "backendUnavailable" }
      const value = body.base64Encoded === true ? Buffer.from(body.body, "base64").toString("utf8") : body.body
      return value.length ? { state: "text", text: value.slice(0, max), truncated: value.length > max } : { state: "empty" }
    }
    const known = responseBody(hop, input.includeResponseBody ?? input.includeBody)
    return {
      request: networkRequest(hop) as NetworkRequest,
      requestHeaders: headerEntries(hop.request.headers),
      responseHeaders: headerEntries(hop.response?.headers ?? {}),
      headersTruncated: hop.headersTruncated,
      requestBody: requestBody(hop, input.includeBody, max),
      responseBody: known === "fetch" ? await fetchBody() : known,
    }
  }

  /** A new tab starts with no entries; the host buffer's position and contexts carry on. */
  forget(): void {
    this.messages.length = 0
    this.requests.clear()
    this.chains.clear()
    this.stashed.clear()
    this.droppedMessages = 0
    this.droppedRequests = 0
  }

  private clear(): void {
    this.messages.length = 0
    this.requests.clear()
    this.chains.clear()
    this.stashed.clear()
    this.contexts.clear()
    this.droppedMessages = 0
    this.droppedRequests = 0
    this.lost = { messages: 0, requests: 0 }
    this.cursor = 0
  }

  private add(level: Level, text: string, timestampMs: number, source?: ConsoleEntry["source"]) {
    const entry: ConsoleEntry = { id: `${this.scope}:${++this.sequence}`, timestampMs, level, text: text.slice(0, 2_000), textTruncated: text.length > 2_000 }
    this.messages.push(source ? { ...entry, source } : entry)
    if (this.messages.length > 500) { this.messages.shift(); this.droppedMessages++ }
  }

  private page(context: unknown, session: string | undefined) {
    return typeof context !== "number" || this.contexts.get(`${session ?? ""}:${context}`) === true
  }

  private apply(method: string, event: Params, session: string | undefined, timestampMs: number | undefined): void {
    switch (method) {
      case "Runtime.executionContextCreated":
        if (typeof event.context?.id === "number") this.contexts.set(`${session ?? ""}:${event.context.id}`,
          typeof event.context.auxData?.frameId === "string" && event.context.auxData.isDefault === true)
        return
      case "Runtime.executionContextDestroyed": this.contexts.delete(`${session ?? ""}:${event.executionContextId}`); return
      case "Runtime.executionContextsCleared":
        for (const key of this.contexts.keys()) if (key.startsWith(`${session ?? ""}:`)) this.contexts.delete(key)
        return
      // An out-of-process frame that detaches never finishes its requests.
      case "Target.detachedFromTarget":
        for (const key of [...this.chains.keys()]) if (key.startsWith(`${event.sessionId}:`)) this.transition(key, { type: "detached" })
        for (const key of this.contexts.keys()) if (key.startsWith(`${event.sessionId}:`)) this.contexts.delete(key)
        return
      case "Runtime.consoleAPICalled": {
        if (!this.page(event.executionContextId, session) || extensionSource(undefined, event.stackTrace as StackTrace | undefined)) return
        const source = event.stackTrace?.callFrames?.[0]
        const type = event.type
        this.add(type === "error" || type === "assert" ? "error" : type === "warning" ? "warning" : type === "debug" ? "debug" : "info",
          (Array.isArray(event.args) ? event.args : []).map((arg: Params) => arg.type === "string" ? String(arg.value)
            : arg.value !== undefined ? JSON.stringify(arg.value) : String(arg.description ?? arg.unserializableValue ?? arg.type)).join(" "),
          Number(event.timestamp) || Date.now(),
          source ? { url: String(source.url).slice(0, MAX_TEXT), line: source.lineNumber + 1, column: source.columnNumber + 1 } : undefined)
        return
      }
      // Chromium's own messages (CSP refusals, mixed content, failed resource loads, deprecations)
      // are Log entries, not Runtime console calls.
      case "Log.entryAdded": {
        const entry = event.entry ?? {}
        if (extensionSource(entry.url, entry.stackTrace)) return
        const level: Level = entry.level === "verbose" ? "debug" : LEVELS.includes(entry.level) ? entry.level : "info"
        this.add(level, String(entry.text ?? ""), Number(entry.timestamp) || Date.now(),
          entry.url ? { url: String(entry.url).slice(0, MAX_TEXT), line: (entry.lineNumber ?? 0) + 1, column: 1 } : undefined)
        return
      }
      case "Runtime.exceptionThrown": {
        const error = event.exceptionDetails ?? {}
        if ((error.executionContextId !== undefined && !this.page(error.executionContextId, session)) || extensionSource(error.url, error.stackTrace)) return
        this.add("error", String(error.exception?.description ?? error.text ?? ""), Number(event.timestamp) || Date.now(),
          error.url ? { url: String(error.url).slice(0, MAX_TEXT), line: error.lineNumber + 1, column: error.columnNumber + 1 } : undefined)
        return
      }
    }
    const change = chainEvent(method, event, session, () => `${this.scope}:${++this.sequence}`, timestampMs)
    if (change && typeof event.requestId === "string") this.transition(`${session ?? ""}:${event.requestId}`, change)
  }

  private transition(key: string, event: ChainEvent) {
    const previous = this.chains.get(key)
    const next = transitionChain(previous, event)
    if (next === previous) return
    if (!next) { this.chains.delete(key); this.stashed.delete(key); return }
    this.chains.set(key, next)
    if (!next.hops.length) {
      this.stashed.add(key)
      const oldest = this.stashed.values().next().value
      if (this.stashed.size > MAX_STASHED_CHAINS && oldest !== undefined) { this.stashed.delete(oldest); this.chains.delete(oldest) }
      return
    }
    this.stashed.delete(key)
    next.hops.forEach((hop, index) => { if (previous?.hops[index] !== hop) this.requests.set(hop.id, hop) })
    while (this.requests.size > MAX_RETAINED_REQUESTS) {
      const first = this.requests.values().next().value
      if (!first) break
      this.requests.delete(first.id)
      this.droppedRequests++
      const key = `${first.sessionID ?? ""}:${first.nativeID}`
      const chain = this.chains.get(key)
      const rest = chain && evictHop(chain, first.id)
      if (rest) this.chains.set(key, rest)
      else this.chains.delete(key)
    }
  }
}

function chainEvent(method: string, event: Params, sessionID: string | undefined, id: () => string, timestampMs: number | undefined): ChainEvent | undefined {
  switch (method) {
    case "Network.requestWillBeSent": return { type: "request", id: id(), sessionID, event: event as RequestEvent }
    case "Network.requestWillBeSentExtraInfo": return { type: "request.extra", headers: (event.headers ?? {}) as Headers }
    case "Network.responseReceived": return { type: "response", event: event as Extract<ChainEvent, { type: "response" }>["event"] }
    case "Network.responseReceivedExtraInfo": return { type: "response.extra", wire: { headers: (event.headers ?? {}) as Headers, statusCode: Number(event.statusCode) } }
    // WebSockets never emit requestWillBeSent; their handshake is the whole request lifecycle.
    case "Network.webSocketCreated": return { type: "ws.created", id: id(), sessionID, event: event as Extract<ChainEvent, { type: "ws.created" }>["event"], wallTime: (timestampMs ?? Date.now()) / 1000 }
    case "Network.webSocketWillSendHandshakeRequest": return { type: "ws.request", event: event as Extract<ChainEvent, { type: "ws.request" }>["event"] }
    case "Network.webSocketHandshakeResponseReceived": return { type: "ws.response", event: event as Extract<ChainEvent, { type: "ws.response" }>["event"] }
    case "Network.webSocketFrameError": return { type: "ws.error", timestamp: event.timestamp, message: String(event.errorMessage ?? "") }
    case "Network.webSocketClosed": return { type: "ws.closed", timestamp: event.timestamp }
    case "Network.loadingFinished": return { type: "finished", timestamp: event.timestamp }
    case "Network.loadingFailed": return { type: "failed", timestamp: event.timestamp, errorText: String(event.errorText ?? "") }
  }
}

function bounded<Item>(items: readonly Item[], limit: number) {
  const selected: Item[] = []
  let size = 0
  for (const item of items.slice(-limit).reverse()) {
    size += JSON.stringify(item).length
    if (size > MAX_TEXT) break
    selected.push(item)
  }
  return selected.reverse()
}

function headerEntries(headers: Headers) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}
