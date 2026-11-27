import assert from "node:assert/strict"
import test from "node:test"
import { missionCalendarEventsSchema, missionCalendarOccurrence, runMissionCalendar, type MissionCalendarControl, type MissionCalendarNews } from "./calendar-run"
import type { MissionJsonValue } from "./model"

type Fake = { id: string; status: "active" | "completed" | "failed"; runState: "prepared" | "running"; revision: number; coordinatorSessionId: string
  control?: { requestID: string; expectedRevision: number; action: "start"; pending: string[] } }

function fixture() {
  const missions = new Map<string, Fake>(), values = new Map<string, MissionJsonValue>(), calls: string[] = [], unusable = new Set<string>()
  let failStart = false, failDelete = false, conversations = 0, clock = 1_000
  const control = {
    create: async (input: { requestID: string; prepared?: boolean; coordinatorSessionID?: string }) => {
      calls.push(`create ${input.requestID} ${input.coordinatorSessionID ?? "new"}`)
      assert.equal(input.prepared, true)
      if (input.coordinatorSessionID && unusable.has(input.coordinatorSessionID)) throw new Error("Coordinator unavailable")
      const id = `msn_${input.requestID}`
      if (!missions.has(id)) missions.set(id, { id, status: "active", runState: "prepared", revision: 1,
        coordinatorSessionId: input.coordinatorSessionID ?? `ses_${++conversations}` })
      return { mission: missions.get(id)!, acknowledgement: "fresh" }
    },
    lifecycle: async (input: { missionID: string; requestID: string; expectedRevision: number }) => {
      calls.push(`start ${input.missionID} ${input.requestID} ${input.expectedRevision}`)
      const mission = missions.get(input.missionID)!
      if (failStart) {
        mission.runState = "running"; mission.revision = 2
        mission.control = { requestID: input.requestID, expectedRevision: input.expectedRevision, action: "start", pending: ["ses_coordinator"] }
        throw new Error("control-pending")
      }
      mission.runState = "running"; mission.revision = 3; delete mission.control
      return { mission }
    },
    mission: async (id: string) => ({ mission: missions.get(id) }),
    delete: async (input: { missionID: string; expectedRevision: number; deleteManagedSessions?: boolean }) => {
      calls.push(`delete ${input.missionID}`)
      assert.deepEqual([input.expectedRevision, input.deleteManagedSessions], [missions.get(input.missionID)!.revision, false])
      if (failDelete) throw new Error("Delete refused")
      missions.delete(input.missionID)
      return { deleted: true }
    },
  } as unknown as MissionCalendarControl
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: MissionJsonValue) => { values.set(key, value) } }
  const run = (number: number, news?: MissionCalendarNews, automationID = "aut_a", mission: Record<string, unknown> = {}, prepared?: string) =>
    runMissionCalendar(control, storage, "key", { automationID, run: number }, { objective: "Review", template: "custom", ...mission }, { news, prepared, now: () => clock += 1_000 })
  const prepare = (id: string, coordinatorSessionId = "ses_prepared") => { missions.set(id, { id, status: "active", runState: "prepared", revision: 1, coordinatorSessionId }) }
  return { missions, calls, run, unusable, prepare, failStarts: (value: boolean) => { failStart = value }, failDeletes: (value: boolean) => { failDelete = value },
    end: (id: string, status: Fake["status"] = "completed") => { missions.get(id)!.status = status } }
}
const launched = (missionID: string, history: unknown[] = [], coordinatorSessionID = "ses_1") => ({ outcome: "launched", missionID, status: "active", coordinatorSessionID, history })

test("an occurrence is an Automation run's message and nothing else", () => {
  assert.deepEqual(missionCalendarOccurrence("msg_aut_01ABCdef_12"), { automationID: "aut_01ABCdef", run: 12 })
  for (const id of ["msg_aut_01ABCdef_0", "msg_aut_01ABCdef_12_send", "msg_01ABCdef_1", "aut_01ABCdef_1", "msg_aut_x-y_1"]) assert.equal(missionCalendarOccurrence(id), undefined)
})

test("a run creates and starts one Mission, and repeating it changes nothing", async () => {
  const f = fixture()
  assert.deepEqual(await f.run(1), launched("msn_calendar_aut_a_1"))
  assert.deepEqual(f.calls, ["create calendar_aut_a_1 new", "start msn_calendar_aut_a_1 calendar-start 1"])
  assert.deepEqual(await f.run(1), launched("msn_calendar_aut_a_1"))
  assert.equal(f.calls.filter(call => call.startsWith("start")).length, 1)
  assert.equal(f.missions.size, 1)
})

