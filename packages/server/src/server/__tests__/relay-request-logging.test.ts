import assert from "node:assert/strict"
import test from "node:test"
import pino from "pino"
import { startRemoteSurface } from "../../remote-control/test-support/surface"

const bytes = Buffer.concat([Buffer.from("synthetic-logging-carrier-"), Buffer.from([251, 255])])
const carriers = [...new Set([
  bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""),
  bytes.toString("base64url"), bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_"),
].flatMap(value => [value, encodeURIComponent(value), encodeURIComponent(encodeURIComponent(value))]))]

function assertPrivate(logs: string, label: string) {
  assert.equal(carriers.some(value => logs.includes(value)), false, `${label}: carrier remains private`)
}

function assertMetadata(record: Record<string, unknown>) {
  const allowed = new Set(["level", "time", "pid", "hostname", "component", "msg", "method", "url", "status", "durationMs"])
  assert.equal(Object.keys(record).some(key => !allowed.has(key)), false, "request record contains only static completion metadata")
  assert.equal(typeof record.method, "string")
  assert.equal(typeof record.url, "string")
  assert.equal(typeof record.status, "number")
  assert.equal(typeof record.durationMs, "number")
}

test("real application/pino strips every query carrier, including ordinary and rejected URLs", async t => {
  let logs = ""
  const logger = pino({ level: "trace" }, { write: (line: string) => { logs += line } })
  const f = await startRemoteSurface(t, { logger, skipAuth: true,
    routes: app => app.post("/api/test/payload", () => ({ ok: true })),
  })
  for (const [index, value] of carriers.entries()) {
    for (const path of ["/api/test/echo", "/api/unknown", "/api/backends", "/api/remote-servers", "/api/%", "//api/backends"]) {
      await f.app.inject(`${path}?__codenomad_authority=${value}&opaque=${value}&${value}=value`)
      assertPrivate(logs, `query case ${index}`)
    }
    await f.app.inject({ method: "POST", url: "/api/test/payload", payload: {
      __codenomad_authority: value, proof: value, nested: { authority: value }, diagnostic: "visible",
    } })
    assertPrivate(logs, `payload case ${index}`)
  }
  const records = logs.trim().split("\n").map(line => JSON.parse(line))
  const ordinary = records.filter(record => record.msg === "HTTP request completed" && record.url === "/api/test/echo")
  assert.equal(ordinary.length, carriers.length, "ordinary diagnostic paths remain recognizable")
  const payload = records.find(record => record.msg === "HTTP request payload" && record.url === "/api/test/payload")
  assert.ok(payload, "ordinary trace completion was emitted")
  for (const record of records.filter(record => record.msg?.startsWith("HTTP request"))) assertMetadata(record)
})

test("real application/pino fixes sensitive paths independently of admission and encoding", async t => {
  let logs = ""
  const logger = pino({ level: "trace" }, { write: (line: string) => { logs += line } })
  const f = await startRemoteSurface(t, { logger, skipAuth: true })
  for (const [index, value] of carriers.entries()) {
    for (const prefix of [
      "/api/backends", "/api/backends;ignored", "/api/%2562ackends",
      "/%2561pi/%252562ackends", "/api/remote-servers", "/api/remote-servers;ignored",
      "/api/%2572emote-servers", "/api%252fbackends", "/api/backends%253bignored",
      "/api/%2525252562ackends", `/api/backends;${value}`,
      "/api/remote-control/server-pair", "/api/remote-control/server-pair;ignored",
    ]) {
      await f.app.inject(`${prefix}/${value}/connect?opaque=${value}`)
      assertPrivate(logs, `path case ${index}`)
    }
    await f.app.inject(`/api/backends/%/${value}`)
    assertPrivate(logs, `malformed path case ${index}`)
  }
  const records = logs.trim().split("\n").map(line => JSON.parse(line))
    .filter(record => record.msg?.startsWith("HTTP request"))
  assert.ok(records.length > 0, "completion logging ran")
  for (const record of records) {
    assert.ok(["/api/backends/:id/*", "/api/remote-servers/:id/connect", "/api/remote-control/server-pair", "<unmatched>", "<catchall>"].includes(record.url),
      "sensitive namespace retains only a fixed diagnostic path")
    assertMetadata(record)
  }
})

test("real application/pino logs templates for every namespace and omits wildcard captures", async t => {
  let logs = ""
  const logger = pino({ level: "trace" }, { write: (line: string) => { logs += line } })
  const f = await startRemoteSurface(t, { logger, skipAuth: true, routes: app => {
    app.get("/api/test/files/*", () => ({ ok: true }))
    app.get("/api/test/named/:id/:token/:proof", () => ({ ok: true }))
  } })
  for (const [index, value] of carriers.entries()) {
    for (const target of [
      `/api/unregistered/${value}`,
      `/api/test/files/${value}`,
      `/api/test/named/${encodeURIComponent(value)}/${encodeURIComponent(value)}/${encodeURIComponent(value)}`,
    ]) {
      await f.app.inject(target)
      assertPrivate(logs, `universal path case ${index}`)
    }
  }
  const records = logs.trim().split("\n").map(line => JSON.parse(line))
    .filter(record => record.msg === "HTTP request payload")
  const named = records.filter(record => record.url === "/api/test/named/:id/:token/:proof")
  assert.equal(named.length, carriers.length, "named routes retain their template")
  for (const record of named) assertMetadata(record)
  const wildcard = records.filter(record => record.url === "/api/test/files/*")
  assert.equal(wildcard.length, carriers.length, "registered wildcard families retain their template")
  for (const record of wildcard) assertMetadata(record)
  const hidden = records.filter(record => ["<unmatched>", "<catchall>"].includes(record.url))
  assert.equal(hidden.length, carriers.length, "global fallback paths use fixed tags")
  for (const record of hidden) assertMetadata(record)
})
