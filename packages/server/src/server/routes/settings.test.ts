import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { enforceSpeechCredentialPairing, registerSettingsRoutes } from "./settings"
import Fastify from "fastify"
import type { SettingsService } from "../../settings/service"
import type { Logger } from "../../logger"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parse, stringify } from "yaml"
import { resolveConfigLocation } from "../../config/location"
import { SettingsService as RealSettingsService } from "../../settings/service"

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

for (const url of ["/api/storage/config", "/api/storage/config/server"]) {
  it(`${url} pairs shared, STT and TTS credentials against fresh configuration inside the write lock`, async t => {
    const root = mkdtempSync(path.join(tmpdir(), "codenomad-speech-pairing-"))
    const logger = { child() { return this }, warn() {}, info() {} } as unknown as Logger
    const location = resolveConfigLocation(root), app = Fastify()
    t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
    const speech = (host: string, withKeys = true) => {
      const pair = () => ({ baseUrl: `https://${host}.example/v1`, ...(withKeys ? { apiKey: `sentinel-${host}` } : {}) })
      return { ...pair(), stt: pair(), tts: pair() }
    }
    writeFileSync(location.configYamlPath, stringify({ server: { speech: speech("a") } }))
    const settings = new RealSettingsService(location, undefined, logger)
    settings.getOwner("config", "server") // Warm the display cache before an external writer.
    let entered!: () => void, release!: () => void, arrivals = 0
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let tail = Promise.resolve()
    registerSettingsRoutes(app, { settings, logger, withConfigLock: <T>(action: () => T) => {
      if (++arrivals === 2) entered()
      const result = tail.then(async () => { await gate; return action() })
      tail = result.then(() => {}, () => {})
      return result
    } })
    const payload = (value: object) => url.endsWith("/server") ? value : { server: value }
    const first = app.inject({ method: "PATCH", url, payload: payload({ speech: speech("b") }) }).then(result => result)
    const second = app.inject({ method: "PATCH", url, payload: payload({ speech: speech("a", false) }) }).then(result => result)
    try {
      await waiting
      // Both requests have reached the lock, neither may have published yet.
      assert.deepEqual(parse(readFileSync(location.configYamlPath, "utf8")), { server: { speech: speech("a") } })
      writeFileSync(location.configYamlPath, stringify({ server: { speech: speech("external"), keep: true }, external: { keep: true } }))
      release()
      assert.deepEqual((await Promise.all([first, second])).map(result => result.statusCode), [200, 200])
      const saved = parse(readFileSync(location.configYamlPath, "utf8"))
      assert.deepEqual(saved, { server: { speech: speech("a", false), keep: true }, external: { keep: true } })
      for (const pair of [saved.server.speech, saved.server.speech.stt, saved.server.speech.tts]) assert.equal(pair.apiKey, undefined)
    } finally { release() }
  })
}

it("only host-local requests change the SideCar direct HTTPS opt-in, through either config route", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-host-only-setting-"))
  const logger = { child() { return this }, warn() {}, info() {} } as unknown as Logger
  const location = resolveConfigLocation(root), app = Fastify()
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
  writeFileSync(location.configYamlPath, stringify({ server: { logLevel: "INFO" } }))
  const settings = new RealSettingsService(location, undefined, logger)
  registerSettingsRoutes(app, { settings, logger })
  const stored = () => parse(readFileSync(location.configYamlPath, "utf8")).server?.sidecarsOverDirectHttps
  const patch = (remoteAddress: string, url: string, payload: unknown) => app.inject({ method: "PATCH", url, remoteAddress, payload: payload as object })
  const lan = "192.0.2.20"
  const enable = [["/api/storage/config/server", { sidecarsOverDirectHttps: true }], ["/api/storage/config", { server: { sidecarsOverDirectHttps: true } }]] as const
  for (const [url, payload] of enable) {
    const refused = await patch(lan, url, payload)
    assert.equal(refused.statusCode, 403, `${url}: ${refused.body}`)
    assert.equal(stored(), undefined)
  }
  // Other server settings stay writable remotely, and writing the current value is no change.
  assert.equal((await patch(lan, "/api/storage/config/server", { logLevel: "WARN", sidecarsOverDirectHttps: false })).statusCode, 200)
  assert.equal((await patch("127.0.0.1", ...enable[0])).statusCode, 200)
  assert.equal(stored(), true)
  for (const [url, payload] of [["/api/storage/config/server", { sidecarsOverDirectHttps: false }], ["/api/storage/config/server", { sidecarsOverDirectHttps: null }],
    ["/api/storage/config", { server: null }], ["/api/storage/config", { server: { sidecarsOverDirectHttps: "yes" } }]] as const) {
    assert.equal((await patch(lan, url, payload)).statusCode, 403, `${url} ${JSON.stringify(payload)}`)
    assert.equal(stored(), true)
  }
  assert.equal((await patch(lan, "/api/storage/config", { server: { logLevel: "ERROR" } })).statusCode, 200)
  assert.deepEqual(parse(readFileSync(location.configYamlPath, "utf8")).server, { logLevel: "ERROR", sidecarsOverDirectHttps: true })
  assert.equal((await patch("127.0.0.1", "/api/storage/config", { server: { sidecarsOverDirectHttps: false } })).statusCode, 200)
  assert.equal(stored(), false)
})

it("both explicit executable settings paths refresh the login start after save; unrelated settings and reads stay passive", async t => {
  const app = Fastify(), order: string[] = []
  t.after(() => app.close())
  const settings = {
    getOwner: () => ({}), getDoc: () => ({}), getRawConfigOwner: () => ({}),
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
