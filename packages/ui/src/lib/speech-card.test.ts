import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildDirSave } from "./speech-dir-save"
import { buildSpeechPatch } from "./speech-patch"

describe("card-level regression: separate → shared preserves directional config", () => {
  it("shared-mode save patch does NOT include stt/tts cleanup", () => {
    const patch = buildSpeechPatch({
      separateProviders: false,
      baseUrl: "https://api.openai.com/v1",
      sttModel: "whisper-1",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      playbackMode: "streaming",
      ttsFormat: "mp3",
    })
    assert.equal("stt" in patch, false, "shared-mode patch must not touch stt")
    assert.equal("tts" in patch, false, "shared-mode patch must not touch tts")
    assert.equal(patch.separateProviders, false)
  })
})

describe("buildDirSave", () => {
  it("does NOT include baseUrl when it matches stored value (no key deletion)", () => {
    const stored = "https://api.groq.com/v1"
    const result = buildDirSave(false, "", stored, "whisper-large-v3", stored, "whisper-1")
    assert.equal("baseUrl" in result, false, "baseUrl must not be in patch when unchanged — prevents server from clearing key")
    assert.equal("apiKey" in result, false, "apiKey must not be in patch when no new key entered")
  })

  it("clears stored key when URL differs from stored (old-server safe)", () => {
    const result = buildDirSave(false, "", "https://api.new.com/v1", "whisper-large-v3", "https://api.old.com/v1", "whisper-1")
    assert.equal(result.baseUrl, "https://api.new.com/v1")
    assert.equal(result.apiKey, null, "apiKey must be null when URL changes without new key — old-server safe")
  })

  it("includes apiKey when user enters a new key", () => {
    const result = buildDirSave(false, "sk-new-key", "https://api.groq.com/v1", "whisper-large-v3", "https://api.groq.com/v1", "whisper-1")
    assert.equal(result.apiKey, "sk-new-key")
    assert.equal("baseUrl" in result, false, "baseUrl unchanged should not be in patch")
  })

  it("clears all fields when clearKey is true", () => {
    const result = buildDirSave(true, "", "", "", undefined, "whisper-1")
    assert.deepEqual(result, { apiKey: null, baseUrl: null, model: null })
  })

  it("sends null model when it matches shared model", () => {
    const result = buildDirSave(false, "sk-key", "https://api.groq.com/v1", "whisper-1", "https://api.groq.com/v1", "whisper-1")
    assert.equal(result.model, null, "matching shared model should not be persisted as directional override")
  })

  it("does not clear stored key when saving unrelated fields (model only)", () => {
    const stored = "https://api.groq.com/v1"
    const result = buildDirSave(false, "", stored, "whisper-large-v3", stored, "whisper-1")
    assert.equal("apiKey" in result, false, "must not include apiKey when only model changed")
    assert.equal("baseUrl" in result, false, "must not include baseUrl when unchanged")
    assert.equal(result.model, "whisper-large-v3")
  })
})

describe("card-level regression: shared key survives shared → separate", () => {
  it("separate-mode patch includes shared apiKey when provided", () => {
    const patch = buildSpeechPatch({
      separateProviders: true,
      apiKey: "sk-shared-key",
      ttsVoice: "alloy",
      playbackMode: "streaming",
      ttsFormat: "mp3",
    })
    assert.equal(patch.apiKey, "sk-shared-key")
    assert.equal(patch.separateProviders, true)
  })

  it("separate-mode patch includes shared apiKey null when clearing", () => {
    const patch = buildSpeechPatch({
      separateProviders: true,
      apiKey: null,
      ttsVoice: "alloy",
      playbackMode: "streaming",
      ttsFormat: "mp3",
    })
    assert.equal(patch.apiKey, null)
  })
})
