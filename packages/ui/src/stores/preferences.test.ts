import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildSpeechPatch } from "../lib/speech-patch"
import { buildBinaryList, normalizePreviewSettings, normalizeServerConfig, validatePreviewOrigin, type SpeechSettingsUpdate } from "./preferences"

describe("buildBinaryList", () => {
  it("does not add built-in commands to custom binary history", () => {
    const custom = { path: "C:/tools/opencode.exe", lastUsed: 1 }
    const source = [{ path: "opencode2", lastUsed: 2 }, custom]

    assert.deepEqual(buildBinaryList("opencode", undefined, source), source)
    assert.deepEqual(buildBinaryList("opencode2", undefined, source), source)
  })
})

describe("normalizeServerConfig", () => {
  it("maps the legacy system command to opencode2", () => {
    assert.equal(normalizeServerConfig({ opencodeBinary: "opencode" }).opencodeBinary, "opencode2")
    assert.equal(normalizeServerConfig({ opencodeBinary: "C:/tools/opencode2.exe" }).opencodeBinary, "C:/tools/opencode2.exe")
  })

  it("defaults to the server opaque preview policy", () => {
    assert.deepEqual(normalizeServerConfig({}).preview, {
      originMode: "opaque",
      customOrigin: "",
      sandbox: { forms: true, modals: true, popups: true, downloads: true },
      features: {
        camera: false,
        microphone: false,
        clipboardRead: false,
        clipboardWrite: false,
        geolocation: false,
        fullscreen: false,
      },
    })
  })

  it("preserves a stored preview policy", () => {
    const stored = normalizePreviewSettings({
      originMode: "custom",
      customOrigin: "https://preview.example.com/",
      sandbox: { forms: false },
      features: { camera: true },
    })

    assert.deepEqual(normalizeServerConfig({ preview: stored }).preview, {
      originMode: "custom",
      customOrigin: "https://preview.example.com",
      sandbox: { forms: false, modals: true, popups: true, downloads: true },
      features: {
        camera: true,
        microphone: false,
        clipboardRead: false,
        clipboardWrite: false,
        geolocation: false,
        fullscreen: false,
      },
    })
  })

  it("repairs an unknown preview mode and a malformed custom origin", () => {
    assert.deepEqual(normalizePreviewSettings({ originMode: "trusted", customOrigin: "https://preview.example.com/path" }), {
      originMode: "opaque",
      customOrigin: "",
      sandbox: { forms: true, modals: true, popups: true, downloads: true },
      features: {
        camera: false,
        microphone: false,
        clipboardRead: false,
        clipboardWrite: false,
        geolocation: false,
        fullscreen: false,
      },
    })
  })
})

