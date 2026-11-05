import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { enforceSpeechCredentialPairing, registerSettingsRoutes } from "./settings"
import Fastify from "fastify"
import type { Logger } from "../../logger"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SettingsService } from "../../settings/service"
import { resolveConfigLocation } from "../../config/location"

it("host PATCH routes reject registry writes, ancestors and conditional/encoded variants atomically", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-settings-registry-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const location = resolveConfigLocation(path.join(directory, "config.yaml"))
  const events: unknown[] = []
  const logger = { child: () => logger, warn() {}, info() {} }
  const settings = new SettingsService(location, { publish: (value: unknown) => events.push(value) } as never, logger as never)
  settings.mergePatchDoc("config", { server: { logLevel: "INFO" }, ui: { theme: "light" } })
  const app = Fastify()
  t.after(() => app.close())
  registerSettingsRoutes(app, { settings, logger: logger as never })
  const profiles = [{ kind: "explicit", id: "remote", label: "Remote", origin: "https://example.test" }]
  const legacyFile = fs.readFileSync(location.configYamlPath, "utf8")
  const legacyEvents = events.length
  for (const [url, payload] of [["/api/storage/config", { server: { opencodeServers: profiles } }],
    ["/api/storage/config/server", { opencodeServers: profiles }]] as const) {
    assert.equal((await app.inject({ method: "PATCH", url, payload })).statusCode, 400)
    assert.equal(fs.readFileSync(location.configYamlPath, "utf8"), legacyFile)
    assert.equal(events.length, legacyEvents)
  }
  // Exercise both addition to an old document and modification/removal of existing metadata.
  for (const existing of [[], profiles]) {
    settings.getOpenCodeServerRegistry().replace(existing)
    const before = fs.readFileSync(location.configYamlPath, "utf8")
    const eventCount = events.length
    for (const patch of [{ opencodeServers: profiles }, { opencodeServers: [{ ...profiles[0], credentialRef: "rotation" }] },
      { opencodeServers: null }, { opencodeServers: {} }, { opencodeServers: [] },
      { opencodeServers: [], logLevel: "ERROR" }, null, [], "replace"]) {
      for (const [url, body] of [
        ["/api/storage/config", { server: patch, ui: { theme: "dark" } }],
        ["/api/storage/config/server", patch],
        ["/%61pi/storage/config", { server: patch }],
        ["/api/storage/config/%73erver", patch],
        ["/api/storage/config/server?conditional=missions-v1", patch],
        ["/api/storage/config/%73erver?conditional=other", patch],
        ["/api/storage/config/ui?conditional=missions-v1", { patch: { server: patch }, expected: [] }],
      ] as const) {
        const response = await app.inject({ method: "PATCH", url,
          headers: { "content-type": "application/json" }, payload: JSON.stringify(body) })
        assert.equal(response.statusCode, 400, `${url}: ${response.body}`)
        assert.equal(fs.readFileSync(location.configYamlPath, "utf8"), before)
        assert.equal(events.length, eventCount)
      }
    }
    for (const body of [null, [], "replace"]) {
      const response = await app.inject({ method: "PATCH", url: "/api/storage/config",
        headers: { "content-type": "application/json" }, payload: JSON.stringify(body) })
      assert.equal(response.statusCode, 400)
      assert.equal(fs.readFileSync(location.configYamlPath, "utf8"), before)
      assert.equal(events.length, eventCount)
    }
    for (const [url, body] of [["/api/storage/config", { server: { logLevel: "WARN" } }],
      ["/api/storage/config/server", { logLevel: "INFO" }]] as const) {
      const response = await app.inject({ method: "PATCH", url, payload: body })
      assert.equal(response.statusCode, 200, response.body)
      assert.doesNotMatch(response.body, /sentinel-reference|credentialRef/)
      assert.deepEqual(settings.getRawConfigOwner("server").opencodeServers, existing)
    }
  }
  assert.doesNotMatch(JSON.stringify(events), /sentinel-reference|credentialRef/)
})

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

it("both explicit executable settings paths refresh the login start after save; unrelated settings and reads stay passive", async t => {
  const app = Fastify(), order: string[] = []
  t.after(() => app.close())
  const settings = {
    getOwner: () => ({}), getDoc: () => ({}),
    mergePatchDoc: (_kind: string, patch: object) => { order.push("save"); return patch },
    mergePatchOwner: (_kind: string, _owner: string, patch: object) => { order.push("save"); return patch },
  } as unknown as SettingsService
  registerSettingsRoutes(app, { settings, logger: {} as Logger,
    refreshLoginStart: async () => { order.push("refresh") } })
  for (const [url, payload] of [["/api/storage/config", { server: { opencodeBinary: "C:\\with spaces\\opencode.exe" } }],
    ["/api/storage/config/server", { opencodeBinary: "C:\\with spaces\\opencode.exe" }]] as const) {
    order.length = 0
    assert.equal((await app.inject({ method: "PATCH", url, payload })).statusCode, 200)
    assert.deepEqual(order, ["save", "refresh"])
  }
  order.length = 0
  await app.inject({ method: "PATCH", url: "/api/storage/config/server", payload: { logLevel: "INFO" } })
  await app.inject({ method: "GET", url: "/api/storage/config" })
  assert.deepEqual(order, ["save"])
})
