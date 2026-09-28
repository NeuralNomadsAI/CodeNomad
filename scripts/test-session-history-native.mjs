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
  const scan = async purpose => {
    let cursor, scanned = 0, tools = 0, reasoning = 0
    const candidates = [], hits = []
    do {
      const page = await rpc("history", { sessionID: session.id, purpose, query: purpose === "search" ? "historicalneedle" : "", includeTechnical: true, ...(cursor ? { cursor } : {}) })
      assert.equal(page.status, "page", JSON.stringify(page))
      assert(page.scanned <= 32)
      assert.equal(page.skipped, 0)
      scanned += page.scanned; tools += page.tools; reasoning += page.reasoning
      candidates.push(...page.candidates); hits.push(...page.hits)
      cursor = page.cursor
    } while (cursor)
    return { scanned, tools, reasoning, candidates, hits }
  }
  try {
    const before = await scan("stats")
    assert.equal(before.scanned, 241)
    assert.equal(before.tools, 241)
    assert.equal(before.reasoning, 241)
    assert.equal((await scan("search")).hits.length, 241)
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
