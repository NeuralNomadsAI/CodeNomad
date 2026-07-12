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

describe("card-level regression: URL edit does not silently delete key", () => {
  it("buildDirSave does NOT clear apiKey when URL changes and no new key entered", () => {
    const result = buildDirSave(false, "", "https://api.groq.com/v1", "whisper-large-v3", "whisper-1")
    assert.equal("apiKey" in result, false, "buildDirSave must not silently add apiKey: null when URL changes")
    assert.equal(result.baseUrl, "https://api.groq.com/v1")
  })

  it("buildDirSave includes apiKey when user enters a new key", () => {
    const result = buildDirSave(false, "sk-new-key", "https://api.groq.com/v1", "whisper-large-v3", "whisper-1")
    assert.equal(result.apiKey, "sk-new-key")
    assert.equal(result.baseUrl, "https://api.groq.com/v1")
  })

  it("buildDirSave clears all fields when clearKey is true", () => {
    const result = buildDirSave(true, "", "", "", "whisper-1")
    assert.deepEqual(result, { apiKey: null, baseUrl: null, model: null })
  })

  it("buildDirSave sends null model when it matches shared model", () => {
    const result = buildDirSave(false, "sk-key", "https://api.groq.com/v1", "whisper-1", "whisper-1")
    assert.equal(result.model, null, "matching shared model should not be persisted as directional override")
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
    assert.equal(patch.apiKey, "sk-shared-key", "shared apiKey must be in the patch")
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
