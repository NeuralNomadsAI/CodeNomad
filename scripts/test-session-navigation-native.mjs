import assert from "node:assert/strict"

export async function testSessionNavigationNative({ client, location, locationOptions, template }) {
  const seed = await client.session.create({ title: "Isolated long navigation fixture", location }, locationOptions)
  const exported = await client.session.export({ sessionID: seed.id })
  await client.session.remove({ sessionID: seed.id })
  const id = index => `msg_navigation_${String(index).padStart(5, "0")}`
  const messages = Array.from({ length: 1501 }, (_, index) => ({
    ...structuredClone(template), id: id(index), content: [{ type: "text", text: `Navigation passage ${index}` }],
  }))
  const session = await client.session.import({ ...exported, messages, location }, locationOptions)
  const rpc = async (method, input) => (await client.rpc.call({ rpcID: "codenomad.session-pruning", method,
    input: { sessionID: session.id, ...input }, location }, locationOptions)).output
  try {
    assert.deepEqual(await rpc("window", { target: { kind: "around", messageID: "msg_removed" } }),
      { status: "blocked", reason: "anchor_missing" }, "missing restore anchor is distinct from ownership conflicts")
    const around = await rpc("window", { target: { kind: "around", messageID: id(1200) } })
    assert.equal(around.status, "window", JSON.stringify(around))
    assert.equal(around.messages.length, 200)
    assert.equal(around.messages[80].id, id(1200))
    const native = await client.session.export({ sessionID: session.id })
    assert.deepEqual(around.messages, native.messages.slice(1120, 1320), "SQL reconstruction matches native export exactly")
    assert.deepEqual(around.messages[80], await client.session.message.get({ sessionID: session.id, messageID: id(1200) }))
    assert.deepEqual(await rpc("window", { target: around.resume }), around)
    const prior = await rpc("window", { target: around.older })
    assert(prior.messages.some(message => message.id === around.messages[0].id), "prior window retains the viewport anchor")
    const following = await rpc("window", { target: around.newer })
    assert(following.messages.some(message => message.id === around.messages.at(-1).id), "next window retains the viewport anchor")
    let cursor, count = 0
    do {
      const outline = await rpc("outline", cursor ? { cursor } : {})
      assert.equal(outline.status, "outline")
      assert.equal(outline.entries.length, Math.min(16384, native.messages.length - count), "structural index does not wait for excerpt pagination")
      assert(outline.entries.every(entry => !("preview" in entry)))
      count += outline.entries.length
      cursor = outline.cursor
    } while (cursor)
    assert.equal(count, native.messages.length)
    const previews = await rpc("outlinePreview", { messageIDs: [id(1200)] })
    assert.equal(previews.status, "previews", JSON.stringify(previews))
    assert.equal(previews.entries[0].text, "Navigation passage 1200")
    console.log("PASS: native 1501-message outline, direct distant windows, overlap and exact native payload/restore parity")
  } finally { await client.session.remove({ sessionID: session.id }) }
}
