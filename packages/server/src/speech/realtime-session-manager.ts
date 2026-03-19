import { randomUUID } from "node:crypto"
import { WebSocket } from "undici"
import type { SpeechRealtimeEvent, SpeechRealtimeSessionResponse } from "../api-types"
import type { Logger } from "../logger"
import type { SpeechService } from "./service"

interface CreateRealtimeSessionOptions {
  language?: string
  prompt?: string
}

interface TranscriptItemState {
  previousItemId?: string
  partialText: string
  finalText?: string
}

interface ManagedRealtimeSession {
  id: string
  ws: WebSocket
  subscribers: Set<(event: SpeechRealtimeEvent) => void>
  items: Map<string, TranscriptItemState>
  orderedItemIds: string[]
  nextFinalIndex: number
  createdAt: number
  lastActivityAt: number
  closed: boolean
}

const OPEN_TIMEOUT_MS = 10_000
const IDLE_TIMEOUT_MS = 2 * 60 * 1000
const SWEEP_INTERVAL_MS = 30_000

export class SpeechRealtimeSessionManager {
  private readonly sessions = new Map<string, ManagedRealtimeSession>()
  private readonly sweepTimer: NodeJS.Timeout

  constructor(
    private readonly speechService: SpeechService,
    private readonly logger: Logger,
  ) {
    this.sweepTimer = setInterval(() => {
      this.sweepIdleSessions()
    }, SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  async createSession(options: CreateRealtimeSessionOptions = {}): Promise<SpeechRealtimeSessionResponse> {
    const config = this.speechService.getRealtimeTranscriptionConfig()
    const id = randomUUID()
    const wsUrl = buildRealtimeWebSocketUrl(config.baseUrl, config.realtimeModel)
    const sessionUpdateEvent = buildSessionUpdateEvent(config, options)
    this.logger.info(
      {
        sessionId: id,
        wsUrl,
        realtimeModel: config.realtimeModel,
        sttModel: config.sttModel,
        payload: sessionUpdateEvent,
      },
      "Opening realtime speech websocket",
    )
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(requiresRealtimeBetaHeader(config.baseUrl) ? { "OpenAI-Beta": "realtime=v1" } : {}),
      },
    })

    const session: ManagedRealtimeSession = {
      id,
      ws,
      subscribers: new Set(),
      items: new Map(),
      orderedItemIds: [],
      nextFinalIndex: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      closed: false,
    }

    this.sessions.set(id, session)
    this.attachSocketHandlers(session)

