import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import Ajv from "ajv"
import Fastify from "fastify"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Schema } from "effect"
import { parseCookies, sendUnauthorized } from "../../auth/http-auth"
import { SessionManager } from "../../auth/session-manager"
import { MISSION_JOURNAL_STORAGE_PREFIX, type MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import { type RecurrenceConfig, type RecurrenceDocument, RECURRENCE_STORAGE_PREFIX } from "../../missions/recurrence-contract"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { recurrencePassageReadWire } from "../../missions/recurrence-reader-contract"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { withNativeRecurrenceRpc } from "../../opencode/missions/managed-owner-plugin"
import { readNativeRecurrencePage } from "../../opencode/missions/native-recurrence-reader"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceSnapshot } from "./mission-recurrence-snapshot"

type ReadInput = { scheduleID: string; passageID: string; section?: number; page?: number; revision?: number }

async function fixture() {
  // All native services/storage below are in-memory. No daemon, filesystem or private native fixture.
  const directory = path.resolve("offline-archived-recurrence")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory,
    project: { id: "project", directory, canonical: directory } })
  const values = new Map<string, MissionJsonValue>()
  const scans: Array<{ prefix: string; after?: string; limit?: number }> = [], gets: string[] = [], writes: string[] = []
  let reading = false, jobReads = 0, databaseReads = 0, sessionReads = 0
  let afterGet: (() => void) | undefined, scanOverride: ((page: Awaited<ReturnType<MissionStorage["scan"]>>) => Awaited<ReturnType<MissionStorage["scan"]>>) | undefined
  const storage: MissionStorage = {
    get: async key => { if (reading) gets.push(key); const value = structuredClone(values.get(key)); afterGet?.(); return value },
    set: async (key, value, current) => {
      if (reading) { writes.push(key); throw new Error("Unexpected reader write") }
      current?.(); values.set(key, structuredClone(value))
    },
    scan: async input => {
      if (reading) scans.push(input)
      const prefix = input.prefix.endsWith("/") ? input.prefix : `${input.prefix}/`
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!input.after || key > input.after)).sort()
      const selected = keys.slice(0, input.limit ?? 100)
      const page = { entries: selected.map(key => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > selected.length ? { next: selected.at(-1)! } : {}) }
      return scanOverride ? scanOverride(page) : page
    },
  }
  const store = new NativeMissionRecurrenceStore(storage, "project", directory)
  const selection = { agent: "private_agent", model: { providerID: "private_provider", id: "private_model" } }
  const config: RecurrenceConfig = { title: "Review", template: "custom", consigne: "PRIVATE_STANDING_PROMPT", clock: { time: "07:00", zone: "UTC" },
    profileID: "private_profile", executionHost: "private_host", profiles: { coordinator: selection, roles: { specialist: selection } },
    taskMode: "independent", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: ["ses_private_watch"] }
  await store.create("daily_review", config, 100, () => true)
  const pending = await store.reserve("daily_review", 0,
    { kind: "manual", requestID: "request_review", expectedRevision: 0, at: 100 }, 100, () => true)
  const scope = recurrencePassage(storage, pending, () => true, () => 500)
  const input = { scheduleID: pending.id, passageID: scope.passageID }
  const prefix = `${RECURRENCE_STORAGE_PREFIX}/passages/${store.projectToken}/${pending.id}/${scope.passageID}/`
  const metadataKey = `${RECURRENCE_STORAGE_PREFIX}/project/${store.projectToken}/${pending.id}`
  const header = "# Final result\n\n```ts\n"
  const finalSummary = header + "x".repeat(8_999 - header.length) + "😀\n" + "return answer\n".repeat(680) + "```\n\nExact final tail.\n"
  const reportSummary = "# Task report\n\n" + "Verbatim report.\n".repeat(720)
  const evidence = Array.from({ length: 6 }, (_, i) => `## Evidence ${i}\n` + "verified source\n".repeat(120))
  const brief = "# Work brief\n\n" + "Do bounded work.\n".repeat(680)
  let clock = 100
  const base = (id: string) => ({ version: 1 as const, id, projectID: "project", missionID: scope.missionID, createdAt: ++clock })
  await scope.journal.append({ ...base("evt_created"), type: "mission.created", requestID: scope.passageID,
    projectCanonical: directory, objective: "Archived objective", notes: "Archived notes", template: "custom",
    profiles: config.profiles, taskMode: config.taskMode,
    coordinator: { sessionID: scope.coordinatorSessionID, title: "Coordinator", location: { directory } } })
  // >100 actual events exercise journal scan cursors; >32 sections exercise catalogue paging.
  for (let i = 0; i < 34; i++) {
    await scope.journal.append({ ...base(`evt_task_${i}`), type: "task.created",
      task: { id: `tsk_${i}`, key: `work_${i}`, title: `Work ${i}`, brief: i === 0 ? brief : `Brief ${i}`,
        role: "specialist", executionMode: { kind: "independent", reason: "playbook", explanation: "Frozen independent passage policy" }, blockedBy: [] } })
    await scope.journal.append({ ...base(`evt_dispatch_${i}`), type: "task.dispatching", taskKey: `work_${i}`,
      actor: { sessionID: "ses_worker", title: "Worker", location: { directory }, managed: true },
      admissionID: `admission_${i}`, delivery: "queue" })
    await scope.journal.append({ ...base(`evt_dispatched_${i}`), type: "task.dispatched", taskKey: `work_${i}` })
  }
  const reported = base("evt_reported")
  await scope.journal.append({ ...reported, type: "task.reported", report: { id: "rpt_work", taskKey: "work_0",
    sessionId: "ses_worker", outcome: "completed", summary: reportSummary, evidence, next: ["Exact next step"],
    artifact: { result: "Exact draft artifact" }, createdAt: reported.createdAt } })
  await scope.journal.append({ ...base("evt_finished"), type: "mission.finished", outcome: "completed", summary: finalSummary })
  await store.recordAdmission(pending.id, { kind: "accepted", passageID: scope.passageID, messageID: scope.messageID,
    missionID: scope.missionID, conversationID: scope.coordinatorSessionID }, 500, () => true)
  const archived = await store.finish(pending.id, { passageID: scope.passageID, messageID: scope.messageID,
    missionID: scope.missionID, conversationID: scope.coordinatorSessionID, outcome: "completed", artifactMessageIDs: ["msg_artifact"], cursors: [] }, 600, () => true)
  const snapshot = await scope.journal.snapshot()
  assert.equal(snapshot.discardedEvents, 0)
  const revision = snapshot.missions[0].revision
  const saved = structuredClone([...values])
  const nativeStorage = {
    get: (key: string) => Effect.promise(() => storage.get(key)),
    scan: (input: Parameters<MissionStorage["scan"]>[0]) => Effect.promise(() => storage.scan(input)),
    set: (key: string, value: MissionJsonValue) => Effect.promise(() => storage.set(key, value)),
  }
  const dbTag = Context.Service<never, unknown>("@opencode/storage/Database")
  const locationTag = Context.Service<never, Location.Info>("@opencode/Location")
  const jobTag = Context.Service<never, unknown>("@opencode/Job")
  const unexpectedSession = new Proxy({}, { get: () => { sessionReads++; throw new Error("Unexpected session API read") } })
  const db = { db: { $client: Object.assign(() => {}, { unsafe: () => {
    databaseReads++; return { withoutTransform: Effect.die("Unexpected database query") }
  } }), transaction: () => { databaseReads++; return Effect.die("Unexpected transaction") } } }
  const job = new Proxy({}, { get: () => { jobReads++; throw new Error("Unexpected Job access") } })
  const graph = Context.make(dbTag, db).pipe(Context.add(locationTag, location), Context.add(jobTag, job))
  const ctx = { storage: nativeStorage, location, session: unexpectedSession, client: { session: unexpectedSession } }
  const ajv = new Ajv({ allErrors: true, strictKeywords: true })
  let validateOutput!: ReturnType<typeof ajv.compile>, validateInput!: ReturnType<typeof ajv.compile>
  let handler!: (input: unknown) => ReturnType<typeof readNativeRecurrencePage>
  const rpc = Object.assign(() => ({}), { register: (definition: typeof CODENOMAD_MISSIONS_RPC,
    handlers: { recurrencePassageRead(input: unknown): ReturnType<typeof readNativeRecurrencePage> }) => Effect.sync(() => {
    assert.deepEqual(definition.methods.recurrencePassageRead, recurrencePassageReadWire)
    validateOutput = ajv.compile(definition.methods.recurrencePassageRead.output)
    validateInput = ajv.compile(definition.methods.recurrencePassageRead.input)
    handler = raw => Effect.suspend(() => {
      assert.equal(validateInput(raw), true, JSON.stringify(validateInput.errors))
      return handlers.recurrencePassageRead(raw).pipe(Effect.tap(page => Effect.sync(() => {
        assert.equal(validateOutput(page), true, JSON.stringify(validateOutput.errors))
      })))
    })
  }) })
  await Effect.runPromiseWith(graph)(Effect.scoped(withNativeRecurrenceRpc({ ...ctx, rpc } as never)
    .register(CODENOMAD_MISSIONS_RPC, {} as never)))
  reading = true
  const read = (selected: ReadInput = input) => Effect.runPromiseWith(graph)(handler(selected))
  const direct = (raw: unknown) => Effect.runPromiseWith(graph)(readNativeRecurrencePage(ctx as never, raw))
  const restore = () => { values.clear(); for (const [key, value] of structuredClone(saved)) values.set(key, value); afterGet = undefined; scanOverride = undefined; gets.length = 0; scans.length = 0 }
  const setDocument = (doc: RecurrenceDocument) => values.set(metadataKey, JSON.parse(JSON.stringify(doc)))
  const assertReadOnly = (scheduleID = pending.id) => {
    assert.deepEqual(writes, [])
    assert.equal(jobReads, 0); assert.equal(databaseReads, 0); assert.equal(sessionReads, 0)
    assert.ok(gets.every(key => key === `${RECURRENCE_STORAGE_PREFIX}/project/${store.projectToken}/${scheduleID}`), "only the exact selected schedule metadata is fetched; no journal get/transcript fallback")
    assert.ok(scans.every(scan => scan.prefix === prefix && scan.limit === 100
      && (scan.after === undefined || scan.after.startsWith(`${prefix}${scope.missionID}/`))), "all scans stay inside the exact bounded passage journal")
  }
  return { read, direct, input, prefix, projectToken: store.projectToken, metadataKey, values, archived, pending, revision, location, directory,
    finalSummary, reportSummary, evidence, brief, validateOutput, scans, gets, restore, setDocument, assertReadOnly,
    setAfterGet: (callback: () => void) => { afterGet = callback },
    setScanOverride: (callback: NonNullable<typeof scanOverride>) => { scanOverride = callback }, unexpectedSession }
}

