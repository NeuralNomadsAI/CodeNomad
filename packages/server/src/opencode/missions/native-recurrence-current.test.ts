import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import Fastify from "fastify"
import { Location } from "@opencode/schema/location"
import { MissionControl } from "../../missions/control"
import { registerMissionRecurrenceCurrent } from "../../server/routes/mission-recurrence-current"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { passageFixture } from "./native-passage-test-fixture"
import { readNativeRecurrenceCurrent, readNativeRecurrenceCurrentContent, readNativeRecurrenceCurrentPage } from "./native-recurrence-current"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"
import { readNativeRecurrencePage } from "./native-recurrence-reader"
import { contentDigest } from "../../missions/content-digest"
import { readMissionContent } from "../../missions/mission-content"
import type { MissionPanelPageRequest, MissionPanelPageResult } from "../../missions/mission-panel-wire"

async function rows(read: (cursor?: { digest: string; index: number; offset: number }) => Promise<MissionPanelPageResult>) {
  let cursor: { digest: string; index: number; offset: number } | undefined, digest: string | undefined
  const text: string[] = []
  do {
    const result = await read(cursor)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536)
    assert.ok(result.available)
    digest ??= result.page.digest; assert.equal(result.page.digest, digest)
    for (const piece of result.page.pieces) {
      assert.equal(piece.offset, text[piece.index]?.length ?? 0)
      assert.ok(piece.characters <= 8 * 1024 * 1024)
      text[piece.index] = (text[piece.index] ?? "") + piece.text
    }
    cursor = result.page.next
  } while (cursor)
  assert.equal(contentDigest(`[${text.join(",")}]`), digest)
  return text.map(value => JSON.parse(value))
}

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
    assert.equal("mission" in result, false)
    assert.equal(result.source?.missionID, f.passage.missionID)
    for (const field of ["digest", "projectID", "passageID"] as const) await assert.rejects(Effect.runPromise(readNativeRecurrenceCurrentPage(ctx, {
      source: { ...result.source, [field]: field === "digest" ? "x".repeat(43) : "foreign" }, selector: { source: "mission", missionID: f.passage.missionID, header: true },
    }).pipe(Effect.provide(graph))), /passage changed|selector differs/)
    const page = await content()
    assert("sourceText" in page)
    assert.equal(page.sourceText, "Finished via real mission tool")
    await assert.rejects(content("rcp_foreign"), /passage changed/)
    mutateDuringScan = true
    await assert.rejects(Effect.runPromise(readNativeRecurrenceCurrentPage(ctx, { source: result.source,
      selector: { source: "mission", missionID: f.passage.missionID, header: true } }).pipe(Effect.provide(graph))), /passage changed/)
    const settled = await observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!, storage: f.storage,
      native: f.observation, directory: f.root, current: () => true, signal: new AbortController().signal })
    await f.calendar.finish("schedule", settled!.result, 30, () => true, settled!.expectedRevision)
    assert.equal((await read()).passageID, null)
    await assert.rejects(content(), /content unavailable|passage changed/)
    assert.equal(writes, 0)
  } finally { await f.dispose() }
})

