import assert from "node:assert/strict"
import { test } from "node:test"
import { missionLaunchPolicySchema } from "../../../server/src/missions/launch-policy"
import { missionCardConnectors, missionEventKinds, missionScheduleShortcuts, newMissionCriterion, newMissionSchedulingDraft, missionSchedulingPolicy,
  MissionSchedulingError, type MissionCriterionDraft } from "./mission-scheduling-data"

const row = (kind: MissionCriterionDraft["kind"], patch: Partial<MissionCriterionDraft> = {}) => ({ ...newMissionCriterion(kind), ...patch })
const draft = (criteria: MissionCriterionDraft[], patch: Partial<ReturnType<typeof newMissionSchedulingDraft>> = {}) =>
  ({ ...newMissionSchedulingDraft("UTC"), criteria, ...patch })
const field = (name: MissionSchedulingError["field"], index?: number) => (error: MissionSchedulingError) =>
  error.field === name && (index === undefined || error.index === index)

test("no criteria is a one-time Mission; every shortcut writes its cron", () => {
  assert.deepEqual(missionSchedulingPolicy(draft([])), { when: [] })
  const expected = { hours: "0 */6 * * *", daily: "0 9 * * *", weekly: "0 9 * * 1,2,3,4,5", monthly: "0 9 1 * *", cron: "0 9 * * *" }
  for (const kind of missionScheduleShortcuts) {
    const policy = missionSchedulingPolicy(draft([row(kind)]))
    assert.deepEqual(missionLaunchPolicySchema.parse(policy), policy)
    assert.ok("when" in policy)
    assert.deepEqual(policy.when, kind === "now" ? [{ kind: "now" }] : [{ kind: "cron", expression: expected[kind], zone: "UTC" }], kind)
  }
  assert.equal((missionSchedulingPolicy(draft([row("hours", { hours: "1" })])) as { when: { expression: string }[] }).when[0].expression, "0 * * * *")
})

test("the first criterion is once-now and remains composable in either event order", () => {
  const initial = newMissionSchedulingDraft("UTC")
  assert.deepEqual(initial.criteria.map(row => row.kind), ["now"])
  const second = newMissionCriterion("daily", initial.criteria)
  const added = { ...initial, criteria: [...initial.criteria, second] }
  assert.deepEqual(missionSchedulingPolicy(added), { when: [{ kind: "now" }, { kind: "cron", expression: "0 9 * * *", zone: "UTC" }] })
  const event = row("files-changed", { files: "a.ts" })
  for (const [rows, connector] of [[ [initial.criteria[0], event], "if" ], [ [event, initial.criteria[0]], "else" ]] as const) {
    assert.deepEqual(missionCardConnectors(rows), [connector])
    assert.deepEqual(missionLaunchPolicySchema.parse(missionSchedulingPolicy(draft([...rows]))), missionSchedulingPolicy(draft([...rows])))
  }
  assert.throws(() => missionSchedulingPolicy(draft([row("now"), row("now")])), field("duplicate"))
})

