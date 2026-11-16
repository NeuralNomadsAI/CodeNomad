import assert from "node:assert/strict"
import test from "node:test"
import { filterMissionPickerEntries, missionMark, scheduleMark, unifiedScheduleMark, type MissionPickerEntry } from "./mission-picker-model"
import type { RecurrenceSchedule } from "../stores/mission-recurrence"
import type { UnifiedMissionSchedule } from "../stores/mission-schedules"

const entry = (key: string, mark: MissionPickerEntry["mark"] = "idle", title = key): MissionPickerEntry => ({ key, title, status: "", mark })

test("a mission's mark: an answer first, then resumable stops, observed work, and unseen completion", () => {
  const unseen = { openRequests: 0, seen: false }, seen = { openRequests: 0, seen: true }
  assert.equal(missionMark({ status: "active" }, { ...seen, openRequests: 1 }), "permission")
  assert.equal(missionMark({ status: "failed" }, { ...seen, openRequests: 1, actorStates: ["form"] }), "permission")
  // Activity states cover whole families: without a question its flag carries, never red.
  assert.equal(missionMark({ status: "active" }, { ...seen, actorStates: ["permission"], coordinatorState: "form" }), "idle")
  assert.equal(missionMark({ status: "failed" }, seen), "interrupted", "a failed mission can be resumed")
  assert.equal(missionMark({ status: "failed", runState: "stopped" }, seen), "idle", "unless the user stopped it since")
  assert.equal(missionMark({ status: "completed" }, unseen), "done")
  assert.equal(missionMark({ status: "completed" }, seen), "idle")
  assert.equal(missionMark({ status: "stopped" }, unseen), "idle")
  assert.equal(missionMark({ status: "active", runState: "paused" }, { ...seen, actorStates: ["running"] }), "paused")
  assert.equal(missionMark({ status: "active", runState: "prepared" }, seen), "prepared", "ready to start, like a composed prompt")
  assert.equal(missionMark({ status: "active" }, { ...seen, actorStates: ["idle-without-report", "queued"],
    coordinatorState: "idle-without-report" }), "working", "running work outranks the idle coordinator")
  assert.equal(missionMark({ status: "active" }, { ...seen, actorStates: ["idle-without-report"], coordinatorState: "idle-without-report" }), "interrupted")
  assert.equal(missionMark({ status: "active" }, { ...seen, actorStates: ["unknown"], coordinatorState: "unknown" }), "idle")
})

test("schedule mark: an answer first, then the schedule's state, the live passage and a retryable failure", () => {
  const schedule = (state: RecurrenceSchedule["state"], pending: { status: NonNullable<RecurrenceSchedule["pending"]>["status"] } | null,
    outcome?: NonNullable<RecurrenceSchedule["latestResult"]>["outcome"]): RecurrenceSchedule =>
    ({ id: "daily", revision: 1, title: "Daily", clock: { time: "09:00", zone: "UTC" }, history: [], actions: [],
      state, pending: pending ? { ...pending, passageID: "pending" } : null,
      latestResult: outcome ? { outcome, passageID: "last", dueAt: 1, settledAt: 2 } : null, controls: [], nextDueAt: Date.now() + 60_000 })
  assert.equal(scheduleMark(schedule("running", { status: "running" }), 1), "permission")
  assert.equal(scheduleMark(schedule("running", { status: "running" }, "failed")), "working")
  assert.equal(scheduleMark(schedule("running", { status: "uncertain" })), "unconfirmed")
  assert.equal(scheduleMark(schedule("running", null, "failed")), "interrupted", "Run now retries a failed run")
  assert.equal(scheduleMark(schedule("interrupted", null, "completed")), "interrupted")
  assert.equal(scheduleMark(schedule("paused", null, "completed")), "paused")
  assert.equal(scheduleMark(schedule("paused", null, "failed")), "paused", "a pause is the user's own choice")
  assert.equal(scheduleMark(schedule("stopped", null, "failed")), "idle", "a stopped schedule offers nothing to continue")
  assert.equal(scheduleMark(schedule("running", null, "completed")), "waiting")
  assert.equal(scheduleMark(schedule("running", null, "ended-without-report")), "waiting",
    "an archived reportless passage does not interrupt the positively running daily scheduler")
  assert.equal(scheduleMark(schedule("running", null, "completed"), 0, false), "done")
  assert.equal(scheduleMark(schedule("running", null, "completed"), 0, false, false), "unconfirmed")
  assert.equal(scheduleMark({ ...schedule("running", null), nextDueAt: null }), "unconfirmed")
  assert.equal(scheduleMark({ ...schedule("running", null), nextDueAt: 5 }, 0, true, true, 10), "unconfirmed")
  assert.equal(scheduleMark({ ...schedule("running", null), lastError: { code: "wake-failed", at: 1 } }), "unconfirmed")
})

test("unified documents share daily priorities and require current positive calendar observation", () => {
  const doc = { state: "running", firstPlayedAt: 1, timeGeneration: 3, blockReason: null, control: null, pendingPassage: null,
    latestResult: null, observation: { state: "known", nativeStatus: "active", timeGeneration: 3, nextDueAt: 100 } } as UnifiedMissionSchedule
  const mark = (patch: Partial<UnifiedMissionSchedule> = {}, seen = true, requests = 0, fresh = true) =>
    unifiedScheduleMark({ ...doc, ...patch }, requests, seen, fresh, 50)
  assert.equal(mark(), "waiting")
  assert.equal(mark({ observation: { ...doc.observation, state: "unknown" } }), "unconfirmed")
  assert.equal(mark({ observation: { ...doc.observation, timeGeneration: 2 } }), "unconfirmed")
  assert.equal(mark({ observation: { ...doc.observation, nativeStatus: "paused", nextDueAt: null } }), "unconfirmed")
  assert.equal(mark({ observation: { ...doc.observation, nextDueAt: 40 } }), "unconfirmed")
  assert.equal(mark({}, true, 0, false), "unconfirmed")
  assert.equal(mark({ blockReason: "unknown" }), "unconfirmed")
  assert.equal(mark({ blockReason: "failed" }, false), "interrupted")
  const pendingPassage = { id: "passage" } as NonNullable<UnifiedMissionSchedule["pendingPassage"]>
  assert.equal(mark({ pendingPassage }), "working")
  assert.equal(mark({ pendingPassage, state: "paused" }), "paused")
  assert.equal(mark({ pendingPassage, state: "paused" }, false, 1), "permission")
  assert.equal(mark({ state: "paused", firstPlayedAt: null, observation: { ...doc.observation, state: "unarmed" } }), "prepared")
  const latestResult = { id: "A", outcome: "completed" } as NonNullable<UnifiedMissionSchedule["latestResult"]>
  assert.equal(mark({ latestResult }, false), "done")
  assert.equal(mark({ latestResult }), "waiting")
  assert.equal(mark({ state: "finished", latestResult }, false), "done")
  assert.equal(mark({ state: "finished", latestResult }), "idle")
  assert.equal(mark({ state: "stopped", latestResult }, false), "idle")
})

test("filter matches titles case-insensitively", () => {
  const entries = [entry("mission:a", undefined, "Release Notes"), entry("mission:b", undefined, "Bug hunt")]
  assert.deepEqual(filterMissionPickerEntries(entries, " notes ").map(item => item.key), ["mission:a"])
  assert.equal(filterMissionPickerEntries(entries, "").length, 2)
})
