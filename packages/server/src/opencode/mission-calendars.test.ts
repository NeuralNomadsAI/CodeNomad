import assert from "node:assert/strict"
import test from "node:test"
import { MISSION_CALENDAR_CARRIER, MISSION_CALENDAR_CODE } from "../missions/calendar-run"
import type { MissionCalendarAutomation } from "../missions/calendar-automation"
import { MissionCalendarMissing, missionCalendars } from "./mission-calendars"

function fixture() {
  const rows: any[] = [], sessions = new Map<string, any>(), calls: string[] = []
  let next = 0, failCreateAt = Infinity
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { const found = sessions.get(sessionID); if (!found) throw new Error("not found"); return found },
      create: async (input: any) => { calls.push(`session ${input.id}`); sessions.set(input.id, { ...input }); return sessions.get(input.id) },
    },
    experimental: { automation: {
      list: async ({ sessionID }: { sessionID: string }) => rows.filter(row => row.sessionID === sessionID).map(row => ({ ...row })),
      create: async (input: any) => {
        if (++next >= failCreateAt) throw new Error("refused")
        const row = { id: `aut_${next}`, tz: "UTC", status: "active", runCount: 0, ...input }
        rows.push(row); calls.push(`create ${row.id}`); return row
      },
      pause: async ({ automationID }: { automationID: string }) => { rows.find(row => row.id === automationID).status = "paused"; calls.push(`pause ${automationID}`) },
      resume: async ({ automationID }: { automationID: string }) => { rows.find(row => row.id === automationID).status = "active"; calls.push(`resume ${automationID}`) },
      delete: async ({ automationID }: { automationID: string }) => { rows.splice(rows.findIndex(row => row.id === automationID), 1); calls.push(`delete ${automationID}`) },
    } },
  }
  const calendars = missionCalendars(client as never, { directory: "D:\\project" }, "project")
  const rule = (cron: string, calendar: string, objective = "Review"): MissionCalendarAutomation => ({ name: "Sync", trigger: { type: "cron", cron, tz: "UTC" },
    action: { type: "code", code: MISSION_CALENDAR_CODE, args: { calendar, objective, template: "custom", launch: { when: [] }, prepared: "msn_prepared" } } })
  return { rows, sessions, calls, calendars, rule, failCreatesFrom: (value: number) => { failCreateAt = value } }
}

test("a calendar is the Automations that name it in the Location's carrier conversation", async () => {
  const f = fixture()
  await f.calendars.save("cal_sync", [f.rule("0 9 * * *", "cal_sync"), f.rule("0 18 * * *", "cal_sync")])
  assert.match(f.calendars.carrier, /^ses_cn_schedule_calendar_[a-f0-9]{24}$/)
  assert.deepEqual(f.sessions.get(f.calendars.carrier).metadata, { [MISSION_CALENDAR_CARRIER]: { version: 1 } })
  // Somebody else's Automation in the same conversation is not a calendar.
  f.rows.push({ id: "aut_other", name: "Other", sessionID: f.calendars.carrier, tz: "UTC", status: "active", runCount: 0, trigger: { type: "every", every: "1 hour" }, action: { type: "prompt", prompt: "Hello" } })
  f.rows[1].lastRunAt = 50; f.rows[1].state = { last: JSON.stringify({ outcome: "waiting", missionID: "msn_running", status: "active", coordinatorSessionID: "ses_1", history: [{ at: 10, outcome: "completed" }], launches: 24 }) }
  f.rows[0].lastRunAt = 40; f.rows[0].state = { last: JSON.stringify({ outcome: "launched", missionID: "msn_running", status: "active", history: [] }) }
  const [calendar, ...others] = await f.calendars.list()
  assert.equal(others.length, 0)
  assert.deepEqual([calendar!.id, calendar!.title, calendar!.paused, calendar!.rules.map(rule => rule.automationID)], ["cal_sync", "Sync", false, ["aut_1", "aut_2"]])
  assert.deepEqual([calendar!.mission, calendar!.launch, calendar!.missionID], [{ objective: "Review", template: "custom" }, { when: [] }, "msn_running"])
  assert.deepEqual(calendar!.last, { outcome: "waiting", missionID: "msn_running", status: "active", coordinatorSessionID: "ses_1",
    history: [{ at: 10, outcome: "completed" }], launches: 24, at: 50 }, "the latest run of any rule")
})

test("saving again replaces the rules under the same identity, and a paused calendar stays paused", async () => {
  const f = fixture()
  await f.calendars.save("cal_sync", [f.rule("0 9 * * *", "cal_sync")])
  await f.calendars.pause("cal_sync")
  await f.calendars.save("cal_sync", [f.rule("0 10 * * *", "cal_sync", "Review again")])
  const [calendar] = await f.calendars.list()
  assert.deepEqual([calendar!.id, calendar!.paused, calendar!.mission.objective, calendar!.rules.map(rule => rule.automationID)], ["cal_sync", true, "Review again", ["aut_2"]])
  assert.equal(calendar!.missionID, "msn_prepared", "before the first launch, the prepared Mission")
  await f.calendars.resume("cal_sync")
  assert.equal((await f.calendars.list())[0]!.paused, false)
  await f.calendars.delete("cal_sync")
  assert.deepEqual(await f.calendars.list(), [])
  await assert.rejects(f.calendars.pause("cal_sync"), MissionCalendarMissing)
})

test("a refused rule leaves the calendar as it was", async () => {
  const f = fixture()
  await f.calendars.save("cal_sync", [f.rule("0 9 * * *", "cal_sync")])
  f.failCreatesFrom(3)
  await assert.rejects(f.calendars.save("cal_sync", [f.rule("0 10 * * *", "cal_sync"), f.rule("bad", "cal_sync")]), /refused/)
  assert.deepEqual((await f.calendars.list())[0]!.rules.map(rule => rule.automationID), ["aut_1"])
})
