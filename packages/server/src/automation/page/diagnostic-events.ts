import { randomUUID } from "node:crypto"

/** Console and network diagnostics of a native preview: the protocol domains a host enables on the
 * preview's own attachment and the raw events it keeps, bounded, for the backend to read. */
export const DIAGNOSTICS = {
  enable: [
    ["Runtime.enable", {}],
    ["Log.enable", {}],
    ["Network.enable", { maxTotalBufferSize: 5 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024, maxPostDataSize: 20_000 }],
  ] as [string, Record<string, unknown>][],
  events: [
    "Runtime.consoleAPICalled", "Runtime.exceptionThrown",
    "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
    "Log.entryAdded",
    "Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo", "Network.responseReceived", "Network.responseReceivedExtraInfo",
    "Network.loadingFinished", "Network.loadingFailed",
    "Network.webSocketCreated", "Network.webSocketWillSendHandshakeRequest", "Network.webSocketHandshakeResponseReceived",
    "Network.webSocketFrameError", "Network.webSocketClosed",
  ],
  /** Retained events and their JSON size; the oldest go first. */
  maxEvents: 4_000,
  maxBytes: 8 * 1024 * 1024,
  /** One read returns at most this many events and bytes; `more` asks for another. */
  maxRead: 1_000,
  maxReadBytes: 2 * 1024 * 1024,
}

export interface DiagnosticEvent { method: string; params: Record<string, unknown> }
/** One read: the events after `after`, the buffer epoch (another buffer, or a main-frame navigation that cleared
 * this one, gives another epoch) and how many events after `after` were already evicted. */
export interface DiagnosticRead { epoch: string; events: DiagnosticEvent[]; next: number; dropped: number; more: boolean }

/** The raw event buffer of one preview, cleared when a main-frame navigation starts a new document. */
export class DiagnosticEventBuffer {
  private readonly instance = randomUUID()
  private readonly events: Array<{ sequence: number; method: string; params: Record<string, unknown>; bytes: number }> = []
  private epoch = 0
  private sequence = 0
  /** The last sequence before the current epoch: a navigation's clear is no loss. */
  private epochStart = 0
  private bytes = 0

  record(method: string, params: unknown): void {
    if (!DIAGNOSTICS.events.includes(method) || !params || typeof params !== "object") return
    const bytes = JSON.stringify(params).length
    if (bytes > DIAGNOSTICS.maxReadBytes) return
    this.events.push({ sequence: ++this.sequence, method, params: params as Record<string, unknown>, bytes })
    this.bytes += bytes
    while (this.events.length > DIAGNOSTICS.maxEvents || this.bytes > DIAGNOSTICS.maxBytes) this.bytes -= this.events.shift()!.bytes
  }

  clear(): void {
    this.events.length = 0
    this.bytes = 0
    this.epoch++
    this.epochStart = this.sequence
  }

  read(after: number): DiagnosticRead {
    const first = this.events[0]?.sequence ?? this.sequence + 1
    const dropped = Math.max(0, first - Math.max(after, this.epochStart) - 1)
    const events: DiagnosticEvent[] = []
    let bytes = 0, next = Math.max(after, first - 1)
    for (const event of this.events) {
      if (event.sequence <= after) continue
      if (events.length >= DIAGNOSTICS.maxRead || bytes + event.bytes > DIAGNOSTICS.maxReadBytes) break
      events.push({ method: event.method, params: event.params })
      bytes += event.bytes
      next = event.sequence
    }
    return { epoch: `${this.instance}:${this.epoch}`, events, next, dropped, more: next < this.sequence }
  }
}
