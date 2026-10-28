import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { fixture, type HistoryFixture } from "./journal-history-fixture"
import { MISSION_INDEX_STALE_AFTER_MS, MissionJournalIndex } from "./journal-index"
import { MISSION_MAX_STORED_EVENTS, type MissionJsonValue } from "./model"
import { setupMissionsPlugin } from "../opencode/missions-plugin"
import { hintsShowWork, retainMissionWork } from "../opencode/missions/lifetime"
import { registerMissionRoutes } from "../server/routes/missions"
import { WorktreeDeletionFence } from "../workspaces/worktree-session-evacuation"

// Finished history that reads of other missions must not pay for: several
// missions' worth of entries, since the event bound is per mission.
const HISTORY_MISSIONS = 200, EVENTS_PER_MISSION = 50, HISTORY = HISTORY_MISSIONS * EVENTS_PER_MISSION
const location = { directory: "/repo" }

/** Bytes as an earlier activation left them: valid finished missions, read by this activation's first build. */
function seedHistory(f: HistoryFixture) {
  for (let m = 0; m < HISTORY_MISSIONS; m++) {
    const missionID = `msn_hist_${String(m).padStart(3, "0")}`
    const base = (id: string, at: number) => ({ version: 1, id, missionID, projectID: "project-1", createdAt: 10 + m * 60 + at })
    const events = [
      { ...base("evt_created", 0), type: "mission.created", projectCanonical: "/repo", objective: `History ${m}`, template: "custom",
        coordinator: { sessionID: `ses_hist_${m}`, title: "Coordinator", location } },
      ...Array.from({ length: EVENTS_PER_MISSION - 2 }, (_, t) => ({ ...base(`evt_task_${t}`, 1 + t), type: "task.created",
        task: { id: `tsk_hist_${m}_${t}`, key: `task-${t}`, title: `Task ${t}`, brief: "Done long ago", role: "specialist", blockedBy: [] } })),
      { ...base("evt_finished", EVENTS_PER_MISSION), type: "mission.finished", outcome: "failed", summary: "Finished long ago" },
    ]
    for (const event of events) f.values.set(`${f.prefix}/${missionID}/${event.id}`, event as unknown as MissionJsonValue)
  }
}

async function liveMission(seed = 1) {
  const f = fixture(seed)
  seedHistory(f)
  const history = await f.journal.snapshot()
  assert.deepEqual([history.discardedEvents, history.missions.length, history.missions.every(mission => mission.status === "failed")], [0, HISTORY_MISSIONS, true])
  const { mission } = await f.control().create({ requestID: "live", objective: "Live work", template: "custom" })
  await f.control().declare(mission.coordinatorSessionId, { missionID: mission.id, taskKey: "work", title: "Work", brief: "Bounded", role: "research", blockedBy: [] })
  // The activation's one build (the creation's own reads went to storage).
  await f.journal.readHints(hints => hints.openIDs())
  const own = (await f.journal.missionEvents(mission.id)).events.length
  return { f, mission, own, pages: Math.ceil((HISTORY + own) / 100) }
}

async function cost<T>(f: HistoryFixture, run: () => Promise<T>) {
  const fullScans = f.fullScans(), entries = f.scannedEntries()
  const value = await run()
  return { value, fullScans: f.fullScans() - fullScans, entries: f.scannedEntries() - entries }
}

