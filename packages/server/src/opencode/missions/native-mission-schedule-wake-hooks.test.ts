import assert from "node:assert/strict"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { registerNativeMissionScheduleCarrierHooks } from "./native-mission-schedule-wake-hooks"
import { NATIVE_SCHEDULE_CARRIER_SIGNAL, NATIVE_SCHEDULE_CARRIER_MARKER } from "./native-schedule-carrier-binding"

test("production hooks keep paused, attempted and retiring title/compaction local with remote auxiliary defaults", async t => {
  for (const phase of ["paused", "attempted", "retiring"] as const) {
    const f = await ownerFixture(t)
    if (phase === "attempted") f.loseCreateACK("reconciliation")
    let doc = await f.control("play")
    const sessionID = doc.calendarOwner!.slots.find(slot => slot.role === "reconciliation")!.sessionID
    if (phase === "paused") doc = await f.control("pause")
    if (phase === "retiring") { f.blocked.add(sessionID); doc = await f.control("stop") }
    const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
    const ctx = { ...f.ctx,
      session: { ...f.ctx.session, hook: (name: string, use: (event: any) => Effect.Effect<void>) => Effect.sync(() => { hooks.set(name, use) }) } } as unknown as Plugin.Context
    await Effect.runPromise(Effect.scoped(registerNativeMissionScheduleCarrierHooks(ctx)))
    const title = { sessionID, model: { providerID: "remote", id: "paid-title" }, result: undefined as string | undefined }
    await Effect.runPromise(hooks.get("title")!(title))
    assert.equal(title.result, "Mission schedule carrier")
    const compaction = { sessionID, model: { providerID: "remote", id: "paid-summary" }, result: undefined as { summary: string } | undefined }
    await Effect.runPromise(hooks.get("compaction")!(compaction))
    assert.match(compaction.result!.summary, /schedule carrier/)
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ sessionID, model: title.model, kind: "title" })), /provider-http/)
    f.sessions.get(sessionID).metadata[NATIVE_SCHEDULE_CARRIER_MARKER].missionID = "foreign_mission"
    await assert.rejects(Effect.runPromise(hooks.get("title")!(title)), /ownership/)
    await assert.rejects(Effect.runPromise(hooks.get("compaction")!(compaction)), /ownership/)
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ sessionID, model: title.model })), /ownership/)
  }
})

test("owned carriers refuse prompts and LLM context turns while blocking provider HTTP", async t => {
  const f = await ownerFixture(t)
  const doc = await f.control("play")
  const sessionID = doc.calendarOwner!.slots.find(slot => slot.role === "reconciliation")!.sessionID
  const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
  const ctx = { ...f.ctx,
    session: { ...f.ctx.session, hook: (name: string, use: (event: any) => Effect.Effect<void>) => Effect.sync(() => { hooks.set(name, use) }) } } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerNativeMissionScheduleCarrierHooks(ctx)))
  const scheduleID = doc.calendarOwner!.slots.find(slot => slot.sessionID === sessionID)!.scheduleID!
  const validPrompt = { sessionID, messageID: `msg_${scheduleID}_1`,
    prompt: { text: NATIVE_SCHEDULE_CARRIER_SIGNAL }, metadata: { schedule: { id: scheduleID, run: 1, dueAt: 1000, late: false } } }
  await assert.rejects(Effect.runPromise(hooks.get("prompt")!(validPrompt)), /carrier-prompt/)
  await assert.rejects(Effect.runPromise(hooks.get("context")!({ sessionID })), /carrier-context/)
  delete f.sessions.get(sessionID).model
  await assert.rejects(Effect.runPromise(hooks.get("prompt")!(validPrompt)), /carrier-prompt/)
  await assert.rejects(Effect.runPromise(hooks.get("context")!({ sessionID, model: { providerID: "remote", id: "chat" }, messages: [], tools: {} })), /carrier-context/)
  await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ sessionID, model: { providerID: "remote", id: "chat" } })), /provider-http/)
})