test("sealed native archived reader preserves exact paged Markdown, report/evidence/brief and bounded wire catalogues", async () => {
  const f = await fixture(), initial = structuredClone([...f.values])
  const first = await f.read()
  assert.ok("missionID" in f.archived.history[0].result)
  assert.equal(first.missionID, f.archived.history[0].result.missionID)
  assert.equal(first.conversationID, f.archived.history[0].result.conversationID)
  assert.equal(first.revision, f.revision)
  assert.equal(first.sections.length, 32)
  assert.ok(first.sectionCount > 32)
  const finalCatalogue = await f.read({ ...f.input, section: 32 })
  assert.equal(finalCatalogue.sections[0].index, 32)
  assert.equal(finalCatalogue.sections.at(-1)!.index, first.sectionCount - 1)
  const catalogue = [...first.sections, ...finalCatalogue.sections]
  assert.equal(new Set(catalogue.map(item => item.index)).size, first.sectionCount)
  const expected = [
    { label: "summary", title: "", text: f.finalSummary },
    { label: "summary", title: "Work 0", text: f.reportSummary },
    { label: "evidence", title: "Work 0", text: f.evidence.join("\n\n") },
    { label: "brief", title: "Work 0", text: f.brief },
  ]
  for (const section of expected) {
    const selected = catalogue.find(item => item.label === section.label && item.title === section.title)!
    assert.ok(selected)
    const pages = [await f.read({ ...f.input, section: selected.index, revision: f.revision })]
    assert.ok(pages[0].pageCount > 1)
    for (let page = 1; page < pages[0].pageCount; page++) pages.push(await f.read({ ...f.input, section: selected.index, page, revision: f.revision }))
    assert.equal(pages.map(page => page.sourceText).join(""), section.text, "source pages concatenate without truncation, duplication or synthetic fences")
    for (const page of pages) {
      assert.ok(page.sourceText.length <= 9_001)
      assert.ok(page.sections.length <= 32)
      assert.equal(f.validateOutput(page), true)
      const output = JSON.stringify(page)
      for (const secret of ["PRIVATE_STANDING_PROMPT", "private_model", "private_provider", "private_agent", "private_profile", "private_host", "ses_private_watch", "profiles", "publication", "consigne"]) assert.ok(!output.includes(secret), secret)
    }
    if (section.text === f.finalSummary) {
      assert.equal(pages[0].sourceText.length, 8_999, "do not split an astral character at a page boundary")
      assert.equal(pages[0].markdownText, pages[0].sourceText + "\n```\n")
      assert.equal(pages[1].sourceText.length, 9_001, "the next exact page retains the entire astral character")
      assert.equal(pages[1].markdownText, "```ts\n" + pages[1].sourceText + "\n```\n")
      assert.equal(pages[2].markdownText, "```ts\n" + pages[2].sourceText)
    }
  }
  for (const item of catalogue.filter(item => ["next", "artifact", "objective", "notes"].includes(item.label))) {
    const page = await f.read({ ...f.input, section: item.index })
    assert.ok(page.sourceText.length > 0)
    assert.equal(item.raw, item.label === "artifact")
  }
  for (const invalid of [
    { ...first, prompt: "private" }, { ...first, model: "private" }, { ...first, config: f.archived.config },
    { ...first, sourceText: "x".repeat(9_002) }, { ...first, sections: Array(33).fill(first.sections[0]) },
  ]) assert.equal(f.validateOutput(invalid), false, "standard strict JSON Schema rejects private/oversized output")
  assert.ok(f.scans.some(scan => scan.after !== undefined), "real >100-event journal scan is paginated")
  assert.deepEqual([...f.values], initial, "refresh/read never changes native storage")
  f.assertReadOnly()
})

