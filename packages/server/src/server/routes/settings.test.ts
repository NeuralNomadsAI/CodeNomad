import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { enforceSpeechCredentialPairing } from "./settings"

describe("enforceSpeechCredentialPairing", () => {
  it("clears shared apiKey when shared baseUrl changes without apiKey in patch", () => {
    const result = enforceSpeechCredentialPairing({
      speech: { baseUrl: "https://api.newendpoint.com/v1" },
    }) as any
    assert.equal(result.speech.apiKey, null, "shared apiKey must be cleared when only baseUrl is patched")
    assert.equal(result.speech.baseUrl, "https://api.newendpoint.com/v1")
  })

  it("preserves shared apiKey when both baseUrl and apiKey are in patch", () => {
    const result = enforceSpeechCredentialPairing({
      speech: { baseUrl: "https://api.newendpoint.com/v1", apiKey: "sk-new-shared" },
    }) as any
    assert.equal(result.speech.apiKey, "sk-new-shared")
  })

  it("clears stored key when baseUrl changes without apiKey in patch", () => {
    const result = enforceSpeechCredentialPairing({
      speech: { stt: { baseUrl: "https://api.groq.com/v1" } },
    }) as any
    assert.equal(result.speech.stt.apiKey, null, "apiKey must be cleared when only baseUrl is patched")
    assert.equal(result.speech.stt.baseUrl, "https://api.groq.com/v1")
  })

  it("preserves apiKey when both baseUrl and apiKey are in patch", () => {
    const result = enforceSpeechCredentialPairing({
      speech: { stt: { baseUrl: "https://api.groq.com/v1", apiKey: "sk-new" } },
    }) as any
    assert.equal(result.speech.stt.apiKey, "sk-new")
  })

  it("does not add apiKey when baseUrl is not in patch", () => {
    const result = enforceSpeechCredentialPairing({
      speech: { stt: { apiKey: "sk-key" } },
    }) as any
    assert.equal("apiKey" in result.speech.stt, true)
    assert.equal("baseUrl" in result.speech.stt, false)
  })

  it("handles both stt and tts independently", () => {
    const result = enforceSpeechCredentialPairing({
      speech: {
        stt: { baseUrl: "https://stt.example.com/v1", apiKey: "sk-stt" },
        tts: { baseUrl: "https://tts.example.com/v1" },
      },
    }) as any
    assert.equal(result.speech.stt.apiKey, "sk-stt")
    assert.equal(result.speech.tts.apiKey, null)
  })

  it("passes through non-speech patches unchanged", () => {
    const body = { logLevel: "INFO", opencodeBinary: "/usr/bin/opencode" }
    const result = enforceSpeechCredentialPairing(body)
    assert.deepEqual(result, body)
  })

  it("passes through null/undefined body", () => {
    assert.equal(enforceSpeechCredentialPairing(null), null)
    assert.equal(enforceSpeechCredentialPairing(undefined), undefined)
  })

  it("does not mutate the original body", () => {
    const original = { speech: { stt: { baseUrl: "https://new.com/v1" } } }
    const originalCopy = JSON.parse(JSON.stringify(original))
    enforceSpeechCredentialPairing(original)
    assert.deepEqual(original, originalCopy, "original body must not be mutated")
  })
})
