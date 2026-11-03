import assert from "node:assert/strict"
import test from "node:test"
import { missionLaunchPolicySchema, type MissionLaunchPolicy, type MissionLegacyLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { decodeMissionSchedulingPolicy } from "./mission-scheduling-decode"
import { missionScheduleShortcuts, missionSchedulingPolicy, newMissionCriterion, newMissionSchedulingDraft, previewMissionScheduling,
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
    const draft = { ...newMissionSchedulingDraft("America/New_York"), until: "2026-12-01T12:00",
      criteria: [{ ...newMissionCriterion(kind), hours: "4", days: [1, 3, 5], time: "09:15", expression: "*/30 9-17 * * MON-FRI" }] }
    const original = missionSchedulingPolicy(draft)
    const decoded = decode(original)
    assert.equal(decoded.stored?.reason, undefined, kind)
    assert.equal(decoded.criteria[0].kind, kind)
    assert.deepEqual(missionSchedulingPolicy(decoded, "/project"), original)
  }
  const original = missionLaunchPolicySchema.parse({ when: [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }, ...events], onlyWithNews: true, until: null })
  const decoded = decode(original)
  assert.deepEqual(decoded.criteria.map(row => row.kind), ["daily", ...events.map(event => event.kind)])
  assert.equal(decoded.onlyWithNews, true)
  assert.deepEqual(missionSchedulingPolicy(decoded, "/project"), original)
})

test("cron recognition proves exact shortcut semantics and keeps the stored spelling of unedited rows", () => {
  for (const [expression, kind] of [
    ["0 09 * * *", "daily"], ["15 09 * * MON,WED,FRI", "weekly"], ["0 0 31 * *", "monthly"], ["0 */6 * * *", "hours"], ["0 0,12 * * *", "hours"],
    ["0 * * * *", "hours"], ["*/15 9-17 * * MON-FRI", "cron"], ["0 9 1 * MON", "cron"], ["30 0 9 * * *", "cron"], ["0 1-23/6 * * *", "cron"], ["0 */5 * * *", "cron"],
  ] as [string, MissionCriterionKind][]) {
    const original = missionLaunchPolicySchema.parse({ when: [{ kind: "cron", expression, zone: "America/New_York" }], onlyWithNews: false, until: null })
    const draft = decode(original)
    assert.equal(draft.criteria[0].kind, kind, expression)
    assert.deepEqual(missionSchedulingPolicy(draft, "/project"), original)
    // Adding an event must not rewrite an equivalent expression and replace its calendar.
    const extended = missionSchedulingPolicy({ ...draft, criteria: [...draft.criteria, { ...newMissionCriterion("files-changed"), files: "src/a.ts" }] }, "/project")
    assert.ok("when" in extended && "when" in original); assert.deepEqual(extended.when[0], original.when[0])
  }
})

test("a legacy frequency with a condition reads as a schedule plus an event with only-with-news checked", () => {
  const stored = legacy({ kind: "multi", calendars: [{ expression: "15 09 * * *", zone: "UTC" }, { expression: "45 17 * * *", zone: "UTC" }] },
    { kind: "branch-commits", directory: "/project", ref: "refs/heads/main" }, { at: Date.parse("2026-12-01T12:00Z") })
  const draft = decode(stored)
  assert.equal(draft.stored?.reason, undefined)
  assert.deepEqual(draft.criteria.map(row => [row.kind, row.time, row.source]), [["daily", "09:15", ""], ["daily", "17:45", ""], ["branch-commits", "09:00", "refs/heads/main"]])
  assert.equal(draft.onlyWithNews, true); assert.equal(draft.until, "2026-12-01T12:00")
  assert.deepEqual(missionSchedulingPolicy(draft, "/project"), stored, "an unchanged reopen keeps the stored legacy bytes")
  const saved = missionSchedulingPolicy({ ...draft, onlyWithNews: false }, "/project")
  assert.ok("when" in saved)
  assert.deepEqual(saved, { when: [{ kind: "cron", expression: "15 09 * * *", zone: "UTC" }, { kind: "cron", expression: "45 17 * * *", zone: "UTC" },
    { kind: "branch-commits", directory: "/project", ref: "refs/heads/main" }], onlyWithNews: false, until: Date.parse("2026-12-01T12:00Z") })
  for (const event of events) {
    const alone = decode(legacy({ kind: "immediate" }, structuredClone(event) as MissionLegacyLaunchPolicy["condition"]))
    assert.equal(alone.stored?.reason, "retired", "an event-only legacy policy launched once")
  }
  assert.deepEqual(decode(legacy({ kind: "immediate" })).criteria, [], "one-time Missions have no criteria")
})

test("retired options, mixed zones and civil-time precision retain the exact stored policy until replaced", () => {
  for (const [original, reason] of [
    [legacy({ kind: "in", delayMs: 3_600_000 }), "retired"], [legacy({ kind: "every", intervalMs: 5_400_000 }), "retired"],
    [legacy({ kind: "at", at: Date.parse("2026-11-02T12:00:00Z"), zone: "UTC" }), "retired"],
    [legacy({ kind: "cron", expression: "0 9 * * *", zone: "UTC" }, null, { maxLaunches: 3 }), "retired"],
    [legacy({ kind: "cron", expression: "0 9 * * *", zone: "UTC" }, null, { afterMs: 3_600_000 }), "retired"],
    [legacy({ kind: "multi", calendars: [{ expression: "0 9 * * *", zone: "UTC" }, { expression: "0 9 * * *", zone: "Asia/Tokyo" }] }), "timing"],
    [missionLaunchPolicySchema.parse({ when: [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }], onlyWithNews: false, until: Date.parse("2026-11-02T12:00:00.001Z") }), "precision"],
  ] as [MissionLaunchPolicy, string][]) {
    const draft = decode(original)
    assert.equal(draft.stored?.reason, reason, JSON.stringify(original))
    assert.deepEqual(missionSchedulingPolicy(draft), original)
    assert.throws(() => missionSchedulingPolicy({ ...draft, until: "2027-01-01T00:00" }), /retained/)
  }
  const anchor = Date.parse("2026-11-01T05:00Z"), interval = legacy({ kind: "every", intervalMs: 5_400_000 })
  assert.deepEqual(previewMissionScheduling(missionSchedulingPolicy(decode(interval)), anchor), previewMissionScheduling(interval, anchor))
  const foreign = decode(legacy({ kind: "cron", expression: "0 9 * * *", zone: "UTC" }, { kind: "branch-commits", directory: "/foreign", ref: "refs/heads/dev" }))
  assert.equal(foreign.stored?.reason, "source")
  assert.throws(() => missionSchedulingPolicy(foreign, "/project"), /source/)
})
