import assert from "node:assert/strict"
import test from "node:test"
import { convertMissionSchedule, convertibleMissionSchedule } from "./mission-schedule-conversion"

const schedule = (extra: Record<string, unknown> = {}) => ({ id: "msn_sync", kind: "schedule", state: "running", revision: 7, pendingPassage: null, control: null, blockReason: null,
  configuration: { title: "Sync", objective: "Review", template: "custom", taskMode: "native", watchedConversationIDs: [], launch: { when: [] },
    roots: [{ mode: "directory-only", directory: "/project" }], profileID: "profile", executionHost: "local", coordinatorSelectionAuthor: { coordinatorSessionID: "ses_1" } },
  ...extra }) as never
function steps(fail?: string) {
  const calls: unknown[] = []
  const step = (name: string) => async (...input: unknown[]) => { calls.push([name, ...input]); if (fail === name) { fail = undefined; throw new Error(name) } }
  return { calls, save: step("save"), remove: step("remove"), resume: step("resume") }
}

test("a schedule is taken over when it runs or is paused and nothing of it is under way", () => {
  assert.deepEqual([{}, { state: "paused" }, { state: "stopped" }, { state: "finished" }, { kind: "one-time" }, { pendingPassage: { id: "p" } },
    { control: { pending: true } }, { control: { pending: false } }, { blockReason: "failed" }, { blockReason: "ended-without-report" }, { blockReason: "native-uncertain" },
    { blockReason: "deleting" }].map(extra => convertibleMissionSchedule(schedule(extra))),
  [true, true, false, false, false, false, false, true, true, true, false, false])
})

test("a running schedule is saved paused under its identity, deleted, then resumed", async () => {
  const s = steps()
  await convertMissionSchedule(schedule(), s)
  assert.deepEqual(s.calls.map(call => (call as unknown[])[0]), ["save", "remove", "resume"])
  const [, calendar, configuration] = s.calls[0] as [string, string, Record<string, unknown>]
  assert.equal(calendar, "msn_sync")
  assert.deepEqual(Object.keys(configuration).sort(), ["launch", "objective", "taskMode", "template", "title", "watchedConversationIDs"])
  assert.deepEqual(s.calls[2], ["resume", "msn_sync"])
})

test("a paused schedule and one held by a failed passage stay paused, and a failed step leaves the schedule in charge", async () => {
  for (const extra of [{ state: "paused" }, { blockReason: "failed" }]) {
    const paused = steps()
    await convertMissionSchedule(schedule(extra), paused)
    assert.deepEqual(paused.calls.map(call => (call as unknown[])[0]), ["save", "remove"], JSON.stringify(extra))
  }
  const refused = steps("save")
  await assert.rejects(convertMissionSchedule(schedule(), refused))
  assert.equal(refused.calls.length, 1, "nothing is deleted when the save is refused")
  const kept = steps("remove")
  await assert.rejects(convertMissionSchedule(schedule(), kept))
  assert.deepEqual(kept.calls.map(call => (call as unknown[])[0]), ["save", "remove"], "never resumed beside a schedule still there")
  const retried = steps("resume")
  await convertMissionSchedule(schedule(), retried)
  assert.deepEqual(retried.calls.map(call => (call as unknown[])[0]), ["save", "remove", "resume", "resume"])
})
