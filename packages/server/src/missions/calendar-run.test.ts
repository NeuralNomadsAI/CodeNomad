import assert from "node:assert/strict"
import test from "node:test"
import { missionCalendarOccurrence, runMissionCalendar, type MissionCalendarControl } from "./calendar-run"
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
  const run = (number: number) => runMissionCalendar(control, storage, "key", { automationID: "aut_a", run: number }, { objective: "Review", template: "custom" })
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
