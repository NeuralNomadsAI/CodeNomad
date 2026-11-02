import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { registerRequestLogging } from "../http-server"
import { registerIntegrationRoutes } from "../routes/integrations"
import { registerIntegrationAttachmentRoutes } from "../routes/integration-attachments"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { registerPluginSourceRoutes } from "../routes/plugin-sources"

const secret = "private-sentinel-not-a-secret-key"
const root = "/api/workspaces/w/integrations"
const query = "?directory=%2Fwork"

function harness(level: "debug" | "trace") {
  const lines: string[] = []
  const logger = pino({ level, base: null, timestamp: false }, { write: line => { lines.push(line) } })
  // Production disables Fastify's raw URL/error logging; exercise its actual completion hook.
  const app = Fastify({ logger: false, disableRequestLogging: true, bodyLimit: 1024 })
  registerRequestLogging(app, logger)
  app.addHook("onRequest", async request => { request.log = logger })
  const state = { error: undefined as unknown }
  const read = async () => { if (state.error) throw state.error; return { integrations: [] } as never }
  registerIntegrationRoutes(app, { integrations: { read } })
  registerPluginSourceRoutes(app, { sources: { add: read, remove: read } })
  registerIntegrationAttachmentRoutes(app, { attachments: {
    hosts: async () => { await read(); return { offers: [] } },
    attach: async () => { await read(); return { outcome: "attached" } },
    detach: async () => { await read(); return { outcome: "none" } },
    installHost: async () => { await read(); return { outcome: "installed" } },
    bindingRead: async () => { await read(); return { state: "unknown" } },
  } })
  app.post("/ordinary/:id", request => ({ query: request.query, body: request.body }))
  const records = () => lines.map(line => JSON.parse(line))
  const check = (label = "request logs") => assert.equal(lines.join("").includes(secret), false, `${label} contain no sentinel`)
  return { app, state, records, check }
}

