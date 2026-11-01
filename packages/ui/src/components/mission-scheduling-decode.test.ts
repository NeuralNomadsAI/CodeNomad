import assert from "node:assert/strict"
import test from "node:test"
import { missionLaunchPolicySchema, type MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { decodeMissionSchedulingPolicy } from "./mission-scheduling-decode"
import { missionFrequencies, missionSchedulingPolicy, newMissionSchedulingDraft, previewMissionScheduling } from "./mission-scheduling-data"

const initial = { ...newMissionSchedulingDraft("America/New_York"), date: "2026-11-02T12:00", endAt: "2026-12-01T12:00", endAfter: "24", maxLaunches: "3" }
const decode = (policy: MissionLaunchPolicy) => decodeMissionSchedulingPolicy(policy, "/project", "UTC")
const policy = (timing: MissionLaunchPolicy["timing"]): MissionLaunchPolicy => ({ timing, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } })

test("every simple form decodes and roundtrips the exact stored policy, limits and all five conditions", () => {
  for (const frequency of missionFrequencies) {
    const original = missionSchedulingPolicy({ ...initial, frequency, times: ["09:15", "17:45"], days: [1, 3, 5] })
    const draft = decode(original)
    assert.equal(draft.stored?.reason, undefined, frequency)
    assert.equal(draft.frequency, frequency === "cron" ? "daily" : frequency)
    assert.deepEqual(missionSchedulingPolicy(draft, "/project"), original)
  }
  for (const condition of [
    { kind: "schedule-success", missionID: "msn_source" }, { kind: "mission-completed", missionID: "msn_source" },
    { kind: "branch-commits", directory: "/project", ref: "refs/heads/dev" },
    { kind: "conversation-message", conversationID: "ses_followed" }, { kind: "files-changed", paths: ["a.ts", "b.ts"] },
  ] as const) {
    const original = missionLaunchPolicySchema.parse({ ...policy({ kind: "immediate" }), condition })
    assert.deepEqual(missionSchedulingPolicy(decode(original), "/project"), original)
  }
})

test("cron recognition proves exact simple semantics and preserves complex/second-position expressions in advanced", () => {
  for (const [expression, frequency] of [
    ["0 09 * * *", "daily"], ["15 09 * * MON,WED,FRI", "weekly"], ["0 0 31 * *", "monthly"],
    ["0 0 * * TUE", "weekly"], ["*/15 9-17 * * MON-FRI", "cron"], ["0 9 1 * MON", "cron"], ["30 0 9 * * *", "cron"],
  ]) {
    const original = policy({ kind: "cron", expression, zone: "America/New_York" }), draft = decode(original)
    assert.equal(draft.frequency, frequency, expression)
    assert.deepEqual(missionSchedulingPolicy(draft, "/project"), original)
    // Editing a quota/source must not replace an equivalent expression and reset its temporal generation.
    assert.deepEqual(missionSchedulingPolicy({ ...draft, maxLaunches: "5" }, "/project").timing, original.timing)
    assert.deepEqual(missionSchedulingPolicy({ ...draft, condition: "files-changed", files: "src/a.ts" }, "/project").timing, original.timing)
  }
})

test("multi calendars keep exact spelling/order and reject lossy conversion of mixed zones or richer calendars", () => {
  const original = policy({ kind: "multi", calendars: [{ expression: "45 17 * * *", zone: "UTC" }, { expression: "15 09 * * *", zone: "UTC" }] })
  const draft = decode(original)
  assert.deepEqual(draft.times, ["09:15", "17:45"])
  assert.deepEqual(missionSchedulingPolicy(draft), original)
  assert.deepEqual(missionSchedulingPolicy({ ...draft, maxLaunches: "4" }).timing, original.timing)
  for (const calendars of [
    [{ expression: "0 9 * * *", zone: "UTC" }, { expression: "0 9 * * *", zone: "Asia/Tokyo" }],
    [{ expression: "*/15 9-17 * * *", zone: "UTC" }],
  ]) {
    const exact = policy({ kind: "multi", calendars }), retained = decode(exact)
    assert.equal(retained.stored?.reason, "timing")
    assert.deepEqual(missionSchedulingPolicy(retained), exact)
    assert.throws(() => missionSchedulingPolicy({ ...retained, frequency: "cron" }), /retained/)
  }
})

test("unrepresentable duration, millisecond date and DST second fold retain the exact policy", () => {
  for (const original of [
    policy({ kind: "in", delayMs: 1_001 }), policy({ kind: "every", intervalMs: 900_001 }),
    policy({ kind: "at", at: Date.parse("2026-11-01T06:30:00Z"), zone: "America/New_York" }),
    policy({ kind: "at", at: Date.parse("2026-11-02T12:00:00.001Z"), zone: "UTC" }),
    { ...policy({ kind: "every", intervalMs: 900_000 }), ends: { at: null, afterMs: 60_000, maxLaunches: 3 } },
  ]) {
    const draft = decode(original)
    assert.equal(draft.stored?.reason, "precision", JSON.stringify(original))
    assert.deepEqual(missionSchedulingPolicy(draft), original)
    assert.throws(() => missionSchedulingPolicy({ ...draft, endAfter: "2" }), /retained/)
  }
})

test("changing one group preserves other exact native values, detached clones and frozen relative origins", () => {
  const original = { ...policy({ kind: "every" as const, intervalMs: 90 * 60_000 }), ends: { maxLaunches: 3, at: Date.parse("2026-12-01T12:00Z"), afterMs: 24 * 3_600_000 } }
  const draft = decode(original), changed = missionSchedulingPolicy({ ...draft, condition: "files-changed", files: "src/a.ts" })
  assert.deepEqual(changed.timing, original.timing); assert.deepEqual(changed.ends, original.ends)
  changed.ends.maxLaunches = 9
  assert.equal(original.ends.maxLaunches, 3)
  const anchor = Date.parse("2026-11-01T05:00Z")
  assert.deepEqual(previewMissionScheduling(missionSchedulingPolicy(draft), anchor), previewMissionScheduling(original, anchor))
  const foreign = decode({ ...original, condition: { kind: "branch-commits", directory: "/foreign", ref: "refs/heads/dev" } })
  assert.equal(foreign.stored?.reason, "source")
  assert.throws(() => missionSchedulingPolicy(foreign, "/project"), /source/)
})
