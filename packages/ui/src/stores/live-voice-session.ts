import { createSignal } from "solid-js"
import {
  loadAudioWorkletModules,
  PCM_RECORDER_PROCESSOR_NAME,
  PCM_STREAM_PLAYER_PROCESSOR_NAME,
} from "../audio/audio-worklet-loader"
import { stopTracks } from "../lib/audio-utils"
import {
  LIVE_VOICE_TOOLS,
  toGeminiFunctionDeclarations,
  toOpenAITools,
  executeLiveVoiceTool,
  type LiveVoiceToolContext,
} from "./live-voice-tools"
import { CODENOMAD_API_BASE } from "../lib/api-base"

export type LiveVoiceProvider = "gemini" | "openai"

export type LiveVoiceConnectionState =
  | "disconnected"
  | "connecting"
  | "idle"
  | "listening"
  | "speaking"
  | "error"

export interface LiveVoiceTranscriptItem {
  id: string
  role: "user" | "assistant"
  text: string
  isFinal: boolean
  timestamp?: string
}

export interface LiveVoiceConnectOptions {
  provider?: LiveVoiceProvider
  model?: string
  voice?: string
  systemInstruction?: string
  instanceId?: string
  sessionId?: string
}

// Global reactive signals
export const [connectionState, setConnectionState] = createSignal<LiveVoiceConnectionState>("disconnected")
export const [isMuted, setIsMuted] = createSignal<boolean>(false)
export const [activeProvider, setActiveProvider] = createSignal<LiveVoiceProvider>("gemini")
export const [transcript, setTranscript] = createSignal<LiveVoiceTranscriptItem[]>([])
export const [analyserNode, setAnalyserNode] = createSignal<AnalyserNode | null>(null)
export const [audioContext, setAudioContext] = createSignal<AudioContext | null>(null)

// Non-reactive internal session references
let activeWebSocket: WebSocket | null = null
let activeMediaStream: MediaStream | null = null
let activeMicSource: MediaStreamAudioSourceNode | null = null
let activeRecorderNode: AudioWorkletNode | null = null
let activePlayerNode: AudioWorkletNode | null = null
let activeAnalyserNode: AnalyserNode | null = null
let activeAudioContext: AudioContext | null = null
let speakingTimeout: ReturnType<typeof setTimeout> | null = null
let currentConnectOptions: LiveVoiceConnectOptions | null = null

function formatTimestamp(): string {
  const now = new Date()
  const hours = String(now.getHours()).padStart(2, "0")
  const minutes = String(now.getMinutes()).padStart(2, "0")
  const seconds = String(now.getSeconds()).padStart(2, "0")
  return `${hours}:${minutes}:${seconds}`
}

/**
 * Encodes an ArrayBuffer of PCM data into a base64 string.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Decodes a base64 string to a 16-bit signed PCM Int16Array.
 */
