import assert from "node:assert/strict"
import test from "node:test"
import { backendCompatibility } from "./backend-compatibility"
import { createBackendClient } from "./backend-client"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"

test("admission requires the exact CodeNomad contract and identity", () => {
  const serverId = "715941e7-8f5e-422a-b64d-25e56c672553"
  assert.equal(backendCompatibility({ apiContract: CODENOMAD_API_CONTRACT, serverId }), "compatible")
  for (const serverId of [undefined, "", " ", null, 123]) {
    assert.equal(backendCompatibility({ apiContract: CODENOMAD_API_CONTRACT, serverId } as never), "refused")
  }
  for (const apiContract of [undefined, 0, -1, 0.5, CODENOMAD_API_CONTRACT + 1, NaN, "1", null]) {
    assert.equal(backendCompatibility({ apiContract, serverId } as never), "refused", String(apiContract))
  }
  assert.equal(backendCompatibility({}), "refused")
})

test("BackendClient.meta shares a read, retains its last good contract on failure and accepts legacy metadata", async t => {
  const meta = { serverId: "server-a", apiContract: CODENOMAD_API_CONTRACT, capabilities: ["events"] }
  const legacy = { host: "legacy" }
  let reads = 0
  const client = createBackendClient({ id: "a", baseUrl: "https://a.invalid", fetcher: async (url) => {
    assert.equal(String(url), "https://a.invalid/api/meta")
    reads++
    if (reads === 2) return Response.json({ error: "meta-unavailable" }, { status: 503 })
    return Response.json(reads === 1 ? meta : legacy)
  } })
  t.after(() => client.events.dispose())
  const [first, concurrent] = await Promise.all([client.meta.getServerMeta(), client.meta.getServerMeta()])
  assert.deepEqual(first, meta)
  assert.equal(first, concurrent)
  assert.equal(reads, 1)
  await assert.rejects(client.meta.getServerMeta(true), /meta-unavailable/)
  assert.equal(await client.meta.getServerMeta(), first)
  assert.equal(reads, 2)
  assert.deepEqual(await client.meta.getServerMeta(true), legacy)
})
