import assert from "node:assert/strict"
import { test } from "node:test"
import { Readable } from "node:stream"
import { setImmediate } from "node:timers/promises"
import Fastify from "fastify"
import { OpenCodeSharedService } from "../../workspaces/opencode-service"
import { forwardRuntimeRequest } from "./proxy"

test("retiring the actual connection preserves complete and streamed native 401 envelopes", async () => {
  for (const delayed of [false, true]) {
    const upstream = Fastify()
    const envelope = { _tag: "UnauthorizedError", message: "fixture" }
    upstream.get("/api/denied", async (_request, reply) => {
      reply.code(401)
      if (!delayed) return envelope
      return reply.type("application/json").send(Readable.from((async function* () {
        yield '{"_tag":"UnauthorizedError",'
        await setImmediate()
        yield '"message":"fixture"}'
      })()))
    })
    await upstream.listen({ host: "127.0.0.1", port: 0 })
    const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
    const service = new OpenCodeSharedService()
    await service.client({ kind: "lifecycle", identity: "fixture", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
    const connection = await service.acquire()
    const app = Fastify()
    let releases = 0
    app.get("/fixture", (request, reply) => forwardRuntimeRequest({
      request, reply, url: `${endpoint.url}/api/denied`, body: undefined, headers: {},
      fetch: connection.fetch, invalidate: connection.invalidate, release: () => { releases++ },
    }))
    try {
      const response = await app.inject("/fixture")
      assert.equal(response.statusCode, 401)
      assert.deepEqual(response.json(), envelope)
      assert.equal(releases, 1)
      assert.throws(connection.assertCurrent, /connection changed/)
    } finally { await service.shutdown(); await app.close(); await upstream.close() }
  }
})

test("a transform rewrites only successful JSON responses and releases each request once", async () => {
  const upstream = Fastify()
  upstream.get("/api/json", async () => ({ data: [{ uri: "inline" }] }))
  upstream.get("/api/missing", async (_request, reply) => reply.code(404).send({ data: [{ uri: "inline" }] }))
  upstream.get("/api/text", async (_request, reply) => reply.type("text/plain").send("plain"))
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const origin = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`
  const app = Fastify()
  let releases = 0, invalidations = 0
  app.get("/:path", (request, reply) => forwardRuntimeRequest({
    request, reply, url: `${origin}/api/${(request.params as { path: string }).path}`, body: undefined, headers: {}, fetch,
    invalidate: () => { invalidations++ }, release: () => { releases++ },
    transform: body => { for (const item of (body as { data: Array<{ uri: string }> }).data) item.uri = "deferred" },
  }))
  try {
    const json = await app.inject("/json")
    assert.equal(json.statusCode, 200)
    assert.match(String(json.headers["content-type"]), /^application\/json/)
    assert.deepEqual(json.json(), { data: [{ uri: "deferred" }] })
    assert.deepEqual((await app.inject("/missing")).json(), { data: [{ uri: "inline" }] }, "errors pass through")
    assert.equal((await app.inject("/text")).body, "plain")
    assert.equal(releases, 3)
    assert.equal(invalidations, 0)
  } finally { await app.close(); await upstream.close() }
})