    try {
      await waitForSocketOpen(ws)
      this.send(session, sessionUpdateEvent)
      return {
        sessionId: id,
        inputFormat: config.inputFormat,
      }
    } catch (error) {
      this.logger.error({ sessionId: id, err: error }, "Failed to create realtime speech session")
      this.closeSession(id, error instanceof Error ? error.message : "Failed to create realtime speech session")
      throw error
    }
  }

  subscribe(sessionId: string, send: (event: SpeechRealtimeEvent) => void): () => void {
    const session = this.getSession(sessionId)
    if (!session) {
      throw new Error("Realtime speech session not found")
    }

    session.subscribers.add(send)
    this.touch(session)
    send({ type: "session.ready", sessionId })

    return () => {
      session.subscribers.delete(send)
      this.touch(session)
    }
  }

  appendAudio(sessionId: string, audioBase64: string): void {
    const session = this.requireSession(sessionId)
    this.send(session, {
      type: "input_audio_buffer.append",
      audio: audioBase64,
    })
  }

  finalize(sessionId: string): void {
    const session = this.requireSession(sessionId)
    this.send(session, {
      type: "input_audio_buffer.commit",
    })
  }

  closeSession(sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return

    session.closed = true
    this.sessions.delete(sessionId)
    this.emit(session, { type: "session.closed", reason })

    try {
      if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
        session.ws.close(1000, reason?.slice(0, 120) ?? "client_closed")
      }
    } catch (error) {
      this.logger.warn({ sessionId, err: error }, "Failed to close realtime speech websocket")
    }

    session.subscribers.clear()
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweepTimer)
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.closeSession(sessionId, "server_shutdown")
    }
  }

  private attachSocketHandlers(session: ManagedRealtimeSession) {
    session.ws.addEventListener("message", (event) => {
      void this.handleSocketMessage(session, event.data)
    })

    session.ws.addEventListener("error", (event) => {
      const message = event.error instanceof Error ? event.error.message : event.message || "Realtime speech connection failed"
      this.logger.warn({ sessionId: session.id, err: event.error ?? event.message }, "Realtime speech websocket error")
      this.emit(session, { type: "session.error", message })
    })

    session.ws.addEventListener("close", (event) => {
      const reason = event.reason || (event.wasClean ? "socket_closed" : "socket_terminated")
      this.logger.info(
        {
          sessionId: session.id,
          code: event.code,
          reason,
          orderedItemIds: session.orderedItemIds,
          pendingItems: Array.from(session.items.entries()).map(([itemId, item]) => ({
            itemId,
            previousItemId: item.previousItemId,
            partialText: item.partialText,
            finalText: item.finalText,
          })),
        },
        "Realtime speech websocket closed",
      )
      this.closeSession(session.id, reason)
    })
  }

  private async handleSocketMessage(session: ManagedRealtimeSession, raw: unknown) {
    if (session.closed) return

    try {
      const payload = await toText(raw)
      const event = JSON.parse(payload) as Record<string, unknown>
      this.touch(session)
      this.handleServerEvent(session, event)
    } catch (error) {
      this.logger.warn({ sessionId: session.id, err: error }, "Failed to process realtime speech event")
    }
  }

  private handleServerEvent(session: ManagedRealtimeSession, event: Record<string, unknown>) {
    const type = typeof event.type === "string" ? event.type : ""
    if (!type) return

    this.logger.debug({ sessionId: session.id, type }, "Realtime speech event received")
    if (type.startsWith("conversation.item") || type.startsWith("input_audio_buffer") || type.startsWith("session.")) {
      this.logger.debug({ sessionId: session.id, event }, "Realtime speech event payload")
    }

    if (type === "error") {
      const message = extractErrorMessage(event)
      this.logger.warn({ sessionId: session.id, event }, "Realtime speech provider error event")
      this.emit(session, { type: "session.error", message })
      return
    }

    if (type === "input_audio_buffer.speech_started") {
      this.emit(session, {
        type: "input.speech_started",
        itemId: readString(event.item_id),
      })
      return
    }

    if (type === "input_audio_buffer.speech_stopped") {
      this.emit(session, {
        type: "input.speech_stopped",
        itemId: readString(event.item_id),
      })
      return
    }

    if (type === "input_audio_buffer.committed") {
      const itemId = readString(event.item_id)
      if (!itemId) return
      const item = this.getOrCreateItem(session, itemId)
      item.previousItemId = readString(event.previous_item_id)
      if (!session.orderedItemIds.includes(itemId)) {
        session.orderedItemIds.push(itemId)
      }
      this.flushFinalizedItems(session)
      return
    }

    if (type === "conversation.item.created" || type === "conversation.item.added" || type === "conversation.item.done") {
      this.handleConversationItemEvent(session, event)
      return
    }

    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = readString(event.item_id)
      const delta = readString(event.delta)
      if (!itemId || !delta) return
      const item = this.getOrCreateItem(session, itemId)
      item.partialText += delta
      this.emit(session, {
        type: "transcript.partial",
        itemId,
        text: item.partialText,
      })
      return
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = readString(event.item_id)
      if (!itemId) return
      const item = this.getOrCreateItem(session, itemId)
      item.finalText = readString(event.transcript) ?? item.partialText
      this.flushFinalizedItems(session)
    }
  }

  private handleConversationItemEvent(session: ManagedRealtimeSession, event: Record<string, unknown>) {
    const itemRecord = asRecord(event.item)
    if (!itemRecord) return

    const itemId = readString(itemRecord.id) ?? readString(event.item_id)
    if (!itemId) return

    const item = this.getOrCreateItem(session, itemId)
    item.previousItemId = readString(event.previous_item_id) ?? item.previousItemId
    if (!session.orderedItemIds.includes(itemId)) {
      session.orderedItemIds.push(itemId)
    }

    const transcript = extractTranscriptFromConversationItem(itemRecord)
    if (transcript) {
      item.finalText = transcript
      this.flushFinalizedItems(session)
    }
  }

  private flushFinalizedItems(session: ManagedRealtimeSession) {
    while (session.nextFinalIndex < session.orderedItemIds.length) {
      const itemId = session.orderedItemIds[session.nextFinalIndex]
      const item = session.items.get(itemId)
      if (!item || item.finalText === undefined) {
        return
      }

      this.emit(session, {
        type: "transcript.final",
        itemId,
        previousItemId: item.previousItemId,
        text: item.finalText,
      })
      session.nextFinalIndex += 1
    }
  }

  private getOrCreateItem(session: ManagedRealtimeSession, itemId: string): TranscriptItemState {
    const existing = session.items.get(itemId)
    if (existing) return existing
    const created: TranscriptItemState = { partialText: "" }
    session.items.set(itemId, created)
    return created
  }

  private emit(session: ManagedRealtimeSession, event: SpeechRealtimeEvent) {
    for (const subscriber of session.subscribers) {
      try {
        subscriber(event)
      } catch (error) {
        this.logger.warn({ sessionId: session.id, err: error, type: event.type }, "Failed to emit realtime speech event")
      }
    }
  }

  private requireSession(sessionId: string): ManagedRealtimeSession {
    const session = this.getSession(sessionId)
    if (!session) {
      throw new Error("Realtime speech session not found")
    }
    return session
  }

  private getSession(sessionId: string): ManagedRealtimeSession | null {
    const session = this.sessions.get(sessionId) ?? null
    if (!session || session.closed) return null
    return session
  }

  private send(session: ManagedRealtimeSession, event: Record<string, unknown>) {
    if (session.closed || session.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime speech session is not connected")
    }

    session.ws.send(JSON.stringify(event))
    this.touch(session)
  }

  private touch(session: ManagedRealtimeSession) {
    session.lastActivityAt = Date.now()
  }

  private sweepIdleSessions() {
    const now = Date.now()
    for (const [sessionId, session] of this.sessions) {
      if (session.closed) continue
      if (now - session.lastActivityAt < IDLE_TIMEOUT_MS) continue
      this.logger.info({ sessionId }, "Closing idle realtime speech session")
      this.closeSession(sessionId, "idle_timeout")
    }
  }
}

