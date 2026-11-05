// Owned-runtime inventory qualification only; no discovery of the shared daemon.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tsImport } from "tsx/esm/api"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { fixturePaginationGuard } from "./native-fixture-guards.mjs"

await withProductRuntime(process.argv[2], async () => ({}), async ({ client, root, requests }) => {
  const { decodeSessionListScope } = await tsImport("../packages/server/src/opencode/compatibility/proxy-locations.ts", import.meta.url)
  const directory = path.join(root, "target")
  const others = [root, path.join(directory, "nested"), path.join(root, "sibling")]
  for (const value of [directory, ...others]) await mkdir(value, { recursive: true })
  const expected = new Set()
  for (const value of [directory, directory, directory, ...others]) {
    const session = await client.session.create({ location: { directory: value }, title: "fixture-only" })
    const placed = await client.session.get({ sessionID: session.id })
    assert.equal(placed.location.directory, value)
    assert.equal(placed.location.workspaceID, undefined)
    if (value === directory) expected.add(session.id)
  }
  const accept = fixturePaginationGuard()
  const found = new Set()
  let page = await client.session.list({ directory, limit: 1, order: "desc" })
  assert.equal(page.data.length, 1)
  assert.ok(page.cursor.next)
  let pages = 0, continuations = 0
  do {
    assert.ok(++pages <= 10, "Bounded synthetic inventory")
    for (const session of page.data) {
      assert.equal(session.location.directory, directory)
      assert.ok(expected.has(session.id))
      assert.ok(!found.has(session.id))
      found.add(session.id)
    }
    const cursor = page.cursor.next
    if (!cursor) break
    assert.deepEqual(decodeSessionListScope(cursor), { directory })
    accept(cursor)
    continuations++
    page = await client.session.list({ cursor })
  } while (true)
  assert.deepEqual(found, expected)
  assert.equal(requests.length, 0)
  console.log(JSON.stringify({ version: (await client.server.info()).version, platform: process.platform,
    pages, continuations, sessions: found.size, exactScope: true, nativeDecoderAccepted: true, providerRequests: requests.length }))
})
