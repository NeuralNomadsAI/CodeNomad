import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import {
  LIVE_VOICE_CLIENT_BYTES, LIVE_VOICE_PROVIDER_BYTES, liveVoiceEngine, type LiveVoiceEndReason,
} from "../speech/live-voice-contract"
import { LIVE_VOICE_ESTABLISH_MS, VOICE_WS_OPTIONS, closeBusyVoiceUpgrade, rawBytes, refuseVoiceUpgrade } from "../speech/live-voice-gateway"
import { readClientMessage, readObject } from "../speech/live-voice-messages"
import { proxyDestination } from "./proxy-destination"

// Project gateways validate content and own provider quotas. The window proxy admits
// only this transport and relays complete bounded text messages, never raw upgrade bytes.
const server = new WebSocketServer({ ...VOICE_WS_OPTIONS,
  noServer: true, clientTracking: false, maxPayload: LIVE_VOICE_CLIENT_BYTES,
})
const MAX_QUEUE = 2 * LIVE_VOICE_PROVIDER_BYTES
const allowedReasons = new Set<LiveVoiceEndReason>([
  "connection", "unconfigured", "busy", "setup-timeout", "idle", "duration", "limit",
  "invalid-message", "provider-error", "provider-disconnected", "revoked",
])

export function proxyRemoteVoice(args: {
  request: IncomingMessage
  socket: Socket
  head: Buffer
  target: URL
  origin: string
  cookie: string
  skipTlsVerify: boolean
  lifetime: AbortSignal
  claim: () => boolean
}) {
  const { request, socket, head, target, origin, cookie, skipTlsVerify, lifetime, claim } = args
  if (!liveVoiceEngine(request.url) || request.method !== "GET" || request.headers["sec-websocket-protocol"] !== undefined) {
    refuseVoiceUpgrade(socket, "404 Not Found")
    return
  }
  if (target.protocol !== "https:" || target.username || target.password || !cookie) {
    refuseVoiceUpgrade(socket, "403 Forbidden")
    return
  }
  if (!claim()) return closeBusyVoiceUpgrade(server, request, socket, head)
  server.handleUpgrade(request, socket, head, window => {
    let upstream: WebSocket | undefined
    let initial: WebSocket.RawData | undefined
    let stopped = false
    const stop = (reason: LiveVoiceEndReason, hard = false) => {
      if (stopped) return
      stopped = true
      initial = undefined
      lifetime.removeEventListener("abort", revoke)
      clearTimeout(timer)
      upstream?.terminate()
      if (hard || window.bufferedAmount > MAX_QUEUE) window.terminate()
      else if (window.readyState === WebSocket.OPEN) window.close(reason === "stopped" ? 1000 : 4000, reason)
    }
    const revoke = () => stop("revoked", true)
    const timer = setTimeout(() => stop("setup-timeout"), LIVE_VOICE_ESTABLISH_MS).unref()
    const relay = (target: WebSocket | undefined, data: WebSocket.RawData, binary: boolean) => {
      if (stopped) return
      if (binary) return stop("invalid-message")
      if (!target || target.readyState !== WebSocket.OPEN) return stop("connection")
      if (target.bufferedAmount + rawBytes(data) > MAX_QUEUE) return stop("limit")
      target.send(data, { binary: false }, error => { if (error) stop("connection", true) })
    }
    window.once("close", () => stop("stopped"))
    window.on("error", () => stop("invalid-message", true))
    window.on("message", (data, binary) => {
      if (upstream?.readyState === WebSocket.OPEN) return relay(upstream, data, binary)
      // The window sends its bounded context as soon as its local upgrade
      // completes. No audio can arrive before the far gateway is ready.
      const value = !initial && !binary && readObject(data)
      if (!value || readClientMessage(value)?.type !== "start") return stop("invalid-message")
      initial = data
    })
    lifetime.addEventListener("abort", revoke, { once: true })
    if (lifetime.aborted) return revoke()
    void (async () => {
      try {
        const lookup = await proxyDestination(target.hostname, Number(target.port) || 443)
        if (stopped) return
        target.protocol = "wss:"
        upstream = new WebSocket(target, { ...VOICE_WS_OPTIONS,
          lookup,
          headers: { Origin: origin, Cookie: cookie },
          rejectUnauthorized: !skipTlsVerify,
          maxPayload: LIVE_VOICE_PROVIDER_BYTES,
          handshakeTimeout: LIVE_VOICE_ESTABLISH_MS,
          followRedirects: false,
        })
        upstream.once("open", () => {
          clearTimeout(timer)
          if (initial) relay(upstream, initial, false)
          initial = undefined
        })
        upstream.on("error", () => stop("connection"))
        upstream.once("close", (code, message) => {
          const reason = message.toString() as LiveVoiceEndReason
          stop(code === 1000 && reason === "stopped" ? reason : allowedReasons.has(reason) ? reason : "connection")
        })
        upstream.on("message", (data, binary) => relay(window, data, binary))
      } catch { stop("connection") }
    })()
  })
}
