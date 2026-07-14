import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { enforceSpeechCredentialPairing } from "./settings"

describe("enforceSpeechCredentialPairing", () => {
  it("clears shared key when baseUrl differs from stored", () => {
    const result = enforceSpeechCredentialPairing(
      { speech: { baseUrl: "https://new.com/v1" } },
      { speech: { baseUrl: "https://old.com/v1", apiKey: "sk-stored" } },
    ) as any
    assert.equal(result.speech.apiKey, null)
  })

  it("does NOT clear shared key when baseUrl matches stored (old client full patch)", () => {
    const result = enforceSpeechCredentialPairing(
      { speech: { baseUrl: "https://api.openai.com/v1", ttsVoice: "alloy", playbackMode: "streaming" } },
      { speech: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-stored" } },
    ) as any
    assert.equal("apiKey" in result.speech, false, "must not clear key when URL unchanged")
  })

  it("clears directional key when directional baseUrl differs from stored", () => {
    const result = enforceSpeechCredentialPairing(
      { speech: { stt: { baseUrl: "https://new.com/v1" } } },
      { speech: { stt: { baseUrl: "https://old.com/v1", apiKey: "sk-stored" } } },
    ) as any
    assert.equal(result.speech.stt.apiKey, null)
  })

  it("does NOT clear directional key when baseUrl matches stored", () => {
    const result = enforceSpeechCredentialPairing(
      { speech: { stt: { baseUrl: "https://same.com/v1", model: "whisper-1" } } },
      { speech: { stt: { baseUrl: "https://same.com/v1", apiKey: "sk-stored" } } },
    ) as any
    assert.equal("apiKey" in result.speech.stt, false, "must not clear directional key when URL unchanged")
  })

  it("preserves apiKey when both baseUrl and apiKey are in patch", () => {
    const result = enforceSpeechCredentialPairing(
      { speech: { baseUrl: "https://new.com/v1", apiKey: "sk-new" } },
      { speech: { baseUrl: "https://old.com/v1", apiKey: "sk-old" } },
    ) as any
    assert.equal(result.speech.apiKey, "sk-new")
  })

  it("handles both stt and tts independently against stored values", () => {
    const result = enforceSpeechCredentialPairing(
      { speech: { stt: { baseUrl: "https://stt-same.com/v1", apiKey: "sk-stt" }, tts: { baseUrl: "https://tts-new.com/v1" } } },
      { speech: { stt: { baseUrl: "https://stt-same.com/v1", apiKey: "sk-stt" }, tts: { baseUrl: "https://tts-old.com/v1", apiKey: "sk-tts" } } },
    ) as any
    assert.equal(result.speech.stt.apiKey, "sk-stt")
    assert.equal(result.speech.tts.apiKey, null)
  })

  it("passes through non-speech patches unchanged", () => {
    const body = { logLevel: "INFO" }
    const result = enforceSpeechCredentialPairing(body, { speech: {} })
    assert.deepEqual(result, body)
  })

  it("passes through null/undefined body", () => {
    assert.equal(enforceSpeechCredentialPairing(null), null)
    assert.equal(enforceSpeechCredentialPairing(undefined), undefined)
  })

  it("does not mutate the original body", () => {
    const original = { speech: { baseUrl: "https://new.com/v1" } }
    const originalCopy = JSON.parse(JSON.stringify(original))
    enforceSpeechCredentialPairing(original, { speech: { baseUrl: "https://old.com/v1" } })
    assert.deepEqual(original, originalCopy)
  })

  it("doc-level payload: clears key when server.speech.baseUrl changes", () => {
    const docBody = { server: { speech: { baseUrl: "https://new.com/v1" } } }
    const currentServer = { speech: { baseUrl: "https://old.com/v1", apiKey: "sk-stored" } }
    const result = enforceSpeechCredentialPairing(docBody.server, currentServer) as any
    assert.equal(result.speech.apiKey, null, "doc-level server.speech must have key cleared on URL change")
    assert.equal(result.speech.baseUrl, "https://new.com/v1")
  })

  it("doc-level payload: preserves key when server.speech.baseUrl unchanged", () => {
    const docBody = { server: { speech: { baseUrl: "https://same.com/v1", ttsVoice: "alloy" } } }
    const currentServer = { speech: { baseUrl: "https://same.com/v1", apiKey: "sk-stored" } }
    const result = enforceSpeechCredentialPairing(docBody.server, currentServer) as any
    assert.equal("apiKey" in result.speech, false, "key must not be cleared when URL unchanged in doc-level patch")
  })
})
