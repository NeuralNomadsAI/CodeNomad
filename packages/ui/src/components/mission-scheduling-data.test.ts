import assert from "node:assert/strict"
import { test } from "node:test"
import { missionLaunchPolicySchema } from "../../../server/src/missions/launch-policy"
import { nextMissionCalendarCron } from "../../../server/src/missions/mission-calendar-plan"
import { missionFrequencies, newMissionSchedulingDraft, missionSchedulingPolicy, previewMissionScheduling, previewSavedMissionScheduling, MissionSchedulingError } from "./mission-scheduling-data"

const now = Date.parse("2026-01-01T00:00:00Z")
const draft = (patch: Partial<ReturnType<typeof newMissionSchedulingDraft>> = {}) => ({ ...newMissionSchedulingDraft("UTC"), ...patch })
test("saved previews preserve interval/delay phases, absolute ends and consumed quotas while showing a late native slot only once", () => {
  const policy = missionSchedulingPolicy(draft({ frequency: "every", amount: "15", endAfter: "2", maxLaunches: "8" }))
  const phase = { firstPlayedAt: now, oneShotAt: null, slotEndsAt: now + 7_200_000, nextDueAt: now + 900_000, launchedCount: 2 }
  const dates = previewSavedMissionScheduling(policy, phase, now + 4_000_000, true)
  assert.deepEqual(dates, [900_000, 4_500_000, 5_400_000, 6_300_000, 7_200_000].map(ms => now + ms))
  assert.deepEqual(previewSavedMissionScheduling({ ...policy, ends: { at: null, afterMs: null, maxLaunches: null } },
    { ...phase, nextDueAt: now + 1_020_000 }, now + 1_080_000, true), [17, 32, 47, 62, 77].map(minutes => now + minutes * 60_000),
    "a replaced interval keeps the current native phase rather than the first Play's phase")
  assert.deepEqual(previewSavedMissionScheduling(policy, { ...phase, nextDueAt: null }, now, true), [], "an unobserved/paused phase is kept unknown")
  assert.deepEqual(previewSavedMissionScheduling(policy, { ...phase, launchedCount: 8 }, now, true), [])
  const delay = missionSchedulingPolicy(draft({ frequency: "in", amount: "2", unit: "hours" }))
  assert.deepEqual(previewSavedMissionScheduling(delay, { ...phase, launchedCount: 0, oneShotAt: now + 7_200_000, nextDueAt: now + 7_200_000 }, now + 1000, true), [now + 7_200_000])
  assert.deepEqual(previewSavedMissionScheduling(delay, { ...phase, launchedCount: 1 }, now + 1000, true), [])
  // Changing the frequency reanchors timing at validation, while the end still
  // belongs to the saved first Play, rather than gaining two more hours.
  assert.deepEqual(previewSavedMissionScheduling(policy, { ...phase, nextDueAt: null }, now + 6_000_000, false), [now + 6_900_000])
})
test("an edited absolute or relative end bounds the persisted next slot, including a late slot", () => {
  const policy = missionSchedulingPolicy(draft({ frequency: "every", amount: "15" }))
  const phase = { firstPlayedAt: now, oneShotAt: null, slotEndsAt: null, nextDueAt: now + 7_200_000, launchedCount: 0 }
  for (const ends of [{ at: now + 3_600_000, afterMs: null, maxLaunches: null }, { at: null, afterMs: 3_600_000, maxLaunches: null }]) {
    for (const at of [now, now + 8_000_000]) assert.deepEqual(previewSavedMissionScheduling({ ...policy, ends }, phase, at, true), [])
  }
  assert.deepEqual(previewSavedMissionScheduling({ ...policy, ends: { at: phase.nextDueAt, afterMs: null, maxLaunches: null } }, phase, now, true), [phase.nextDueAt])
})
test("all form frequencies produce the strict native launch contract and exact bounded previews", () => {
  for (const frequency of missionFrequencies) {
    const policy = missionSchedulingPolicy(draft({ frequency, date: "2026-01-03T12:00" }))
    assert.deepEqual(missionLaunchPolicySchema.parse(policy), policy)
    const dates = previewMissionScheduling(policy, now)
    assert.equal(dates.length, ["immediate", "at", "in"].includes(frequency) ? 1 : 5, frequency)
    assert.ok(dates.every(at => at >= now))
  }
  assert.equal(missionSchedulingPolicy(draft()).timing.kind, "immediate")
  assert.equal(missionSchedulingPolicy(draft()).condition, null)
})
test("arbitrary minutes, duplicate normalization, ninth time refusal and shared quota", () => {
  const policy = missionSchedulingPolicy(draft({ frequency: "multi", times: ["09:15", "17:45", "09:15"], maxLaunches: "2" }))
  assert.equal(policy.timing.kind, "multi")
  if (policy.timing.kind === "multi") assert.equal(policy.timing.calendars.length, 2)
  assert.deepEqual(previewMissionScheduling(policy, now).map(at => new Date(at).toISOString()), ["2026-01-01T09:15:00.000Z", "2026-01-01T17:45:00.000Z"])
  assert.throws(() => missionSchedulingPolicy(draft({ frequency: "multi", times: Array(9).fill("09:00") })), MissionSchedulingError)
})
test("relative origins, elapsed intervals, civil monthly skips and native DST wrapper", () => {
  const relative = missionSchedulingPolicy(draft({ frequency: "in", amount: "2", unit: "hours" }))
  assert.deepEqual(previewMissionScheduling(relative, now), [now + 7_200_000])
  assert.deepEqual(previewMissionScheduling(relative, now + 1_000), [now + 7_201_000])
  assert.throws(() => missionSchedulingPolicy(draft({ frequency: "every", amount: "14" })), MissionSchedulingError)
  const monthly = missionSchedulingPolicy(draft({ frequency: "monthly", monthDay: "31" }))
  assert.deepEqual(previewMissionScheduling(monthly, now).map(at => new Date(at).getUTCMonth()), [0, 2, 4, 6, 7])
  for (const instant of ["2026-03-08T06:00:00Z", "2026-11-01T05:31:00Z"]) {
    const anchor = Date.parse(instant), policy = missionSchedulingPolicy(draft({ frequency: "daily", times: ["01:30"], zone: "America/New_York" }))
    assert.equal(previewMissionScheduling(policy, anchor)[0], nextMissionCalendarCron("30 1 * * *", "America/New_York", anchor))
  }
  const elapsed = missionSchedulingPolicy(draft({ frequency: "every", amount: "24", unit: "hours", zone: "America/New_York" }))
  assert.equal(previewMissionScheduling(elapsed, Date.parse("2026-03-07T12:00Z"))[1] - previewMissionScheduling(elapsed, Date.parse("2026-03-07T12:00Z"))[0], 86_400_000)
})
test("all five explicit conditions map to the native source contract; event-only previews are checks", () => {
  for (const [condition, source] of [["schedule-success", "msn_source"], ["mission-completed", "msn_source"],
    ["branch-commits", "refs/heads/dev"], ["conversation-message", "ses_source"], ["files-changed", ""]] as const) {
    const policy = missionSchedulingPolicy(draft({ condition, source, files: "src/a.ts\nsrc/b.ts" }), "/project")
    assert.deepEqual(missionLaunchPolicySchema.parse(policy), policy)
    assert.deepEqual(previewMissionScheduling(policy, now), [1, 2, 3, 4, 5].map(index => now + index * 900_000))
  }
  for (const files of ["../secret", "/outside", "a\\b", "a/./b", "a//b", "C:/secret", "a/../b"]) {
    assert.throws(() => missionSchedulingPolicy(draft({ condition: "files-changed", files })), MissionSchedulingError)
  }
  assert.throws(() => missionSchedulingPolicy(draft({ condition: "branch-commits", source: "refs/heads/dev..other" }), "/project"), MissionSchedulingError)
})
test("end bounds combine without turning check counts into launch quotas; invalid input stays invalid", () => {
  const policy = missionSchedulingPolicy(draft({ frequency: "every", amount: "15", endAt: "2026-01-01T00:45", endAfter: "1" }))
  assert.deepEqual(previewMissionScheduling(policy, now), [1, 2, 3].map(index => now + index * 900_000))
  for (const change of [{ zone: "Invalid/Zone" }, { frequency: "at", date: "2026-02-31T12:00" }, { frequency: "cron", expression: "* * * * * *" },
    { frequency: "weekly", days: [] }, { frequency: "monthly", monthDay: "32" }, { endAfter: "1.5" }, { maxLaunches: "0" }] as const) {
    assert.throws(() => missionSchedulingPolicy(draft(change as any)), MissionSchedulingError)
  }
  const past = missionSchedulingPolicy(draft({ frequency: "at", date: "2025-12-31T23:00" }))
  assert.deepEqual(previewMissionScheduling(past, now), [])
})
