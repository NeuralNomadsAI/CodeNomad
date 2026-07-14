import assert from "node:assert/strict"
import { describe, it } from "node:test"

type Caps = Record<string, unknown>

function normalizeCapabilities(result: Caps): Caps {
  if (result.sttConfigured === undefined) result.sttConfigured = result.configured
  if (result.ttsConfigured === undefined) result.ttsConfigured = result.configured
  if (result.separateProviders === undefined) result.separateProviders = false
  return result
}

describe("normalizeCapabilities (old server compat)", () => {
  it("derives sttConfigured/ttsConfigured from configured when absent", () => {
    const legacy: Caps = {
      available: true,
      configured: true,
      provider: "openai-compatible",
      supportsStt: true,
      supportsTts: true,
      supportsStreamingTts: true,
      sttModel: "whisper-1",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsFormats: ["mp3"],
      streamingTtsFormats: ["mp3"],
    }
    const normalized = normalizeCapabilities(legacy)
    assert.equal(normalized.sttConfigured, true)
    assert.equal(normalized.ttsConfigured, true)
    assert.equal(normalized.separateProviders, false)
  })

  it("preserves explicit directional values from new server", () => {
    const modern: Caps = {
      available: true,
      configured: false,
      provider: "openai-compatible",
      supportsStt: true,
      supportsTts: true,
      supportsStreamingTts: true,
      sttModel: "whisper-1",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsFormats: ["mp3"],
      streamingTtsFormats: ["mp3"],
      separateProviders: true,
      sttConfigured: true,
      ttsConfigured: false,
    }
    const normalized = normalizeCapabilities(modern)
    assert.equal(normalized.sttConfigured, true, "must not overwrite explicit sttConfigured")
    assert.equal(normalized.ttsConfigured, false, "must not overwrite explicit ttsConfigured")
    assert.equal(normalized.separateProviders, true)
  })

  it("derives false when legacy configured is false", () => {
    const legacy: Caps = {
      available: true,
      configured: false,
      provider: "openai-compatible",
      supportsStt: true,
      supportsTts: true,
      supportsStreamingTts: true,
      sttModel: "whisper-1",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsFormats: ["mp3"],
      streamingTtsFormats: ["mp3"],
    }
    const normalized = normalizeCapabilities(legacy)
    assert.equal(normalized.sttConfigured, false)
    assert.equal(normalized.ttsConfigured, false)
  })
})
