import {
  LIVE_VOICE_ABSOLUTE_MS, LIVE_VOICE_ESTABLISH_MS, LIVE_VOICE_IDLE_MS, LIVE_VOICE_MAX_CALLS, LIVE_VOICE_OUTPUT_RATE,
  LIVE_VOICE_PROVIDER_BYTES, LIVE_VOICE_TRACKED_IDS, liveVoiceIdentifier, liveVoiceInputRate, liveVoiceKeys, liveVoiceObject, readLiveVoiceTool,
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
  const calls = new Map<string, { state: "started" | "cancelled" | "finished"; responseId?: string }>()
  const interruptedResponses = new Set<string>()
  const rows = new Map<number, LiveVoiceTranscriptRow>()
  const positions: { id: number; itemId?: string; previousItemId?: string | null }[] = []
  const keys = new Map<string, number>()
  const assistantRows = new Set<number>()
  const awaitingPlayback = new Set<number>()
  let sequence = 0
  let socket: ReturnType<typeof options.socket> | undefined
  let audio: LiveVoiceAudio | undefined
  let connected = false
  let ready = false
  let muted = false
  let playing = false
  let responseOpen = false
  let responseSpoken = false
  let responseId: string | undefined
  let discardResponse = false
  let silenceGeminiReply = false
  let geminiThinking = false
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

  function publish() {
    options.onTranscript(positions.flatMap(({ id }) => {
      const row = rows.get(id)
      return row ? [row] : []
    }))
  }

  // Reserve positions before transcription arrives, including non-spoken items
  // that can be predecessors, without displaying empty rows.
  function position(itemId?: string) {
    const existing = itemId ? positions.find(entry => entry.itemId === itemId) : undefined
    if (existing) return existing
    const entry: typeof positions[number] = { id: ++sequence, itemId }
    if (positions.length >= MAX_ROWS + LIVE_VOICE_TRACKED_IDS) {
      positions.splice(positions.findIndex(({ id }) => !rows.has(id)), 1)
    }
    positions.push(entry)
    return entry
  }

  function orderItem(itemId: string, previousItemId?: string | null) {
    const entry = position(itemId)
    if (previousItemId === undefined || previousItemId === entry.previousItemId) return
    const previous = previousItemId === null ? undefined : positions.find(entry => entry.itemId === previousItemId)
    if (previousItemId !== null && !previous) return
    entry.previousItemId = previousItemId
    const after = previous ? positions.indexOf(previous) : -1
    const nextItem = (index: number) => positions.findIndex((candidate, at) => at > index && candidate.itemId !== undefined)
    if (positions[nextItem(after)] === entry) return
    positions.splice(positions.indexOf(entry), 1)
    const next = nextItem(previous ? positions.indexOf(previous) : -1)
    positions.splice(next < 0 ? positions.length : next, 0, entry)
    if (rows.has(entry.id)) publish()
  }

  function pendingTool() {
    for (const call of calls.values()) if (call.state === "started") return call
  }

  function updateActivity() {
    if (!ready || signal.aborted) return
    const pending = pendingTool()
    const canInterrupt = playing || (!discardResponse && !silenceGeminiReply && (responseOpen || Boolean(pending?.responseId)))
    options.onActivity(playing || responseSpoken ? "speaking" : canInterrupt || pending || geminiThinking ? "thinking" : "listening", canInterrupt)
  }

  function saveRow(row: LiveVoiceTranscriptRow) {
    rows.set(row.id, row)
    if (rows.size <= MAX_ROWS) return
    const index = positions.findIndex(({ id }) => rows.has(id))
    const [{ id: oldest }] = positions.splice(index, 1)
    rows.delete(oldest)
    assistantRows.delete(oldest)
    awaitingPlayback.delete(oldest)
    for (const [key, id] of keys) if (id === oldest) keys.delete(key)
  }

  function marker(role: "sent" | "interrupted", text = "") {
    saveRow({ id: position().id, role, text: text.slice(0, ROW_CHARS), final: true, announce: true })
    publish()
  }

  function transcript(value: TranscriptEvent) {
    if (discardResponse && value.role === "assistant") return
    const key = value.itemId ? `${value.role}:${value.itemId}` : value.role
    const prior = rows.get(keys.get(key) ?? 0)
    if (prior?.final && value.itemId && !(options.engine === "gemini-live" && value.role === "user")) return
    let fragment = value.replace ? value.text || prior?.text || "" : (prior?.text ?? "") + value.text
    if (!fragment.trim() && !prior) return
    fragment = fragment.slice(0, ROW_CHARS)
    const id = prior?.id ?? position(options.engine === "openai-realtime" ? value.itemId : undefined).id
    if (!prior && rows.has(id)) return
    saveRow({ id, role: value.role, text: fragment, final: value.final,
      ...(value.role === "user" && value.final ? { announce: true } : {}) })
    if (!rows.has(id)) return
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
    // User rows close on their own transcription's final event, independently of model turns.
  }

  function flushPlayback(overflow: boolean) {
    if (!overflow) awaitingPlayback.clear()
    // Resolve the flush at the hardware playback position, not bytes queued.
    void audio?.interrupt(overflow).then(truncations => {
      if (options.engine === "openai-realtime") for (const item of truncations) {
        if (item.contentIndex === 0) send(item)
      }
    }, () => stop("device"))
  }

  function interrupt(manual: boolean, overflow = false) {
    if (!ready || !audio || !current()) return
    if (discardResponse) {
      // An overflow dropped only the current reply; barge-in also stops older playback.
      if (!overflow && playing) flushPlayback(false)
      return
    }
    const pending = pendingTool()?.responseId
    const active = responseOpen || playing || pending
    // OpenAI reports speech start as an interruption hint, including when idle.
    if (!active && (manual || options.engine === "openai-realtime")) return
    const interrupted = responseOpen ? responseId : pending ?? responseId
    discardResponse = responseOpen || (!manual && options.engine === "gemini-live")
    if (interrupted && !interruptedResponses.has(interrupted)) {
      if (interruptedResponses.size >= LIVE_VOICE_MAX_CALLS) return stop("limit")
      interruptedResponses.add(interrupted)
      for (const call of calls.values()) if (call.responseId === interrupted && call.state === "started") {
        call.state = "cancelled"
      }
    }
    responseOpen = responseSpoken = false
    flushPlayback(overflow)
    if (manual && interrupted) send({ type: "interrupt", responseId: interrupted })
    responseId = undefined
    if (signal.aborted) return
    finishTurn(true)
    if (!silenceGeminiReply) marker("interrupted")
    updateActivity()
  }

  function stopPlayback() {
    if (options.engine !== "gemini-live") return interrupt(true)
    if (!ready || !audio || !current() || !(playing || responseOpen)) return
    if (discardResponse) return interrupt(true)
    if (silenceGeminiReply) return
    silenceGeminiReply = responseOpen
    responseSpoken = false
    flushPlayback(false)
    marker("interrupted")
    updateActivity()
  }

  function completeTurn(thinking: boolean) {
    audio?.turnComplete()
    finishTurn(discardResponse)
    geminiThinking = thinking
    responseOpen = responseSpoken = discardResponse = silenceGeminiReply = false
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
    const call = calls.get(id)!
    const admitted = () => current() && socket?.readyState === OPEN && call.state === "started"
    if (!admitted()) return
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
      call.state = "finished"
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
      case "speech-start":
        if (options.engine !== "gemini-live") return stop("invalid-message")
        // Gemini may have completed generation while its last reply is still playing.
        if (playing && !responseOpen) interrupt(true)
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
        if (!discardResponse && !silenceGeminiReply) {
          responseOpen = responseSpoken = true
          if (audio.play(value as AudioEvent) === "overflow") interrupt(true, true)
        }
        break
      case "transcript":
        if ((value.role !== "user" && value.role !== "assistant") || typeof value.text !== "string" ||
          typeof value.final !== "boolean" || (value.itemId !== undefined && !liveVoiceIdentifier(value.itemId)) ||
          (value.replace !== undefined && value.replace !== true)) return stop("invalid-message")
        transcript(value as TranscriptEvent)
        break
      case "item-order":
        if (options.engine !== "openai-realtime" || !liveVoiceIdentifier(value.itemId)
          || value.itemId === value.previousItemId || (value.previousItemId !== null && value.previousItemId !== undefined
            && !liveVoiceIdentifier(value.previousItemId))) return stop("invalid-message")
        orderItem(value.itemId, value.previousItemId)
        break
      case "turn-complete":
        if (value.thinking !== undefined && (options.engine !== "gemini-live" || value.thinking !== true)) return stop("invalid-message")
        completeTurn(value.thinking === true)
        break
      case "interrupted":
        interrupt(false)
        break
      case "tool-cancel":
        if (!liveVoiceIdentifier(value.id)) return stop("invalid-message")
        if (!calls.has(value.id) && calls.size >= LIVE_VOICE_MAX_CALLS) return stop("limit")
        const call = calls.get(value.id)
        if (call) call.state = "cancelled"
        else calls.set(value.id, { state: "cancelled" })
        updateActivity()
        break
      case "tool-call": {
        const tool = readLiveVoiceTool(value.name, value.arguments)
        const { id, responseId: ownerResponse } = value
        const keys = ["type", "id", "name", "arguments"]
        if (options.engine === "openai-realtime") {
          if (!liveVoiceIdentifier(ownerResponse)) return stop("invalid-message")
          keys.push("responseId")
        }
        if (!tool || !liveVoiceIdentifier(id) || !liveVoiceKeys(value, ...keys)) return stop("invalid-message")
        if (calls.has(id)) return
        if (calls.size >= LIVE_VOICE_MAX_CALLS) return stop("limit")
        // The gateway settles calls from this response when it receives interrupt.
        if (typeof ownerResponse === "string" && interruptedResponses.has(ownerResponse)) {
          calls.set(id, { state: "cancelled" })
          break
        }
        calls.set(id, { state: "started", responseId: ownerResponse as string | undefined })
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
        signal, engine: options.engine, outputRate,
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
    interrupt: stopPlayback,
    setMuted(value: boolean) {
      if (!ready || !audio || !current()) return false
      if (muted === value) return true
      muted = value
      audio.setMuted(value)
      if (value && options.engine === "gemini-live") send({ type: "audio-end" })
      return !signal.aborted
    },
    activityLevel: () => audio?.level(playing || responseSpoken) ?? 0,
  }
}
