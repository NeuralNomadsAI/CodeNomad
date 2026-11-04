import assert from "node:assert/strict"
import test from "node:test"
import { missionLaunchPolicySchema, type MissionLaunchPolicy, type MissionLegacyLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { decodeMissionSchedulingPolicy } from "./mission-scheduling-decode"
import { missionScheduleShortcuts, missionSchedulingPolicy, newMissionCriterion, newMissionSchedulingDraft,
  type MissionCriterionKind } from "./mission-scheduling-data"

const decode = (policy: MissionLaunchPolicy) => decodeMissionSchedulingPolicy(policy, "/project", "UTC")
const legacy = (timing: MissionLegacyLaunchPolicy["timing"], condition: MissionLegacyLaunchPolicy["condition"] = null,
  ends: Partial<MissionLegacyLaunchPolicy["ends"]> = {}): MissionLaunchPolicy => missionLaunchPolicySchema.parse({ timing, condition, ends: { at: null, afterMs: null, maxLaunches: null, ...ends } })
const events = [
  { kind: "schedule-success", missionID: "msn_source" }, { kind: "mission-completed", missionID: "msn_source" },
  { kind: "branch-commits", directory: "/project", ref: "refs/heads/dev" },
  { kind: "conversation-message", conversationID: "ses_followed" }, { kind: "files-changed", paths: ["a.ts", "b.ts"] },
] as const

test("every shortcut and all five events decode back into their rows and roundtrip the exact policy", () => {
  for (const kind of missionScheduleShortcuts) {
    const draft = { ...newMissionSchedulingDraft("America/New_York"),
      criteria: [{ ...newMissionCriterion(kind), hours: "4", days: [1, 3, 5], time: "09:15", expression: "*/30 9-17 * * MON-FRI" }] }
    const original = missionSchedulingPolicy(draft)
    const decoded = decode(original)
    assert.equal(decoded.stored?.reason, undefined, kind)
    assert.equal(decoded.criteria[0].kind, kind)
    assert.deepEqual(missionSchedulingPolicy(decoded, "/project"), original)
  }
  const original = missionLaunchPolicySchema.parse({ when: [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }, ...events.slice(0, 2)], onlyIf: events.slice(2) })
  const decoded = decode(original)
  assert.deepEqual(decoded.criteria.map(row => row.kind), ["daily", ...events.map(event => event.kind)])
  assert.deepEqual(decoded.criteria.map(row => row.onlyIf), [false, false, false, true, true, true])
  assert.deepEqual(missionSchedulingPolicy(decoded, "/project"), original)
})

test("cron recognition proves exact shortcut semantics and keeps the stored spelling of unedited rows", () => {
  for (const [expression, kind] of [
    ["0 09 * * *", "daily"], ["15 09 * * MON,WED,FRI", "weekly"], ["0 0 31 * *", "monthly"], ["0 */6 * * *", "hours"], ["0 0,12 * * *", "hours"],
    ["0 * * * *", "hours"], ["*/15 9-17 * * MON-FRI", "cron"], ["0 9 1 * MON", "cron"], ["30 0 9 * * *", "cron"], ["0 1-23/6 * * *", "cron"], ["0 */5 * * *", "cron"],
  ] as [string, MissionCriterionKind][]) {
    const original = missionLaunchPolicySchema.parse({ when: [{ kind: "cron", expression, zone: "America/New_York" }], onlyIf: [] })
    const draft = decode(original)
    assert.equal(draft.criteria[0].kind, kind, expression)
    assert.deepEqual(missionSchedulingPolicy(draft, "/project"), original)
    // Adding an event must not rewrite an equivalent expression and replace its calendar.
    const extended = missionSchedulingPolicy({ ...draft, criteria: [...draft.criteria, { ...newMissionCriterion("files-changed"), files: "src/a.ts" }] }, "/project")
    assert.ok("when" in extended && "when" in original); assert.deepEqual(extended.when[0], original.when[0])
  }
})

test("a legacy frequency with a condition reads as When schedules plus an Only if event; an edit drops the stored end date", () => {
  const stored = legacy({ kind: "multi", calendars: [{ expression: "15 09 * * *", zone: "UTC" }, { expression: "45 17 * * *", zone: "UTC" }] },
    { kind: "branch-commits", directory: "/project", ref: "refs/heads/main" }, { at: Date.parse("2026-12-01T12:00Z") })
  const draft = decode(stored)
  assert.equal(draft.stored?.reason, undefined)
  assert.deepEqual(draft.criteria.map(row => [row.kind, row.time, row.source]), [["daily", "09:15", ""], ["daily", "17:45", ""], ["branch-commits", "09:00", "refs/heads/main"]])
  assert.deepEqual(draft.criteria.map(row => row.onlyIf), [false, false, true])
  assert.deepEqual(missionSchedulingPolicy(draft, "/project"), stored, "an unchanged reopen keeps the stored legacy bytes and end date")
  const saved = missionSchedulingPolicy({ ...draft, criteria: draft.criteria.map(row => ({ ...row, onlyIf: false })) }, "/project")
  assert.deepEqual(saved, { when: [{ kind: "cron", expression: "15 09 * * *", zone: "UTC" }, { kind: "cron", expression: "45 17 * * *", zone: "UTC" },
    { kind: "branch-commits", directory: "/project", ref: "refs/heads/main" }], onlyIf: [] })
  for (const event of events) {
    const alone = decode(legacy({ kind: "immediate" }, structuredClone(event) as MissionLegacyLaunchPolicy["condition"]))
    assert.equal(alone.stored?.reason, undefined, "an event-only legacy policy reopens as one When event")
    assert.deepEqual(alone.criteria.map(row => [row.kind, row.onlyIf]), [[event.kind, false]])
    assert.ok("timing" in missionSchedulingPolicy(alone, "/project"), "unchanged, it keeps launching once")
  }
  assert.deepEqual(decode(legacy({ kind: "immediate" })).criteria, [], "one-time Missions have no criteria")
})

test("retired options and mixed zones retain the exact stored policy until replaced", () => {
  for (const [original, reason] of [
    [legacy({ kind: "in", delayMs: 3_600_000 }), "retired"], [legacy({ kind: "every", intervalMs: 5_400_000 }), "retired"],
    [legacy({ kind: "at", at: Date.parse("2026-11-02T12:00:00Z"), zone: "UTC" }), "retired"],
    [legacy({ kind: "cron", expression: "0 9 * * *", zone: "UTC" }, null, { maxLaunches: 3 }), "retired"],
    [legacy({ kind: "cron", expression: "0 9 * * *", zone: "UTC" }, null, { afterMs: 3_600_000 }), "retired"],
    [legacy({ kind: "multi", calendars: [{ expression: "0 9 * * *", zone: "UTC" }, { expression: "0 9 * * *", zone: "Asia/Tokyo" }] }), "timing"],
  ] as [MissionLaunchPolicy, string][]) {
    const draft = decode(original)
    assert.equal(draft.stored?.reason, reason, JSON.stringify(original))
    assert.deepEqual(missionSchedulingPolicy(draft), original)
    assert.throws(() => missionSchedulingPolicy({ ...draft, zone: "Europe/Berlin" }), /retained/)
  }
  const foreign = decode(legacy({ kind: "cron", expression: "0 9 * * *", zone: "UTC" }, { kind: "branch-commits", directory: "/foreign", ref: "refs/heads/dev" }))
  assert.equal(foreign.stored?.reason, "source")
  assert.throws(() => missionSchedulingPolicy(foreign, "/project"), /source/)
})
