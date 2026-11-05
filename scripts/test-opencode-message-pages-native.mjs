// Owned runtime only: replay synthetic messages, never call a model or discover a service.
import assert from "node:assert/strict"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { tsImport } from "tsx/esm/api"

await withProductRuntime(process.argv[2], async () => ({}), async ({ client, root, requests }) => {
  const { decodeMessageListCursor } = await tsImport("../packages/server/src/opencode/compatibility/proxy-locations.ts", import.meta.url)
  const location = { directory: root }
  const seed = await client.session.create({ location, title: "Native message pages" })
  const exported = await client.session.export({ sessionID: seed.id })
  await client.session.remove({ sessionID: seed.id })
  const messages = Array.from({ length: 451 }, (_, index) => ({ id: `msg_pages_${String(index).padStart(5, "0")}`,
    type: "user", text: `Synthetic passage ${index}`, time: { created: index + 1 } }))
  const session = await client.session.import({ ...exported, messages, location })
  try {
    const ids = page => page.data.map(row => row.id)
    for (const order of ["asc", "desc"]) {
      const expected = order === "asc" ? messages : [...messages].reverse()
      const first = await client.message.list({ sessionID: session.id, limit: 200, order })
      assert.deepEqual(ids(first), expected.slice(0, 200).map(row => row.id))
      assert.ok(first.cursor.next)
      assert.deepEqual(decodeMessageListCursor(first.cursor.next), { id: first.data.at(-1).id, order, direction: "next" })
      const second = await client.message.list({ sessionID: session.id, limit: 200, cursor: first.cursor.next })
      assert.deepEqual(ids(second), expected.slice(200, 400).map(row => row.id))
      assert.ok(second.cursor.previous)
      assert.deepEqual(decodeMessageListCursor(second.cursor.previous), { id: second.data[0].id, order, direction: "previous" })
      const back = await client.message.list({ sessionID: session.id, limit: 200, cursor: second.cursor.previous })
      assert.deepEqual(ids(back), ids(first), "previous retains the originating order")
      const last = await client.message.list({ sessionID: session.id, limit: 200, cursor: second.cursor.next })
      assert.deepEqual(ids(last), expected.slice(400).map(row => row.id))
      // Boundary tokens are permitted even when their probe returns no rows.
      if (last.cursor.next) {
        const boundary = await client.message.list({ sessionID: session.id, limit: 200, cursor: last.cursor.next })
        assert.equal(boundary.data.length, 0)
      }
    }
    assert.equal(requests.length, 0)
    console.log(JSON.stringify({ version: (await client.server.info()).version, platform: process.platform,
      messages: messages.length, orders: ["asc", "desc"], previousNext: true, providerRequests: requests.length }))
  } finally { await client.session.remove({ sessionID: session.id }) }
})
