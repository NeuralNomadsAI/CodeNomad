import {
  LIVE_VOICE_ABSOLUTE_MS, LIVE_VOICE_ESTABLISH_MS, LIVE_VOICE_IDLE_MS, LIVE_VOICE_MAX_CALLS, LIVE_VOICE_OUTPUT_RATE,
  LIVE_VOICE_PROVIDER_BYTES, liveVoiceIdentifier, liveVoiceInputRate, liveVoiceKeys, liveVoiceObject, readLiveVoiceTool,
  type LiveVoiceClientMessage, type LiveVoiceContext, type LiveVoiceEndReason, type LiveVoiceEngine,
  type LiveVoiceServerMessage, type LiveVoiceTool,
} from "../../../server/src/speech/live-voice-contract"
import type { startLiveVoiceAudio } from "./live-voice-audio"
import { MicrophoneUnavailable, type MicrophonePurpose } from "./microphone-lease"

type LiveVoiceAudio = Awaited<ReturnType<typeof startLiveVoiceAudio>>
export type LiveVoiceStopReason = LiveVoiceEndReason | "targetChanged" | "device" | "permission" | "microphoneUnavailable" | MicrophonePurpose
export interface LiveVoiceTranscriptRow {
  id: number
  role: "user" | "assistant"
  text: string
  final: boolean
}
type TranscriptEvent = Extract<LiveVoiceServerMessage, { type: "transcript" }>
type AudioEvent = Extract<LiveVoiceServerMessage, { type: "audio" }>

const SOCKET_BACKLOG = 256 * 1024
const MAX_ROWS = 96
const ROW_CHARS = 4096
const OPEN = 1
const closeReasons: readonly LiveVoiceEndReason[] = [
  "stopped", "connection", "unconfigured", "busy", "setup-timeout", "idle", "duration", "limit",
  "invalid-message", "provider-error", "provider-disconnected", "revoked",
]

function closeReason(event: CloseEvent): LiveVoiceEndReason {
  if (event.code === 4000 && closeReasons.includes(event.reason as LiveVoiceEndReason)) return event.reason as LiveVoiceEndReason
  return "connection"
}

function audioFailure(error: unknown): LiveVoiceStopReason {
  if (error instanceof MicrophoneUnavailable) return error.reason === "unavailable" ? "microphoneUnavailable" : error.reason
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) return "permission"
  return "device"
}

