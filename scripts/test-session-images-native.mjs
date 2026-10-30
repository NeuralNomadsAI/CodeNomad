import assert from "node:assert/strict"

// The image gallery and Images conversation RPCs inside the official runtime: the
// authoritative lookup, one creation for concurrent opens from two clients, and the
// gallery membership check on a stored non-`read` tool file in whichever form the runtime stores it.
export async function testSessionImagesNative({ client, second, location, locationOptions, other, generate }) {
  const rpc = async (input, method = "imagesConversation", at = location, options = locationOptions, caller = client) =>
    (await caller.rpc.call({ rpcID: "codenomad.session-pruning", method, location: at, input }, options)).output
  assert.deepEqual(await rpc({ mode: "lookup" }), { status: "absent" })
  const opened = await Promise.all([rpc({ mode: "open", title: "Images" }), rpc({ mode: "open", title: "Images" }, undefined, undefined, undefined, second)])
  assert.equal(opened.filter(result => result.created).length, 1, JSON.stringify(opened))
  assert.equal(new Set(opened.map(result => result.sessionID)).size, 1)
  const images = opened[0].sessionID
  const session = await client.session.get({ sessionID: images })
  assert.deepEqual([session.title, session.metadata, session.parentID ?? null], ["Images", { "codenomad.companion": "images" }, null])
  for (let n = 0; n < 60; n++) await client.session.create({ location }, locationOptions)
  // Children inherit their parent's metadata; a newer marked child is never the conversation.
  await client.session.create({ parentID: images })
  assert.deepEqual(await rpc({ mode: "open" }), { status: "found", sessionID: images, created: false })
  const fresh = await rpc({ mode: "new", title: "Images" })
  assert.equal(fresh.created, true)
  assert.deepEqual(await rpc({ mode: "lookup" }), { status: "found", sessionID: fresh.sessionID, created: false })
  await client.session.remove({ sessionID: fresh.sessionID })
  assert.deepEqual(await rpc({ mode: "lookup" }), { status: "found", sessionID: images, created: false })
  assert.deepEqual(await rpc({ mode: "lookup" }, undefined, other.location, other.locationOptions), { status: "absent" }, "another location has its own conversation")

  assert.deepEqual(await rpc({ sessionID: images }, "images"), { status: "page", entries: [], cursor: null })
  const probe = await client.session.create({ location }, locationOptions)
  await generate(probe.id)
  const assets = await rpc({ sessionID: probe.id }, "assets")
  const asset = assets.entries?.find(entry => entry.tool === "media_probe")
  assert(asset, JSON.stringify(assets))
  assert.deepEqual(await rpc({ sessionID: probe.id, target: asset.target }, "imageRead"), { status: "blocked", reason: "not-gallery" })
  assert.deepEqual(await rpc({ sessionID: probe.id, target: asset.target }, "imageReference"), { status: "refused", reason: "not-gallery" })
  const page = await rpc({ sessionID: probe.id }, "images")
  assert.equal(page.status, "page", JSON.stringify(page))
  assert(page.entries.every(entry => entry.kind !== "image"))
  console.log("PASS: Images conversation lookup/open/new in the runtime (one creation for concurrent opens, marked child, deletion, other location) and gallery membership on a stored tool file")
  return images
}
