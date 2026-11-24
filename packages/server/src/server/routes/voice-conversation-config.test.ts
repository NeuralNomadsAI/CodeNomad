import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import Fastify from "fastify"
import { stringify } from "yaml"
import type { WorkspaceEventPayload } from "../../api-types"
import { resolveConfigLocation } from "../../config/location"
import { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { SettingsService } from "../../settings/service"
import { SpeechService } from "../../speech/service"
import { registerSettingsRoutes } from "./settings"
import { registerSpeechRoutes } from "./speech"

const geminiLive = { apiKey: "fixture-secret-gemini", model: "models/gemini-fixture", voice: "Kore" }
const openaiRealtime = { apiKey: "fixture-secret-openai", model: "realtime-fixture", voice: "marin" }
const secret = /fixture-secret|"apiKey"/

function fixture(t: TestContext, config?: string, state?: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "codenomad-voice-config-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = resolveConfigLocation(path.join(directory, "config.yaml"))
  const file = location.configYamlPath
  if (config !== undefined) writeFileSync(file, config)
  if (state !== undefined) writeFileSync(location.stateYamlPath, state)
  const warnings: unknown[] = []
  const log = { child: () => log, info() {}, warn: (data: unknown) => warnings.push(data) }
  const logger = log as unknown as Logger
  const bus = new EventBus()
  const events: WorkspaceEventPayload[] = []
  t.after(bus.onEvent(event => events.push(event)))
  const settings = new SettingsService(location, bus, logger)
  const service = new SpeechService(settings, logger)
  const app = Fastify()
  t.after(() => app.close())
  registerSettingsRoutes(app, { settings, logger })
  registerSpeechRoutes(app, { speechService: service })
  const capabilities = async () => {
    const response = await app.inject("/api/speech/capabilities")
    assert.equal(response.statusCode, 200)
    assert.doesNotMatch(response.body, secret)
    return response.json()
  }
  return { app, service, file, events, capabilities, warnings, settings }
}

test("voice provider patches persist independently and redact both config forms and SSE payloads", async t => {
  const { app, service, file, events, capabilities } = fixture(t)
  const full = "/api/storage/config"
  const owner = `${full}/server`
  const publicConfig = {
    geminiLive: { hasApiKey: true, model: geminiLive.model, voice: geminiLive.voice },
    openaiRealtime: { hasApiKey: false, model: openaiRealtime.model },
  }
  const first = await app.inject({ method: "PATCH", url: full, payload: { server: {
    voiceConversation: { geminiLive: { ...geminiLive, apiKey: ` ${geminiLive.apiKey} ` }, openaiRealtime: { model: openaiRealtime.model } },
  } } })
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json().server.voiceConversation, publicConfig)
  assert.doesNotMatch(first.body, secret)
  assert.deepEqual(service.getVoiceConversationProvider("gemini-live"), { provider: "geminiLive", ...geminiLive })
  assert.equal(service.getVoiceConversationProvider("openai-realtime"), undefined)
  assert.equal(service.getVoiceConversationProvider("classic"), undefined)
  assert.deepEqual((await capabilities()).voiceConversation, {
    geminiLive: { configured: true }, openaiRealtime: { configured: false },
  })

  const changed = await app.inject({ method: "PATCH", url: owner, payload: { voiceConversation: {
    openaiRealtime: { apiKey: openaiRealtime.apiKey, voice: openaiRealtime.voice }, geminiLive: { model: "models/gemini-next" },
  } } })
  assert.equal(changed.statusCode, 200)
  assert.doesNotMatch(changed.body, secret)
  assert.deepEqual(service.getVoiceConversationProvider("openai-realtime"), { provider: "openaiRealtime", ...openaiRealtime })
  assert.deepEqual(service.getVoiceConversationProvider("gemini-live"),
    { provider: "geminiLive", ...geminiLive, model: "models/gemini-next" })
  assert.deepEqual(changed.json().voiceConversation, {
    geminiLive: { hasApiKey: true, model: "models/gemini-next", voice: geminiLive.voice },
    openaiRealtime: { hasApiKey: true, model: openaiRealtime.model, voice: openaiRealtime.voice },
  })
  for (const [url, unwrap] of [[full, true], [owner, false]] as const) {
    const read = await app.inject(url)
    assert.equal(read.statusCode, 200)
    assert.doesNotMatch(read.body, secret)
    const value = read.json()
    assert.deepEqual((unwrap ? value.server : value).voiceConversation, changed.json().voiceConversation)
  }
  assert.deepEqual(events, [
    { type: "storage.configChanged", owner: "*", value: {} },
    { type: "storage.configChanged", owner: "server", value: changed.json() },
  ])
  assert.doesNotMatch(JSON.stringify(events), secret)
  assert.match(readFileSync(file, "utf8"), /fixture-secret-gemini/)
  assert.match(readFileSync(file, "utf8"), /fixture-secret-openai/)

  const cleared = await app.inject({ method: "PATCH", url: owner, payload: { voiceConversation: {
    geminiLive: { voice: null }, openaiRealtime: { apiKey: null },
  } } })
  assert.equal(cleared.statusCode, 200)
  assert.doesNotMatch(cleared.body, secret)
  assert.deepEqual(cleared.json().voiceConversation, {
    geminiLive: { hasApiKey: true, model: "models/gemini-next" },
    openaiRealtime: { hasApiKey: false, model: openaiRealtime.model, voice: openaiRealtime.voice },
  })
  assert.deepEqual(service.getVoiceConversationProvider("gemini-live"),
    { provider: "geminiLive", apiKey: geminiLive.apiKey, model: "models/gemini-next" })
  assert.equal(service.getVoiceConversationProvider("openai-realtime"), undefined)
})

