import assert from "node:assert/strict"
import { test } from "node:test"
import { MissionControl } from "./control"
import { MISSION_BRIEFING_RESPONSES_MAX, parseMissionBriefing, parseMissionBriefingInput, type MissionBriefingInput } from "./briefing"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { reduceMissionEvents, type MissionEvent, type MissionJsonValue } from "./model"
import type { NativeMissionSession } from "./control-types"

function harness() {
  const entries = new Map<string, MissionJsonValue>()
  const sessions = new Map<string, NativeMissionSession>([["ses_coordinator", { id: "ses_coordinator", projectID: "project",
    title: "Coordinator", location: { directory: "/repo" } }]])
  const storage: MissionStorage = { get: async key => entries.get(key), set: async (key, value) => { entries.set(key, structuredClone(value)) },
    scan: async ({ prefix }) => ({ entries: [...entries].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) }
  let now = 100, sends = 0, active = true
  const control = new MissionControl({ project: { id: "project", canonical: "/repo", location: { directory: "/repo" } }, storage,
    now: () => now++, isActive: () => active, sessions: {
      get: async ({ sessionID }) => { const value = sessions.get(sessionID); if (!value) throw new Error("missing"); return value },
      create: async () => { throw new Error("No creation in a briefing") },
      prompt: async () => { sends++ }, synthetic: async () => { sends++ },
    } })
  return { control, entries, sessions, storage, sends: () => sends, deactivate: () => { active = false } }
}
const content = (revision = 1, patch: Partial<MissionBriefingInput> = {}): MissionBriefingInput => ({ requestID: "request-one", basedOnRevision: revision,
  summary: "Android and iOS are not compiled yet.", achieved: [], ongoing: [], obstacles: [],
  next: [{ text: "Resolve the toolchain prerequisites.", taskKeys: [] }], ...patch })
const start = (f: ReturnType<typeof harness>, prepared = false) => f.control.create({ requestID: "create", objective: "Deliver Android and iOS",
  template: "custom", coordinatorSessionID: "ses_coordinator", prepared })

test("briefings survive journal reconstruction without settling tasks, finalizing or waking sessions", async () => {
  const f = harness(), created = (await start(f)).mission
  const declared = await f.control.declare("ses_coordinator", { taskKey: "xcode", title: "Prepare Xcode", brief: "Read-only toolchain inventory",
    role: "specialist", blockedBy: [] })
  const input = content(declared.mission.revision, { next: [{ text: "Validate Xcode before compiling.", taskKeys: ["xcode"] }] })
  const saved = (await f.control.briefing("ses_coordinator", input)).mission
  assert.equal(saved.status, "active")
  assert.equal(saved.summary, undefined)
  assert.equal(saved.tasks[0].status, "ready")
  assert.equal(saved.tasks[0].report, undefined)
  assert.deepEqual(saved.reports, [])
  assert.equal(saved.briefing?.basedOnUpdatedAt, declared.mission.updatedAt)
  assert.equal(saved.briefing?.basedOnRevision, declared.mission.revision)
  assert.equal(saved.briefing?.requestID, input.requestID)
  assert.equal(f.sends(), 0)
  const rebuilt = (await new MissionJournal(f.storage, "project", "/repo").snapshot()).missions[0]
  assert.deepEqual(rebuilt.briefing, saved.briefing)
  assert.equal(created.coordinatorSessionId, saved.coordinatorSessionId)
})

test("exact briefing replay is idempotent but another payload or stale revision is rejected", async () => {
  const f = harness(); await start(f)
  const first = await f.control.briefing("ses_coordinator", content())
  const replay = await f.control.briefing("ses_coordinator", content())
  assert.deepEqual(replay, first)
  await assert.rejects(f.control.briefing("ses_coordinator", content(1, { summary: "Another claim" })), { code: "request-conflict" })
  await assert.rejects(f.control.briefing("ses_coordinator", content(1, { requestID: "new-request" })), { code: "revision-conflict" })
  assert.equal(f.entries.size, 2)
})

test("unrequested auto:<revision> briefings advance per revision without disturbing explicit UI requests", async () => {
  const f = harness(); await start(f)
  const auto = (revision: number, summary: string) => content(revision, { requestID: `auto:${revision}`, summary })
  const first = (await f.control.briefing("ses_coordinator", auto(1, "The plan is ready."))).mission
  assert.equal(first.briefing?.requestID, "auto:1")
  assert.deepEqual(await f.control.briefing("ses_coordinator", auto(1, "The plan is ready.")), { mission: first })
  await assert.rejects(f.control.briefing("ses_coordinator", auto(1, "Another claim")), { code: "request-conflict" })
  await assert.rejects(f.control.briefing("ses_coordinator", auto(first.revision - 1, "Late")), { code: "request-conflict" })
  const next = (await f.control.briefing("ses_coordinator", auto(first.revision, "Still on track."))).mission
  assert.equal(next.briefing?.requestID, `auto:${first.revision}`)
  const requested = (await f.control.briefing("ses_coordinator", content(next.revision, { requestID: "ui-request-7" }))).mission
  assert.equal(requested.briefing?.requestID, "ui-request-7")
  await assert.rejects(f.control.briefing("ses_coordinator", auto(next.revision - 1, "Stale")), { code: "request-conflict" })
  await assert.rejects(f.control.briefing("ses_coordinator", auto(next.revision, "Stale")), { code: "revision-conflict" })
  assert.equal(f.sends(), 0)
})

test("a requested briefing superseded by automatic milestones keeps its exact identity within a bounded window", async () => {
  const f = harness(); await start(f)
  const requested = (await f.control.briefing("ses_coordinator", content(1, { requestID: "ui-request-1" }))).mission
  const milestone = (await f.control.briefing("ses_coordinator", content(requested.revision, { requestID: `auto:${requested.revision}` }))).mission
  assert.equal(milestone.briefing?.requestID, `auto:${requested.revision}`)
  assert.deepEqual(milestone.briefingResponses, [{ requestID: "ui-request-1", briefingID: requested.briefing!.id },
    { requestID: `auto:${requested.revision}`, briefingID: milestone.briefing!.id }])
  const rebuilt = (await new MissionJournal(f.storage, "project", "/repo").snapshot()).missions[0]
  assert.deepEqual(rebuilt.briefingResponses, milestone.briefingResponses)
  let latest = milestone
  for (let i = 0; i < MISSION_BRIEFING_RESPONSES_MAX - 1; i++)
    latest = (await f.control.briefing("ses_coordinator", content(latest.revision, { requestID: `auto:${latest.revision}` }))).mission
  assert.equal(latest.briefingResponses?.length, MISSION_BRIEFING_RESPONSES_MAX)
  assert.ok(!latest.briefingResponses!.some(item => item.requestID === "ui-request-1"), "only a bounded recent window is retained")
  assert.equal(f.sends(), 0)
})

test("briefing publication preserves coordinator, current location, lifecycle, source and damaged-storage gates", async () => {
  const f = harness(), created = (await start(f)).mission
  f.sessions.set("ses_foreign", { id: "ses_foreign", projectID: "project", location: { directory: "/repo" } })
  await assert.rejects(f.control.briefing("ses_foreign", content()), { code: "mission-not-found" })
  await assert.rejects(f.control.briefing("ses_coordinator", content(1, { achieved: [{ text: "Not a proof", taskKeys: ["missing"] }] })), { code: "invalid-report-contract" })
  f.sessions.get("ses_coordinator")!.location.directory = "/moved"
  await assert.rejects(f.control.briefing("ses_coordinator", content()), { code: "foreign-session" })
  f.sessions.get("ses_coordinator")!.location.directory = "/repo"
  // No native control transport is installed in this unit harness: saved Pause
  // intent still fences the readout, independently of its missing native ACK.
  await assert.rejects(f.control.lifecycle({ missionID: created.id, requestID: "pause", expectedRevision: 1, action: "pause" }), { code: "control-pending" })
  await assert.rejects(f.control.briefing("ses_coordinator", content((await f.control.snapshot()).missions[0].revision)), { code: "mission-not-running" })
  const prepared = harness(); await start(prepared, true)
  await assert.rejects(prepared.control.briefing("ses_coordinator", content()), { code: "mission-not-running" })
  const damaged = harness(); await start(damaged)
  const key = [...damaged.entries.keys()][0].replace(/\/[^/]+$/, "/evt_damaged")
  damaged.entries.set(key, { type: "broken" })
  await assert.rejects(damaged.control.briefing("ses_coordinator", content()), { code: "invalid-journal" })
  const inactive = harness(); await start(inactive); inactive.deactivate()
  await assert.rejects(inactive.control.briefing("ses_coordinator", content()), /no longer available/)
})

test("bounded JSON briefing parsing rejects malformed content rather than coercing claims", () => {
  for (const patch of [{ basedOnRevision: "1" }, { basedOnRevision: 0 }, { summary: " " }, { summary: "x".repeat(1201) },
    { next: [{ text: "x", taskKeys: ["same", "same"] }] }, { achieved: Array(4).fill({ text: "x", taskKeys: [] }) },
    { obstacles: [{ text: "x", taskKeys: [false] }] }]) assert.throws(() => parseMissionBriefingInput({ ...content(), ...patch }))
  assert.equal(parseMissionBriefing({ ...content(), id: "evt_valid", basedOnUpdatedAt: 100, createdAt: 100 }), undefined)
})

test("direct stored events cannot fabricate a foreign, stale or paused briefing", async () => {
  const f = harness(); await start(f)
  const events = (await new MissionJournal(f.storage, "project", "/repo").events()).events
  const base = events[0]
  const event: MissionEvent = { version: 1, projectID: base.projectID, missionID: base.missionID, id: "evt_briefing", createdAt: base.createdAt + 1,
    type: "mission.briefed", actorSessionID: "ses_coordinator", briefing: { ...content(), id: "evt_briefing",
      basedOnUpdatedAt: base.createdAt, createdAt: base.createdAt + 1 } }
  assert.ok(parseMissionEvent(event))
  assert.ok(reduceMissionEvents([...events, event]).missions[0].briefing)
  for (const patch of [{ actorSessionID: "ses_foreign" }, { briefing: { ...event.briefing, basedOnRevision: 2 } },
    { briefing: { ...event.briefing, basedOnUpdatedAt: 0 } }, { briefing: { ...event.briefing, next: [{ text: "Missing source", taskKeys: ["not-declared"] }] } }]) {
    const reduced = reduceMissionEvents([...events, { ...event, ...patch }])
    assert.equal(reduced.missions[0].briefing, undefined)
    assert.equal(reduced.missions[0].briefingResponses, undefined, "a discarded briefing answers no request")
    assert.equal(reduced.discardedEvents, 1)
  }
  assert.equal(reduceMissionEvents([{ ...events[0], prepared: true } as MissionEvent, event]).missions[0].briefing, undefined)
})