export function openLiveVoiceSession(options: {
  engine: LiveVoiceEngine
  context: LiveVoiceContext
  current: () => boolean
  startAudio: typeof startLiveVoiceAudio
  socket: () => Pick<WebSocket, "addEventListener" | "removeEventListener" | "close" | "send" | "readyState" | "bufferedAmount">
  execute: (tool: LiveVoiceTool, current: () => boolean) => unknown
  onReady: () => void
  onStop: (reason: LiveVoiceStopReason) => void
  onTranscript: (value: readonly LiveVoiceTranscriptRow[]) => void
}) {
  const lifetime = new AbortController()
  const signal = lifetime.signal
  const inputRate = liveVoiceInputRate(options.engine)
  const outputRate = LIVE_VOICE_OUTPUT_RATE
  const calls = new Map<string, "started" | "cancelled">()
  const rows = new Map<number, LiveVoiceTranscriptRow>()
  const keys = new Map<string, number>()
  let sequence = 0
  let socket: ReturnType<typeof options.socket> | undefined
  let audio: LiveVoiceAudio | undefined
  let connected = false
  let ready = false
  let idle: ReturnType<typeof setTimeout> | undefined
  let setup: ReturnType<typeof setTimeout> | undefined
  const absolute = setTimeout(() => stop("duration"), LIVE_VOICE_ABSOLUTE_MS)

  function stop(reason: LiveVoiceStopReason = "stopped") {
    if (signal.aborted) return
    lifetime.abort()
    clearTimeout(absolute)
    clearTimeout(setup)
    clearTimeout(idle)
    socket?.removeEventListener("open", opened)
    socket?.removeEventListener("message", message)
    socket?.removeEventListener("close", closed)
    socket?.removeEventListener("error", errored)
    // Closing this socket also closes the corresponding provider socket.
    socket?.close()
    void audio?.close().catch(() => {})
    calls.clear()
    options.onStop(reason)
  }

  function current() {
    if (signal.aborted) return false
    if (options.current()) return true
    stop("targetChanged")
    return false
  }

  function send(value: LiveVoiceClientMessage) {
    if (!current()) return
    if (socket?.readyState !== OPEN) return stop("connection")
    if (socket.bufferedAmount > SOCKET_BACKLOG) return stop("limit")
    try { socket.send(JSON.stringify(value)) } catch { stop("connection") }
  }

  function activity() {
    clearTimeout(idle)
    idle = setTimeout(() => stop("idle"), LIVE_VOICE_IDLE_MS)
  }

  function publish() { options.onTranscript([...rows.values()]) }

  function transcript(value: TranscriptEvent) {
    const key = value.itemId ? `${value.role}:${value.itemId}` : value.role
    const prior = rows.get(keys.get(key) ?? 0)
    if (prior?.final && value.itemId) return
    let fragment = value.replace ? value.text || prior?.text || "" : (prior?.text ?? "") + value.text
    if (!fragment.trim() && !prior) return
    fragment = fragment.slice(0, ROW_CHARS)
    const id = prior?.id ?? ++sequence
    rows.set(id, { id, role: value.role, text: fragment, final: value.final })
    if (!value.itemId && value.final) keys.delete(key)
    else keys.set(key, id)
    if (rows.size > MAX_ROWS) {
      const oldest = rows.keys().next().value!
      rows.delete(oldest)
      for (const [known, id] of keys) if (id === oldest) keys.delete(known)
    }
    publish()
  }

  function finishTurn(interrupted: boolean) {
    // Gemini segments have no item ID. On OpenAI interruption, the truncated
    // response may never send a transcript completion.
    for (const [key, id] of keys) {
      if (key !== "assistant" && (interrupted ? !key.startsWith("assistant:") : key !== "user")) continue
      const row = rows.get(id)!
      if (!row.final) rows.set(id, { ...row, final: true })
      if (key === "assistant" || key === "user") keys.delete(key)
    }
    publish()
  }

  async function execute(id: string, tool: LiveVoiceTool) {
    const admitted = () => current() && socket?.readyState === OPEN && calls.get(id) === "started"
    if (!admitted()) return
    let output: string
    try { output = JSON.stringify(await options.execute(tool, admitted)) } catch {
      // A failed response may follow an accepted native send. Never retry it.
      output = JSON.stringify({ error: "Result unconfirmed. Do not repeat this request." })
    }
    if (admitted()) send({ type: "tool-result", id, output })
  }

  function message(event: MessageEvent) {
    if (!current()) return
    if (typeof event.data !== "string" || event.data.length > LIVE_VOICE_PROVIDER_BYTES) return stop("invalid-message")
    let value
    try { value = liveVoiceObject(JSON.parse(event.data)) } catch { /* malformed envelope */ }
    if (!value) return stop("invalid-message")
    if (value.type === "ready") {
      if (ready || !connected || value.inputRate !== inputRate || value.outputRate !== outputRate) return stop("invalid-message")
      clearTimeout(setup)
      ready = true
      activity()
      options.onReady()
      return
    }
    if (!ready || !audio) return stop("invalid-message")
    switch (value.type) {
      case "activity":
        activity()
        break
      case "audio":
        if (typeof value.pcm !== "string" || (options.engine === "openai-realtime" &&
          (!liveVoiceIdentifier(value.itemId) || !Number.isInteger(value.contentIndex) ||
            Number(value.contentIndex) < 0 || Number(value.contentIndex) > 32))) return stop("invalid-message")
        audio.play(value as AudioEvent)
        break
      case "transcript":
        if ((value.role !== "user" && value.role !== "assistant") || typeof value.text !== "string" ||
          typeof value.final !== "boolean" || (value.itemId !== undefined && !liveVoiceIdentifier(value.itemId)) ||
          (value.replace !== undefined && value.replace !== true)) return stop("invalid-message")
        transcript(value as TranscriptEvent)
        break
      case "turn-complete":
        audio.turnComplete()
        finishTurn(false)
        break
      case "interrupted":
        // The flush settles asynchronously with samples actually rendered, not enqueued.
        void audio.interrupt().then(truncations => {
          if (options.engine === "openai-realtime") for (const item of truncations) send(item)
        }, () => stop("device"))
        finishTurn(true)
        break
      case "tool-cancel":
        if (!liveVoiceIdentifier(value.id)) return stop("invalid-message")
        if (!calls.has(value.id) && calls.size >= LIVE_VOICE_MAX_CALLS) return stop("limit")
        calls.set(value.id, "cancelled")
        break
      case "tool-call": {
        const tool = readLiveVoiceTool(value.name, value.arguments)
        if (!tool || !liveVoiceIdentifier(value.id) || !liveVoiceKeys(value, "type", "id", "name", "arguments")) return stop("invalid-message")
        const id = value.id
        if (calls.has(id)) return
        if (calls.size >= LIVE_VOICE_MAX_CALLS) return stop("limit")
        calls.set(id, "started")
        void execute(id, tool)
        break
      }
      default: stop("invalid-message")
    }
  }

  const closed = (event: CloseEvent) => stop(closeReason(event))
  const errored = () => stop("connection")
  const opened = () => {
    if (!current()) return
    connected = true
    send({ type: "start", context: options.context })
  }

  // Invoke before the first await to keep the user's activation for AudioContext and WebKit.
  async function start() {
    try {
      const media = await options.startAudio({
        signal, inputRate, outputRate,
        onInput: input => { if (ready) send(input) },
        onError: error => stop(audioFailure(error)),
      })
      if (!current()) { void media.close().catch(() => {}); return }
      audio = media
    } catch (error) {
      if (current()) stop(audioFailure(error))
      return
    }
    try {
      socket = options.socket()
      setup = setTimeout(() => stop("setup-timeout"), LIVE_VOICE_ESTABLISH_MS)
      socket.addEventListener("open", opened)
      socket.addEventListener("message", message)
      socket.addEventListener("close", closed)
      socket.addEventListener("error", errored)
    } catch { stop("connection") }
  }

  void start()
  return { stop }
}
