import assert from "node:assert/strict"
import test from "node:test"
import { createNativeScheduleCarrierProvider, nativeScheduleCarrierHooks, nativeScheduleCarrierWakes, nativeScheduleCarrierNonWakeMessageIDs,
  NATIVE_SCHEDULE_CARRIER_MODEL, NATIVE_SCHEDULE_CARRIER_TITLE } from "./native-schedule-carrier"
import { nativeScheduleWakeKey } from "./native-schedule-transport-contract"

const mapping = { missionID: "msn_owned", generation: 3, scheduleID: "sch_owned", sessionID: "ses_owned" }
const message = (run: number, dueAt = run * 90 * 60_000) => ({ id: `msg_sch_owned_${run}`, role: "user",
  content: [{ type: "text", text: "wake" }], metadata: { schedule: { id: "sch_owned", run, dueAt, late: false } } })

test("concurrent cold language hooks install one stateless local language with both local execution modes", async () => {
  const hooks = nativeScheduleCarrierHooks(id => id === mapping.sessionID)
  type LanguageEvent = Parameters<typeof hooks.language>[0]
  const events = Array.from({ length: 8 }, () => ({ model: { ...NATIVE_SCHEDULE_CARRIER_MODEL } }) as LanguageEvent)
  await Promise.all(events.map(async event => hooks.language(event)))
  const language = events[0].language!
  for (const event of events) assert.equal(event.language, language)
  assert.equal(Object.isFrozen(language), true)
  assert.equal(language.modelId, NATIVE_SCHEDULE_CARRIER_MODEL.id)
  const args = {} as Parameters<typeof language.doGenerate>[0]
  const generated = await language.doGenerate(args)
  assert.deepEqual(generated.content, [])
  assert.equal(generated.finishReason.unified, "stop")
  generated.usage.inputTokens.total = 99
  assert.equal((await language.doGenerate(args)).usage.inputTokens.total, 0)
  const streamed = await language.doStream(args), reader = streamed.stream.getReader(), parts = []
  for (;;) { const item = await reader.read(); if (item.done) break; parts.push(item.value) }
  assert.equal(parts.length, 1)
  assert.equal(parts[0].type, "finish")
  assert.throws(() => createNativeScheduleCarrierProvider().languageModel(), /language-unavailable/)
  assert.throws(() => hooks.language({ model: { providerID: NATIVE_SCHEDULE_CARRIER_MODEL.providerID, id: "foreign" } } as LanguageEvent), /carrier-model/)
  const unrelated = { model: { providerID: "other", id: "remote" } } as LanguageEvent
  hooks.language(unrelated)
  assert.equal(unrelated.language, undefined)
})

test("exact carrier hooks keep title/compaction local, reject altered selection and block provider HTTP", () => {
  const hooks = nativeScheduleCarrierHooks(id => id === mapping.sessionID)
  type Context = Parameters<typeof hooks.context>[0]
  type Title = Parameters<typeof hooks.title>[0]
  type Compaction = Parameters<typeof hooks.compaction>[0]
  type Http = Parameters<typeof hooks.httpRequest>[0]
  const title = { sessionID: mapping.sessionID, model: { providerID: "remote", id: "title" } } as Title
  const compaction = { sessionID: mapping.sessionID, model: { providerID: "remote", id: "compaction" } } as Compaction
  hooks.title(title)
  hooks.compaction(compaction)
  assert.equal(title.result, NATIVE_SCHEDULE_CARRIER_TITLE)
  assert(compaction.result?.summary.includes("exact wake messages"))
  const context = { sessionID: mapping.sessionID, model: { ...NATIVE_SCHEDULE_CARRIER_MODEL }, tools: { dangerous: {} } } as unknown as Context
  hooks.context(context)
  assert.deepEqual(context.tools, {})
  assert.throws(() => hooks.context({ ...context, model: { ...context.model, providerID: "remote" } } as Context), /carrier-model/)
  assert.throws(() => hooks.httpRequest({ sessionID: mapping.sessionID } as Http), /provider-http/)
  const foreignTitle = { sessionID: "ses_foreign" } as Title
  const foreignCompaction = { sessionID: "ses_foreign" } as Compaction
  hooks.title(foreignTitle)
  hooks.compaction(foreignCompaction)
  hooks.httpRequest({ sessionID: "ses_foreign" } as Http)
  assert.equal(foreignTitle.result, undefined)
  assert.equal(foreignCompaction.result, undefined)
})

