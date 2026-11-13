import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { fixtureCliVersion } from "./native-fixture-cli-version.mjs"

const cli = process.argv[2], version = await fixtureCliVersion(cli)
await withProductRuntime(cli, async ({ root }) => {
  const plugin = path.join(root, "observer")
  await mkdir(plugin)
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "schedule-context-observer", type: "module", exports: "./index.mjs" }))
  await writeFile(path.join(plugin, "index.mjs"), `
    import { Plugin } from "@opencode/plugin/effect"
    import { Effect } from "effect"
    import { appendFileSync } from "node:fs"
    export default Plugin.define({ id: "fixture.schedule-context", effect: ctx => Effect.gen(function* () {
      yield* ctx.session.hook("context", event => Effect.sync(() => appendFileSync(${JSON.stringify(path.join(root, "context.jsonl"))},
        JSON.stringify({ sessionID: event.sessionID, messages: event.messages.map(({ id, role, metadata }) => ({ id, role, metadata })) }) + "\\n")))
    }) })
  `)
  return { experimental: { schedules: true }, plugins: [plugin] }
}, async ({ client, root }) => {
  assert.equal((await client.server.info()).version, version)
  const session = await client.session.create({ title: "Schedule context contract", location: { directory: root } })
  const schedule = await client.experimental.schedule.create({ sessionID: session.id,
    when: { at: new Date(Date.now() + 2000).toISOString() }, prompt: "FIXTURE_SCHEDULE_WAKE" })
  const id = `msg_${schedule.id}_1`
  let context
  for (const end = Date.now() + 20000; Date.now() < end;) {
    const lines = await readFile(path.join(root, "context.jsonl"), "utf8").catch(() => "")
    context = lines.trim().split("\n").filter(Boolean).map(JSON.parse).find(event => event.messages.some(message => message.id === id))
    if (context) break
    await delay(50)
  }
  assert(context, "The native scheduled input retains its ID in context")
  const db = new DatabaseSync(path.join(root, "fixture.db"), { readOnly: true })
  let stored
  try { stored = db.prepare("SELECT id,type,data FROM session_message WHERE id=? AND session_id=?").get(id, session.id) } finally { db.close() }
  assert.equal(stored.type, "user")
  const metadata = JSON.parse(stored.data).metadata.schedule
  assert.equal(metadata.id, schedule.id); assert.equal(metadata.run, 1)
  assert(Number.isSafeInteger(metadata.dueAt) && metadata.dueAt >= 0)
  assert.equal(typeof metadata.late, "boolean")
  assert.equal(JSON.parse(stored.data).text, "FIXTURE_SCHEDULE_WAKE")
  const projected = context.messages.find(message => message.id === id)
  assert.equal(projected.role, "user")
  if (projected.metadata?.schedule) assert.deepEqual(projected.metadata.schedule, metadata)
  const result = { version, context: projected, stored: { id: stored.id, type: stored.type, schedule: metadata } }
  await writeFile(path.join(root, "schedule-context-proof.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}, { service: true })