export function base64ToInt16Array(base64: string): Int16Array {
  const binary = atob(base64)
  const len = binary.length
  const evenLen = len - (len % 2)
  const bytes = new Uint8Array(evenLen)
  for (let i = 0; i < evenLen; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
}

/**
 * Resamples 16-bit linear PCM from one sample rate to another using linear interpolation.
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0 || input.length === 0) {
    return input
  }
  const ratio = toRate / fromRate
  const outLength = Math.round(input.length * ratio)
  const output = new Int16Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i / ratio
    const indexLow = Math.floor(srcIndex)
    const indexHigh = Math.min(indexLow + 1, input.length - 1)
    const weight = srcIndex - indexLow
    output[i] = Math.round(input[indexLow] * (1 - weight) + input[indexHigh] * weight)
  }
  return output
}

/**
 * Resolves the WebSocket URL for live voice streaming against the CodeNomad gateway.
 */
export function resolveLiveVoiceWsUrl(options?: {
  provider?: LiveVoiceProvider
  model?: string
  voice?: string
}): string {
  const base =
    CODENOMAD_API_BASE ||
    (typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost:9898")

  const wsBase = base.replace(/^http/i, "ws")
  const url = new URL("/api/speech/live/ws", wsBase)

  if (options?.provider) {
    url.searchParams.set("provider", options.provider)
  }
  if (options?.model) {
    url.searchParams.set("model", options.model)
  }
  if (options?.voice) {
    url.searchParams.set("voice", options.voice)
  }

  return url.toString()
}

/**
 * Appends text to the assistant's currently active transcript item or creates a new one.
 */
function appendAssistantTranscript(delta: string): void {
  if (!delta) return
  setTranscript((prev) => {
    const last = prev[prev.length - 1]
    if (last && last.role === "assistant" && !last.isFinal) {
      return [
        ...prev.slice(0, prev.length - 1),
        {
          ...last,
          text: last.text + delta,
        },
      ]
    }
    return [
      ...prev,
      {
        id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "assistant",
        text: delta,
        isFinal: false,
        timestamp: formatTimestamp(),
      },
    ]
  })
}

/**
 * Marks the assistant's active transcript item as finalized.
 */
function finalizeAssistantTranscript(): void {
  setTranscript((prev) => {
    const last = prev[prev.length - 1]
    if (last && last.role === "assistant" && !last.isFinal) {
      return [
        ...prev.slice(0, prev.length - 1),
        {
          ...last,
          isFinal: true,
        },
      ]
    }
    return prev
  })
}

/**
 * Adds or updates a user transcript item.
 */
function recordUserTranscript(text: string, isFinal = true): void {
  if (!text) return
  setTranscript((prev) => {
    const last = prev[prev.length - 1]
    if (last && last.role === "user" && !last.isFinal) {
      return [
        ...prev.slice(0, prev.length - 1),
        {
          ...last,
          text,
          isFinal,
        },
      ]
    }
    return [
      ...prev,
      {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "user",
        text,
        isFinal,
        timestamp: formatTimestamp(),
      },
    ]
  })
}

/**
 * Resets speaking state back to listening after audio plays out.
 */
function scheduleSpeakingTransition(delayMs = 400): void {
  if (speakingTimeout) {
    clearTimeout(speakingTimeout)
  }
  speakingTimeout = setTimeout(() => {
    if (connectionState() === "speaking") {
      setConnectionState("listening")
    }
    speakingTimeout = null
  }, delayMs)
}

function clearSpeakingTimeout(): void {
  if (speakingTimeout) {
    clearTimeout(speakingTimeout)
    speakingTimeout = null
  }
}

/**
 * Sets the mute state of the microphone stream and state signal.
 */
export function setMuted(muted: boolean): void {
  setIsMuted(muted)
  if (activeMediaStream) {
    for (const track of activeMediaStream.getAudioTracks()) {
      track.enabled = !muted
    }
  }
}

/**
 * Interrupts current model playback and speech output.
 */
export function interrupt(): void {
  clearSpeakingTimeout()

  // Immediately flush buffered audio from the player processor
  if (activePlayerNode) {
    activePlayerNode.port.postMessage({ type: "FLUSH" })
  }

  // If using OpenAI, notify server to cancel current response
  if (
    activeProvider() === "openai" &&
    activeWebSocket &&
    activeWebSocket.readyState === WebSocket.OPEN
  ) {
    try {
      activeWebSocket.send(JSON.stringify({ type: "response.cancel" }))
    } catch (err) {
      console.warn("Failed to send response.cancel to OpenAI Realtime:", err)
    }
  }

  finalizeAssistantTranscript()

  if (connectionState() === "speaking") {
    setConnectionState("listening")
  }
}

/**
 * Handles incoming Gemini Live BidiGenerateContent messages.
 */
async function handleGeminiMessage(data: Record<string, unknown>): Promise<void> {
  // Check for interruption from server
  const serverContent = data.serverContent as Record<string, unknown> | undefined
  if (serverContent) {
    if (serverContent.interrupted === true) {
      clearSpeakingTimeout()
      if (activePlayerNode) {
        activePlayerNode.port.postMessage({ type: "FLUSH" })
      }
      finalizeAssistantTranscript()
      setConnectionState("listening")
      return
    }

    const modelTurn = serverContent.modelTurn as Record<string, unknown> | undefined
    if (modelTurn && Array.isArray(modelTurn.parts)) {
      for (const part of modelTurn.parts) {
        const p = part as Record<string, unknown>

        // Audio part
        const inlineData = p.inlineData as { mimeType?: string; data?: string } | undefined
        if (inlineData?.data) {
          clearSpeakingTimeout()
          setConnectionState("speaking")

          const rawPcm = base64ToInt16Array(inlineData.data)
          let sourceRate = 24000
          if (inlineData.mimeType) {
            const match = /rate=(\d+)/.exec(inlineData.mimeType)
            if (match && match[1]) {
              sourceRate = parseInt(match[1], 10)
            }
          }

          const targetRate = activeAudioContext?.sampleRate || 24000
          const resampled = resamplePcm16(rawPcm, sourceRate, targetRate)

          if (activePlayerNode) {
            activePlayerNode.port.postMessage(
              { type: "FEED", pcm: resampled.buffer },
              [resampled.buffer],
            )
          }
        }

        // Text transcript part
        if (typeof p.text === "string" && p.text.length > 0) {
          appendAssistantTranscript(p.text)
        }
      }
    }

    if (serverContent.turnComplete === true) {
      finalizeAssistantTranscript()
      scheduleSpeakingTransition(600)
    }
  }

  // Tool Call handling
  const toolCall = data.toolCall as Record<string, unknown> | undefined
  if (toolCall && Array.isArray(toolCall.functionCalls) && activeWebSocket) {
    const responses: Array<{
      id?: string
      name?: string
      response: { output: unknown }
    }> = []

    const toolContext: LiveVoiceToolContext = {
      instanceId: currentConnectOptions?.instanceId,
      sessionId: currentConnectOptions?.sessionId,
    }

    for (const call of toolCall.functionCalls) {
      const c = call as { id?: string; name: string; args?: Record<string, unknown> }
      try {
        const result = await executeLiveVoiceTool(
          {
            name: c.name,
            arguments: c.args,
          },
          toolContext,
        )
        responses.push({
          ...(c.id ? { id: c.id } : {}),
          ...(c.name ? { name: c.name } : {}),
          response: { output: result },
        })
      } catch (err) {
        responses.push({
          ...(c.id ? { id: c.id } : {}),
          ...(c.name ? { name: c.name } : {}),
          response: {
            output: {
              error: err instanceof Error ? err.message : "Failed to execute tool",
            },
          },
        })
      }
    }

    if (activeWebSocket.readyState === WebSocket.OPEN) {
      activeWebSocket.send(
        JSON.stringify({
          toolResponse: {
            functionResponses: responses,
          },
        }),
      )
    }
  }
}

/**
 * Handles incoming OpenAI Realtime messages.
 */
async function handleOpenAIMessage(data: Record<string, unknown>): Promise<void> {
  const type = data.type as string | undefined

  switch (type) {
    case "response.audio.delta": {
      const delta = data.delta as string | undefined
      if (delta) {
        clearSpeakingTimeout()
        setConnectionState("speaking")

        const rawPcm = base64ToInt16Array(delta)
        const sourceRate = 24000
        const targetRate = activeAudioContext?.sampleRate || 24000
        const resampled = resamplePcm16(rawPcm, sourceRate, targetRate)

        if (activePlayerNode) {
          activePlayerNode.port.postMessage(
            { type: "FEED", pcm: resampled.buffer },
            [resampled.buffer],
          )
        }
      }
      break
    }

    case "response.audio_transcript.delta": {
      const delta = data.delta as string | undefined
      if (delta) {
        appendAssistantTranscript(delta)
      }
      break
    }

    case "conversation.item.input_audio_transcription.completed": {
      const text = data.transcript as string | undefined
      if (text) {
        recordUserTranscript(text, true)
      }
      break
    }

    case "input_audio_buffer.speech_started": {
      // Barge-in: user started speaking, instantly cancel response & flush audio
      clearSpeakingTimeout()
      if (activeWebSocket && activeWebSocket.readyState === WebSocket.OPEN) {
        try {
          activeWebSocket.send(JSON.stringify({ type: "response.cancel" }))
        } catch {
          // ignore
        }
      }
      if (activePlayerNode) {
        activePlayerNode.port.postMessage({ type: "FLUSH" })
      }
      finalizeAssistantTranscript()
      setConnectionState("listening")
      break
    }

    case "response.done": {
      finalizeAssistantTranscript()
      scheduleSpeakingTransition(600)
      break
    }

    case "response.function_call_arguments.done": {
      const callId = data.call_id as string
      const name = data.name as string
      const args = data.arguments as string

      const toolContext: LiveVoiceToolContext = {
        instanceId: currentConnectOptions?.instanceId,
        sessionId: currentConnectOptions?.sessionId,
      }

      let result: unknown
      try {
        result = await executeLiveVoiceTool(
          {
            name,
            arguments: args,
          },
          toolContext,
        )
      } catch (err) {
        result = {
          error: err instanceof Error ? err.message : "Failed to execute tool",
        }
      }

      if (activeWebSocket && activeWebSocket.readyState === WebSocket.OPEN) {
        activeWebSocket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(result),
            },
          }),
        )

        activeWebSocket.send(
          JSON.stringify({
            type: "response.create",
          }),
        )
      }
      break
    }

    case "error": {
      console.error("OpenAI Realtime error received:", data.error)
      setConnectionState("error")
      break
    }
  }
}

