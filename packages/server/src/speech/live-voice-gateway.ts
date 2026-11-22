import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import { performance } from "node:perf_hooks"
import WebSocket, { WebSocketServer } from "ws"
import { isLoopbackHost } from "../server/network-host"
import {
  LIVE_VOICE_ABSOLUTE_MS, LIVE_VOICE_CLIENT_BYTES, LIVE_VOICE_ESTABLISH_MS, LIVE_VOICE_IDLE_MS, LIVE_VOICE_PATH,
  LIVE_VOICE_PROVIDER_BYTES, liveVoiceEngine, liveVoiceInputRate, type LiveVoiceContext, type LiveVoiceEndReason,
} from "./live-voice-contract"
import { pcmBytes, readClientMessage, readObject, type JsonObject } from "./live-voice-messages"
import { voiceProviderConnection, voiceProviderProtocol } from "./live-voice-provider"
import type { SpeechService } from "./service"

export { LIVE_VOICE_ESTABLISH_MS } from "./live-voice-contract"
const MAX_SESSIONS = 4
const MAX_QUEUE = 2 * LIVE_VOICE_PROVIDER_BYTES
export const VOICE_WS_OPTIONS = { perMessageDeflate: false, maxFragments: 256, maxBufferedChunks: 1024, closeTimeout: 1000 }

export const isLiveVoiceRoute = (target: string | undefined) => target?.split("?", 1)[0] === LIVE_VOICE_PATH

export function voiceSource(origin: string | undefined): URL | undefined {
  if (!origin) return
  try {
    const url = new URL(origin)
    if (url.origin === origin && !url.hostname.replace(/\.$/, "").endsWith(".preview.localhost")
      && (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname)))) return url
  } catch { /* invalid or opaque */ }
}

export function refuseVoiceUpgrade(socket: Socket, status: "401 Unauthorized" | "403 Forbidden" | "404 Not Found") {
  if (socket.destroyed) return
  if (!socket.writable) { socket.destroy(); return }
  const close = () => socket.destroy()
  socket.once("error", close)
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, close)
}

// Browsers cannot read the HTTP status of a rejected WebSocket handshake.
export function closeBusyVoiceUpgrade(server: WebSocketServer, request: IncomingMessage, socket: Socket, head: Buffer) {
  server.handleUpgrade(request, socket, head, client => {
    client.on("error", () => client.terminate())
    client.close(4000, "busy")
  })
}

interface LiveVoicePrincipal {
  identity: string
  watchRevocation?(close: () => void): () => void
}

/** Budget valid audio at slightly above real time, with one second of jitter tolerance. */
function budget(capacity: number, perSecond: number) {
  let tokens = capacity
  let last = performance.now()
  return (cost: number) => {
    const now = performance.now()
    tokens = Math.min(capacity, tokens + (now - last) * perSecond / 1000)
    last = now
    tokens -= cost
    return tokens >= 0
  }
}

interface Options {
  connect?: (url: URL, options: WebSocket.ClientOptions) => WebSocket
  establishMs?: number
  idleMs?: number
  absoluteMs?: number
}

export class LiveVoiceGateway {
  private readonly server = new WebSocketServer({ ...VOICE_WS_OPTIONS,
    noServer: true, clientTracking: false, maxPayload: LIVE_VOICE_CLIENT_BYTES,
  })
  private readonly identities = new Set<string>()
  private readonly connect: NonNullable<Options["connect"]>

  constructor(private readonly speech: Pick<SpeechService, "getVoiceConversationProvider">, private readonly options: Options = {}) {
    this.connect = options.connect ?? ((url, options) => new WebSocket(url, options))
  }

