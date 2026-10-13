import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import Fastify from "fastify"
import { INGRESS_TIMEOUTS, RemoteIngress } from "./ingress"

test("the remote ingress keeps the local listener's timeouts", async () => {
  const app = Fastify()
  for (const [name, value] of Object.entries(INGRESS_TIMEOUTS)) {
    assert.equal(app.server[name as keyof typeof INGRESS_TIMEOUTS], value, name)
  }
  await app.close()
})

test("the remote ingress applies those timeouts to its listener", async (t) => {
  let observed: Partial<Record<keyof typeof INGRESS_TIMEOUTS, number>> = {}
  const ingress = new RemoteIngress((request, response) => {
    const server = (request.socket as unknown as { server: http.Server }).server
    observed = { requestTimeout: server.requestTimeout, headersTimeout: server.headersTimeout, keepAliveTimeout: server.keepAliveTimeout }
    response.end()
  })
  t.after(() => ingress.stop())
  const [hostname, port] = (await ingress.start()).split(":")
  await new Promise<void>((resolve, reject) => {
    http.get({ hostname, port: Number(port), path: "/" }, (response) => {
      response.resume()
      response.on("end", resolve)
    }).on("error", reject)
  })
  assert.deepEqual(observed, INGRESS_TIMEOUTS)
})
