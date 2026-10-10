import assert from "node:assert/strict"
import test from "node:test"
import { filterMissionPickerEntries, missionEntryAttention, missionPickerAttention, missionPickerAttentionLabel,
  scheduleEntryAttention, type MissionPickerEntry } from "./mission-picker-model"

const entry = (key: string, attention?: MissionPickerEntry["attention"], title = key): MissionPickerEntry =>
  ({ key, title, status: "", mark: attention ?? "running", attention })

test("chevron attention ignores the selected entry and keeps the most urgent state", () => {
  const entries = [entry("mission:a", "permission"), entry("mission:b", "working"), entry("schedule:c", "failed"), entry("mission:d", "working")]
  assert.deepEqual(missionPickerAttention(entries, "mission:a"), { kind: "failed", counts: { permission: 0, failed: 1, working: 2 } })
  assert.equal(missionPickerAttention(entries).kind, "permission")
  assert.equal(missionPickerAttention([entry("mission:a")]).kind, undefined)
})

test("attention label counts each state in urgency order", () => {
  const t = (key: string, params?: Record<string, string>) => `${key}:${params?.count}`
  assert.equal(missionPickerAttentionLabel(t, { permission: 1, failed: 0, working: 2 }),
    "missionsPanel.attention.permission.one:1, missionsPanel.attention.working.other:2")
})

test("mission attention: requests, then failure, then observed work of a running mission", () => {
  assert.equal(missionEntryAttention({ status: "active" }, 1), "permission")
  assert.equal(missionEntryAttention({ status: "active" }, 0, ["form"]), "permission")
  assert.equal(missionEntryAttention({ status: "failed" }, 0), "failed")
  assert.equal(missionEntryAttention({ status: "active", runState: "running" }, 0, ["idle-without-report", "queued"]), "working")
  assert.equal(missionEntryAttention({ status: "active", runState: "paused" }, 0, ["running"]), undefined)
  assert.equal(missionEntryAttention({ status: "active" }, 0, ["unknown"]), undefined)
})

test("schedule attention follows the live passage, otherwise a failed latest result", () => {
  assert.equal(scheduleEntryAttention({ pending: { status: "running" }, latestResult: { outcome: "failed" } }), "working")
  assert.equal(scheduleEntryAttention({ pending: { status: "uncertain" }, latestResult: null }), undefined)
  assert.equal(scheduleEntryAttention({ pending: null, latestResult: { outcome: "failed" } }), "failed")
  assert.equal(scheduleEntryAttention({ pending: null, latestResult: { outcome: "completed" } }), undefined)
})

test("filter matches titles case-insensitively", () => {
  const entries = [entry("mission:a", undefined, "Release Notes"), entry("mission:b", undefined, "Bug hunt")]
  assert.deepEqual(filterMissionPickerEntries(entries, " notes ").map(item => item.key), ["mission:a"])
  assert.equal(filterMissionPickerEntries(entries, "").length, 2)
})