test("invalid config patches fail atomically without disclosing input", async t => {
  const original = stringify({ server: { voiceConversation: { geminiLive, openaiRealtime } } })
  const { app, file, events } = fixture(t, original)
  for (const [url, wrap] of [
    ["/api/storage/config", (voiceConversation: unknown) => ({ server: { voiceConversation } })],
    ["/api/storage/config/%73erver", (voiceConversation: unknown) => ({ voiceConversation })],
  ] as const) {
    for (const invalid of [
      [geminiLive],
      { geminiLive: { apiKey: [geminiLive.apiKey] } },
      { geminiLive: { ...geminiLive, model: "    " } },
      { geminiLive: { ...geminiLive, voice: { secret: geminiLive.apiKey } } },
      { openaiRealtime: { ...openaiRealtime, voice: "two words" } },
      { openaiRealtime: { ...openaiRealtime, baseUrl: "https://example.test" } },
      { openaiRealtime: { ...openaiRealtime, hasApiKey: true } },
      { geminiLive, engine: "gemini-live" },
    ]) {
      const response = await app.inject({ method: "PATCH", url, payload: wrap(invalid) })
      assert.equal(response.statusCode, 400)
      assert.doesNotMatch(response.body, secret)
    }
    const malformed = await app.inject({ method: "PATCH", url, headers: { "content-type": "application/json" },
      payload: JSON.stringify(wrap({ geminiLive })).replace(`"${geminiLive.apiKey}"`, geminiLive.apiKey) })
    assert.equal(malformed.statusCode, 400)
    assert.doesNotMatch(malformed.body, secret)
  }
  assert.equal(readFileSync(file, "utf8"), original)
  assert.deepEqual(events, [])
})