/**
 * Connects to the live voice WebSocket session and initializes audio nodes.
 */
export async function connect(options?: LiveVoiceConnectOptions): Promise<void> {
  disconnect()

  const provider = options?.provider || activeProvider()
  setActiveProvider(provider)
  currentConnectOptions = options || null
  setConnectionState("connecting")

  try {
    // 1. Initialize Web Audio Context
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) {
      throw new Error("Web Audio API is not supported in this environment")
    }

    const ctx = new AudioCtx()
    if (ctx.state === "suspended") {
      await ctx.resume()
    }
    activeAudioContext = ctx
    setAudioContext(ctx)

    // 2. Load and register audio worklet processors
    await loadAudioWorkletModules(ctx)

    // 3. Request user microphone input
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    activeMediaStream = stream

    // Apply existing mute state to tracks
    if (isMuted()) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = false
      }
    }

    // 4. Create and wire audio nodes
    // Mic MediaStreamSourceNode -> AudioWorkletNode("pcm-recorder-processor")
    const micSource = ctx.createMediaStreamSource(stream)
    activeMicSource = micSource

    const targetRecorderRate = provider === "gemini" ? 16000 : 24000
    const recorderNode = new AudioWorkletNode(ctx, PCM_RECORDER_PROCESSOR_NAME, {
      processorOptions: {
        targetSampleRate: targetRecorderRate,
        chunkDurationMs: 40,
      },
    })
    activeRecorderNode = recorderNode
    micSource.connect(recorderNode)

    // AudioWorkletNode("pcm-stream-player-processor") -> AnalyserNode -> destination
    const playerNode = new AudioWorkletNode(ctx, PCM_STREAM_PLAYER_PROCESSOR_NAME)
    activePlayerNode = playerNode

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.8
    activeAnalyserNode = analyser
    setAnalyserNode(analyser)

    playerNode.connect(analyser)
    analyser.connect(ctx.destination)

    // 5. Connect WebSocket
    const wsUrl = resolveLiveVoiceWsUrl({
      provider,
      model: options?.model,
      voice: options?.voice,
    })

    const ws = new WebSocket(wsUrl)
    activeWebSocket = ws

    // 6. Hook recorder output to WebSocket
    recorderNode.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; pcm?: ArrayBuffer; rms?: number } | undefined
      if (data?.type === "DATA" && data.pcm) {
        if (isMuted() || !activeWebSocket || activeWebSocket.readyState !== WebSocket.OPEN) {
          return
        }

        if (typeof data.rms === "number" && data.rms > 0.015 && connectionState() === "idle") {
          setConnectionState("listening")
        }

        const base64PCM = arrayBufferToBase64(data.pcm)

        if (provider === "gemini") {
          activeWebSocket.send(
            JSON.stringify({
              realtimeInput: {
                mediaChunks: [
                  {
                    mimeType: "audio/pcm;rate=16000",
                    data: base64PCM,
                  },
                ],
              },
            }),
          )
        } else if (provider === "openai") {
          activeWebSocket.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: base64PCM,
            }),
          )
        }
      }
    }

    // 7. Setup WebSocket event lifecycle
    ws.onopen = () => {
      setConnectionState("listening")

      if (provider === "gemini") {
        const rawModel = options?.model || "gemini-2.0-flash-exp"
        const formattedModel = rawModel.startsWith("models/") ? rawModel : `models/${rawModel}`
        const voice = options?.voice || "Aoede"
        const systemInstruction =
          options?.systemInstruction ||
          "You are CodeNomad's live voice coding assistant. Speak concisely and accurately."

        const setupPayload = {
          setup: {
            model: formattedModel,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voice,
                  },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            tools: [
              {
                functionDeclarations: toGeminiFunctionDeclarations(LIVE_VOICE_TOOLS),
              },
            ],
          },
        }

        ws.send(JSON.stringify(setupPayload))
      } else if (provider === "openai") {
        const voice = options?.voice || "alloy"
        const systemInstruction =
          options?.systemInstruction ||
          "You are CodeNomad's live voice coding assistant. Speak concisely and accurately."

        const sessionUpdate = {
          type: "session.update",
          session: {
            voice,
            instructions: systemInstruction,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: {
              type: "server_vad",
            },
            tools: toOpenAITools(LIVE_VOICE_TOOLS),
          },
        }

        ws.send(JSON.stringify(sessionUpdate))
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data as string) as Record<string, unknown>
        if (provider === "gemini") {
          void handleGeminiMessage(parsed)
        } else if (provider === "openai") {
          void handleOpenAIMessage(parsed)
        }
      } catch (err) {
        console.warn("Failed to parse live voice message:", err)
      }
    }

    ws.onerror = (err) => {
      console.error("Live voice WebSocket error:", err)
      setConnectionState("error")
    }

    ws.onclose = () => {
      if (connectionState() !== "disconnected") {
        disconnect()
      }
    }
  } catch (error) {
    console.error("Failed to connect live voice session:", error)
    disconnect()
    setConnectionState("error")
    throw error
  }
}