for (const revisions of [72, 144]) test(`current display stays byte bounded for ${revisions * 12} maximum-brief tasks without a cumulative journal cap`, { timeout: 900_000 }, async t => {
  const f = await passageFixture()
  let app: ReturnType<typeof Fastify> | undefined
  try {
    await f.start()
    let mission = (await f.passage.journal.snapshot()).missions[0]
    const control = new MissionControl({ project: { id: "project", canonical: f.root, location: { directory: f.root } }, storage: f.passage.storage,
      sessions: { get: async ({ sessionID }: { sessionID: string }) => f.sessions.get(sessionID), create: async () => { throw new Error("unused") },
        prompt: async () => {}, synthetic: async () => {} } as never })
    // 72 revisions of 12 tasks, each with the accepted 20,000-character brief and below the 256 KiB entry bound.
    for (let revision = 0; revision < revisions; revision++) {
      mission = (await control.revise(mission.coordinatorSessionId, { missionID: mission.id, requestID: `rev-${revision}`, expectedRevision: mission.revision,
        reason: "More tasks", retireTasks: [], dependencyUpdates: [], addTasks: Array.from({ length: 12 }, (_, index) => ({ taskKey: `task-${revision}-${index}`,
          title: "Work", brief: "b".repeat(20_000), role: "specialist", blockedBy: [], executionMode: { kind: "native" as const, parentTaskKey: null } })) })).mission
    }
    assert.equal(mission.tasks.length, revisions * 12)
    assert.ok(Buffer.byteLength(JSON.stringify(mission)) > 17_500_000, "a journal over half the reader's 32 MiB budget")
    const events = await f.passage.journal.missionEvents(mission.id), rangeBytes = events.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
    if (revisions === 144) assert.ok(rangeBytes > 32 * 1024 * 1024, "accepted entries exceed the full-response capacity")
    let scannedEntries = 0, rangeObservations = 0
    const location = Schema.decodeUnknownSync(Location.Info)({ directory: f.root, project: { id: "project", directory: f.root, canonical: f.root } })
    const tag = (name: string) => Context.Service<never, unknown>(name)
    const client = Object.assign(() => {}, { unsafe: () => { throw new Error("Reader cannot query") } })
    const graph = Context.make(tag("@opencode/storage/Database"), { db: { $client: client, transaction: () => Effect.die("Reader cannot transact") } })
      .pipe(Context.add(tag("@opencode/Location"), location))
    const ctx = { location, storage: { get: (key: string) => { assert.ok(!key.includes("/finishes/"), "isolated passages never use the project finish counter"); return Effect.promise(() => f.storage.get(key)) }, set: () => Effect.die("Reader cannot write"),
      scan: (input: Parameters<typeof f.storage.scan>[0]) => Effect.promise(async () => {
        assert.ok(input.prefix.includes(f.passage.passageID)); if (!input.after) rangeObservations++
        const page = await f.storage.scan(input); scannedEntries += page.entries.length; return page
      }) } } as unknown as Parameters<typeof readNativeRecurrenceCurrent>[0]
    const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect.pipe(Effect.provide(graph)) as Effect.Effect<A, unknown, never>)
    const read = () => run(readNativeRecurrenceCurrent(ctx, { scheduleID: "schedule" }))
    const result = await read()
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536, "current display never ships the full passage map")
    assert.equal(scannedEntries, 0, "source identity precedes external range slices")
    const source = result.source!
    const pageRows = (selector: MissionPanelPageRequest) => rows(cursor => run(readNativeRecurrenceCurrentPage(ctx, { source, selector: { ...selector, cursor } })))
    const before = rangeObservations, headerRows = await pageRows({ source: "mission", missionID: mission.id, header: true }), projected = headerRows[0]
    assert.equal(rangeObservations - before, 1); assert.equal(scannedEntries, events.events.length)
    assert.equal(projected.tasks.page.total, revisions * 12)
    assert.equal(projected.root.tasks, undefined); assert.ok(JSON.stringify(projected).length < 20000)
    const seen = new Set<string>()
    for (let offset = 0; offset < revisions * 12; offset += 50) {
      const [page] = await pageRows({ source: "tasks", task: { missionID: mission.id, offset, order: projected.tasks.page.order } })
      for (const task of page.tasks) { assert.equal(task.brief, undefined); seen.add(task.key) }
    }
    assert.equal(seen.size, revisions * 12)
    // Qualify every exact body selector over the accepted observation; representative
    // first/last selectors below also traverse the native Effect/RPC byte paginator.
    for (const task of mission.tasks) {
      let offset = 0, digest: string | undefined, text = ""
      for (;;) {
        const body = readMissionContent(mission.projectID, { missionID: mission.id, kind: "task", taskKey: task.key, field: "brief", offset, digest }, mission)
        assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 65536); assert.ok("content" in body)
        text += body.content.text; digest = body.content.digest
        if (body.content.next === undefined) break
        offset = body.content.next
      }
      assert.equal(text, task.brief)
    }
    for (const task of [mission.tasks[0], mission.tasks.at(-1)!]) {
      let offset = 0, digest: string | undefined, text = ""
      for (;;) {
        const [answer] = await rows(cursor => run(readNativeRecurrenceCurrentPage(ctx, { source, selector: { source: "mission", missionID: mission.id, field: "body", window: { offset: 0 }, cursor },
          body: { missionID: mission.id, kind: "task", taskKey: task.key, field: "brief", offset, digest } })))
        text += answer.content.text; digest = answer.content.digest
        if (answer.content.next === undefined) break
        offset = answer.content.next
      }
      assert.equal(text, task.brief)
    }
    t.diagnostic(JSON.stringify({ tasks: mission.tasks.length, rangeEntries: events.events.length, rangeBytes, identityBytes: Buffer.byteLength(JSON.stringify(result)), headerBytes: Buffer.byteLength(JSON.stringify(projected)), initialRangeObservations: 1, rowsReached: seen.size, exactBodiesReached: mission.tasks.length }))
    // The real current and content handlers over the real reader.
    const owned = { directory: f.root }, workspace = { id: "workspace" }
    const api = { location: { get: async () => location },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      rpc: () => ({ recurrenceCurrent: async () => JSON.parse(JSON.stringify(await read())),
        recurrenceCurrentPage: async (input: unknown) => JSON.parse(JSON.stringify(await run(readNativeRecurrenceCurrentPage(ctx, input)))),
        recurrenceCurrentContent: async (input: unknown) => JSON.parse(JSON.stringify(await run(readNativeRecurrenceCurrentContent(ctx, input)))) }),
      session: { get: async ({ sessionID }: { sessionID: string }) => f.sessions.get(sessionID), list: async () => ({ data: [], cursor: { next: null } }),
        inbox: { list: async () => [] }, active: async () => ({}) },
      shell: { list: async () => ({ location: owned, data: [] }) }, form: { list: async () => ({ location: owned, data: [] }) },
      permission: { request: { list: async () => ({ location: owned, data: [] }) } } }
    app = Fastify({ logger: false })
    registerMissionRecurrenceCurrent(app, { workspaceManager: { get: () => workspace, getServiceLocation: () => owned,
      getSharedServiceConnection: async () => ({ client: api, assertCurrent() {} }), ownsLocation: async () => true,
      getWorktreeIdentityForPath: async () => f.root }, worktreeDeletionFence: new WorktreeDeletionFence() } as never)
    const url = "/api/workspaces/workspace/missions/recurrence/schedule/current"
    const beforeCurrent = rangeObservations
    const current = await app.inject({ method: "GET", url })
    assert.equal(current.statusCode, 200, current.body.slice(0, 200))
    assert.equal(current.json().source.missionID, mission.id)
    assert.equal(rangeObservations, beforeCurrent)
    const beforeHeader = rangeObservations
    const header = await app.inject({ method: "POST", url: `${url}/${f.passage.passageID}/page`, payload: { source: current.json().source,
      selector: { source: "mission", missionID: mission.id, header: true } } })
    assert.equal(header.statusCode, 200, header.body.slice(0, 200))
    assert.ok(header.rawPayload.length <= 65536)
    assert.equal(rangeObservations - beforeHeader, 1, "HTTP publication rereads only the current identity, not a second range")
    assert.equal(JSON.parse(header.json().page.pieces.map((piece: { text: string }) => piece.text).join("")).tasks.page.total, revisions * 12)
    const beforeContent = rangeObservations
    const content = await app.inject({ method: "GET", url: `${url}/${f.passage.passageID}/content?kind=overview&section=objective` })
    assert.equal(content.statusCode, 200, content.body.slice(0, 200))
    assert.equal(rangeObservations - beforeContent, 1)
    const doc = (await f.calendar.read("schedule"))!
    await f.calendar.finish(doc.id, { passageID: f.passage.passageID, messageID: f.passage.messageID, missionID: mission.id,
      conversationID: mission.coordinatorSessionId, outcome: "ended-without-report", artifactMessageIDs: [], cursors: [] }, Date.now(), () => true, doc.revision)
    const beforeArchive = rangeObservations, archived = []
    for (let page = 0; page < 3; page++) {
      const answer = await run(readNativeRecurrencePage(ctx, { scheduleID: doc.id, passageID: f.passage.passageID, section: mission.tasks.length, page }))
      assert.equal(answer.missionID, mission.id); assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 65536)
      archived.push(answer.sourceText)
    }
    assert.equal(rangeObservations - beforeArchive, 3, "one accepted range per archived page, never snapshot plus events")
    assert.equal(archived.join(""), mission.tasks.at(-1)!.brief)
  } finally { await app?.close(); await f.dispose() }
})
