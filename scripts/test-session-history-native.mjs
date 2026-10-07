import assert from "node:assert/strict"

// Invoked only inside the pruning fixture's private daemon and synthetic DB.
export async function testSessionHistoryNative({ client, location, locationOptions, template }) {
  const seed = await client.session.create({ title: "Isolated full-history fixture", location }, locationOptions)
  const exported = await client.session.export({ sessionID: seed.id })
  await client.session.remove({ sessionID: seed.id })
  const messages = Array.from({ length: 241 }, (_, index) => ({
    ...structuredClone(template), id: `msg_history_fixture_${String(index).padStart(5, "0")}`,
    content: [...template.content.map(part => part.type === "tool" ? { ...structuredClone(part), id: `history_call_${index}` } : structuredClone(part)),
      { type: "text", text: `Keep historicalneedle answer ${index}` }],
  }))
  const session = await client.session.import({ ...exported, messages, location }, locationOptions)
  const rpc = async (method, input) => (await client.rpc.call({ rpcID: "codenomad.session-pruning", method, input, location }, locationOptions)).output
  const scan = async (purpose, includeTechnical = true, sessionID = session.id) => {
    let cursor, scanned = 0, tools = 0, reasoning = 0
    const candidates = [], hits = []
    do {
      const page = await rpc("history", { ...(sessionID ? { sessionID } : {}), purpose, query: purpose === "search" ? "historicalneedle" : "", includeTechnical, ...(cursor ? { cursor } : {}) })
      assert.equal(page.status, "page", JSON.stringify(page))
      assert(page.scanned <= (purpose === "search" || (purpose === "stats" && !includeTechnical) ? 1024 : 32))
      assert(page.hits.length <= 32 && page.sessions.length <= 32)
      assert.equal(page.skipped, 0)
      scanned += page.scanned; tools += page.tools; reasoning += page.reasoning
      candidates.push(...page.candidates); hits.push(...page.hits)
      cursor = page.cursor
    } while (cursor)
    return { scanned, tools, reasoning, candidates, hits }
  }
  try {
    const assetMessage = structuredClone(messages[0])
    assetMessage.id = "msg_assets_fixture"
    const assetTool = assetMessage.content.find(part => part.type === "tool")
    assert(assetTool)
    assetTool.state.content = [{ type: "file", name: "Native image", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=" },
      { type: "file", name: "Native notes", mime: "text/plain", uri: "data:text/plain;base64,YQ==" }]
    const assetSeed = await client.session.create({ title: "Isolated assets fixture", location }, locationOptions)
    const assetExport = await client.session.export({ sessionID: assetSeed.id })
    await client.session.remove({ sessionID: assetSeed.id })
    const assetSession = await client.session.import({ ...assetExport, messages: [assetMessage], location }, locationOptions)
    try {
      const assets = await rpc("assets", { sessionID: assetSession.id })
      assert.equal(assets.status, "page", JSON.stringify(assets))
      assert.equal(assets.entries.length, 2)
      assert(!JSON.stringify(assets).includes("aGVsbG8"), "Metadata does not expose bytes")
      const read = await rpc("assetRead", { sessionID: assetSession.id, target: assets.entries[0].target })
      assert.equal(read.status, "asset", JSON.stringify(read))
      assert.equal(read.uri, assetTool.state.content[0].uri)
      assert.equal((await rpc("assetRead", { sessionID: session.id, target: assets.entries[0].target })).status, "blocked")
      console.log("PASS: native asset metadata, exact embedded bytes and cross-session isolation")
    } finally { await client.session.remove({ sessionID: assetSession.id }) }
    const before = await scan("stats")
    assert.equal(before.scanned, 241)
    assert.equal(before.tools, 241)
    assert.equal(before.reasoning, 241)
    assert.equal((await scan("search")).hits.length, 241)
    const textOnly = await scan("search", false)
    assert.equal(textOnly.hits.length, 241)
    assert(textOnly.hits.every(hit => hit.kind === "text"))
    const messagesOnly = await scan("stats", false)
    assert.equal(messagesOnly.scanned, 241)
    assert.equal(messagesOnly.tools + messagesOnly.reasoning, 0)
    const peerSeed = await client.session.create({ title: "Isolated workspace history peer", location }, locationOptions)
    const peerExport = await client.session.export({ sessionID: peerSeed.id })
    await client.session.remove({ sessionID: peerSeed.id })
    const peerMessage = { ...structuredClone(messages[0]), id: "msg_history_peer",
      content: [{ type: "text", text: "Another historicalneedle answer in a different session" }] }
    const peer = await client.session.import({ ...peerExport, messages: [peerMessage], location }, locationOptions)
    try {
      const workspace = await scan("search", false, null)
      assert.equal(workspace.hits.length, 242)
      assert.deepEqual(new Set(workspace.hits.map(hit => hit.sessionID)), new Set([session.id, peer.id]))
      console.log("PASS: native text-only workspace search includes both sessions and all 242 matches")
    } finally { await client.session.remove({ sessionID: peer.id }) }
    const plan = await scan("prune")
    assert.equal(plan.candidates.length, 241)
    for (let offset = 0; offset < plan.candidates.length; offset += 16) {
      const input = { sessionID: session.id, candidates: plan.candidates.slice(offset, offset + 16) }
      const result = await rpc("pruneBatch", input)
      assert(result.results.every(entry => entry.result.status === "pruned"), JSON.stringify(result))
      assert.deepEqual(await rpc("pruneBatch", input), result, "batch receipts survive identical retries")
    }
    const after = await scan("stats")
    assert.equal(after.scanned, 241)
    assert.equal(after.tools, 0)
    assert.equal(after.reasoning, 0)
    assert.equal((await scan("search")).hits.length, 241, "answers remain searchable")
    console.log("PASS: native 241-message counts, paginated search, complete technical cleanup and batch retry receipts")
  } finally { await client.session.remove({ sessionID: session.id }) }
}
