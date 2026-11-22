import assert from "node:assert/strict"
import test from "node:test"
import type { SpeechCapabilitiesResponse } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { loadSpeechCapabilities, resetSpeechCapabilities, serverSupportsSeparateProviders, speechCapabilities } from "../stores/speech"

test("capability reads support both legacy and directional settings", async t => {
  const base: SpeechCapabilitiesResponse = {
    available: true, configured: true, provider: "openai-compatible",
    supportsStt: true, supportsTts: true, supportsStreamingTts: true,
    sttModel: "whisper-1", ttsModel: "tts-1", ttsVoice: "alloy",
    ttsFormats: ["mp3"], streamingTtsFormats: ["mp3"],
  }
  let reply: SpeechCapabilitiesResponse
  t.mock.method(serverApi, "fetchSpeechCapabilities", async () => reply)
  t.after(resetSpeechCapabilities)
  for (const configured of [true, false]) {
    reply = { ...base, configured }
    await loadSpeechCapabilities(true)
    assert.equal(speechCapabilities()?.sttConfigured, configured)
    assert.equal(speechCapabilities()?.ttsConfigured, configured)
    assert.equal(speechCapabilities()?.separateProviders, false)
    assert.equal(serverSupportsSeparateProviders(), false)
  }
  reply = { ...base, configured: false, sttConfigured: true, ttsConfigured: false, separateProviders: true }
  await loadSpeechCapabilities(true)
  assert.equal(speechCapabilities()?.sttConfigured, true)
  assert.equal(speechCapabilities()?.ttsConfigured, false)
  assert.equal(speechCapabilities()?.separateProviders, true)
  assert.equal(serverSupportsSeparateProviders(), true)
})
