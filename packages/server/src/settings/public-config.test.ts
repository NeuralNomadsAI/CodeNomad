import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { sanitizeConfigOwner } from "./public-config"

describe("sanitizeConfigOwner server speech", () => {
  it("strips shared apiKey and sets hasApiKey", () => {
    const result = sanitizeConfigOwner("server", {
      speech: { apiKey: "sk-secret", sttModel: "whisper-1" },
    })
    assert.equal((result.speech as any).apiKey, undefined)
    assert.equal((result.speech as any).hasApiKey, true)
  })

  it("strips stt.apiKey and sets stt.hasApiKey when separateProviders is true", () => {
    const result = sanitizeConfigOwner("server", {
      speech: {
        separateProviders: true,
        apiKey: "sk-shared",
        stt: { apiKey: "sk-stt-secret", baseUrl: "https://groq.com" },
        tts: { apiKey: "sk-tts-secret", baseUrl: "https://openai.com" },
      },
    })
    assert.equal((result.speech as any).apiKey, undefined)
    assert.equal((result.speech as any).hasApiKey, true)
    assert.equal((result.speech as any).stt.apiKey, undefined)
    assert.equal((result.speech as any).stt.hasApiKey, true)
    assert.equal((result.speech as any).tts.apiKey, undefined)
    assert.equal((result.speech as any).tts.hasApiKey, true)
  })

  it("sets hasApiKey=false when per-direction apiKey is absent", () => {
    const result = sanitizeConfigOwner("server", {
      speech: {
        separateProviders: true,
        stt: { baseUrl: "https://groq.com" },
        tts: { baseUrl: "https://openai.com" },
      },
    })
    assert.equal((result.speech as any).stt.hasApiKey, false)
    assert.equal((result.speech as any).tts.hasApiKey, false)
  })

  it("preserves stt/tts sub-objects that have no apiKey", () => {
    const result = sanitizeConfigOwner("server", {
      speech: {
        separateProviders: true,
        stt: { model: "whisper-large-v3" },
        tts: { model: "tts-1" },
      },
    })
    assert.equal((result.speech as any).stt.model, "whisper-large-v3")
    assert.equal((result.speech as any).stt.hasApiKey, false)
    assert.equal((result.speech as any).tts.model, "tts-1")
    assert.equal((result.speech as any).tts.hasApiKey, false)
  })

  it("passes through non-server owners unchanged", () => {
    const result = sanitizeConfigOwner("ui", { foo: "bar" })
    assert.deepEqual(result, { foo: "bar" })
  })
})
