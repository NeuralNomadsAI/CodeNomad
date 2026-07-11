import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SpeechService } from "./service"
import type { SettingsService } from "../settings/service"
import type { Logger } from "../logger"

function createMockSettings(serverConfig: Record<string, unknown>): SettingsService {
  return {
    getOwner: () => serverConfig,
  } as unknown as SettingsService
}

const mockLogger: Logger = {
  child: () => mockLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

describe("SpeechService direction resolution", () => {
  describe("separateProviders = false (default)", () => {
    it("uses shared apiKey for both STT and TTS", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          baseUrl: "https://api.openai.com/v1",
          sttModel: "whisper-1",
          ttsModel: "tts-1",
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.separateProviders, false)
      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, true)
      assert.equal(caps.configured, true)
    })

    it("reports unconfigured when no apiKey is set", () => {
      const settings = createMockSettings({
        speech: { sttModel: "whisper-1", ttsModel: "tts-1" },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, false)
      assert.equal(caps.ttsConfigured, false)
      assert.equal(caps.configured, false)
    })
  })

  describe("separateProviders = true", () => {
    it("reports per-direction configured status independently", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          separateProviders: true,
          stt: { apiKey: "sk-groq", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3" },
          tts: { apiKey: "sk-openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.separateProviders, true)
      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, true)
      assert.equal(caps.configured, true)
      assert.equal(caps.sttBaseUrl, "https://api.groq.com/openai/v1")
      assert.equal(caps.ttsBaseUrl, "https://api.openai.com/v1")
    })

    it("reports partial config when only STT has complete directional pair", () => {
      const settings = createMockSettings({
        speech: {
          separateProviders: true,
          stt: { apiKey: "sk-groq", baseUrl: "https://api.groq.com/openai/v1" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, false)
      assert.equal(caps.configured, false)
    })

    it("does NOT combine directional key with shared URL (incomplete pair)", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          baseUrl: "https://api.openai.com/v1",
          separateProviders: true,
          stt: { apiKey: "sk-groq" },
          tts: { apiKey: "sk-deepseek" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, false, "directional key without directional URL should not be configured")
      assert.equal(caps.ttsConfigured, false)
    })

    it("does NOT combine shared key with directional URL (incomplete pair)", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          baseUrl: "https://api.openai.com/v1",
          separateProviders: true,
          stt: { baseUrl: "https://api.groq.com/openai/v1" },
          tts: { baseUrl: "https://api.openai.com/v1" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, false)
      assert.equal(caps.ttsConfigured, false)
    })

    it("inherits complete shared pair when neither directional value is set", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          baseUrl: "https://api.openai.com/v1",
          separateProviders: true,
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, true)
    })

    it("uses complete directional pair when both key and URL are set", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          baseUrl: "https://api.openai.com/v1",
          separateProviders: true,
          stt: { apiKey: "sk-groq", baseUrl: "https://api.groq.com/openai/v1" },
          tts: { apiKey: "sk-openai", baseUrl: "https://api.openai.com/v1" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, true)
      assert.equal(caps.sttBaseUrl, "https://api.groq.com/openai/v1")
    })

    it("falls back to shared sttModel/ttsModel when per-direction model is absent", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          sttModel: "shared-stt-model",
          ttsModel: "shared-tts-model",
          separateProviders: true,
          stt: { apiKey: "sk-stt" },
          tts: { apiKey: "sk-tts" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttModel, "shared-stt-model")
      assert.equal(caps.ttsModel, "shared-tts-model")
    })

    it("uses per-direction model when set", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          sttModel: "shared-stt-model",
          ttsModel: "shared-tts-model",
          separateProviders: true,
          stt: { apiKey: "sk-stt", model: "whisper-large-v3" },
          tts: { apiKey: "sk-tts", model: "gpt-4o-mini-tts" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttModel, "whisper-large-v3")
      assert.equal(caps.ttsModel, "gpt-4o-mini-tts")
    })

    it("omits sttBaseUrl/ttsBaseUrl when separateProviders is false", () => {
      const settings = createMockSettings({
        speech: { apiKey: "sk-shared", baseUrl: "https://api.openai.com/v1" },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttBaseUrl, undefined)
      assert.equal(caps.ttsBaseUrl, undefined)
    })
  })
})
