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
export type LiveVoiceActivity = "listening" | "speaking" | "thinking"
export interface LiveVoiceTranscriptRow {
  id: number
  role: "user" | "assistant" | "sent" | "interrupted"
  text: string
  final: boolean
  announce?: true
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
  onActivity: (value: LiveVoiceActivity, canInterrupt: boolean) => void
}) {
  const lifetime = new AbortController()
  const signal = lifetime.signal
  const inputRate = liveVoiceInputRate(options.engine)
  const outputRate = LIVE_VOICE_OUTPUT_RATE
  const calls = new Map<string, "started" | "cancelled" | "finished">()
  const rows = new Map<number, LiveVoiceTranscriptRow>()
  const keys = new Map<string, number>()
  const assistantRows = new Set<number>()
  const awaitingPlayback = new Set<number>()
  let sequence = 0
  let socket: ReturnType<typeof options.socket> | undefined
  let audio: LiveVoiceAudio | undefined
  let connected = false
  let ready = false
  let playing = false
  let responseOpen = false
  let responseSpoken = false
  let responseId: string | undefined
  let discardResponse = false
  let pendingTools = 0
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

  function updateActivity() {
    if (!ready || signal.aborted) return
    const canInterrupt = !discardResponse && (responseOpen || playing)
    options.onActivity(playing || responseSpoken ? "speaking" : canInterrupt || pendingTools > 0 ? "thinking" : "listening", canInterrupt)
  }

  function saveRow(row: LiveVoiceTranscriptRow) {
    rows.set(row.id, row)
    if (rows.size <= MAX_ROWS) return
    const oldest = rows.keys().next().value!
    rows.delete(oldest)
    assistantRows.delete(oldest)
    awaitingPlayback.delete(oldest)
    for (const [key, id] of keys) if (id === oldest) keys.delete(key)
  }

  function marker(role: "sent" | "interrupted", text = "") {
    saveRow({ id: ++sequence, role, text: text.slice(0, ROW_CHARS), final: true })
    publish()
  }

  function transcript(value: TranscriptEvent) {
    if (discardResponse && value.role === "assistant") return
    const key = value.itemId ? `${value.role}:${value.itemId}` : value.role
    const prior = rows.get(keys.get(key) ?? 0)
    if (prior?.final && value.itemId) return
    let fragment = value.replace ? value.text || prior?.text || "" : (prior?.text ?? "") + value.text
    if (!fragment.trim() && !prior) return
    fragment = fragment.slice(0, ROW_CHARS)
    const id = prior?.id ?? ++sequence
    saveRow({ id, role: value.role, text: fragment, final: value.final,
      ...(value.role === "user" && value.final ? { announce: true } : {}) })
    if (value.role === "assistant") {
      assistantRows.add(id)
      responseOpen = true
      updateActivity()
    }
    if (!value.itemId && value.final) keys.delete(key)
    else keys.set(key, id)
    publish()
  }

  function finishTurn(interrupted: boolean) {
    for (const id of assistantRows) {
      const row = rows.get(id)!
      if (!interrupted && playing) awaitingPlayback.add(id)
      rows.set(id, { ...row, final: true, ...(!interrupted && !playing ? { announce: true } : {}) })
    }
    assistantRows.clear()
    keys.delete("assistant")
    // Gemini segments do not have item IDs. OpenAI inputs finish independently.
    const user = keys.get("user")
    if (!interrupted && user !== undefined) {
      rows.set(user, { ...rows.get(user)!, final: true, announce: true })
      keys.delete("user")
    }
  }

  function interrupt(manual: boolean) {
    if (!ready || !audio || !current() || discardResponse) return
    const active = responseOpen || playing
    // OpenAI reports speech start as an interruption hint, including when idle.
    if (!active && (manual || options.engine === "openai-realtime")) return
    discardResponse = responseOpen || (!manual && options.engine === "gemini-live")
    responseOpen = responseSpoken = false
    awaitingPlayback.clear()
    // Resolve the flush at the hardware playback position, not bytes queued.
    void audio.interrupt().then(truncations => {
      if (options.engine === "openai-realtime") for (const item of truncations) {
        if (item.contentIndex === 0) send(item)
      }
    }, () => stop("device"))
    if (manual && responseId) send({ type: "interrupt", responseId })
    responseId = undefined
    if (signal.aborted) return
    finishTurn(true)
    marker("interrupted")
    updateActivity()
  }

  function completeTurn() {
    audio?.turnComplete()
    finishTurn(discardResponse)
    responseId = undefined
    responseOpen = responseSpoken = discardResponse = false
    updateActivity()
    publish()
  }

  function playbackChanged(value: boolean) {
    playing = value
    updateActivity()
    if (value || !awaitingPlayback.size || !current()) return
    for (const id of awaitingPlayback) rows.set(id, { ...rows.get(id)!, announce: true })
    awaitingPlayback.clear()
    publish()
  }

  async function execute(id: string, tool: LiveVoiceTool) {
    const admitted = () => current() && socket?.readyState === OPEN && calls.get(id) === "started"
    if (!admitted()) return
    pendingTools++
    updateActivity()
    let output: string
    try {
      const result = await options.execute(tool, admitted)
      output = JSON.stringify(result)
      const delivery = liveVoiceObject(result)?.delivery
      // A native send may settle after the provider cancels its tool call.
      if (tool.name === "send_to_agent" && (delivery === "queued" || delivery === "submitted") && options.current()) {
        marker("sent", tool.arguments.text.trim())
      }
    } catch {
      // A failed response may follow an accepted native send. Never retry it.
      output = JSON.stringify({ error: "Result unconfirmed. Do not repeat this request." })
    }
    if (admitted()) {
      calls.set(id, "finished")
      pendingTools--
      updateActivity()
      send({ type: "tool-result", id, output })
    }
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
      case "thinking":
        if (options.engine === "openai-realtime" ? !liveVoiceIdentifier(value.responseId) : value.responseId !== undefined) {
          return stop("invalid-message")
        }
        if (discardResponse) break
        responseId = value.responseId as string | undefined
        responseOpen = true
        updateActivity()
        break
      case "audio":
        if (typeof value.pcm !== "string" || (options.engine === "openai-realtime" &&
          (!liveVoiceIdentifier(value.itemId) || !Number.isInteger(value.contentIndex) ||
            Number(value.contentIndex) < 0 || Number(value.contentIndex) > 32))) return stop("invalid-message")
        if (!discardResponse) {
          responseOpen = responseSpoken = true
          audio.play(value as AudioEvent)
        }
        break
      case "transcript":
        if ((value.role !== "user" && value.role !== "assistant") || typeof value.text !== "string" ||
          typeof value.final !== "boolean" || (value.itemId !== undefined && !liveVoiceIdentifier(value.itemId)) ||
          (value.replace !== undefined && value.replace !== true)) return stop("invalid-message")
        transcript(value as TranscriptEvent)
        break
      case "turn-complete":
        completeTurn()
        break
      case "interrupted":
        interrupt(false)
        break
      case "tool-cancel":
        if (!liveVoiceIdentifier(value.id)) return stop("invalid-message")
        if (!calls.has(value.id) && calls.size >= LIVE_VOICE_MAX_CALLS) return stop("limit")
        if (calls.get(value.id) === "started") pendingTools--
        calls.set(value.id, "cancelled")
        updateActivity()
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
        onPlaybackChange: playbackChanged,
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
  return {
    stop,
    interrupt: () => interrupt(true),
    setMuted(value: boolean) {
      if (!ready || !audio || !current()) return false
      audio.setMuted(value)
      return true
    },
    activityLevel: () => audio?.level(playing || responseSpoken) ?? 0,
  }
}
