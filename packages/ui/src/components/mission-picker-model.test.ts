import assert from "node:assert/strict"
import test from "node:test"
import { filterMissionPickerEntries, missionMark, missionPickerAttention, missionPickerAttentionLabel,
  scheduleMark, type MissionPickerEntry } from "./mission-picker-model"

const entry = (key: string, mark: MissionPickerEntry["mark"] = "idle", title = key): MissionPickerEntry => ({ key, title, status: "", mark })

test("chevron attention ignores the selected entry, interrupted, paused, prepared and idle entries, and keeps the most urgent state", () => {
  const entries = [entry("mission:a", "permission"), entry("mission:b", "working"), entry("schedule:c", "interrupted"),
    entry("mission:d", "working"), entry("mission:e", "done"), entry("mission:f", "paused"), entry("mission:g", "prepared")]
  assert.deepEqual(missionPickerAttention(entries, "mission:a"), { kind: "working", counts: { permission: 0, working: 2, done: 1 } })
  assert.equal(missionPickerAttention(entries).kind, "permission")
  assert.equal(missionPickerAttention([entry("mission:a", "interrupted"), entry("mission:b", "paused"), entry("mission:c", "prepared")]).kind, undefined,
    "like a collapsed session parent, interrupted entries stay on their own rows")
})

test("attention label counts each state in urgency order", () => {
  const t = (key: string, params?: Record<string, string>) => `${key}:${params?.count}`
  assert.equal(missionPickerAttentionLabel(t, { permission: 1, working: 2, done: 1 }),
    "missionsPanel.attention.permission.one:1, missionsPanel.attention.working.other:2, missionsPanel.attention.done.one:1")
})

test("a mission's mark: an answer first, then resumable stops, observed work, and unseen completion", () => {
  const unseen = { openRequests: 0, seen: false }, seen = { openRequests: 0, seen: true }
  assert.equal(missionMark({ status: "active" }, { ...seen, openRequests: 1 }), "permission")
  assert.equal(missionMark({ status: "failed" }, { ...seen, actorStates: ["form"] }), "permission")
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
  const schedule = (state: string, pending: { status: string } | null, outcome?: string) =>
    ({ state, pending, latestResult: outcome ? { outcome } : null })
  assert.equal(scheduleMark(schedule("running", { status: "running" }), 1), "permission")
  assert.equal(scheduleMark(schedule("running", { status: "running" }, "failed")), "working")
  assert.equal(scheduleMark(schedule("running", { status: "uncertain" })), "idle")
  assert.equal(scheduleMark(schedule("running", null, "failed")), "interrupted", "Run now retries a failed run")
  assert.equal(scheduleMark(schedule("interrupted", null, "completed")), "interrupted")
  assert.equal(scheduleMark(schedule("paused", null, "completed")), "paused")
  assert.equal(scheduleMark(schedule("paused", null, "failed")), "paused", "a pause is the user's own choice")
  assert.equal(scheduleMark(schedule("stopped", null, "failed")), "idle", "a stopped schedule offers nothing to continue")
  assert.equal(scheduleMark(schedule("unavailable", null, "failed")), "idle")
  assert.equal(scheduleMark(schedule("running", null, "completed")), "idle")
})

test("filter matches titles case-insensitively", () => {
  const entries = [entry("mission:a", undefined, "Release Notes"), entry("mission:b", undefined, "Bug hunt")]
  assert.deepEqual(filterMissionPickerEntries(entries, " notes ").map(item => item.key), ["mission:a"])
  assert.equal(filterMissionPickerEntries(entries, "").length, 2)
})