test("the stored list keeps the card order; the connectors between cards come from the shared parser", () => {
  const daily = { kind: "cron", expression: "0 9 * * *", zone: "UTC" }, commits = { kind: "branch-commits", directory: "/project", ref: "refs/heads/main" }
  const commitsRow = () => row("branch-commits", { source: "refs/heads/main" })
  assert.deepEqual(missionSchedulingPolicy(draft([commitsRow(), row("daily")]), "/project"), { when: [commits, daily] })
  assert.deepEqual(missionCardConnectors([commitsRow(), row("daily")]), ["else"], "commits, else 09:00")
  assert.deepEqual(missionSchedulingPolicy(draft([row("daily"), commitsRow()]), "/project"), { when: [daily, commits] })
  assert.deepEqual(missionCardConnectors([row("daily"), commitsRow()]), ["if"], "09:00 if commits")
  assert.deepEqual(missionCardConnectors([commitsRow(), row("files-changed", { files: "a.ts" })]), ["or"], "commits or files")
  assert.deepEqual(missionCardConnectors([row("hours"), row("daily"), row("files-changed"), row("mission-completed")]), ["or", "if", "or"])
  assert.deepEqual(missionCardConnectors([commitsRow(), row("daily"), row("files-changed"), row("cron")]), ["else", "if", "else"])
  assert.throws(() => missionSchedulingPolicy(draft([row("daily"), row("daily", { time: "09:00" })])), field("duplicate"))
  assert.throws(() => missionSchedulingPolicy(draft([row("files-changed", { files: "a.ts" }), row("daily"), row("files-changed", { files: "a.ts" })])),
    field("duplicate"), "one event appears once")
  const eight = Array.from({ length: 8 }, (_, hour) => row("daily", { time: `0${hour}:00` }))
  assert.throws(() => missionSchedulingPolicy(draft([row("files-changed", { files: "a.ts" }), ...eight])), field("count"))
  assert.doesNotThrow(() => missionSchedulingPolicy(draft([...eight, row("files-changed", { files: "a.ts" })])),
    "events after schedules are conditions and need no check of their own")
})

test("all events map to the native source contract and reject unsafe sources with their row index", () => {
  const sources = { "schedule-success": "msn_source", "mission-completed": "msn_source", "branch-commits": "refs/heads/dev",
    "conversation-message": "ses_source", "files-changed": "", "github-notification": "", "github-security-alert": "acme/repo",
    "github-pull-request": "acme/repo", "github-issue": "acme/repo" }
  for (const kind of missionEventKinds) {
    const policy = missionSchedulingPolicy(draft([row(kind, { source: sources[kind], files: "src/a.ts\nsrc/b.ts" })]), "/project")
    assert.deepEqual(missionLaunchPolicySchema.parse(policy), policy)
  }
  for (const files of ["../secret", "/outside", "a\\b", "a/./b", "a//b", "C:/secret", "a/../b"])
    assert.throws(() => missionSchedulingPolicy(draft([row("daily"), row("files-changed", { files })])), field("source", 1))
  assert.throws(() => missionSchedulingPolicy(draft([row("branch-commits", { source: "refs/heads/dev..other" })]), "/project"), MissionSchedulingError)
  assert.throws(() => missionSchedulingPolicy(draft([row("branch-commits", { source: "refs/heads/dev" })])), MissionSchedulingError, "a branch needs its directory")
})

test("invalid fields stay invalid and an impossible calendar is refused", () => {
  assert.throws(() => missionSchedulingPolicy(draft([row("daily")], { zone: "Invalid/Zone" })), field("zone"))
  for (const patch of [{ kind: "cron", expression: "* * * * * *" }, { kind: "weekly", days: [] }, { kind: "monthly", monthDay: "32" },
    { kind: "hours", hours: "24" }, { kind: "hours", hours: "1.5" }, { kind: "daily", time: "25:00" }] as const)
    assert.throws(() => missionSchedulingPolicy(draft([row(patch.kind, patch as Partial<MissionCriterionDraft>)])), MissionSchedulingError, JSON.stringify(patch))
  assert.throws(() => missionSchedulingPolicy(draft([row("daily"), row("cron", { expression: "0 9 30 2 *" })])), field("empty", 1))
})

test("GitHub criteria retain exact repository and optional author filters", () => {
  assert.deepEqual(missionSchedulingPolicy(draft([row("github-pull-request", { source: "Acme/Repo", author: "@Alice" })])),
    { when: [{ kind: "github-pull-request", repository: "acme/repo", author: "alice" }] })
  assert.deepEqual(missionSchedulingPolicy(draft([row("github-notification")])), { when: [{ kind: "github-notification" }] })
  assert.throws(() => missionSchedulingPolicy(draft([row("github-issue", { source: "../repo" })])), field("source", 0))
  assert.throws(() => missionSchedulingPolicy(draft([row("github-pull-request", { source: "acme/repo", author: "alice OR bob" })])), field("source", 0))
})