test("native reader rejects selected-page errors and pending/unarchived/foreign/corrupt binding without fallback", async t => {
  const f = await fixture()
  for (const selected of [
    { ...f.input, section: 8_399 }, { ...f.input, page: 63 }, { ...f.input, revision: f.revision + 1 },
    { ...f.input, scheduleID: "foreign_schedule" }, { ...f.input, passageID: "rcp_unarchived" },
  ]) { f.restore(); await assert.rejects(f.read(selected)); f.assertReadOnly(selected.scheduleID) }
  for (const raw of [{ ...f.input, section: -1 }, { ...f.input, page: 64 }, { ...f.input, revision: 0 },
    { ...f.input, missionID: "msn_selector" }, { ...f.input, sessionID: "ses_selector" }]) {
    f.restore(); await assert.rejects(f.direct(raw)); f.assertReadOnly()
  }
  const cases: Array<[string, (doc: RecurrenceDocument) => void]> = [
    ["pending admission is not an archive", () => f.setDocument(f.pending)],
    ["accepted pending admission is still not an archive", () => {
      const doc = structuredClone(f.pending)
      doc.pending!.admission = { kind: "accepted", passageID: f.input.passageID, messageID: doc.pending!.passage.messageID,
        missionID: (f.archived.history[0].result as { missionID: string }).missionID, conversationID: "ses_coordinator" }
      f.setDocument(doc)
    }],
    ["unarchived passage", doc => { doc.history = []; doc.settledCount = 0; f.setDocument(doc) }],
    ["rejected-before-effect has no readable result", doc => {
      const passage = doc.history[0].passage
      Object.assign(doc.history[0].result, { kind: "rejected-before-effect", passageID: passage.id, messageID: passage.messageID, effect: "none", proofID: "proof_no_effect" })
      f.setDocument(doc)
    }],
    ["foreign project", doc => { doc.projectID = "foreign"; f.setDocument(doc) }],
    ["foreign canonical project", doc => { doc.projectCanonical = path.resolve("foreign-project"); f.setDocument(doc) }],
    ["foreign schedule placement", doc => { doc.id = "foreign_schedule"; f.setDocument(doc) }],
    ["foreign owning root", doc => { doc.config.roots = [{ mode: "directory-only", directory: path.resolve("foreign-root") }]; f.setDocument(doc) }],
    ["receipt mission misbinding", doc => { Object.assign(doc.history[0].result, { missionID: "msn_foreign" }); f.setDocument(doc) }],
    ["receipt conversation misbinding", doc => { Object.assign(doc.history[0].result, { conversationID: "ses_foreign" }); f.setDocument(doc) }],
    ["receipt outcome misbinding", doc => { Object.assign(doc.history[0].result, { outcome: "failed" }); f.setDocument(doc) }],
    ...["requestID", "projectCanonical", "projectID", "missionID"].map(field => [`creation ${field} misbinding`, () => {
      const key = [...f.values.keys()].find(key => key.endsWith("/evt_created"))!
      f.values.set(key, { ...(f.values.get(key) as Record<string, MissionJsonValue>), [field]: "foreign_binding" })
    }] as [string, (doc: RecurrenceDocument) => void]),
    ["corrupt journal", () => {
      const key = [...f.values.keys()].find(key => key.endsWith("/evt_reported"))!
      f.values.set(key, { version: 1, type: "corrupt" })
    }],
    ["unterminated journal", () => { for (const key of f.values.keys()) if (key.endsWith("/evt_finished")) f.values.delete(key) }],
    ["ordinary journal is never a substitute", () => {
      for (const [key, value] of [...f.values]) if (key.startsWith(f.prefix)) {
        f.values.delete(key)
        f.values.set(`${MISSION_JOURNAL_STORAGE_PREFIX}/${f.projectToken}/${key.slice(f.prefix.length)}`, value)
      }
    }],
    ["foreign scan placement", () => f.setScanOverride(page => ({ ...page,
      entries: page.entries.map((entry, i) => i === 0 ? { ...entry, key: `foreign/${entry.key}` } : entry) }))],
    ["receipt changes during read", () => {
      let reads = 0
      f.setAfterGet(() => { if (++reads === 1) { const doc = structuredClone(f.archived); Object.assign(doc.history[0].result, { conversationID: "ses_changed" }); f.setDocument(doc) } })
    }],
  ]
  for (const [name, mutate] of cases) await t.test(name, async () => {
    f.restore(); mutate(structuredClone(f.archived))
    const before = structuredClone([...f.values])
    await assert.rejects(f.read(), error => error instanceof Error, name)
    if (name !== "receipt changes during read") assert.deepEqual([...f.values], before, "failures do not repair or write journals")
    f.assertReadOnly()
  })
})

