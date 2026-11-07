import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { backendCompatibility } from "./backend-compatibility"
import { createBackendClient } from "./backend-client"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"

test("native policy requires the exact CodeNomad contract, including legacy fallback", () => {
  assert.equal(backendCompatibility({ apiContract: CODENOMAD_API_CONTRACT }), "native")
  for (const apiContract of [undefined, 0, -1, 0.5, CODENOMAD_API_CONTRACT + 1, NaN, "1", null]) {
    assert.equal(backendCompatibility({ apiContract } as never), "fallback", String(apiContract))
  }
  assert.equal(backendCompatibility({}), "fallback")
})

test("BackendClient.meta caches contract fields per HTTP backend and tolerates a legacy server", async () => {
  async function backend(id: string, meta: Record<string, unknown>) {
    let reads = 0, fail = false
    const server = createServer((request, response) => {
      assert.equal(request.url, "/api/meta")
      reads++
      response.writeHead(fail ? 503 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify(fail ? { error: "meta-unavailable" } : meta))
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as { port: number }
    return {
      client: createBackendClient({ id, baseUrl: `http://127.0.0.1:${address.port}` }),
      reads: () => reads, fail: () => { fail = true },
      close: () => {
        server.closeAllConnections()
        return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      },
    }
  }
  const meta = { serverId: "server-a", apiContract: CODENOMAD_API_CONTRACT, capabilities: ["events"] }
  const a = await backend("a", meta), b = await backend("b", { ...meta, serverId: "server-b", capabilities: [] })
  const old = await backend("old", { serverVersion: "legacy" })
  try {
    const [first, concurrent, second, legacy] = await Promise.all([
      a.client.meta.getServerMeta(), a.client.meta.getServerMeta(),
      b.client.meta.getServerMeta(), old.client.meta.getServerMeta(),
    ])
    assert.deepEqual(first, meta)
    assert.equal(first, concurrent)
    assert.equal(second.serverId, "server-b")
    assert.deepEqual(second.capabilities, [])
    assert.equal(backendCompatibility(legacy), "fallback")
    assert.equal(await a.client.meta.getServerMeta(), first)
    assert.equal(await old.client.meta.getServerMeta(), legacy)
    assert.deepEqual([a.reads(), b.reads(), old.reads()], [1, 1, 1])
    a.fail()
    await assert.rejects(a.client.meta.getServerMeta(true), /meta-unavailable/)
    assert.equal(await a.client.meta.getServerMeta(), first, "failed refresh preserves the last successful cache")
    assert.equal(await b.client.meta.getServerMeta(), second)
    assert.deepEqual([a.reads(), b.reads(), old.reads()], [2, 1, 1])
  } finally {
    for (const backend of [a, b, old]) backend.client.events.dispose()
    await Promise.all([a.close(), b.close(), old.close()])
  }
})
