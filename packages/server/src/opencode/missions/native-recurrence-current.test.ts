import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import Fastify from "fastify"
import { Location } from "@opencode/schema/location"
import { MissionControl } from "../../missions/control"
import { registerMissionRecurrenceCurrent } from "../../server/routes/mission-recurrence-current"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
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
    await f.calendar.finish("schedule", settled!.result, 30, () => true, settled!.expectedRevision)
    assert.equal((await read()).passageID, null)
    await assert.rejects(content(), /content unavailable/)
    assert.equal(writes, 0)
  } finally { await f.dispose() }
})

test("a passage of 864 tasks with full briefs is read once: the reader and its current and content routes serve its 17 MB map", { timeout: 900_000 }, async () => {
  const f = await passageFixture()
  let app: ReturnType<typeof Fastify> | undefined
  try {
    await f.start()
    let mission = (await f.passage.journal.snapshot()).missions[0]
    const control = new MissionControl({ project: { id: "project", canonical: f.root, location: { directory: f.root } }, storage: f.passage.storage,
      sessions: { get: async ({ sessionID }: { sessionID: string }) => f.sessions.get(sessionID), create: async () => { throw new Error("unused") },
        prompt: async () => {}, synthetic: async () => {} } as never })
    // 72 revisions of 12 tasks, each with the accepted 20,000-character brief and below the 256 KiB entry bound.
    for (let revision = 0; revision < 72; revision++) {
      mission = (await control.revise(mission.coordinatorSessionId, { missionID: mission.id, requestID: `rev-${revision}`, expectedRevision: mission.revision,
        reason: "More tasks", retireTasks: [], dependencyUpdates: [], addTasks: Array.from({ length: 12 }, (_, index) => ({ taskKey: `task-${revision}-${index}`,
          title: "Work", brief: "b".repeat(20_000), role: "specialist", blockedBy: [], executionMode: { kind: "native" as const, parentTaskKey: null } })) })).mission
    }
    assert.equal(mission.tasks.length, 864)
    assert.ok(Buffer.byteLength(JSON.stringify(mission)) > 17_500_000, "a journal over half the reader's 32 MiB budget")
    const location = Schema.decodeUnknownSync(Location.Info)({ directory: f.root, project: { id: "project", directory: f.root, canonical: f.root } })
    const tag = (name: string) => Context.Service<never, unknown>(name)
    const client = Object.assign(() => {}, { unsafe: () => { throw new Error("Reader cannot query") } })
    const graph = Context.make(tag("@opencode/storage/Database"), { db: { $client: client, transaction: () => Effect.die("Reader cannot transact") } })
      .pipe(Context.add(tag("@opencode/Location"), location))
    const ctx = { location, storage: { get: (key: string) => Effect.promise(() => f.storage.get(key)), set: () => Effect.die("Reader cannot write"),
      scan: (input: Parameters<typeof f.storage.scan>[0]) => Effect.promise(() => f.storage.scan(input)) } } as unknown as Parameters<typeof readNativeRecurrenceCurrent>[0]
    const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect.pipe(Effect.provide(graph)) as Effect.Effect<A, unknown, never>)
    const read = () => run(readNativeRecurrenceCurrent(ctx, { scheduleID: "schedule" }))
    const result = await read()
    assert("mission" in result && result.mission?.tasks.length === 864)
    // The real current and content handlers over the real reader.
    const owned = { directory: f.root }, workspace = { id: "workspace" }
    const api = { location: { get: async () => location },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      rpc: () => ({ recurrenceCurrent: async () => JSON.parse(JSON.stringify(await read())),
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
    const current = await app.inject({ method: "GET", url })
    assert.equal(current.statusCode, 200, current.body.slice(0, 200))
    assert.equal(current.json().mission.tasks.length, 864)
    const content = await app.inject({ method: "GET", url: `${url}/${f.passage.passageID}/content?kind=overview&section=objective` })
    assert.equal(content.statusCode, 200, content.body.slice(0, 200))
  } finally { await app?.close(); await f.dispose() }
})