test("authenticated backend GET forwards only exact archive selectors and owned Location, rejecting foreign output and stale fences", async () => {
  const f = await fixture(), app = Fastify({ logger: false }), fence = new WorktreeDeletionFence()
  const sessions = new SessionManager(), session = sessions.createSession("offline-reader")
  app.addHook("preHandler", async (request, reply) => {
    if (!sessions.getSession(parseCookies(request.headers.cookie).codenomad_session)) sendUnauthorized(request, reply)
  })
  const cookie = { cookie: `codenomad_session=${session.id}` }
  let connected = true, owned = true, workspace = { id: "workspace" }, connections = 0
  let override: ((page: Awaited<ReturnType<typeof f.read>>) => unknown) | undefined
  let duringRead: (() => Promise<void> | void) | undefined
  const calls: Array<{ input: ReadInput; options: unknown }> = []
  registerMissionRecurrenceSnapshot(app, { worktreeDeletionFence: fence, workspaceManager: {
    get: () => workspace, getServiceLocation: () => ({ directory: f.directory }),
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    ownsLocation: async (_id: string, location: unknown) => { assert.deepEqual(location, { directory: f.directory }); return owned },
    getSharedServiceConnection: async () => {
      connections++
      return { assertCurrent: () => { if (!connected) throw new Error("Connection changed") }, client: {
        session: f.unexpectedSession,
        location: { get: async ({ location }: { location: unknown }) => { assert.deepEqual(location, { directory: f.directory }); return f.location } },
        plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
        rpc: (definition: unknown) => {
          assert.equal(definition, CODENOMAD_MISSIONS_RPC)
          return { recurrencePassageRead: async (input: ReadInput, options: unknown) => {
            calls.push({ input, options })
            const page = await f.read(input)
            await duringRead?.()
            return override ? override(page) : page
          }, recurrenceSnapshot: () => assert.fail("No snapshot or ordinary Mission reader fallback") }
        },
      } }
    },
  } as never })
  const url = `/api/workspaces/workspace/missions/recurrence/${f.input.scheduleID}/passages/${f.input.passageID}`
  const get = (suffix = "") => app.inject({ method: "GET", url: url + suffix, headers: cookie })
  try {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url, headers: { cookie: "codenomad_session=forged" } })).statusCode, 401)
    assert.equal(connections, 0)
    let response = await get()
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(calls[0].input, { ...f.input, section: 0, page: 0 })
    assert.deepEqual(calls[0].options, { location: { directory: f.directory } })
    const direct = await f.read(), { projectCanonical: _canonical, location: _location, ...publicPage } = direct
    assert.deepEqual(response.json(), publicPage)
    assert.ok(!response.body.includes(f.directory))
    assert.ok(!response.body.includes("PRIVATE_STANDING_PROMPT"))
    response = await get(`?section=1&page=1&revision=${f.revision}`)
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(calls.at(-1)!.input, { ...f.input, section: 1, page: 1, revision: f.revision })
    assert.equal(response.json().sourceText, f.reportSummary.slice(9_000))
    const admitted = connections
    for (const query of ["missionID=msn_foreign", "sessionID=ses_foreign", "mission=msn_foreign", "session=ses_foreign", "directory=foreign", "page=64", "section=-1", "revision=0"]) {
      assert.equal((await get(`?${query}`)).statusCode, 400, query)
    }
    assert.equal(connections, admitted, "invalid selectors are rejected before any upstream read")
    for (const corrupt of [
      { projectID: "foreign" }, { projectCanonical: path.resolve("foreign") }, { location: { directory: path.resolve("foreign") } },
      { scheduleID: "foreign_schedule" }, { passageID: "rcp_foreign" }, { section: 1 }, { page: 1 },
    ]) {
      override = page => ({ ...page, ...corrupt })
      assert.equal((await get()).statusCode, 502, JSON.stringify(corrupt))
    }
    override = page => ({ ...page, revision: page.revision + 1 })
    assert.equal((await get(`?revision=${f.revision}`)).statusCode, 502)
    override = page => ({ ...page, prompt: "PRIVATE" })
    assert.equal((await get()).statusCode, 503)
    override = undefined; owned = false
    assert.equal((await get()).statusCode, 403)
    owned = true
    duringRead = () => { connected = false }
    assert.equal((await get()).statusCode, 503, "connection invalidated while native read was in flight")
    connected = true
    duringRead = () => fence.run(f.directory, [f.directory], async () => {})
    assert.equal((await get()).statusCode, 503, "deletion generation changed while native read was in flight")
    duringRead = () => { workspace = { id: "workspace" } }
    assert.equal((await get()).statusCode, 503, "workspace replacement fences completed reads")
    duringRead = undefined
    assert.equal((await get()).statusCode, 200, "explicit fresh read succeeds without mutation replay")
  } finally { await app.close() }
  f.assertReadOnly()
})
