import assert from "node:assert/strict"
import { describe, it } from "node:test"

function enforceSpeechCredentialPairing(body: unknown): unknown {
  if (!body || typeof body !== "object") return body
  const patch = { ...(body as Record<string, unknown>) }
  const speech = patch.speech
  if (!speech || typeof speech !== "object") return patch
  const speechPatch = { ...(speech as Record<string, unknown>) }
  for (const dir of ["stt", "tts"] as const) {
    if (dir in speechPatch) {
      const dirPatch = { ...(speechPatch[dir] as Record<string, unknown>) }
      if ("baseUrl" in dirPatch && !("apiKey" in dirPatch)) {
        dirPatch.apiKey = null
        speechPatch[dir] = dirPatch
      }
    }
  }
  patch.speech = speechPatch
  return patch
}

describe("enforceSpeechCredentialPairing", () => {
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
    assert.equal(result.speech.stt.apiKey, "sk-stt", "stt key preserved when both fields provided")
    assert.equal(result.speech.tts.apiKey, null, "tts key cleared when only baseUrl provided")
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