test("malformed and removed on-disk settings fail closed without falling back to legacy credentials", async t => {
  const originalEnv = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "fixture-environment"
  t.after(() => {
    if (originalEnv === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalEnv
  })
  const { app, service, file, capabilities, warnings } = fixture(t, stringify({
    server: {
      speech: { separateProviders: true, stt: { model: "fixture-stt" }, tts: { model: "fixture-tts" } },
      voiceConversation: {
        geminiLive,
        openaiRealtime: { ...openaiRealtime, apiKey: [openaiRealtime.apiKey], model: geminiLive.apiKey },
      },
    },
  }))
  const read = await app.inject("/api/storage/config/server")
  assert.equal(read.statusCode, 200)
  assert.deepEqual(read.json().voiceConversation, {
    geminiLive: { hasApiKey: true, model: geminiLive.model, voice: geminiLive.voice },
    openaiRealtime: { hasApiKey: false },
  })
  assert.doesNotMatch(read.body, secret)
  const { sttConfigured, ttsConfigured, sttModel, ttsModel, voiceConversation } = await capabilities()
  assert.deepEqual({ sttConfigured, ttsConfigured, sttModel, ttsModel },
    { sttConfigured: true, ttsConfigured: true, sttModel: "fixture-stt", ttsModel: "fixture-tts" })
  assert.deepEqual(voiceConversation, { geminiLive: { configured: true }, openaiRealtime: { configured: false } })

  writeFileSync(file, stringify({ server: { voiceConversation: {
    geminiLive: { ...geminiLive, voice: { secret: geminiLive.apiKey } },
    openaiRealtime: { model: openaiRealtime.model, voice: openaiRealtime.voice },
  } } }))
  assert.equal(service.getVoiceConversationProvider("gemini-live"), undefined)
  assert.equal(service.getVoiceConversationProvider("openai-realtime"), undefined)
  writeFileSync(file, `server:\n  voiceConversation: [${geminiLive.apiKey}\n`)
  assert.equal(service.getVoiceConversationProvider("gemini-live"), undefined)
  assert.equal(service.getVoiceConversationProvider("openai-realtime"), undefined)
  assert.doesNotMatch(JSON.stringify(warnings), secret)
})

test("YAML parser failures at startup leave provider keys out of public errors and diagnostics", async t => {
  const { app, warnings, capabilities } = fixture(t, `server:\n  voiceConversation: [${geminiLive.apiKey}\n`)
  const response = await app.inject("/api/storage/config")
  assert.equal(response.statusCode, 200)
  assert.doesNotMatch(response.body, secret)
  assert.deepEqual((await capabilities()).voiceConversation, {
    geminiLive: { configured: false }, openaiRealtime: { configured: false },
  })
  assert.ok(warnings.length > 0)
  assert.doesNotMatch(JSON.stringify(warnings), secret)
})

test("voice provider secrets stay in their server owner through legacy state migration", async t => {
  const original = stringify({ server: { voiceConversation: { geminiLive } } })
  const { app, service, file } = fixture(t, original, "recentFolders: []\n")
  assert.deepEqual(service.getVoiceConversationProvider("gemini-live"), { provider: "geminiLive", ...geminiLive })
  assert.equal(readFileSync(file, "utf8"), original)
  assert.doesNotMatch((await app.inject("/api/storage/config")).body, secret)
})

test("migrating a mixed legacy config does not publish provider secrets in the legacy bucket", async t => {
  const { app, service } = fixture(t, stringify({
    preferences: { logLevel: "INFO" },
    server: { voiceConversation: { geminiLive }, unknown: "preserved" },
  }))
  const response = await app.inject("/api/storage/config")
  assert.equal(response.statusCode, 200)
  assert.doesNotMatch(response.body, secret)
  assert.deepEqual(response.json().legacy.unknown.server, { unknown: "preserved" })
  assert.deepEqual(service.getVoiceConversationProvider("gemini-live"), { provider: "geminiLive", ...geminiLive })
})

test("legacy JSON migrations keep provider secrets out of the state document", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "codenomad-voice-legacy-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = resolveConfigLocation(path.join(directory, "config.yaml"))
  writeFileSync(location.legacyJsonPath, JSON.stringify({
    recentFolders: [], server: { voiceConversation: { geminiLive } },
  }))
  const log = { child: () => log, info() {}, warn() {} } as unknown as Logger
  const settings = new SettingsService(location, undefined, log)
  assert.deepEqual(settings.getRawConfigOwner("server").voiceConversation, { geminiLive })
  assert.doesNotMatch(JSON.stringify(settings.getDoc("state")), secret)
})

test("classic speech provider errors keep upstream credential echoes out of responses", async t => {
  const secret = "fixture-secret-classic"
  const mock = Fastify()
  t.after(() => mock.close())
  for (const path of ["/audio/transcriptions", "/audio/speech"]) {
    mock.post(path, async (request, reply) => {
      assert.equal(request.headers.authorization, `Bearer ${secret}`)
      return reply.code(400).send({ error: { message: secret } })
    })
  }
  mock.addContentTypeParser(/^multipart\/form-data/, { parseAs: "buffer" }, (_request, _body, done) => done(null, {}))
  const baseUrl = await mock.listen({ port: 0, host: "127.0.0.1" })
  const { app } = fixture(t, stringify({ server: { speech: { apiKey: secret, baseUrl } } }))
  for (const [url, payload] of [
    ["/api/speech/transcribe", { audioBase64: "AAA=", mimeType: "audio/wav" }],
    ["/api/speech/synthesize/stream", { text: "fixture" }],
  ] as const) {
    const response = await app.inject({ method: "POST", url, payload })
    assert.equal(response.statusCode, 502)
    assert.doesNotMatch(response.body, /fixture-secret-classic/)
  }
})