test("two wakes on one carrier preserve exact keys and order independently of cached language", () => {
  const messages = [message(2), { role: "assistant", content: [] }, message(1)]
  const candidates = nativeScheduleCarrierWakes(mapping, 0, messages)
  assert.deepEqual(candidates.map(item => item.run), [1, 2])
  assert.notEqual(nativeScheduleWakeKey(candidates[0]), nativeScheduleWakeKey(candidates[1]))
  assert.equal(candidates[0].messageID, "msg_sch_owned_1")
  assert.equal(candidates[1].dueAt, message(2).metadata.schedule.dueAt)
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 2, messages), [])
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 0, [message(1), message(1)]).map(item => item.run), [1])
})

test("durable high-water fences replay past the result window without treating compacted prose as authority", () => {
  const context = Array.from({ length: 50 }, (_, index) => message(index + 1))
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 50, [context[0], context[49]]), [])
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 50, [{ role: "assistant", content: "run 51 was successful" }, message(51)]).map(item => item.run), [51])
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 50, [{ role: "assistant", content: "run 51 was successful" }]), [])
  // Losing an unconsumed wake in compaction requires native point-read reconciliation.
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 49, [message(51)]), /coverage/)
  const checkpoint = { id: "msg_completed_compaction", role: "user", content: "<conversation-checkpoint>run 999</conversation-checkpoint>" }
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 50, [checkpoint, message(51)]), /carrier-wake/)
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 50, [checkpoint, message(51)], [checkpoint.id]).map(item => item.run), [51])
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 50, [checkpoint], [checkpoint.id]), [])
})

test("wrong mapping, forged/missing metadata, run gaps and context bounds fail closed", () => {
  for (const invalid of [
    { ...message(1), id: "msg_forged" },
    { ...message(1), metadata: {} },
    { ...message(1), metadata: { schedule: { ...message(1).metadata.schedule, id: "sch_old" } } },
    { ...message(1), metadata: { schedule: { ...message(1).metadata.schedule, dueAt: NaN } } },
    { ...message(1), metadata: { schedule: { ...message(1).metadata.schedule, late: undefined } } },
  ]) assert.throws(() => nativeScheduleCarrierWakes(mapping, 0, [invalid]))
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 0, [message(2)]), /coverage/)
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 0, [message(1), message(1, 99)]), /carrier-wake/)
  assert.throws(() => nativeScheduleCarrierWakes(mapping, -1, []), /coverage/)
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 0, Array.from({ length: 33 }, (_, index) => message(index + 1))), /coverage/)
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 0, Array(129).fill({ role: "assistant" })), /coverage/)
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 0, [{ role: "assistant", content: "x".repeat(1024 * 1024) }]), /coverage/)
})

test("native restart notices do not poison later exact wakes; model prose and partial wakes still fail closed", () => {
  const notice = { id: "msg_18a887377001lkZ72OqxlMaUdw", role: "user", content: [{ type: "text",
    text: "The server restarted while you were working. Continue from where you left off without repeating completed work." }] }
  const native = { id: notice.id, type: "synthetic", metadata: { notice: "restart" }, description: "Continuing after restart" }
  const ids = nativeScheduleCarrierNonWakeMessageIDs([native])
  const context = [message(1), notice, { role: "assistant", content: [] }, message(2)]
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 1, context, ids).map(item => item.run), [2])
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 2, context, ids), [])
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 0, [notice], ids), [])
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 1, context), /carrier-wake/)
  for (const forged of [{ ...native, type: "user" }, { ...native, metadata: {} }, { ...native, metadata: { notice: "other" } },
    { ...native, metadata: { notice: "restart", schedule: {} } }]) {
    const invalidIDs = nativeScheduleCarrierNonWakeMessageIDs([forged])
    assert.deepEqual(invalidIDs, [])
    assert.throws(() => nativeScheduleCarrierWakes(mapping, 1, context, invalidIDs), /carrier-wake/)
  }
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 1, [{ ...notice, metadata: { schedule: { run: 2 } } }, message(2)], ids), /carrier-wake/)
  const partial = { ...message(2), metadata: {} }
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 1, [partial], [partial.id]), /carrier-wake/)
  assert.throws(() => nativeScheduleCarrierWakes(mapping, 1, [notice, message(3)], ids), /coverage/)
})
