import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { passageFixture } from "./native-passage-test-fixture"
import { readNativeRecurrenceCurrent, readNativeRecurrenceCurrentContent } from "./native-recurrence-current"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"

test("current reader uses pending identity and real passage journal, with no signed ledger or writes", async () => {
  const f = await passageFixture()
  try {
    const location = Schema.decodeUnknownSync(Location.Info)({ directory: f.root, project: { id: "project", directory: f.root, canonical: f.root } })
    const tag = (name: string) => Context.Service<never, unknown>(name)
    const client = Object.assign(() => {}, { unsafe: () => { throw new Error("Reader cannot query session or signer") } })
    const graph = Context.make(tag("@opencode/storage/Database"), { db: { $client: client, transaction: () => Effect.die("Reader cannot transact") } })
      .pipe(Context.add(tag("@opencode/Location"), location))
    let mutateDuringScan = false, writes = 0
    const ctx = { location, storage: {
      get: (key: string) => Effect.promise(() => f.storage.get(key)),
      set: () => Effect.sync(() => { writes++; throw new Error("Reader cannot write") }),
      scan: (input: Parameters<typeof f.storage.scan>[0]) => Effect.promise(async () => {
        const page = await f.storage.scan(input)
        if (mutateDuringScan) { mutateDuringScan = false; const doc = (await f.calendar.read("schedule"))!; await f.calendar.setState(doc.id, doc.revision, "paused", () => true) }
        return page
      }),
    } } as unknown as Parameters<typeof readNativeRecurrenceCurrent>[0]
    const read = () => Effect.runPromise(readNativeRecurrenceCurrent(ctx, { scheduleID: "schedule" }).pipe(Effect.provide(graph)))
    const content = (passageID = f.passage.passageID) => Effect.runPromise(readNativeRecurrenceCurrentContent(ctx,
      { scheduleID: "schedule", passageID, kind: "overview", section: "summary" }).pipe(Effect.provide(graph)))
    const reserved = await read()
    assert.equal(reserved.passageID, f.passage.passageID)
    assert.equal("mission" in reserved, false)
    await f.start()
    await f.finish()
    const result = await read()
    assert("mission" in result && result.mission)
    assert.equal(result.mission.id, f.passage.missionID)
    assert.equal(result.mission.summary, "Finished via real mission tool")
    const page = await content()
    assert("sourceText" in page)
    assert.equal(page.sourceText, "Finished via real mission tool")
    await assert.rejects(content("rcp_foreign"), /passage changed/)
    mutateDuringScan = true
    await assert.rejects(read(), /passage changed/)
    const settled = await observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!, storage: f.storage,
      native: f.observation, directory: f.root, current: () => true, signal: new AbortController().signal })
    await f.calendar.finish("schedule", settled!.result, 30, settled!.current)
    assert.equal((await read()).passageID, null)
    await assert.rejects(content(), /content unavailable/)
    assert.equal(writes, 0)
  } finally { await f.dispose() }
})