function buildRealtimeWebSocketUrl(baseUrl: string | undefined, model: string): string {
  const target = new URL(baseUrl?.trim() || "https://api.openai.com/v1")
  target.protocol = target.protocol === "http:" ? "ws:" : "wss:"
  const normalizedPath = target.pathname.replace(/\/+$/, "")
  target.pathname = normalizedPath.endsWith("/realtime") ? normalizedPath : `${normalizedPath}/realtime`
  target.hash = ""
  if (!target.searchParams.has("model")) {
    target.searchParams.set("model", model)
  }
  return target.toString()
}

function requiresRealtimeBetaHeader(baseUrl?: string): boolean {
  if (!baseUrl || !baseUrl.trim()) return false
  try {
    return new URL(baseUrl).hostname.toLowerCase() !== "api.openai.com"
  } catch {
    return false
  }
}

function buildSessionUpdateEvent(
  config: { baseUrl?: string; sttModel: string; realtimeModel: string; inputFormat: { type: "audio/pcm"; rate: 24000 } },
  options: CreateRealtimeSessionOptions,
): Record<string, unknown> {
  if (requiresRealtimeBetaHeader(config.baseUrl)) {
    return {
      type: "session.update",
      session: {
        input_audio_transcription: {
          model: config.sttModel,
          ...(options.language ? { language: options.language } : {}),
          ...(options.prompt ? { prompt: options.prompt } : {}),
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.45,
          prefix_padding_ms: 250,
          silence_duration_ms: 400,
        },
      },
    }
  }

  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: config.inputFormat,
          noise_reduction: { type: "near_field" },
          transcription: {
            model: config.sttModel,
            ...(options.language ? { language: options.language } : {}),
            ...(options.prompt ? { prompt: options.prompt } : {}),
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.45,
            prefix_padding_ms: 250,
            silence_duration_ms: 400,
          },
        },
      },
    },
  }
}

function waitForSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out connecting to realtime speech provider"))
    }, OPEN_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("open", handleOpen)
      ws.removeEventListener("error", handleError)
      ws.removeEventListener("close", handleClose)
    }

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }

    const handleOpen = () => {
      finish(resolve)
    }

    const handleError = (event: { error?: unknown; message?: string }) => {
      finish(() => reject(event.error instanceof Error ? event.error : new Error(event.message || "Failed to connect")))
    }

    const handleClose = () => {
      finish(() => reject(new Error("Realtime speech connection closed before initialization")))
    }

    ws.addEventListener("open", handleOpen)
    ws.addEventListener("error", handleError as any)
    ws.addEventListener("close", handleClose)
  })
}

async function toText(data: unknown): Promise<string> {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8")
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8")
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer()).toString("utf-8")
  }
  return String(data ?? "")
}

function extractErrorMessage(event: Record<string, unknown>): string {
  const error = event.error
  if (error && typeof error === "object") {
    const message = readString((error as Record<string, unknown>).message)
    if (message) return message
  }
  return readString(event.message) ?? "Realtime speech request failed"
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function extractTranscriptFromConversationItem(item: Record<string, unknown>): string | undefined {
  const directTranscript = readString(item.transcript) ?? readString(item.text)
  if (directTranscript) return directTranscript

  const content = Array.isArray(item.content) ? item.content : []
  for (const part of content) {
    const record = asRecord(part)
    if (!record) continue
    const transcript =
      readString(record.transcript) ??
      readString(record.text) ??
      readString(asRecord(record.audio)?.transcript)
    if (transcript) {
      return transcript
    }
  }

  return undefined
}