test("read-mostly paths read one mission's range, never the finished history", async () => {
  const { f, mission, own } = await liveMission()
  const coordinator = mission.coordinatorSessionId
  const control = f.control()

  const context = await cost(f, () => control.contextFor(coordinator))
  assert.equal(context.value?.coordinator, true)
  assert.match(context.value?.instruction ?? "", /coordinator/i)
  assert.deepEqual([context.fullScans, context.entries <= own], [0, true])
  // A conversation outside every mission (the common per-turn case) reads nothing at all.
  assert.deepEqual(await cost(f, () => control.contextFor("ses_stranger")), { value: undefined, fullScans: 0, entries: 0 })

  for (const input of [{}, { missionID: mission.id }]) {
    const inspected = await cost(f, () => control.inspect(coordinator, input, "read"))
    assert.deepEqual([inspected.value.mission?.id, inspected.fullScans, inspected.entries <= own], [mission.id, 0, true])
    assert.deepEqual(inspected.value.mission, (await f.journal.snapshot()).missions.find(candidate => candidate.id === mission.id))
  }
  const listed = await cost(f, () => control.listMissions(coordinator))
  assert.deepEqual([listed.value.map(entry => entry.missionID), listed.fullScans, listed.entries <= own], [[mission.id], 0, true])

  const outbox = await cost(f, () => control.retryPendingNotifications())
  assert.deepEqual([outbox.value, outbox.fullScans, outbox.entries <= own], [{ attempted: 0, failed: 0 }, 0, true])
  const retained = await cost(f, () => retainMissionWork(() => f.journal.snapshot(), () => f.journal.readHints(hintsShowWork)))
  assert.deepEqual([retained.value, retained.fullScans, retained.entries], [true, 0, 0])
})

test("the panel list reads the open ranges and the selection, never a closed map it was not asked for", async () => {
  const { f, mission, own } = await liveMission(10)
  const control = f.control()
  const listed = await cost(f, () => control.list())
  assert.deepEqual([listed.fullScans, listed.entries <= own], [0, true])
  assert.deepEqual(listed.value.missions.map(value => value.id), [mission.id])
  assert.equal(listed.value.summaries?.length, HISTORY_MISSIONS + 1)
  assert.deepEqual(listed.value.summaries, (await f.journal.snapshot()).missions.map(value => listed.value.summaries!.find(row => row.id === value.id)))
  // Unchanged rows are not resent; a selected closed mission costs its own range.
  const selected = await cost(f, () => control.list({ include: ["msn_hist_007"], summariesVersion: listed.value.summariesVersion }))
  assert.deepEqual([selected.fullScans, selected.entries <= own + EVENTS_PER_MISSION, selected.value.summaries], [0, true, undefined])
  assert.deepEqual(selected.value.missions.map(value => value.id).sort(), [mission.id, "msn_hist_007"].sort())
  const read = await cost(f, () => control.mission("msn_hist_007"))
  assert.deepEqual([read.fullScans, read.entries, read.value.mission?.status], [0, EVENTS_PER_MISSION, "failed"])
})

