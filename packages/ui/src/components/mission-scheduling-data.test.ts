import assert from "node:assert/strict"
import { test } from "node:test"
import { missionLaunchPolicySchema, type MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { nextMissionCalendarCron } from "../../../server/src/missions/mission-calendar-plan"
import { missionEventKinds, missionScheduleShortcuts, newMissionCriterion, newMissionSchedulingDraft, missionSchedulingPolicy,
  previewMissionScheduling, previewSavedMissionScheduling, MissionSchedulingError, type MissionCriterionDraft } from "./mission-scheduling-data"

const now = Date.parse("2026-01-01T00:00:00Z")
const row = (kind: MissionCriterionDraft["kind"], patch: Partial<MissionCriterionDraft> = {}) => ({ ...newMissionCriterion(kind), ...patch })
const draft = (criteria: MissionCriterionDraft[], patch: Partial<ReturnType<typeof newMissionSchedulingDraft>> = {}) =>
  ({ ...newMissionSchedulingDraft("UTC"), criteria, ...patch })
const legacy = (timing: object, ends: object = {}): MissionLaunchPolicy => missionLaunchPolicySchema.parse({ timing, condition: null,
  ends: { at: null, afterMs: null, maxLaunches: null, ...ends } })

test("no criteria is a one-time Mission; every shortcut writes its cron and previews five slots", () => {
  assert.deepEqual(missionSchedulingPolicy(draft([])), { when: [], onlyWithNews: false, until: null })
  assert.deepEqual(missionSchedulingPolicy(draft([], { until: "2026-02-01T00:00" })), { when: [], onlyWithNews: false, until: null }, "an end needs a criterion")
  const expected = { hours: "0 */6 * * *", daily: "0 9 * * *", weekly: "0 9 * * 1,2,3,4,5", monthly: "0 9 1 * *", cron: "0 9 * * *" }
  for (const kind of missionScheduleShortcuts) {
    const policy = missionSchedulingPolicy(draft([row(kind)]))
    assert.deepEqual(missionLaunchPolicySchema.parse(policy), policy)
    assert.ok("when" in policy)
    assert.deepEqual(policy.when, [{ kind: "cron", expression: expected[kind], zone: "UTC" }], kind)
    assert.equal(previewMissionScheduling(policy, now).length, 5, kind)
  }
  assert.equal((missionSchedulingPolicy(draft([row("hours", { hours: "1" })])) as { when: { expression: string }[] }).when[0].expression, "0 * * * *")
})

test("schedules OR events, only-with-news needs both, duplicates and over-capacity lists are refused", () => {
  const both = missionSchedulingPolicy(draft([row("daily"), row("branch-commits", { source: "refs/heads/main" })], { onlyWithNews: true }), "/project")
  assert.ok("when" in both); assert.equal(both.onlyWithNews, true)
  assert.equal((missionSchedulingPolicy(draft([row("daily")], { onlyWithNews: true })) as { onlyWithNews: boolean }).onlyWithNews, false,
    "a stale checkbox never turns a schedule-only list into a refused policy")
  assert.throws(() => missionSchedulingPolicy(draft([row("daily"), row("daily", { time: "09:00" })])), (error: MissionSchedulingError) => error.field === "duplicate")
  const nine = Array.from({ length: 8 }, (_, hour) => row("daily", { time: `0${hour}:00` }))
  assert.throws(() => missionSchedulingPolicy(draft([...nine, row("files-changed", { files: "a.ts" })])), (error: MissionSchedulingError) => error.field === "count")
  assert.doesNotThrow(() => missionSchedulingPolicy(draft([...nine, row("files-changed", { files: "a.ts" })], { onlyWithNews: true })))
  const events = missionSchedulingPolicy(draft([row("files-changed", { files: "src/b.ts\nsrc/a.ts" })]))
  assert.deepEqual(previewMissionScheduling(events, now), [], "events alone have no dated slots")
})

test("all five events map to the native source contract and reject unsafe sources with their row index", () => {
  const sources = { "schedule-success": "msn_source", "mission-completed": "msn_source", "branch-commits": "refs/heads/dev",
    "conversation-message": "ses_source", "files-changed": "" }
  for (const kind of missionEventKinds) {
    const policy = missionSchedulingPolicy(draft([row(kind, { source: sources[kind], files: "src/a.ts\nsrc/b.ts" })]), "/project")
    assert.deepEqual(missionLaunchPolicySchema.parse(policy), policy)
  }
  for (const files of ["../secret", "/outside", "a\\b", "a/./b", "a//b", "C:/secret", "a/../b"])
    assert.throws(() => missionSchedulingPolicy(draft([row("daily"), row("files-changed", { files })])),
      (error: MissionSchedulingError) => error.field === "source" && error.index === 1)
  assert.throws(() => missionSchedulingPolicy(draft([row("branch-commits", { source: "refs/heads/dev..other" })]), "/project"), MissionSchedulingError)
  assert.throws(() => missionSchedulingPolicy(draft([row("branch-commits", { source: "refs/heads/dev" })])), MissionSchedulingError, "a branch needs its directory")
})

test("invalid fields stay invalid; the end date bounds previews; civil schedules follow native DST", () => {
  for (const change of [{ zone: "Invalid/Zone" }, { until: "2026-02-31T12:00" }] as const)
    assert.throws(() => missionSchedulingPolicy(draft([row("daily")], change)), MissionSchedulingError)
  for (const patch of [{ kind: "cron", expression: "* * * * * *" }, { kind: "weekly", days: [] }, { kind: "monthly", monthDay: "32" },
    { kind: "hours", hours: "24" }, { kind: "hours", hours: "1.5" }, { kind: "daily", time: "25:00" }] as const)
    assert.throws(() => missionSchedulingPolicy(draft([row(patch.kind, patch as Partial<MissionCriterionDraft>)])), MissionSchedulingError, JSON.stringify(patch))
  const bounded = missionSchedulingPolicy(draft([row("hours", { hours: "6" })], { until: "2026-01-01T13:00" }))
  assert.deepEqual(previewMissionScheduling(bounded, now).map(at => new Date(at).toISOString()),
    ["2026-01-01T06:00:00.000Z", "2026-01-01T12:00:00.000Z"])
  const monthly = missionSchedulingPolicy(draft([row("monthly", { monthDay: "31" })]))
  assert.deepEqual(previewMissionScheduling(monthly, now).map(at => new Date(at).getUTCMonth()), [0, 2, 4, 6, 7])
  for (const instant of ["2026-03-08T06:00:00Z", "2026-11-01T05:31:00Z"]) {
    const anchor = Date.parse(instant), policy = missionSchedulingPolicy(draft([row("daily", { time: "01:30" })], { zone: "America/New_York" }))
    assert.equal(previewMissionScheduling(policy, anchor)[0], nextMissionCalendarCron("30 1 * * *", "America/New_York", anchor))
  }
})

test("saved legacy previews keep interval/delay phases, relative ends and consumed quotas, showing a late slot once", () => {
  const policy = legacy({ kind: "every", intervalMs: 900_000 }, { afterMs: 7_200_000, maxLaunches: 8 })
  const phase = { firstPlayedAt: now, oneShotAt: null, slotEndsAt: now + 7_200_000, nextDueAt: now + 900_000, launchedCount: 2 }
  assert.deepEqual(previewSavedMissionScheduling(policy, phase, now + 4_000_000, true), [900_000, 4_500_000, 5_400_000, 6_300_000, 7_200_000].map(ms => now + ms))
  assert.deepEqual(previewSavedMissionScheduling(legacy({ kind: "every", intervalMs: 900_000 }), { ...phase, nextDueAt: now + 1_020_000 }, now + 1_080_000, true),
    [17, 32, 47, 62, 77].map(minutes => now + minutes * 60_000), "a replaced interval keeps the current native phase")
  assert.deepEqual(previewSavedMissionScheduling(policy, { ...phase, nextDueAt: null }, now, true), [], "an unobserved phase is kept unknown")
  assert.deepEqual(previewSavedMissionScheduling(policy, { ...phase, launchedCount: 8 }, now, true), [])
  const delay = legacy({ kind: "in", delayMs: 7_200_000 })
  assert.deepEqual(previewSavedMissionScheduling(delay, { ...phase, launchedCount: 0, oneShotAt: now + 7_200_000, nextDueAt: now + 7_200_000 }, now + 1000, true), [now + 7_200_000])
  assert.deepEqual(previewSavedMissionScheduling(delay, { ...phase, launchedCount: 1 }, now + 1000, true), [])
  const criteria = missionSchedulingPolicy(draft([row("daily")], { until: "2026-01-03T00:00" }))
  assert.deepEqual(previewSavedMissionScheduling(criteria, { ...phase, launchedCount: 40, nextDueAt: null }, now, false).map(at => new Date(at).toISOString()),
    ["2026-01-01T09:00:00.000Z", "2026-01-02T09:00:00.000Z"], "criteria have no passage quota")
})