  upgrade(request: IncomingMessage, socket: Socket, head: Buffer, principal: LiveVoicePrincipal): void {
    const engine = liveVoiceEngine(request.url)
    if (!engine || request.method !== "GET" || request.headers["sec-websocket-protocol"] !== undefined) {
      refuseVoiceUpgrade(socket, "404 Not Found")
      return
    }
    if (this.identities.has(principal.identity) || this.identities.size >= MAX_SESSIONS) {
      closeBusyVoiceUpgrade(this.server, request, socket, head)
      return
    }
    this.server.handleUpgrade(request, socket, head, client => {
      this.identities.add(principal.identity)
      client.once("close", () => this.identities.delete(principal.identity))
      let configured
      try { configured = this.speech.getVoiceConversationProvider(engine) } catch { /* no configuration details on this wire */ }
      if (!configured || configured.provider !== (engine === "gemini-live" ? "geminiLive" : "openaiRealtime")) {
        client.on("error", () => client.terminate())
        client.close(4000, "unconfigured")
        return
      }
      const settings = configured
      const encodedKey = JSON.stringify(settings.apiKey).slice(1, -1)
      const uriKey = new URLSearchParams({ key: settings.apiKey }).toString().slice(4)
      let upstream: WebSocket | undefined
      let stopWatching: (() => void) | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let stopped = false
      const timeout = (fn: () => void, ms: number) => setTimeout(fn, ms).unref()
      const establishMs = this.options.establishMs ?? LIVE_VOICE_ESTABLISH_MS
      const idleMs = this.options.idleMs ?? LIVE_VOICE_IDLE_MS
      const stop = (reason: LiveVoiceEndReason, hard = false) => {
        if (stopped) return
        stopped = true
        clearTimeout(setupTimer)
        clearTimeout(absoluteTimer)
        clearTimeout(idleTimer)
        stopWatching?.()
        upstream?.terminate()
        if (hard || client.bufferedAmount > MAX_QUEUE) client.terminate()
        else if (client.readyState === WebSocket.OPEN) client.close(reason === "stopped" ? 1000 : 4000, reason)
      }
      const setupTimer = timeout(() => stop("setup-timeout"), establishMs)
      const absoluteTimer = timeout(() => stop("duration"), this.options.absoluteMs ?? LIVE_VOICE_ABSOLUTE_MS)
      const resetIdle = () => {
        if (stopped) return
        clearTimeout(idleTimer)
        idleTimer = timeout(() => stop("idle"), idleMs)
      }
      // Never return provider messages, errors, close reasons or request URLs verbatim.
      const send = (target: WebSocket | undefined, value: JsonObject, limit: number) => {
        if (stopped) return
        const message = JSON.stringify(value)
        const bytes = Buffer.byteLength(message)
        if (!target || target.readyState !== WebSocket.OPEN) return stop("connection")
        if (bytes > limit || target.bufferedAmount + bytes > MAX_QUEUE) return stop("limit")
        if (target === client && (message.includes(encodedKey) || message.includes(uriKey))) return stop("provider-error")
        target.send(message, error => { if (error) stop("connection", true) })
      }
      let protocol: ReturnType<typeof voiceProviderProtocol> | undefined
      function createProtocol(context: LiveVoiceContext) {
        return voiceProviderProtocol(settings, context, {
          send: event => send(upstream, event, LIVE_VOICE_CLIENT_BYTES + 1024),
          emit: event => {
            if (event.type === "ready") { clearTimeout(setupTimer); resetIdle() }
            send(client, event, LIVE_VOICE_PROVIDER_BYTES)
          },
          speech: () => { resetIdle(); send(client, { type: "activity" }, LIVE_VOICE_PROVIDER_BYTES) },
          stop,
        })
      }
      const clientMessages = budget(120, 120)
      const audioBytesPerSecond = liveVoiceInputRate(engine) * 2
      const audioRate = budget(audioBytesPerSecond, audioBytesPerSecond * 1.1)
      const clientData = budget(128 * 1024, 128 * 1024)
      const providerMessages = budget(512, 256)
      const providerData = budget(1024 * 1024, 1024 * 1024)
      const clientControl = budget(20, 5)
      client.on("ping", () => { if (!clientControl(1)) stop("limit", true) })
      client.on("pong", () => { if (!clientControl(1)) stop("limit", true) })
      client.on("message", (data, binary) => {
        if (stopped) return
        if (!clientMessages(1) || !clientData(rawBytes(data))) return stop("limit")
        const decoded = binary ? undefined : readObject(data)
        const value = decoded && readClientMessage(decoded)
        if (!value) return stop("invalid-message")
        if (value.type === "stop") return stop("stopped")
        if (value.type === "start") {
          if (protocol) return stop("invalid-message")
          startProvider(value.context)
          return
        }
        if (!protocol) return stop("invalid-message")
        if (value.type === "audio" && !audioRate(pcmBytes(value.pcm))) return stop("limit")
        protocol.client(value)
      })
      client.on("error", () => stop("invalid-message", true))
      client.once("close", () => stop("stopped"))
      stopWatching = principal.watchRevocation?.(() => stop("revoked"))
      if (stopped) { stopWatching?.(); return }
      const startProvider = (context: LiveVoiceContext) => {
        const active = protocol = createProtocol(context)
        const connection = voiceProviderConnection(settings)
        try {
          upstream = this.connect(connection.url, { ...VOICE_WS_OPTIONS,
            headers: connection.headers, maxPayload: LIVE_VOICE_PROVIDER_BYTES, handshakeTimeout: establishMs,
            followRedirects: false, rejectUnauthorized: true,
          })
          upstream.once("open", () => { if (!stopped) active.opened() })
          upstream.on("error", () => stop("provider-error"))
          upstream.once("close", () => stop("provider-disconnected"))
          upstream.on("message", (data, binary) => {
            if (stopped) return
            if (!providerMessages(1) || !providerData(rawBytes(data))) return stop("limit")
            const decoded = (settings.provider === "geminiLive" || !binary) && readObject(data)
            if (!decoded) return stop("provider-error")
            active.receive(decoded)
          })
        } catch { stop("provider-error") }
      }
    })
  }
}

export function rawBytes(data: WebSocket.RawData): number {
  return Array.isArray(data) ? data.reduce((bytes, part) => bytes + part.byteLength, 0) : data.byteLength
}