test("GET /missions over the plugin observes and loads only open and selected missions", async () => {
  const { f, mission, own } = await liveMission(11)
  let handlers: Record<string, (input: unknown) => Promise<unknown>> | undefined
  const registration = () => ({ dispose: async () => {} })
  const dispose = await setupMissionsPlugin({
    location: { directory: "/repo", project: { id: "project-1", canonical: "/repo" } },
    storage: f.storage,
    session: { get: async ({ sessionID }: { sessionID: string }) => f.native.get(sessionID), hook: async () => registration() },
    tool: { transform: async (callback: (draft: unknown) => void) => { callback({ namespace: () => {}, add: () => {} }); return registration() } },
    rpc: { register: async (_definition: unknown, value: typeof handlers) => { handlers = value; return { ...registration(), events: { emit: async () => {} } } } },
  } as never, undefined, undefined, undefined, undefined, false, new MissionJournalIndex())
  const observed: string[] = []
  const client = {
    location: { get: async () => ({ ...location, project: { id: "project-1" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ list: (input: unknown) => handlers!.list(input), mission: (input: unknown) => handlers!.mission(input),
      snapshot: () => { throw new Error("The panel never reads the full snapshot") } }),
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { observed.push(sessionID); return { id: sessionID, projectID: "project-1", location } },
      list: async () => ({ data: [], cursor: { next: null } }), inbox: { list: async () => [] }, active: async () => ({}),
    },
    shell: { list: async () => ({ location, data: [] }) }, form: { list: async () => ({ location, data: [] }) },
    permission: { request: { list: async () => ({ location, data: [] }) } },
  }
  const app = Fastify({ logger: false })
  const workspace = { id: "workspace-1" }
  registerMissionRoutes(app, { workspaceManager: { get: () => workspace, getServiceLocation: () => location,
    getSharedServiceConnection: async () => ({ client, assertCurrent() {} }), ownsLocation: async () => true,
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory } as never, worktreeDeletionFence: new WorktreeDeletionFence() })
  try {
    // The activation's own index builds once, on its first read.
    await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })
    observed.length = 0
    const first = await cost(f, () => app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" }).then(response => response.json()))
    assert.deepEqual([first.fullScans, first.entries <= own, first.value.missions.map((value: { id: string }) => value.id)], [0, true, [mission.id]])
    assert.equal(first.value.summaries.length, HISTORY_MISSIONS + 1)
    assert.deepEqual([...new Set(observed)], [mission.coordinatorSessionId], "activity reads only the open mission's actors")
    observed.length = 0
    const url = `/api/workspaces/workspace-1/missions?include=msn_hist_042&summaries=${first.value.summariesVersion}`
    const selected = await cost(f, () => app.inject({ method: "GET", url }).then(response => response.json()))
    assert.deepEqual([selected.fullScans, selected.entries <= own + EVENTS_PER_MISSION, selected.value.summaries], [0, true, undefined])
    assert.deepEqual(selected.value.activity.missions.map((value: { missionId: string }) => value.missionId).sort(), [mission.id, "msn_hist_042"].sort())
    assert.deepEqual([...new Set(observed)].sort(), [mission.coordinatorSessionId, "ses_hist_42"].sort())
    const one = await cost(f, () => app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions/msn_hist_042" }).then(response => response.json()))
    assert.deepEqual([one.fullScans, one.entries, one.value.mission.id], [0, EVENTS_PER_MISSION, "msn_hist_042"])
  } finally { await app.close(); await dispose() }
})

test("a project far beyond one mission's bound reads, creates, appends, deletes and purges", async () => {
  const { f, mission } = await liveMission(8)
  assert.ok(HISTORY > 4 * MISSION_MAX_STORED_EVENTS)
  await f.control().declare(mission.coordinatorSessionId, { missionID: mission.id, taskKey: "more", title: "More", brief: "Bounded", role: "research", blockedBy: [] })
  const snapshot = await f.journal.snapshot()
  assert.deepEqual([snapshot.discardedEvents, snapshot.missions.length], [0, HISTORY_MISSIONS + 1])
  assert.equal(snapshot.missions.find(candidate => candidate.id === mission.id)?.tasks.length, 2)
  const finished = snapshot.missions.find(candidate => candidate.id === "msn_hist_000")!
  await f.control().delete({ missionID: finished.id, requestID: "delete-history", expectedRevision: finished.revision })
  assert.equal(await f.journal.purgeDeleted({ all: true }), EVENTS_PER_MISSION + 1)
  const after = await f.journal.snapshot()
  assert.deepEqual([after.discardedEvents, after.missions.length, after.missions.some(candidate => candidate.id === finished.id)], [0, HISTORY_MISSIONS, false])
  assert.deepEqual(await f.journal.readHints(hints => hints.openIDs()), [mission.id])
})

test("capacity checks and appends read only their mission's range", async () => {
  const { f, mission, own } = await liveMission(9)
  const checked = await cost(f, () => f.journal.assertCanAppend(mission.id))
  assert.deepEqual([checked.fullScans, checked.entries], [0, own])
  const history = await cost(f, () => f.journal.assertCanAppend("msn_hist_007", 0))
  assert.deepEqual([history.fullScans, history.entries], [0, EVENTS_PER_MISSION])
  const appended = await cost(f, () => f.journal.append({ version: 1, id: "evt_budget", type: "task.dispatched", missionID: mission.id,
    projectID: "project-1", taskKey: "work", createdAt: 90_000 }))
  assert.deepEqual([appended.fullScans, appended.entries], [0, own])
})

test("membership refusals and damage gates read what the hints have not seen", async () => {
  const { f, mission } = await liveMission(2)
  f.native.set("ses_claimed", { id: "ses_claimed", projectID: "project-1", title: "Coordinator", location })
  // Another Location's older build made this session an active coordinator.
  f.tamper(`${f.prefix}/msn_claimed/evt_created`, { version: 1, id: "evt_created", missionID: "msn_claimed", projectID: "project-1",
    createdAt: 90_000, type: "mission.created", projectCanonical: "/repo", objective: "Claimed", template: "custom",
    coordinator: { sessionID: "ses_claimed", title: "Coordinator", location } })
  assert.deepEqual(await f.journal.readHints(hints => hints.refs("ses_claimed")), [], "the hints have not seen it")
  await assert.rejects(f.control().create({ requestID: "attach", objective: "Attach", template: "custom", coordinatorSessionID: "ses_claimed" }), { code: "already-member" })
  await assert.rejects(f.control().inspect("ses_claimed", { start: { objective: "Start", template: "custom" } }, "start"), { code: "already-member" })
  await assert.rejects(f.control().delegate(mission.coordinatorSessionId, { missionID: mission.id, taskKey: "root", title: "Root", brief: "Bounded",
    role: "specialist", blockedBy: [], delivery: "queue", targetSessionID: "ses_claimed" }), { code: "target-claimed" })
  f.tamper(`${f.prefix}/stray`, { damaged: true })
  assert.equal(await f.journal.readHints(hints => hints.aggregate().discardedEvents), 0, "the hints have not seen the damage")
  await assert.rejects(f.control().declare(mission.coordinatorSessionId, { missionID: mission.id, taskKey: "more", title: "More", brief: "Bounded",
    role: "research", blockedBy: [] }), { code: "invalid-journal" })
})

test("presence is released only after a full read confirms the hints' empty answer", async () => {
  const { f, mission, pages } = await liveMission(3)
  await f.control().report(mission.coordinatorSessionId, { missionID: mission.id, outcome: "failed", summary: "Stopped here", evidence: [], next: [], final: true })
  const released = await cost(f, () => retainMissionWork(() => f.journal.snapshot(), () => f.journal.readHints(hintsShowWork)))
  assert.equal(released.value, false)
  assert.ok(released.fullScans >= pages)

  let reads = 0
  const read = async () => { reads++; return f.journal.snapshot() }
  assert.equal(await retainMissionWork(read, async () => true), true)
  assert.equal(reads, 0, "open work in the hints retains without the full read")
  assert.equal(await retainMissionWork(read, async () => { throw new Error("Index unavailable") }), false)
  assert.equal(reads, 1, "a failed hint read falls back to the authoritative one")
})

test("the context hook reads no history and needs one membership read per turn", async () => {
  const { f, mission } = await liveMission(4)
  const specialist = (await f.control().delegate(mission.coordinatorSessionId, { missionID: mission.id, taskKey: "root", title: "Root",
    brief: "Bounded", role: "specialist", blockedBy: [], delivery: "queue" })).mission.actors.find(actor => actor.kind === "specialist")!.sessionId
  const index = new MissionJournalIndex()
  let hook: ((event: { sessionID: string; system: Array<{ type: "text"; text: string }>; tools: Record<string, unknown> }) => Promise<void>) | undefined
  const registration = () => ({ dispose: async () => {} })
  const dispose = await setupMissionsPlugin({
    location: { directory: "/repo", project: { id: "project-1", canonical: "/repo" } },
    storage: f.storage,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => f.native.get(sessionID)
        ?? { id: sessionID, projectID: "project-1", title: "Conversation", location },
      hook: async (_name: "context", callback: typeof hook) => { hook = callback; return registration() },
    },
    tool: { transform: async (callback: (draft: unknown) => void) => { callback({ namespace: () => {}, add: () => {} }); return registration() } },
    rpc: { register: async () => ({ ...registration(), events: { emit: async () => {} } }) },
  } as never, undefined, undefined, undefined, undefined, true, index)
  try {
    const turn = (sessionID: string) => ({ sessionID, system: [] as Array<{ type: "text"; text: string }>,
      tools: { mission_inspect: {}, mission_delegate: {}, mission_report: {} } as Record<string, unknown> })
    // The activation's own index builds once (the outbox's first pass may already have).
    await hook!(turn("ses_warm"))
    const stranger = turn("ses_stranger")
    assert.deepEqual(await cost(f, () => hook!(stranger)).then(({ fullScans, entries }) => [fullScans, entries]), [0, 0])
    assert.deepEqual([stranger.system, Object.keys(stranger.tools)], [[], ["mission_inspect", "mission_delegate", "mission_report"]])
    const coordinator = turn(mission.coordinatorSessionId)
    const own = (await f.journal.missionEvents(mission.id)).events.length
    const read = await cost(f, () => hook!(coordinator))
    assert.deepEqual([read.fullScans, read.entries <= own], [0, true])
    assert.equal(coordinator.system.length, 1)
    assert.ok(coordinator.tools.mission_delegate, "the coordinator keeps its topology tools")
    const actor = turn(specialist)
    await hook!(actor)
    assert.deepEqual([actor.system.length, Object.keys(actor.tools)], [1, ["mission_inspect", "mission_report"]], "another actor loses them")
  } finally { await dispose() }
})

