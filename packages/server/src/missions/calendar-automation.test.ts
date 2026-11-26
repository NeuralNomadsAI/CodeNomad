import assert from "node:assert/strict"
import test from "node:test"
import { missionCalendarAutomation } from "./calendar-automation"
import { MISSION_CALENDAR_CODE } from "./calendar-run"
import { missionConfigurationSchema, type MissionConfiguration } from "./launch-policy"

const profile = { agent: "build", model: { providerID: "fixture", id: "fixture" } }
const configuration = (launch: unknown, extra: Record<string, unknown> = {}): MissionConfiguration => missionConfigurationSchema.parse({
  title: "Sync", objective: "Review what changed", template: "custom", taskMode: "native", profileID: "profile", executionHost: "host",
  profiles: { coordinator: profile, roles: { specialist: profile } }, roots: [{ mode: "directory-only", directory: "D:\\project" }], watchedConversationIDs: [], launch, ...extra })
const commits = { kind: "remote-branch-commits", provider: "github", host: "github.com", repository: "owner/repo", ref: "refs/heads/dev" }
const pulls = { kind: "repository-activity", provider: "github", host: "github.com", repository: "owner/repo", event: "pull-request-created", author: "dependabot[bot]" }
const cron = { kind: "cron", expression: "0 9 * * 1-5", zone: "Europe/Paris" }

test("events alone become one Automation that asks every fifteen minutes, in the conversation the calendar names", () => {
  const automation = missionCalendarAutomation(configuration({ when: [commits, pulls] }, { coordinatorSessionID: "ses_coordinator", coordinatorGoal: true }))
  assert.ok(!("unsupported" in automation))
  assert.deepEqual(automation.trigger, { type: "every", every: "15 minutes" })
  assert.equal(automation.action.code, MISSION_CALENDAR_CODE)
  assert.deepEqual(automation.action.args, { title: "Sync", objective: "Review what changed", template: "custom", taskMode: "native",
    profiles: { coordinator: profile, roles: { specialist: profile } }, coordinatorGoal: true, coordinatorSessionID: "ses_coordinator",
    when: [{ ...commits }, { ...pulls }] })
})

test("a date rule keeps its time zone, and the events after it are its condition", () => {
  const plain = missionCalendarAutomation(configuration({ when: [cron] }))
  assert.ok(!("unsupported" in plain))
  assert.deepEqual(plain.trigger, { type: "cron", cron: "0 9 * * 1-5", tz: "Europe/Paris" })
  assert.equal("when" in plain.action.args, false)
  const conditioned = missionCalendarAutomation(configuration({ when: [cron, commits] }))
  assert.ok(!("unsupported" in conditioned))
  assert.deepEqual(conditioned.action.args.when, [{ ...commits }])
})

test("criteria one Automation cannot express are named", () => {
  const other = { ...cron, expression: "0 18 * * *" }
  assert.deepEqual(missionCalendarAutomation(configuration({ when: [] })), { unsupported: "one-time" })
  assert.deepEqual(missionCalendarAutomation(configuration({ when: [cron, other] })), { unsupported: "several-schedules" })
  assert.deepEqual(missionCalendarAutomation(configuration({ when: [commits, cron] })), { unsupported: "fallback-schedule" })
  assert.deepEqual(missionCalendarAutomation(configuration({ when: [{ kind: "mission-completed", missionID: "msn_other" }] })), { unsupported: "event" })
  assert.deepEqual(missionCalendarAutomation(configuration({ when: [cron] }, { watchedConversationIDs: ["ses_followed"] })), { unsupported: "followed-conversations" })
})
