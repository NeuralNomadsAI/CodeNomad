import assert from "node:assert/strict"
import test from "node:test"
import { missionCalendarEventsSchema, missionCalendarOccurrence, runMissionCalendar, type MissionCalendarControl, type MissionCalendarNews } from "./calendar-run"
import type { MissionJsonValue } from "./model"

type Fake = { id: string; status: "active" | "completed"; runState: "prepared" | "running"; revision: number
  control?: { requestID: string; expectedRevision: number; action: "start"; pending: string[] } }

function fixture() {
  const missions = new Map<string, Fake>(), values = new Map<string, MissionJsonValue>(), calls: string[] = []
  let failStart = false
  const control = {
    create: async (input: { requestID: string; prepared?: boolean }) => {
      calls.push(`create ${input.requestID}`)
      assert.equal(input.prepared, true)
      const id = `msn_${input.requestID}`
      if (!missions.has(id)) missions.set(id, { id, status: "active", runState: "prepared", revision: 1 })
      return { mission: missions.get(id)!, acknowledgement: "fresh" }
    },
    lifecycle: async (input: { missionID: string; requestID: string; expectedRevision: number; action: string }) => {
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
  } as unknown as MissionCalendarControl
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: MissionJsonValue) => { values.set(key, value) } }
  const run = (number: number, news?: MissionCalendarNews, automationID = "aut_a") => runMissionCalendar(control, storage, "key", { automationID, run: number },
    { objective: "Review", template: "custom" }, news)
  return { missions, calls, run, failStarts: (value: boolean) => { failStart = value } }
}

test("an occurrence is an Automation run's message and nothing else", () => {
  assert.deepEqual(missionCalendarOccurrence("msg_aut_01ABCdef_12"), { automationID: "aut_01ABCdef", run: 12 })
  for (const id of ["msg_aut_01ABCdef_0", "msg_aut_01ABCdef_12_send", "msg_01ABCdef_1", "aut_01ABCdef_1", "msg_aut_x-y_1"]) assert.equal(missionCalendarOccurrence(id), undefined)
})

test("a run creates and starts one Mission, and repeating it changes nothing", async () => {
  const f = fixture()
  assert.deepEqual(await f.run(1), { missionID: "msn_calendar_aut_a_1", status: "active" })
  assert.deepEqual(f.calls, ["create calendar_aut_a_1", "start msn_calendar_aut_a_1 calendar-start 1"])
  assert.deepEqual(await f.run(1), { missionID: "msn_calendar_aut_a_1", status: "active" })
  assert.equal(f.calls.filter(call => call.startsWith("start")).length, 1)
  assert.equal(f.missions.size, 1)
})

test("later runs wait while the previous Mission is active and launch again once it ends", async () => {
  const f = fixture()
  await f.run(1)
  assert.deepEqual(await f.run(2), { waiting: "msn_calendar_aut_a_1" })
  assert.equal(f.missions.size, 1)
  f.missions.get("msn_calendar_aut_a_1")!.status = "completed"
  assert.deepEqual(await f.run(3), { missionID: "msn_calendar_aut_a_3", status: "active" })
})

test("a Mission whose start did not finish is started by the next run with its original request", async () => {
  const f = fixture()
  f.failStarts(true)
  await assert.rejects(f.run(1), /control-pending/)
  f.failStarts(false)
  assert.deepEqual(await f.run(2), { waiting: "msn_calendar_aut_a_1" })
  assert.deepEqual(f.calls.slice(-1), ["start msn_calendar_aut_a_1 calendar-start 1"])
  assert.equal(f.missions.get("msn_calendar_aut_a_1")!.control, undefined)
  assert.equal(f.missions.size, 1)
})

test("events gate the launch, and their news waits for the active Mission", async () => {
  const f = fixture()
  let head = "a", reads = 0
  // Like the source readers: the first read only records where the source stands.
  const news: MissionCalendarNews = async previous => {
    reads++
    const old = previous[0]?.value as { oid?: string } | undefined
    return { checkpoints: [{ key: "a".repeat(64), kind: "remote-branch-commits", placementDigest: "b".repeat(64), value: { oid: head } }], changed: !!old && old.oid !== head }
  }
  assert.deepEqual(await f.run(1, news), { idle: true })
  assert.deepEqual(await f.run(2, news), { idle: true })
  assert.equal(f.calls.length, 0, "a run without news asks nothing of Missions")
  head = "b"
  assert.deepEqual(await f.run(3, news), { missionID: "msn_calendar_aut_a_3", status: "active" })
  head = "c"
  assert.deepEqual(await f.run(4, news), { waiting: "msn_calendar_aut_a_3" })
  assert.equal(reads, 3, "an active Mission leaves the events unread")
  f.missions.get("msn_calendar_aut_a_3")!.status = "completed"
  assert.deepEqual(await f.run(5, news), { missionID: "msn_calendar_aut_a_5", status: "active" }, "the commit that landed meanwhile launches the next Mission")
  f.missions.get("msn_calendar_aut_a_5")!.status = "completed"
  assert.deepEqual(await f.run(6, news), { idle: true })
  assert.deepEqual(await f.run(7, news), { idle: true })
  assert.equal(f.calls.filter(call => call.startsWith("create")).length, 2)
})

test("a calendar waits only for events read from Git and the forges", () => {
  assert.equal(missionCalendarEventsSchema.safeParse([{ kind: "files-changed", paths: ["package.json"] }]).success, true)
  for (const event of [{ kind: "mission-completed", missionID: "msn_other" }, { kind: "conversation-message", conversationID: "ses_other" }])
    assert.equal(missionCalendarEventsSchema.safeParse([event]).success, false)
})

test("the Automations of one calendar share its Mission: a second date rule waits for the first one's launch", async () => {
  const f = fixture()
  assert.deepEqual(await f.run(1, undefined, "aut_morning"), { missionID: "msn_calendar_aut_morning_1", status: "active" })
  assert.deepEqual(await f.run(1, undefined, "aut_evening"), { waiting: "msn_calendar_aut_morning_1" }, "the same run number of another Automation is another occurrence")
  f.missions.get("msn_calendar_aut_morning_1")!.status = "completed"
  assert.deepEqual(await f.run(2, undefined, "aut_evening"), { missionID: "msn_calendar_aut_evening_2", status: "active" })
})