/**
 * Disconnects the active live voice session and releases all hardware resources.
 */
export function disconnect(): void {
  clearSpeakingTimeout()

  if (activeWebSocket) {
    activeWebSocket.onopen = null
    activeWebSocket.onmessage = null
    activeWebSocket.onerror = null
    activeWebSocket.onclose = null
    if (
      activeWebSocket.readyState === WebSocket.OPEN ||
      activeWebSocket.readyState === WebSocket.CONNECTING
    ) {
      activeWebSocket.close()
    }
    activeWebSocket = null
  }

  if (activeMediaStream) {
    stopTracks(activeMediaStream)
    activeMediaStream = null
  }

  if (activeMicSource) {
    try {
      activeMicSource.disconnect()
    } catch {
      // ignore
    }
    activeMicSource = null
  }

  if (activeRecorderNode) {
    try {
      activeRecorderNode.port.onmessage = null
      activeRecorderNode.disconnect()
    } catch {
      // ignore
    }
    activeRecorderNode = null
  }

  if (activePlayerNode) {
    try {
      activePlayerNode.port.postMessage({ type: "FLUSH" })
      activePlayerNode.disconnect()
    } catch {
      // ignore
    }
    activePlayerNode = null
  }

  if (activeAnalyserNode) {
    try {
      activeAnalyserNode.disconnect()
    } catch {
      // ignore
    }
    activeAnalyserNode = null
    setAnalyserNode(null)
  }

  if (activeAudioContext) {
    try {
      void activeAudioContext.close()
    } catch {
      // ignore
    }
    activeAudioContext = null
    setAudioContext(null)
  }

  currentConnectOptions = null
  setConnectionState("disconnected")
}

/**
 * Live voice session controller bundle for easy importing.
 */
export const liveVoiceSession = {
  connectionState,
  isMuted,
  setMuted,
  activeProvider,
  setActiveProvider,
  transcript,
  analyserNode,
  audioContext,
  connect,
  disconnect,
  interrupt,
}