test("later runs wait while the launch is active; the next launch replaces it in the same conversation", async () => {
  const f = fixture()
  await f.run(1)
  assert.deepEqual(await f.run(2), { outcome: "waiting", missionID: "msn_calendar_aut_a_1", status: "active", coordinatorSessionID: "ses_1", history: [] })
  f.end("msn_calendar_aut_a_1")
  assert.deepEqual(await f.run(3), launched("msn_calendar_aut_a_3", [{ at: 2_000, outcome: "completed" }]))
  assert.deepEqual([...f.missions.keys()], ["msn_calendar_aut_a_3"], "one Mission at a time: the previous launch is gone")
  assert.equal(f.missions.get("msn_calendar_aut_a_3")!.coordinatorSessionId, "ses_1")
  f.end("msn_calendar_aut_a_3", "failed")
  assert.deepEqual((await f.run(4)).history, [{ at: 2_000, outcome: "completed" }, { at: 3_000, outcome: "failed" }])
})

test("a launch whose start did not finish is started by the next run with its original request", async () => {
  const f = fixture()
  f.failStarts(true)
  await assert.rejects(f.run(1), /control-pending/)
  f.failStarts(false)
  assert.equal((await f.run(2)).outcome, "waiting")
  assert.deepEqual(f.calls.slice(-1), ["start msn_calendar_aut_a_1 calendar-start 1"])
  assert.equal(f.missions.get("msn_calendar_aut_a_1")!.control, undefined)
  assert.equal(f.missions.size, 1)
})

test("events gate the launch, and their news waits for the active launch", async () => {
  const f = fixture()
  let head = "a", reads = 0
  // Like the source readers: the first read only records where the source stands.
  const news: MissionCalendarNews = async previous => {
    reads++
    const old = previous[0]?.value as { oid?: string } | undefined
    return { checkpoints: [{ key: "a".repeat(64), kind: "remote-branch-commits", placementDigest: "b".repeat(64), value: { oid: head } }], changed: !!old && old.oid !== head }
  }
  assert.deepEqual(await f.run(1, news), { outcome: "idle", history: [] })
  assert.equal((await f.run(2, news)).outcome, "idle")
  assert.equal(f.calls.length, 0, "a run without news asks nothing of Missions")
  head = "b"
  assert.equal((await f.run(3, news)).missionID, "msn_calendar_aut_a_3")
  head = "c"
  assert.equal((await f.run(4, news)).outcome, "waiting")
  assert.equal(reads, 3, "an active launch leaves the events unread")
  f.end("msn_calendar_aut_a_3")
  assert.equal((await f.run(5, news)).missionID, "msn_calendar_aut_a_5", "the commit that landed meanwhile launches again")
  f.end("msn_calendar_aut_a_5")
  const asked = f.calls.length
  assert.deepEqual(await f.run(6, news), { outcome: "idle", missionID: "msn_calendar_aut_a_5", status: "completed", coordinatorSessionID: "ses_1", history: [{ at: 2_000, outcome: "completed" }] })
  assert.equal((await f.run(7, news)).outcome, "idle")
  assert.equal(f.calls.length, asked, "an ended launch without news is kept and not asked about again")
  assert.deepEqual([...f.missions.keys()], ["msn_calendar_aut_a_5"])
})

test("the conversation of the first launch is kept, replaced when it can no longer coordinate, and required when named", async () => {
  const f = fixture()
  await f.run(1)
  f.end("msn_calendar_aut_a_1")
  f.unusable.add("ses_1")
  assert.deepEqual(await f.run(2), launched("msn_calendar_aut_a_2", [{ at: 2_000, outcome: "completed" }], "ses_2"))
  f.end("msn_calendar_aut_a_2")
  f.unusable.add("ses_named")
  await assert.rejects(f.run(3, undefined, "aut_a", { coordinatorSessionID: "ses_named" }), /Coordinator unavailable/)
  f.unusable.delete("ses_named")
  assert.equal((await f.run(3, undefined, "aut_a", { coordinatorSessionID: "ses_named" })).coordinatorSessionID, "ses_named")
})

