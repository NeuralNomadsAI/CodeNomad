import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect, Exit } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { nativeMissionScheduleCodeWake } from "./native-mission-schedule-code-wake"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import type { NativeMissionScheduleIdleHint } from "./native-mission-schedule-wake-maintenance"

const unattended = Context.Reference<unknown>("@opencode/Permission/Unattended", { defaultValue: () => undefined })
const ctx = { location: { directory: "/project", project: { id: "project", canonical: "/project" } },
  storage: { get: () => Effect.succeed(undefined) },
  session: { get: () => Effect.fail({ _tag: "Session.NotFoundError" }) } } as unknown as Plugin.Context

async function refusal(tool: { sessionID: string; messageID: string }, automation = true) {
  const effect = nativeMissionScheduleCodeWake(ctx, tool as never)
  const exit = await Effect.runPromiseExit(automation ? effect.pipe(Effect.provideService(unattended, [])) : effect)
  assert(Exit.isFailure(exit))
  return JSON.stringify(exit.cause)
}

test("the wake tool refuses every caller except an unattended run of an owned carrier's calendar", async () => {
  const run = { sessionID: "ses_cn_schedule_" + "a".repeat(40), messageID: "msg_aut_scope_1" }
  assert.match(await refusal(run, false), /schedule-code-wake-caller/, "a model's own call")
  assert.match(await refusal({ ...run, messageID: "msg_ordinary" }), /schedule-code-wake-caller/)
  assert.match(await refusal({ ...run, messageID: "msg_sch_scope_1" }), /schedule-code-wake-caller/, "only native automation IDs")
  assert.match(await refusal(run), /schedule-code-wake-owner/, "a session that is no carrier")
})

test("a retained retiring auxiliary's own run asks cleanup maintenance; another automation of its carrier cannot", async t => {
  const f = await ownerFixture(t), armed = await f.control("play"), auxiliary = armed.calendars.find(item => item.role === "reconciliation")!
  f.blocked.add(auxiliary.sessionID)
  const stopped = await f.control("stop")
  assert(stopped.calendarOwner!.retired.some(item => item.descriptor.sessionID === auxiliary.sessionID && !item.scheduleRemoved))
  const hints: NativeMissionScheduleIdleHint[] = []
  const wake = (scheduleID: string) => Effect.runPromise(nativeMissionScheduleCodeWake(f.ctx, { sessionID: auxiliary.sessionID,
    messageID: `msg_${scheduleID}_1` } as never, async hint => { hints.push(hint); return true }).pipe(Effect.provideService(unattended, [])))
  assert.equal(await wake("aut_foreign"), "retired")
  assert.equal(hints.length, 0, "a different automation of the same carrier")
  assert.equal(await wake(auxiliary.scheduleID.replace(/^sch_/, "aut_")), "retired")
  assert.deepEqual(hints.map(hint => [hint.missionID, hint.sessionID]), [[stopped.id, auxiliary.sessionID]])
})