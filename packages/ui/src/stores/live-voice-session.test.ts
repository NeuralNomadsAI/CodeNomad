import assert from "node:assert/strict"
import { beforeEach, afterEach, describe, it } from "node:test"
import {
  arrayBufferToBase64,
  base64ToInt16Array,
  resamplePcm16,
  resolveLiveVoiceWsUrl,
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
  liveVoiceSession,
} from "./live-voice-session"

describe("Live Voice Session Store", () => {
  beforeEach(() => {
    disconnect()
    setMuted(false)
    setActiveProvider("gemini")
  })

  describe("Binary PCM & Base64 Audio Utilities", () => {
    it("converts between ArrayBuffer PCM and Base64 round-trip", () => {
      const originalSamples = new Int16Array([0, 1000, -1000, 32767, -32768, 500, -500])
      const base64 = arrayBufferToBase64(originalSamples.buffer)
      assert.ok(typeof base64 === "string" && base64.length > 0)

      const decoded = base64ToInt16Array(base64)
      assert.equal(decoded.length, originalSamples.length)
      for (let i = 0; i < originalSamples.length; i++) {
        assert.equal(decoded[i], originalSamples[i])
      }
    })

    it("handles empty buffers gracefully", () => {
      const emptyBuffer = new ArrayBuffer(0)
      const base64 = arrayBufferToBase64(emptyBuffer)
      assert.equal(base64, "")

      const decoded = base64ToInt16Array("")
      assert.equal(decoded.length, 0)
    })

    it("resamples 16-bit PCM linearly across sample rates", () => {
      const srcRate = 16000
      const dstRate = 32000
      const srcSamples = new Int16Array([0, 10000, 20000, 10000, 0])
      const resampled = resamplePcm16(srcSamples, srcRate, dstRate)

      assert.equal(resampled.length, srcSamples.length * 2)
      assert.equal(resampled[0], 0)

      const unchanged = resamplePcm16(srcSamples, 16000, 16000)
      assert.equal(unchanged, srcSamples)
    })

    it("resolves live voice gateway WebSocket URLs", () => {
      const geminiUrl = resolveLiveVoiceWsUrl({
        provider: "gemini",
        model: "gemini-2.0-flash-exp",
        voice: "Aoede",
      })
      assert.ok(geminiUrl.includes("/api/speech/live/ws"))
      assert.ok(geminiUrl.includes("provider=gemini"))
      assert.ok(geminiUrl.includes("model=gemini-2.0-flash-exp"))
      assert.ok(geminiUrl.includes("voice=Aoede"))

      const openaiUrl = resolveLiveVoiceWsUrl({
        provider: "openai",
        model: "gpt-4o-realtime-preview",
        voice: "alloy",
      })
      assert.ok(openaiUrl.includes("/api/speech/live/ws"))
      assert.ok(openaiUrl.includes("provider=openai"))
      assert.ok(openaiUrl.includes("model=gpt-4o-realtime-preview"))
      assert.ok(openaiUrl.includes("voice=alloy"))
    })
  })

  describe("Reactive State Exports", () => {
    it("exposes expected initial reactive signals", () => {
      assert.equal(connectionState(), "disconnected")
      assert.equal(isMuted(), false)
      assert.equal(activeProvider(), "gemini")
      assert.ok(Array.isArray(transcript()))
      assert.equal(analyserNode(), null)
      assert.equal(audioContext(), null)
    })

    it("updates mute state reactively", () => {
      assert.equal(isMuted(), false)
      setMuted(true)
      assert.equal(isMuted(), true)
      setMuted(false)
      assert.equal(isMuted(), false)
    })

    it("updates provider reactively", () => {
      assert.equal(activeProvider(), "gemini")
      setActiveProvider("openai")
      assert.equal(activeProvider(), "openai")
      setActiveProvider("gemini")
      assert.equal(activeProvider(), "gemini")
    })

    it("bundles all exports into liveVoiceSession object", () => {
      assert.equal(liveVoiceSession.connectionState, connectionState)
      assert.equal(liveVoiceSession.isMuted, isMuted)
      assert.equal(liveVoiceSession.setMuted, setMuted)
      assert.equal(liveVoiceSession.activeProvider, activeProvider)
      assert.equal(liveVoiceSession.setActiveProvider, setActiveProvider)
      assert.equal(liveVoiceSession.transcript, transcript)
      assert.equal(liveVoiceSession.analyserNode, analyserNode)
      assert.equal(liveVoiceSession.audioContext, audioContext)
      assert.equal(liveVoiceSession.connect, connect)
      assert.equal(liveVoiceSession.disconnect, disconnect)
      assert.equal(liveVoiceSession.interrupt, interrupt)
    })
  })

  describe("Session Protocol Handling & Mock Lifecycle", () => {
    let lastMockWebSocket: MockWebSocket | null = null
    let mockRecorderNode: MockAudioWorkletNode | null = null
    let mockPlayerNode: MockAudioWorkletNode | null = null

    class MockPort {
      public onmessage: ((event: { data: unknown }) => void) | null = null
      public messages: unknown[] = []

      postMessage(msg: unknown) {
        this.messages.push(msg)
      }
    }

    class MockAudioWorkletNode {
      public port = new MockPort()
      public connectedTo: unknown = null

      constructor(public context: unknown, public processorName: string) {
        if (processorName === "pcm-recorder-processor") {
          mockRecorderNode = this
        } else if (processorName === "pcm-stream-player-processor") {
          mockPlayerNode = this
        }
      }

      connect(target: unknown) {
        this.connectedTo = target
      }

      disconnect() {
        this.connectedTo = null
      }
    }

    class MockMediaStreamSourceNode {
      public connectedTo: unknown = null
      connect(target: unknown) {
        this.connectedTo = target
      }
      disconnect() {
        this.connectedTo = null
      }
    }

    class MockAnalyserNode {
      public fftSize = 2048
      public smoothingTimeConstant = 0.8
      public connectedTo: unknown = null
      connect(target: unknown) {
        this.connectedTo = target
      }
      disconnect() {
        this.connectedTo = null
      }
    }

    class MockAudioContext {
      public state = "running"
      public sampleRate = 48000
      public destination = {}
      public audioWorklet = {
        addModule: async () => {},
      }
      createMediaStreamSource() {
        return new MockMediaStreamSourceNode()
      }
      createAnalyser() {
        return new MockAnalyserNode()
      }
      async resume() {
        this.state = "running"
      }
      async close() {
        this.state = "closed"
      }
    }

    class MockWebSocket {
      static OPEN = 1
      static CONNECTING = 0
      static CLOSING = 2
      static CLOSED = 3

      public readyState = MockWebSocket.CONNECTING
      public sent: string[] = []
      public onopen: (() => void) | null = null
      public onmessage: ((event: { data: string }) => void) | null = null
      public onerror: ((err: unknown) => void) | null = null
      public onclose: (() => void) | null = null

      constructor(public url: string) {
        lastMockWebSocket = this
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          this.onopen?.()
        }, 10)
      }

      send(data: string) {
        this.sent.push(data)
      }

      close() {
        this.readyState = MockWebSocket.CLOSED
        this.onclose?.()
      }
    }

    let originalWindow: typeof globalThis.window
    let originalWebSocket: typeof globalThis.WebSocket
    let originalAudioContext: unknown
    let originalAudioWorkletNode: unknown
    let originalNavigator: typeof globalThis.navigator

    beforeEach(() => {
      lastMockWebSocket = null
      mockRecorderNode = null
      mockPlayerNode = null

      originalWindow = globalThis.window
      originalWebSocket = globalThis.WebSocket
      originalAudioContext = (globalThis as any).AudioContext
      originalAudioWorkletNode = (globalThis as any).AudioWorkletNode
      originalNavigator = globalThis.navigator

      ;(globalThis as any).window = {
        AudioContext: MockAudioContext,
        location: { origin: "http://localhost:9898" },
      }
      ;(globalThis as any).WebSocket = MockWebSocket
      ;(globalThis as any).AudioContext = MockAudioContext
      ;(globalThis as any).AudioWorkletNode = MockAudioWorkletNode

      Object.defineProperty(globalThis, "navigator", {
        value: {
          mediaDevices: {
            getUserMedia: async () => ({
              getTracks: () => [{ enabled: true, stop: () => {} }],
              getAudioTracks: () => [{ enabled: true, stop: () => {} }],
            }),
          },
        },
        configurable: true,
        writable: true,
      })
    })

    afterEach(() => {
      ;(globalThis as any).window = originalWindow
      ;(globalThis as any).WebSocket = originalWebSocket
      ;(globalThis as any).AudioContext = originalAudioContext
      ;(globalThis as any).AudioWorkletNode = originalAudioWorkletNode
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      })
    })

    it("connects and sends Gemini setup payload on open", async () => {
      await connect({
        provider: "gemini",
        model: "gemini-2.0-flash-exp",
        voice: "Aoede",
      })

      assert.equal(connectionState(), "connecting")

      await new Promise((resolve) => setTimeout(resolve, 30))

      assert.equal(connectionState(), "listening")
      assert.ok(analyserNode() !== null)
      assert.ok(audioContext() !== null)

      assert.ok(lastMockWebSocket)
      assert.equal(lastMockWebSocket.sent.length, 1)
      const parsedSetup = JSON.parse(lastMockWebSocket.sent[0]) as any
      assert.ok(parsedSetup.setup)
      assert.equal(parsedSetup.setup.model, "models/gemini-2.0-flash-exp")
      assert.equal(
        parsedSetup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
        "Aoede",
      )
      assert.equal(parsedSetup.setup.tools[0].functionDeclarations.length, 4)
    })

    it("processes Gemini incoming text and audio stream parts", async () => {
      await connect({ provider: "gemini" })
      await new Promise((resolve) => setTimeout(resolve, 30))

      assert.ok(lastMockWebSocket)
      assert.ok(mockPlayerNode)

      const dummyPCM = new Int16Array([100, 200, 300, 400])
      const dummyBase64 = arrayBufferToBase64(dummyPCM.buffer)

      lastMockWebSocket.onmessage?.({
        data: JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [
                { text: "Hello developer, " },
                {
                  inlineData: {
                    mimeType: "audio/pcm;rate=24000",
                    data: dummyBase64,
                  },
                },
              ],
            },
          },
        }),
      })

      assert.equal(connectionState(), "speaking")
      assert.ok(transcript().some((t) => t.text.includes("Hello developer")))
      assert.ok(mockPlayerNode.port.messages.some((m: any) => m.type === "FEED"))

      lastMockWebSocket.onmessage?.({
        data: JSON.stringify({
          serverContent: {
            interrupted: true,
          },
        }),
      })

      assert.equal(connectionState(), "listening")
      assert.ok(mockPlayerNode.port.messages.some((m: any) => m.type === "FLUSH"))
    })

    it("handles Gemini toolCall and sends toolResponse", async () => {
      await connect({ provider: "gemini" })
      await new Promise((resolve) => setTimeout(resolve, 30))

      assert.ok(lastMockWebSocket)

      lastMockWebSocket.onmessage?.({
        data: JSON.stringify({
          toolCall: {
            functionCalls: [
              {
                id: "call-1",
                name: "read_active_file",
                args: {},
              },
            ],
          },
        }),
      })

      await new Promise((resolve) => setTimeout(resolve, 20))

      const toolResponseMsg = lastMockWebSocket.sent.find((m) => m.includes("toolResponse"))
      assert.ok(toolResponseMsg)
      const parsedToolRes = JSON.parse(toolResponseMsg) as any
      assert.equal(parsedToolRes.toolResponse.functionResponses[0].id, "call-1")
    })

    it("connects and sends OpenAI session.update payload on open", async () => {
      await connect({
        provider: "openai",
        model: "gpt-4o-realtime-preview",
        voice: "alloy",
      })

      await new Promise((resolve) => setTimeout(resolve, 30))

      assert.equal(connectionState(), "listening")
      assert.equal(activeProvider(), "openai")

      assert.ok(lastMockWebSocket)
      assert.equal(lastMockWebSocket.sent.length, 1)
      const parsedUpdate = JSON.parse(lastMockWebSocket.sent[0]) as any
      assert.equal(parsedUpdate.type, "session.update")
      assert.equal(parsedUpdate.session.voice, "alloy")
      assert.equal(parsedUpdate.session.input_audio_format, "pcm16")
      assert.equal(parsedUpdate.session.output_audio_format, "pcm16")
      assert.equal(parsedUpdate.session.tools.length, 4)
    })

    it("handles OpenAI speech interruption and response cancellation", async () => {
      await connect({ provider: "openai" })
      await new Promise((resolve) => setTimeout(resolve, 30))

      assert.ok(lastMockWebSocket)
      assert.ok(mockPlayerNode)

      lastMockWebSocket.onmessage?.({
        data: JSON.stringify({
          type: "input_audio_buffer.speech_started",
        }),
      })

      assert.ok(lastMockWebSocket.sent.some((m) => m.includes("response.cancel")))
      assert.ok(mockPlayerNode.port.messages.some((m: any) => m.type === "FLUSH"))
      assert.equal(connectionState(), "listening")
    })

    it("handles OpenAI function call arguments done and responds with tool output", async () => {
      await connect({ provider: "openai" })
      await new Promise((resolve) => setTimeout(resolve, 30))

      assert.ok(lastMockWebSocket)

      lastMockWebSocket.onmessage?.({
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call_open_1",
          name: "read_active_file",
          arguments: "{}",
        }),
      })

      await new Promise((resolve) => setTimeout(resolve, 20))

      const outputMsg = lastMockWebSocket.sent.find((m) => m.includes("function_call_output"))
      assert.ok(outputMsg)
      const parsedOutput = JSON.parse(outputMsg) as any
      assert.equal(parsedOutput.item.call_id, "call_open_1")

      const createResponseMsg = lastMockWebSocket.sent.find((m) => m.includes("response.create"))
      assert.ok(createResponseMsg)
    })

    it("forwards mic recorder PCM audio chunks to WebSocket when unmuted", async () => {
      await connect({ provider: "gemini" })
      await new Promise((resolve) => setTimeout(resolve, 30))

      assert.ok(lastMockWebSocket)
      assert.ok(mockRecorderNode)

      const testBuffer = new Int16Array([50, 100, 150]).buffer
      mockRecorderNode.port.onmessage?.({
        data: {
          type: "DATA",
          pcm: testBuffer,
          rms: 0.05,
        },
      } as any)

      const audioSent = lastMockWebSocket.sent.find((m) => m.includes("realtimeInput"))
      assert.ok(audioSent)

      setMuted(true)
      const sentCountBefore = lastMockWebSocket.sent.length
      mockRecorderNode.port.onmessage?.({
        data: {
          type: "DATA",
          pcm: testBuffer,
          rms: 0.05,
        },
      } as any)
      assert.equal(lastMockWebSocket.sent.length, sentCountBefore)
    })

    it("cleans up resources and resets state on disconnect", async () => {
      await connect({ provider: "gemini" })
      await new Promise((resolve) => setTimeout(resolve, 30))

      disconnect()

      assert.equal(connectionState(), "disconnected")
      assert.equal(analyserNode(), null)
      assert.equal(audioContext(), null)
    })
  })
})