test("a removal that fails never holds the launch and is tried again by the next one", async () => {
  const f = fixture()
  await f.run(1)
  f.end("msn_calendar_aut_a_1")
  f.failDeletes(true)
  assert.equal((await f.run(2)).missionID, "msn_calendar_aut_a_2")
  assert.equal(f.missions.size, 2)
  f.failDeletes(false)
  f.end("msn_calendar_aut_a_2")
  assert.equal((await f.run(3)).missionID, "msn_calendar_aut_a_3")
  assert.deepEqual([...f.missions.keys()], ["msn_calendar_aut_a_3"])
})

test("a launch seen ended that a person resumed is waited for again", async () => {
  const f = fixture()
  let changed = false
  const news: MissionCalendarNews = async () => ({ checkpoints: [], changed })
  changed = true
  await f.run(1, news)
  f.end("msn_calendar_aut_a_1", "failed")
  changed = false
  assert.equal((await f.run(2, news)).status, "failed")
  f.missions.get("msn_calendar_aut_a_1")!.status = "active"
  changed = true
  assert.deepEqual([(await f.run(3, news)).outcome, f.missions.size], ["waiting", 1])
})

test("the Automations of one programmed Mission share its launch, even when due at the same instant", async () => {
  const f = fixture()
  const results = await Promise.all([f.run(1, undefined, "aut_morning"), f.run(1, undefined, "aut_weekly")])
  assert.deepEqual(results.map(result => [result.outcome, result.missionID]), [["launched", "msn_calendar_aut_morning_1"], ["waiting", "msn_calendar_aut_morning_1"]])
  f.end("msn_calendar_aut_morning_1")
  assert.equal((await f.run(2, undefined, "aut_weekly")).missionID, "msn_calendar_aut_weekly_2")
  assert.equal(f.missions.size, 1)
})

test("a programmed Mission waits only for events read from Git and the forges", () => {
  assert.equal(missionCalendarEventsSchema.safeParse([{ kind: "files-changed", paths: ["package.json"] }]).success, true)
  for (const event of [{ kind: "mission-completed", missionID: "msn_other" }, { kind: "conversation-message", conversationID: "ses_other" }])
    assert.equal(missionCalendarEventsSchema.safeParse([event]).success, false)
})

test("the Mission prepared with the programming is what the first launch starts", async () => {
  const f = fixture()
  f.prepare("msn_prepared")
  let changed = false
  const news: MissionCalendarNews = async () => ({ checkpoints: [], changed })
  const run = (number: number) => f.run(number, news, "aut_a", {}, "msn_prepared")
  assert.deepEqual(await run(1), { outcome: "idle", missionID: "msn_prepared", history: [] })
  assert.equal(f.calls.length, 0, "waiting for news asks nothing of Missions")
  changed = true
  assert.deepEqual(await run(2), launched("msn_prepared", [], "ses_prepared"))
  assert.deepEqual(f.calls, ["start msn_prepared calendar-start 1"], "started, not created")
  assert.equal((await run(3)).outcome, "waiting")
  f.end("msn_prepared")
  assert.deepEqual(await run(4), launched("msn_calendar_aut_a_4", [{ at: 3_000, outcome: "completed" }], "ses_prepared"))
  assert.deepEqual([...f.missions.keys()], ["msn_calendar_aut_a_4"])
})

test("a prepared Mission a person started, removed or replaced by an edit is followed", async () => {
  const started = fixture()
  started.prepare("msn_prepared")
  started.missions.get("msn_prepared")!.runState = "running"
  assert.deepEqual([(await started.run(1, undefined, "aut_a", {}, "msn_prepared")).outcome, started.missions.size], ["waiting", 1])
  const removed = fixture()
  assert.equal((await removed.run(1, undefined, "aut_a", {}, "msn_gone")).missionID, "msn_calendar_aut_a_1")
  const edited = fixture()
  edited.prepare("msn_first"); edited.prepare("msn_second")
  const quiet: MissionCalendarNews = async () => ({ checkpoints: [], changed: false })
  assert.equal((await edited.run(1, quiet, "aut_a", {}, "msn_first")).missionID, "msn_first")
  assert.equal((await edited.run(2, quiet, "aut_b", {}, "msn_second")).missionID, "msn_second")
  assert.equal((await edited.run(3, undefined, "aut_b", {}, "msn_second")).missionID, "msn_second")
  assert.deepEqual(edited.calls, ["start msn_second calendar-start 1"])
})