// Explicit CLI, private database/configuration and loopback provider only.
import assert from "node:assert/strict"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { withProductRuntime } from "./native-product-fixture.mjs"

await withProductRuntime(process.argv[2], async () => ({}), async ({ client, root, requests }) => {
  const runtime = (await client.server.info()).version
  const stream = new AbortController(), events = []
  const listener = (async () => {
    try { for await (const event of client.event.subscribe({ signal: stream.signal })) events.push(event) }
    catch (error) { if (!stream.signal.aborted) throw error }
  })()
  const until = async check => {
    for (const end = Date.now() + 15000; Date.now() < end;) {
      if (check()) return
      await delay(25)
    }
    throw new Error("Archive event deadline")
  }
  try {
    await until(() => events.some(event => event.type === "server.connected"))
    const roots = []
    for (let index = 0; index < 4; index++) roots.push(await client.session.create({
      title: `Archive fixture ${index}`, location: { directory: root },
    }))
    const own = roots[0]
    const child = await client.session.create({ parentID: own.id, title: "Unarchived child" })
    await client.session.prompt({ sessionID: own.id, text: "Keep this transcript when archived." })
    await client.session.wait({ sessionID: own.id }, { signal: AbortSignal.timeout(20000) })
    const before = (await client.message.list({ sessionID: own.id, order: "asc", limit: 100 })).data
    const calls = requests.length
    await client.session.update({ sessionID: own.id, archived: true })
    const archived = await client.session.get({ sessionID: own.id })
    assert(archived.time.archived != null)
    await client.session.update({ sessionID: own.id, archived: true })
    assert.equal((await client.session.get({ sessionID: own.id })).time.archived, archived.time.archived)
    assert.equal((await client.session.get({ sessionID: child.id })).time.archived, undefined)
    await client.session.update({ sessionID: roots[2].id, archived: true })
    const pages = [], archivedIDs = []
    let cursor
    do {
      const page = await client.session.list(cursor ? { cursor } : { directory: root, archived: true, parentID: null, limit: 1 })
      archivedIDs.push(...page.data.map(session => session.id))
      cursor = page.cursor.next
      if (cursor) { assert(!pages.includes(cursor)); pages.push(cursor) }
      assert(pages.length < 10)
    } while (cursor)
    assert.deepEqual(archivedIDs.sort(), [own.id, roots[2].id].sort())
    const visible = await client.session.list({ directory: root, archived: false, parentID: null, limit: 100 })
    assert.deepEqual(visible.data.map(session => session.id).sort(), [roots[1].id, roots[3].id].sort())
    const all = await client.session.list({ directory: root, parentID: null, limit: 100 })
    assert.deepEqual(all.data.map(session => session.id).sort(), roots.map(session => session.id).sort())
    const db = new DatabaseSync(path.join(root, "fixture.db"), { readOnly: true })
    try {
      assert(Number(db.prepare("SELECT time_archived FROM session_v2 WHERE id=?").get(own.id).time_archived) > 0)
    } finally { db.close() }
    assert.deepEqual((await client.message.list({ sessionID: own.id, order: "asc", limit: 100 })).data, before)
    await client.session.update({ sessionID: own.id, archived: false })
    await client.session.update({ sessionID: own.id, archived: false })
    assert.equal((await client.session.get({ sessionID: own.id })).time.archived, undefined)
    await until(() => events.some(event => event.type === "session.unarchived" && event.data?.sessionID === own.id))
    const ownEvents = events.filter(event => event.data?.sessionID === own.id && ["session.archived", "session.unarchived"].includes(event.type))
    assert.deepEqual(ownEvents.map(event => event.type), ["session.archived", "session.unarchived"])
    assert.equal(requests.length, calls, "archiving never prompts or executes the model")
    await writeFile(path.join(root, "archive-proof.json"), JSON.stringify({ runtime, archivedIDs, events: ownEvents.map(event => event.type),
      transcriptPreserved: true, childUnchanged: true, idempotent: true, persisted: true }, null, 2))
    console.log(`PASS ${runtime}: native archive/restore, filtered cursor pages, idempotent events, stored flag, retained transcript and unchanged child`)
  } finally { stream.abort(); await listener }
})
