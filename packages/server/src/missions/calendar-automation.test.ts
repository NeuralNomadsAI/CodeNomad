import assert from "node:assert/strict"
import test from "node:test"
import { missionCalendarAutomations } from "./calendar-automation"
import { MISSION_CALENDAR_CODE } from "./calendar-run"
import { missionConfigurationSchema, type MissionConfiguration } from "./launch-policy"

const profile = { agent: "build", model: { providerID: "fixture", id: "fixture" } }
const configuration = (launch: unknown, extra: Record<string, unknown> = {}): MissionConfiguration => missionConfigurationSchema.parse({
  title: "Sync", objective: "Review what changed", template: "custom", taskMode: "native", profileID: "profile", executionHost: "host",
  profiles: { coordinator: profile, roles: { specialist: profile } }, roots: [{ mode: "directory-only", directory: "D:\\project" }], watchedConversationIDs: [], launch, ...extra })
const commits = { kind: "remote-branch-commits", provider: "github", host: "github.com", repository: "owner/repo", ref: "refs/heads/dev" }
const pulls = { kind: "repository-activity", provider: "github", host: "github.com", repository: "owner/repo", event: "pull-request-created", author: "dependabot[bot]" }
const morning = { kind: "cron", expression: "0 9 * * 1-5", zone: "Europe/Paris" }, evening = { kind: "cron", expression: "0 18 * * *", zone: "Europe/Paris" }
const plan = (launch: unknown, extra?: Record<string, unknown>) => {
  const automations = missionCalendarAutomations(configuration(launch, extra), "cal_sync")
  assert.ok(Array.isArray(automations))
  return automations
}

test("events alone become one Automation that asks every fifteen minutes, in the conversation the calendar names", () => {
  const [automation, ...others] = plan({ when: [commits, pulls] }, { coordinatorSessionID: "ses_coordinator", coordinatorGoal: true })
  assert.equal(others.length, 0)
  assert.deepEqual(automation!.trigger, { type: "every", every: "15 minutes" })
  assert.equal(automation!.action.code, MISSION_CALENDAR_CODE)
  assert.deepEqual(automation!.action.args, { calendar: "cal_sync", title: "Sync", objective: "Review what changed", template: "custom", taskMode: "native",
    profiles: { coordinator: profile, roles: { specialist: profile } }, coordinatorGoal: true, coordinatorSessionID: "ses_coordinator",
    when: [{ ...commits }, { ...pulls }], launch: { when: [{ ...commits }, { ...pulls }] } })
  const prepared = missionCalendarAutomations(configuration({ when: [commits] }), "cal_sync", "msn_prepared")
  assert.ok(Array.isArray(prepared))
  assert.equal(prepared[0]!.action.args.prepared, "msn_prepared", "the Mission the first launch starts")
})

test("each date rule is an Automation of the same calendar, with the events after the rules as its condition", () => {
  const plain = plan({ when: [morning] })
  assert.deepEqual(plain.map(item => item.trigger), [{ type: "cron", cron: "0 9 * * 1-5", tz: "Europe/Paris" }])
  assert.equal("when" in plain[0]!.action.args, false)
  const conditioned = plan({ when: [morning, evening, commits] })
  assert.deepEqual(conditioned.map(item => item.trigger), [{ type: "cron", cron: "0 9 * * 1-5", tz: "Europe/Paris" }, { type: "cron", cron: "0 18 * * *", tz: "Europe/Paris" }])
  for (const item of conditioned) assert.deepEqual([item.action.args.calendar, item.action.args.when], ["cal_sync", [{ ...commits }]])
})

test("criteria Automations cannot express are named", () => {
  const refused = (launch: unknown, extra?: Record<string, unknown>) => missionCalendarAutomations(configuration(launch, extra), "cal_sync")
  assert.deepEqual(refused({ when: [] }), { unsupported: "one-time" })
  assert.deepEqual(refused({ when: [commits, morning] }), { unsupported: "fallback-schedule" })
  assert.deepEqual(refused({ when: [{ kind: "mission-completed", missionID: "msn_other" }] }), { unsupported: "event" })
  assert.deepEqual(refused({ when: [morning] }, { watchedConversationIDs: ["ses_followed"] }), { unsupported: "followed-conversations" })
})