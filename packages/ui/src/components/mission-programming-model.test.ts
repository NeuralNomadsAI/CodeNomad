import assert from "node:assert/strict"
import test from "node:test"
import type { MissionCalendarView } from "../../../server/src/opencode/mission-calendars"
import { missionProgramming, missionProgrammingDraft, missionProgrammingSuccessor } from "./mission-programming-model"
import { missionSchedulingPolicy } from "./mission-scheduling-data"

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

test("the creation form reopens a programmed Mission as it was saved", () => {
  const profile = { agent: "build", model: { providerID: "provider", id: "model" } }
  const launch = { when: [{ kind: "cron" as const, expression: "0 9 * * *", zone: "Europe/Paris" }, { kind: "branch-commits" as const, directory: "/service/project", ref: "refs/heads/main" }] }
  const draft = missionProgrammingDraft(calendar({ title: "Daily review", launch, mission: { objective: "Review", notes: "Briefly", template: "debug", taskMode: "independent",
    profiles: { coordinator: profile }, coordinatorSessionID: "ses_review", when: [launch.when[1]] } }), "/ui/project")!
  assert.deepEqual([draft.mode, draft.titleOverride, draft.objective, draft.notes, draft.template, draft.taskMode, draft.coordinatorSessionID, draft.calendarID, draft.zone],
    ["recurring", "Daily review", "Review", "Briefly", "debug", "independent", "ses_review", "cal_review", "Europe/Paris"])
  assert.deepEqual(draft.profiles, { coordinator: profile })
  assert.deepEqual(draft.scheduling!.criteria.map(row => [row.kind, row.time, row.source]), [["daily", "09:00", ""], ["branch-commits", "09:00", "refs/heads/main"]])
  assert.deepEqual(missionSchedulingPolicy(draft.scheduling!, "/ui/project"), launch, "unchanged criteria are saved as they were stored")
  assert.equal(missionProgrammingDraft(calendar({ launch: undefined })), undefined)
})

test("between launches the row waits for its next wake or is paused; a launch keeps its own mark", () => {
  const running = missionProgramming(calendar(), t, "en-GB"), paused = missionProgramming(calendar({ paused: true }), t, "en-GB")
  assert.deepEqual((["idle", "prepared", "permission", "done", "interrupted"] as const).map(mark => running.mark(mark, true)),
    ["waiting", "waiting", "permission", "done", "interrupted"])
  assert.deepEqual((["idle", "prepared", "done"] as const).map(mark => paused.mark(mark, true)), ["paused", "paused", "done"])
  assert.equal(running.mark("idle", false), "idle", "a launch under way is never shown as waiting")
})