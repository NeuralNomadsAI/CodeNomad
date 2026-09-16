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