test("malformed classic settings keep schema diagnostics private", async t => {
  const { app } = fixture(t, stringify({ server: { speech: { ttsFormat: geminiLive.apiKey } } }))
  const response = await app.inject("/api/speech/capabilities")
  assert.equal(response.statusCode, 503)
  assert.doesNotMatch(response.body, secret)
})

test("desktop engine choice defaults to Classic and persists separately for each host profile", async t => {
  const { app, file, settings, capabilities } = fixture(t)
  const original = { identity: process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY, channel: process.env.CODENOMAD_UPDATE_CHANNEL }
  function restore(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    restore("CODENOMAD_PROFILE_CONFIG_IDENTITY", original.identity)
    restore("CODENOMAD_UPDATE_CHANNEL", original.channel)
  })
  delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
  const { configIdentity } = settings.getProfileScope()
  const url = "/api/speech/conversation/engine"
  assert.equal((await app.inject(url)).statusCode, 404)
  process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = configIdentity
  process.env.CODENOMAD_UPDATE_CHANNEL = "voice-one"
  assert.equal((await capabilities()).desktopVoiceConversationEngine, true)
  assert.deepEqual((await app.inject(url)).json(), { engine: "classic" })
  const patch = (engine: string, remoteAddress = "127.0.0.1") => app.inject({ method: "PATCH", url, remoteAddress, payload: { engine } })
  assert.equal((await patch("gemini-live", "192.0.2.80")).statusCode, 404)
  assert.equal((await patch("fixture-secret")).statusCode, 400)
  assert.deepEqual((await patch("gemini-live")).json(), { engine: "gemini-live" })
  process.env.CODENOMAD_UPDATE_CHANNEL = "voice-two"
  assert.deepEqual((await app.inject(url)).json(), { engine: "classic" })
  assert.deepEqual((await patch("openai-realtime")).json(), { engine: "openai-realtime" })
  process.env.CODENOMAD_UPDATE_CHANNEL = "voice-one"
  assert.deepEqual((await app.inject(url)).json(), { engine: "gemini-live" })
  assert.throws(() => readFileSync(file), { code: "ENOENT" })
})

test("desktop live notice acceptance is versioned and isolated by profile and provider", async t => {
  const { app, settings, capabilities } = fixture(t)
  const identity = process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
  const channel = process.env.CODENOMAD_UPDATE_CHANNEL
  t.after(() => {
    if (identity === undefined) delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
    else process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = identity
    if (channel === undefined) delete process.env.CODENOMAD_UPDATE_CHANNEL
    else process.env.CODENOMAD_UPDATE_CHANNEL = channel
  })
  process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = settings.getProfileScope().configIdentity
  process.env.CODENOMAD_UPDATE_CHANNEL = "voice-one"
  const accept = (version: number, remoteAddress = "127.0.0.1") => app.inject({
    method: "PUT", url: "/api/speech/conversation/consent", remoteAddress, payload: { engine: "gemini-live", version },
  })
  assert.equal((await accept(1)).statusCode, 400)
  assert.equal((await accept(2, "192.0.2.80")).statusCode, 404)
  settings.desktopLiveVoiceConsentStore("gemini-live")!.replace({ notice: { version: 1 } })
  assert.deepEqual((await capabilities()).desktopLiveVoiceConsent, {})
  assert.equal((await accept(2)).statusCode, 204)
  assert.deepEqual((await capabilities()).desktopLiveVoiceConsent, { "gemini-live": 2 })
  process.env.CODENOMAD_UPDATE_CHANNEL = "voice-two"
  assert.deepEqual((await capabilities()).desktopLiveVoiceConsent, {})
  process.env.CODENOMAD_UPDATE_CHANNEL = "voice-one"
  assert.deepEqual((await capabilities()).desktopLiveVoiceConsent, { "gemini-live": 2 })
})
