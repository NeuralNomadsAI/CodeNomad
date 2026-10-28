import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// The fixture tool's file result. With `experimental.media_blob` the runtime
// stores it as a `media:` ref into `blob`; native reads return it inline.
export const MEDIA_PROBE_HTML = "<p>MEDIA_PRUNING_CANARY</p>"
export const mediaProbeTool = `{ name:'media_probe', description:'Fixture', input:{type:'object',properties:{}}, options:{codemode:false},
  execute:async()=>({content:[{type:'file',mime:'text/html',name:'media.html',uri:'data:text/html;base64,${Buffer.from(MEDIA_PROBE_HTML).toString("base64")}'}]}) }`

// Readers of stored rows must agree with native reads whichever representation
// the runtime chose; the stored form is qualified from the database itself.
export async function testSessionMediaBlobNative({ client, location, locationOptions, db, generate, revision }) {
  const session = await client.session.create({ location }, locationOptions)
  await generate(session.id)
  const rpc = async (method, input) => (await client.rpc.call({ rpcID: "codenomad.session-pruning", method, location,
    input: { sessionID: session.id, ...input } }, locationOptions)).output
  const messages = (await client.message.list({ sessionID: session.id, limit: 100, order: "asc" })).data
  const target = messages.find(message => message.type === "assistant" && message.content.some(part => part.type === "tool" && part.name === "media_probe"))
  assert(target, "media_probe produced a stored tool result")
  const index = target.content.findIndex(part => part.type === "tool" && part.name === "media_probe")
  const bytes = Buffer.from(MEDIA_PROBE_HTML), hash = createHash("sha256").update(bytes).digest("hex")
  const uri = `data:text/html;base64,${bytes.toString("base64")}`
  assert.equal(target.content[index].state.content[0].uri, uri, "native reads return the inline file")
  const stored = JSON.parse(db.prepare("SELECT data FROM session_message WHERE id=?").get(target.id).data).content[index].state.content[0].uri
  const blobs = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='blob'").get())
  const refs = () => db.prepare("SELECT count(*) AS n FROM blob_ref WHERE session_id=? AND hash=?").get(session.id, hash).n
  const blob = () => db.prepare("SELECT count(*) AS n FROM blob WHERE hash=?").get(hash).n
  if (blobs) {
    assert.equal(stored, `media:${hash}`, "media_blob stores the tool file as a blob ref")
    assert.equal(refs(), 1)
    assert.equal(blob(), 1)
  } else assert.equal(stored, uri)

  const window = await rpc("window", { target: { kind: "around", messageID: target.id } })
  assert.equal(window.status, "window", JSON.stringify(window))
  assert.deepEqual(window.messages.find(message => message.id === target.id),
    await client.session.message.get({ sessionID: session.id, messageID: target.id }), "navigation emits the native read form")
  const page = await rpc("assets", {})
  const entry = page.entries?.find(item => item.target.messageID === target.id)
  assert.deepEqual(entry && [entry.name, entry.mime, entry.available], ["media.html", "text/html", true], JSON.stringify(page))
  assert.deepEqual(await rpc("assetRead", { target: entry.target }), { status: "asset", mime: "text/html", uri })

  const preview = await rpc("preview", { messageID: target.id })
  assert.equal(preview.revision, revision(target.content), "preview hashes the native read form")
  const result = await rpc("prune", { messageID: target.id, revision: preview.revision, indexes: [index] })
  assert.equal(result.status, "pruned", JSON.stringify(result))
  const after = await client.session.message.get({ sessionID: session.id, messageID: target.id })
  assert.deepEqual(after.content, target.content.filter((_, position) => position !== index))
  assert.equal(result.revision, revision(after.content))
  if (blobs) {
    assert.equal(refs(), 0, "pruning releases the dropped part's blob ref")
    assert.equal(blob(), 0, "an unreferenced blob is deleted, as native content updates do")
  }
  console.log(`PASS: ${blobs ? "media_blob refs" : "inline files"} read natively through navigation, assets and pruning${blobs ? ", with blob release" : ""}`)
}