test("hinted selection keeps the snapshot's choice among several missions naming the session", async () => {
  const { f } = await liveMission(7)
  const coordinator = "ses_returning"
  f.native.set(coordinator, { id: coordinator, projectID: "project-1", title: "Coordinator", location })
  const missions: string[] = []
  for (const requestID of ["older", "newer"]) {
    const { mission } = await f.control().create({ requestID, objective: requestID, template: "custom", coordinatorSessionID: coordinator })
    await f.control().report(coordinator, { missionID: mission.id, outcome: "failed", summary: "Ended", evidence: [], next: [], final: true })
    missions.push(mission.id)
  }
  // Neither is active: the most recently updated one, as the snapshot orders them.
  const expected = (await f.journal.snapshot()).missions.find(mission => mission.actors.some(actor => actor.sessionId === coordinator))!.id
  assert.equal(expected, missions[1])
  assert.equal((await f.control().inspect(coordinator, {}, "read")).mission?.id, expected)
})

test("hinted maps carry the project's damage flags as the snapshot stamps them", async () => {
  const { f, mission } = await liveMission(6)
  f.tamper(`${f.prefix}/stray`, { damaged: true })
  f.advanceIndexClock(MISSION_INDEX_STALE_AFTER_MS)
  const { mission: inspected } = await f.control().inspect(mission.coordinatorSessionId, { missionID: mission.id }, "read")
  assert.deepEqual([inspected?.controlUnavailable, inspected?.notificationUnavailable], [true, true])
  assert.deepEqual(inspected, (await f.journal.snapshot()).missions.find(candidate => candidate.id === mission.id))
})

test("a mission written outside the index's generation reaches the context within the rebuild bound", async () => {
  const { f } = await liveMission(5)
  const control = f.control()
  f.native.set("ses_elsewhere", { id: "ses_elsewhere", projectID: "project-1", title: "Coordinator", location })
  // An older build in another Location: bytes no current journal counted.
  f.tamper(`${f.prefix}/msn_elsewhere/evt_created`, { version: 1, id: "evt_created", missionID: "msn_elsewhere", projectID: "project-1",
    createdAt: 90_000, type: "mission.created", projectCanonical: "/repo", objective: "Elsewhere", template: "custom",
    coordinator: { sessionID: "ses_elsewhere", title: "Coordinator", location } })
  assert.equal(await control.contextFor("ses_elsewhere"), undefined, "a hint, never proof: the miss lasts until the rebuild")
  // Authoritative reads see it at once.
  assert.ok((await f.journal.snapshot()).missions.some(mission => mission.id === "msn_elsewhere"))
  f.advanceIndexClock(MISSION_INDEX_STALE_AFTER_MS)
  assert.equal((await control.contextFor("ses_elsewhere"))?.coordinator, true)
})
