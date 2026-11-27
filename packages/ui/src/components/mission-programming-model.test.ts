import assert from "node:assert/strict"
import test from "node:test"
import type { MissionCalendarView } from "../../../server/src/opencode/mission-calendars"
import { missionProgramming, missionProgrammingSuccessor } from "./mission-programming-model"

const t = (key: string) => key.replace(/^missions\.(scheduling|scheduleList)\.|^missionsPanel\./, "")
const calendar = (extra: Partial<MissionCalendarView> = {}): MissionCalendarView => ({ id: "cal_review", title: "Review", paused: false, mission: {},
  launch: { when: [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }] },
  rules: [{ automationID: "aut_1", trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, tz: "UTC", runCount: 3, nextDueAt: Date.UTC(2026, 10, 28, 9) }], ...extra })

test("a programming shows its criteria, its next wake and its past launches, newest first", () => {
  const shown = missionProgramming(calendar({ last: { outcome: "launched", at: 3, launches: 4, missionID: "msn_4",
    history: [{ at: Date.UTC(2026, 10, 25, 9), outcome: "completed" }, { at: Date.UTC(2026, 10, 26, 9), outcome: "failed" }, { at: Date.UTC(2026, 10, 27, 9), outcome: "removed" }] } }), t, "en-GB")
  assert.deepEqual([shown.criteria, shown.state, shown.nextLabel, shown.next, shown.launches],
    ["shortcut.daily · 09:00 · UTC", "state.running", "nextWake", "28 Nov 2026, 09:00", 4])
  assert.deepEqual(shown.runs, ["27 Nov 2026, 09:00 · run.stopped", "26 Nov 2026, 09:00 · run.failed", "25 Nov 2026, 09:00 · run.completed"])
  assert.deepEqual(shown.row, ["shortcut.daily · 09:00 · UTC", "nextWake · 28 Nov 2026, 09:00"])
})

test("events alone are checked, and a paused programming has no next wake", () => {
  const events = calendar({ launch: { when: [{ kind: "files-changed", paths: ["a.ts"] }] },
    rules: [{ automationID: "aut_1", trigger: { type: "every", every: "15 minutes" }, tz: "UTC", runCount: 0, nextDueAt: Date.UTC(2026, 10, 28, 9) }] })
  assert.deepEqual([missionProgramming(events, t, "en-GB").nextLabel, missionProgramming(events, t, "en-GB").launches], ["nextCheck", 0])
  const paused = missionProgramming(calendar({ paused: true }), t, "en-GB")
  assert.deepEqual([paused.state, paused.next, paused.row[1]], ["state.paused", "none", "state.paused"])
  assert.equal(missionProgramming(calendar({ launch: undefined }), t, "en-GB").criteria, "")
})

test("the selection follows a programmed Mission to the launch that replaced it", () => {
  const before = [{ id: "cal_a", missionID: "msn_1" }, { id: "cal_b", missionID: "msn_9" }]
  assert.equal(missionProgrammingSuccessor(before, [{ id: "cal_a", missionID: "msn_2" }, { id: "cal_b", missionID: "msn_9" }], "msn_1"), "msn_2")
  assert.equal(missionProgrammingSuccessor(before, before, "msn_1"), undefined)
  assert.equal(missionProgrammingSuccessor(before, [{ id: "cal_b", missionID: "msn_9" }], "msn_1"), undefined, "a deleted programming leads nowhere")
  assert.equal(missionProgrammingSuccessor(before, [{ id: "cal_a", missionID: "msn_2" }], "msn_other"), undefined, "an ordinary Mission is left alone")
})