describe("validatePreviewOrigin", () => {
  it("returns the normalized origin for a valid http(s) origin", () => {
    assert.equal(validatePreviewOrigin("  https://preview.example.com/  "), "https://preview.example.com")
    assert.equal(validatePreviewOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000")
  })

  it("rejects values that are not a bare http(s) origin", () => {
    assert.equal(validatePreviewOrigin(""), null)
    assert.equal(validatePreviewOrigin("   "), null)
    assert.equal(validatePreviewOrigin("not a url"), null)
    assert.equal(validatePreviewOrigin("ftp://preview.example.com"), null)
    assert.equal(validatePreviewOrigin("https://preview.example.com/path"), null)
    assert.equal(validatePreviewOrigin("https://preview.example.com/?q=1"), null)
    assert.equal(validatePreviewOrigin("https://user:pass@preview.example.com"), null)
  })
})

describe("buildSpeechPatch", () => {
  it("only includes fields that are explicitly provided", () => {
    const patch = buildSpeechPatch({ ttsVoice: "alloy" })
    assert.deepEqual(patch, { ttsVoice: "alloy" })
  })

  it("does not include fields that were not provided", () => {
    const patch = buildSpeechPatch({ separateProviders: true })
    assert.deepEqual(patch, { separateProviders: true })
    assert.equal("apiKey" in patch, false)
    assert.equal("baseUrl" in patch, false)
    assert.equal("sttModel" in patch, false)
    assert.equal("stt" in patch, false)
    assert.equal("tts" in patch, false)
  })

  it("converts empty string shared baseUrl to null", () => {
    const patch = buildSpeechPatch({ baseUrl: "  " })
    assert.equal(patch.baseUrl, null)
  })

  it("preserves non-empty shared baseUrl", () => {
    const patch = buildSpeechPatch({ baseUrl: "  https://api.openai.com/v1  " })
    assert.equal(patch.baseUrl, "https://api.openai.com/v1")
  })

  it("clears shared apiKey with null", () => {
    const patch = buildSpeechPatch({ apiKey: null })
    assert.equal(patch.apiKey, null)
  })

  it("sets shared apiKey to provided value", () => {
    const patch = buildSpeechPatch({ apiKey: "sk-new" })
    assert.equal(patch.apiKey, "sk-new")
  })

  it("includes directional apiKey as null for clearing", () => {
    const patch = buildSpeechPatch({ stt: { apiKey: null } })
    assert.deepEqual(patch.stt, { apiKey: null })
  })

  it("includes directional apiKey as string for setting", () => {
    const patch = buildSpeechPatch({ stt: { apiKey: "sk-groq" } })
    assert.deepEqual(patch.stt, { apiKey: "sk-groq" })
  })

  it("includes directional baseUrl only when provided", () => {
    const patch = buildSpeechPatch({ stt: { baseUrl: "https://api.groq.com/openai/v1" } })
    assert.deepEqual(patch.stt, { baseUrl: "https://api.groq.com/openai/v1" })
  })

  it("converts empty directional baseUrl to null", () => {
    const patch = buildSpeechPatch({ stt: { baseUrl: "" } })
    assert.deepEqual(patch.stt, { baseUrl: null })
  })

  it("clears all directional fields", () => {
    const patch = buildSpeechPatch({
      stt: { apiKey: null, baseUrl: null, model: null },
      tts: { apiKey: null, baseUrl: null, model: null },
    })
    assert.deepEqual(patch.stt, { apiKey: null, baseUrl: null, model: null })
    assert.deepEqual(patch.tts, { apiKey: null, baseUrl: null, model: null })
  })

  it("includes complete directional pair", () => {
    const patch = buildSpeechPatch({
      stt: { apiKey: "sk-groq", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3" },
    })
    assert.deepEqual(patch.stt, {
      apiKey: "sk-groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3",
    })
  })

  it("does not include empty directional sub-objects", () => {
    const patch = buildSpeechPatch({ stt: {}, tts: {} })
    assert.equal("stt" in patch, false)
    assert.equal("tts" in patch, false)
  })

  it("trims directional model and converts empty to null", () => {
    const patch = buildSpeechPatch({ stt: { model: "  whisper-large-v3  " } })
    assert.equal((patch.stt as Record<string, unknown>).model, "whisper-large-v3")

    const patchEmpty = buildSpeechPatch({ stt: { model: "  " } })
    assert.equal((patchEmpty.stt as Record<string, unknown>).model, null)
  })

  it("does not materialize fallback values from current settings", () => {
    const patch = buildSpeechPatch({ ttsVoice: "nova" })
    assert.equal("stt" in patch, false, "should not materialize stt sub-object")
    assert.equal("tts" in patch, false, "should not materialize tts sub-object")
    assert.equal("sttModel" in patch, false, "should not materialize sttModel")
    assert.equal("ttsModel" in patch, false, "should not materialize ttsModel")
    assert.equal("playbackMode" in patch, false, "should not materialize playbackMode")
  })

  it("builds a minimal patch for mode switch only", () => {
    const patch = buildSpeechPatch({ separateProviders: false })
    assert.deepEqual(patch, { separateProviders: false })
  })

  it("builds a mode switch with directional cleanup", () => {
    const patch = buildSpeechPatch({
      separateProviders: false,
      stt: { apiKey: null, baseUrl: null, model: null },
      tts: { apiKey: null, baseUrl: null, model: null },
    })
    assert.equal(patch.separateProviders, false)
    assert.deepEqual(patch.stt, { apiKey: null, baseUrl: null, model: null })
    assert.deepEqual(patch.tts, { apiKey: null, baseUrl: null, model: null })
  })
})