for (const level of ["debug", "trace"] as const) {
  test(`${level}: plugin source configuration and error diagnostics remain private`, async t => {
    const f = harness(level)
    t.after(() => f.app.close())
    const payload = { location: { directory: secret }, scope: "global", target: secret, entryIndex: 0, expectedRevision: "a".repeat(64) }
    for (const error of [undefined, new Error(secret), new PluginControlsError(secret, "unavailable"), new PluginControlsError(secret, "forbidden")]) {
      f.state.error = error
      const response = await f.app.inject({ method: "DELETE", url: `/api/workspaces/${secret}/plugin-sources?private=${secret}`, payload })
      assert.equal(response.body.includes(secret), false)
      f.check()
    }
    await f.app.inject({ method: "DELETE", url: `/api/workspaces/${secret}/plugin-sources`, payload: { ...payload, [secret]: secret } })
    await f.app.inject({ method: "DELETE", url: `/api/workspaces/w;${secret}/plugin-sources/unknown?directory=${secret}`, payload })
    f.check()
    const records = f.records().filter(record => record.msg.startsWith("HTTP request"))
    assert.ok(records.length >= 5)
    for (const record of records) {
      assert.match(record.url, /^\/api\/workspaces\/:id\/plugin-sources(?:\/\*)?$/)
      for (const key of ["params", "query", "body", "err"]) assert.equal(key in record, false)
    }
  })

  test(`${level}: actual request logs project integration paths, rejected query/body and native errors`, async t => {
    const f = harness(level)
    t.after(() => f.app.close())
    const requests = [
      { method: "GET", url: `${root}${query}&${secret}=${secret}` },
      { method: "GET", url: `/api/workspaces/${secret}/integrations${query}` },
      { method: "GET", url: `${root}/${secret}/hosts${query}` },
      { method: "GET", url: `${root}/fixture/hosts?directory=${secret}` },
      { method: "GET", url: `${root}/fixture/hosts${query}&directory=${secret}` },
      { method: "GET", url: `${root}/fixture/hosts?${secret}=${secret}` },
      { method: "GET", url: `${root}/fixture/binding${query}&sessionID=ses_${secret}` },
      { method: "GET", url: `${root}/${secret}/binding${query}&sessionID=ses_${secret}` },
      { method: "GET", url: `${root}/fixture/binding${query}&sessionID=ses_a&sessionID=ses_${secret}` },
      { method: "GET", url: `${root}/fixture/binding?directory=${secret}&sessionID=ses_a&${secret}=${secret}` },
      { method: "GET", url: `${root}/fixture/binding/${secret}${query}` },
      { method: "POST", url: `${root}/fixture/attach${query}`, payload: { offerID: "offer_fixture", sessionID: `ses_${secret}` } },
      { method: "POST", url: `${root}/fixture/attach${query}`, payload: { offerID: secret, sessionID: secret, [secret]: { nested: secret } } },
      { method: "POST", url: `${root}/fixture/detach${query}`, payload: { sessionID: `ses_${secret}` } },
      { method: "POST", url: `${root}/fixture/install-host${query}`, payload: { [secret]: { detail: secret } } },
      { method: "POST", url: `${root}/${secret}/install-host${query}`, payload: {} },
      { method: "POST", url: `${root}/fixture/install-host?directory=${secret}`, payload: {} },
      { method: "POST", url: `${root}/fixture/detach${query}`, payload: JSON.stringify({ nested: secret }) + "broken", headers: { "content-type": "application/json" } },
      { method: "POST", url: `${root}/fixture/attach${query}`, payload: secret, headers: { "content-type": "application/unknown" } },
      { method: "POST", url: `${root}/fixture/attach${query}`, payload: { text: secret.repeat(100) } },
      { method: "DELETE", url: `${root}/fixture/hosts${query}&value=${secret}` },
      { method: "GET", url: `${root}/fixture/${secret}${query}` },
      { method: "GET", url: `${root}/fixture/hosts/${secret}${query}` },
      { method: "GET", url: `/api/workspaces/${encodeURIComponent(secret + "/path")}/integrations/fixture/hosts${query}` },
      { method: "GET", url: `/api/workspaces/w/%69ntegrations/fixture/hosts${query}&value=${secret}` },
      { method: "GET", url: `${root}/fixture/hosts;${secret}?value=${secret}` },
      { method: "GET", url: `/api/workspaces/w;${secret}/integrations/fixture/unknown?directory=${secret}` },
    ] as const
    for (const [index, input] of requests.entries()) {
      const before = f.records().filter(record => record.msg === "HTTP request completed").length
      await f.app.inject(input as never)
      f.check(`request ${index} logs`)
      assert.equal(f.records().filter(record => record.msg === "HTTP request completed").length, before + 1, `request ${index} reached completion logging`)
    }
    // Fastify refuses malformed percent escapes before hooks; confidentiality here means no log records.
    const beforeMalformed = f.records().length
    assert.equal((await f.app.inject(`/api/workspaces/%${secret}/integrations/fixture/hosts${query}`)).statusCode, 400)
    assert.equal(f.records().length, beforeMalformed)
    for (const error of [Object.assign(new Error(secret), { cause: new Error(secret), input: secret }),
      new PluginControlsError(secret, "unavailable"), new PluginControlsError(secret, "forbidden")]) {
      f.state.error = error
      for (const action of ["", "/fixture/hosts", "/fixture/binding", "/fixture/attach", "/fixture/detach", "/fixture/install-host"]) {
        const mutation = action.endsWith("attach") || action.endsWith("detach") || action.endsWith("install-host")
        await f.app.inject({ method: mutation ? "POST" : "GET", url: `${root}${action}${query}${action.endsWith("binding") ? "&sessionID=ses_fixture" : ""}`,
          ...(mutation ? { payload: action.endsWith("install-host") ? {} : action.endsWith("detach") ? { sessionID: "ses_fixture" } : { sessionID: "ses_fixture", offerID: "offer_fixture" } } : {}) })
        f.check()
      }
    }
    const completed = f.records().filter(record => record.msg === "HTTP request completed")
    assert.equal(completed.length, requests.length + 18, "each hook-admitted request and failure completed logging")
    for (const record of completed) {
      assert.match(record.url, /^\/api\/workspaces\/:id\/integrations(?:\/:integrationId\/(?:hosts|binding|attach|detach|install-host)|\/\*)?$/)
      assert.equal(typeof record.status, "number")
    }
    assert(completed.some(record => record.url.endsWith("/:integrationId/binding")), "binding uses its exact fixed template")
    const payloads = f.records().filter(record => record.msg === "HTTP request payload")
    assert.equal(payloads.length, level === "trace" ? completed.length : 0, "trace logging actually ran")
    for (const record of payloads) for (const key of ["params", "query", "body", "err"]) assert.equal(key in record, false)
  })

  test(`${level}: logger reentry keeps safe ordinary diagnostics across concurrent refusals and recovery`, async t => {
    const f = harness(level)
    t.after(() => f.app.close())
    await Promise.all(Array.from({ length: 10 }, (_, index) => f.app.inject(index % 2
      ? { method: "GET", url: `${root}/fixture/hosts${query}&unsafe=${secret}` }
      : { method: "POST", url: "/ordinary/safe?view=normal", payload: { value: "visible", token: "hidden" } })))
    f.state.error = new Error(secret)
    await f.app.inject(`${root}/fixture/hosts${query}`)
    f.state.error = undefined
    assert.equal((await f.app.inject(`${root}/fixture/hosts${query}`)).statusCode, 200)
    await f.app.inject({ method: "POST", url: "/ordinary/last?view=normal", payload: { value: "visible" } })
    f.check()
    const ordinary = f.records().filter(record => record.url?.startsWith("/ordinary/"))
    assert.equal(ordinary.filter(record => record.level === 20).length, 6)
    if (level === "trace") {
      const payloads = ordinary.filter(record => record.level === 10)
      assert.equal(payloads.length, 6)
      assert.deepEqual(payloads[0].params, { id: "safe" })
      assert.equal(payloads[0].query, "<redacted>", "Fastify query objects retain the existing conservative prototype redaction")
      assert.deepEqual(payloads[0].body, { value: "visible", token: "<redacted>" })
      assert.deepEqual(payloads.at(-1).body, { value: "visible" })
    }
  })
}
