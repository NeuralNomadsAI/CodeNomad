import assert from "node:assert/strict"
import test from "node:test"
import { assertRecurrenceDispatchFeasible, recurrenceInputBudget, recurrenceReadBudget, recurrenceSourceContextLimit,
  RECURRENCE_SOURCE_CONTEXT_HEADER, RECURRENCE_SOURCE_REFERENCE_RESERVE } from "./recurrence-read-budget"
import { NativeMissionRecurrenceStore } from "./recurrence-store"
import { MissionRecurrenceRunner } from "./recurrence-runner"
import type { MissionStorage } from "./journal"
import type { RecurrenceConfig } from "./recurrence-contract"

test("fixed passage effects and every source batch are preflighted without enlarging human budgets", () => {
  const budgets = { effects: 3, inboxMessages: 32 }
  assert.equal(recurrenceReadBudget(0, budgets).sufficient, true)
  assert.deepEqual(recurrenceReadBudget(1, budgets), { sufficient: false, effectsMinimum: 4, inboxMinimum: 1, readLimit: 32 })
  assert.equal(recurrenceReadBudget(2, { effects: 5, inboxMessages: 1 }).sufficient, false)
  assert.equal(recurrenceReadBudget(2, { effects: 5, inboxMessages: 3 }).readLimit, 1)
  assert.equal(recurrenceReadBudget(1, { effects: 4, inboxMessages: 256 }).readLimit, 32)
  assert.deepEqual(budgets, { effects: 3, inboxMessages: 32 })
})

test("whole deterministic source input reserves native evidence and JSON/Location/cursor envelopes", () => {
  const config = { consigne: "Original consigne", roots: [{ directory: "/owned/project" }], watchedConversationIDs: ["ses_watched"] }
  const budget = recurrenceInputBudget(config)
  const messages = [{ id: "msg_source", type: "user", text: "x".repeat(900) }]
  assert(JSON.stringify(messages).length <= 1024)
  const text = config.consigne + RECURRENCE_SOURCE_CONTEXT_HEADER + JSON.stringify([{ conversationID: "ses_watched",
    directory: "/owned/project", afterMessageID: null, limit: 32, messages }])
  assert(text.length <= budget.textMaximum)
  assert.equal(recurrenceInputBudget({ ...config, consigne: "x".repeat(budget.instructionsMaximum) }).sufficient, true)
  assert.equal(recurrenceInputBudget({ ...config, consigne: "x".repeat(budget.instructionsMaximum + 1) }).sufficient, false)
  assert.throws(() => assertRecurrenceDispatchFeasible(config, { effects: 3, inboxMessages: 32 }), /insufficient signed source budget/)
  assert.equal(config.consigne, "Original consigne")
})

test("quiet sources release text room for full later replies, while future exact references retain reserved room", () => {
  const config = { consigne: "Review new replies", roots: [{ directory: "/owned/project" }], watchedConversationIDs: ["ses_one", "ses_two"] }
  const first = recurrenceSourceContextLimit(config, [])
  const quietThenSecond = recurrenceSourceContextLimit(config, [[]])
  assert.equal(quietThenSecond, first + RECURRENCE_SOURCE_REFERENCE_RESERVE - 2)
  assert(quietThenSecond > 8 * 1024)
  const full = [{ id: "msg_one", type: "assistant", text: "x".repeat(8 * 1024), nativeDigest: "a".repeat(64), completedAt: 3 }]
  assert.equal(recurrenceSourceContextLimit(config, [full]), quietThenSecond - JSON.stringify(full).length + 2)
  const worstEnvelopes = config.watchedConversationIDs.map((conversationID, index) => ({ conversationID, directory: "/owned/project",
    workspaceID: "x".repeat(240), afterMessageID: "x".repeat(240), limit: 32, contextLimit: 16_384,
    messages: index ? [{ id: "msg_needs_decision", type: "assistant", text: "", nativeDigest: "b".repeat(64), completedAt: 4, needsDecision: "source-input-capacity" }] : full }))
  assert(config.consigne.length + RECURRENCE_SOURCE_CONTEXT_HEADER.length + JSON.stringify(worstEnvelopes).length <= 16_384)
})

test("oversized watched input is an explicit no-effect runner result, without a pending passage or authority/native calls", async () => {
  const values = new Map<string, unknown>()
  const storage: MissionStorage = { get: async key => values.get(key) as never,
    set: async (key, value) => { values.set(key, value) },
    scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: value as never })) }) }
  const config: RecurrenceConfig = { template: "custom", consigne: "x".repeat(16_000), clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
    profiles: { coordinator: { agent: "build", model: { providerID: "fixture", id: "model" } },
      roles: { specialist: { agent: "build", model: { providerID: "fixture", id: "model" } } } }, taskMode: "native",
    roots: [{ mode: "git", directory: "/owned/project", checkout: "/owned/project", family: "/owned/project/.git" }],
    watchedConversationIDs: ["ses_watched"], publication: { policy: "disabled", conversationIDs: [] } }
  const calendar = new NativeMissionRecurrenceStore(storage, "project", "/owned/project")
  const document = await calendar.create("schedule", config, 1, () => true)
  let calls = 0
  const runner = new MissionRecurrenceRunner(calendar, { authorize: async () => { calls++; return () => true },
    admit: async () => { calls++; throw Error("must not admit oversized input") } }, () => 10)
  assert.equal(await runner.trigger(document.id, document.revision, "manual_request"), "rejected-before-effect")
  assert.equal(calls, 0)
  assert.deepEqual(await calendar.read(document.id), document)
})

test("signed source-budget feasibility rejects before calendar high-water/reservation, including an async preparation race", async () => {
  const values = new Map<string, unknown>()
  let beforeWrite = () => {}
  const storage: MissionStorage = { get: async key => values.get(key) as never,
    set: async (key, value, fence) => { await Promise.resolve(); beforeWrite(); fence?.(); values.set(key, value) },
    scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: value as never })) }) }
  const config: RecurrenceConfig = { template: "custom", consigne: "Review replies", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
    profiles: { coordinator: { agent: "build", model: { providerID: "fixture", id: "model" } },
      roles: { specialist: { agent: "build", model: { providerID: "fixture", id: "model" } } } }, taskMode: "native",
    roots: [{ mode: "git", directory: "/owned/project", checkout: "/owned/project", family: "/owned/project/.git" }],
    watchedConversationIDs: ["ses_watched"], publication: { policy: "disabled", conversationIDs: [] } }
  const calendar = new NativeMissionRecurrenceStore(storage, "project", "/owned/project")
  let document = await calendar.create("schedule", config, 1, () => true)
  document = await calendar.setState(document.id, document.revision, "running", () => true)
  let signedBudgets = { effects: 3, inboxMessages: 32 }, nativeCalls = 0
  const runner = new MissionRecurrenceRunner(calendar, {
    authorize: async doc => {
      assertRecurrenceDispatchFeasible(doc.config, signedBudgets)
      return () => assertRecurrenceDispatchFeasible(doc.config, signedBudgets)
    },
    admit: async () => { nativeCalls++; throw Error("must not admit") },
  }, () => Date.parse("2026-10-08T08:00:00Z"))
  for (const budgets of [{ effects: 3, inboxMessages: 32 }, { effects: 4, inboxMessages: 0 }]) {
    signedBudgets = budgets
    await assert.rejects(runner.tick(document.id), /insufficient signed source budget/)
    assert.deepEqual(await calendar.read(document.id), document)
  }
  signedBudgets = { effects: 4, inboxMessages: 32 }
  beforeWrite = () => { signedBudgets = { effects: 3, inboxMessages: 32 } }
  await assert.rejects(runner.tick(document.id), /policy-unqualified/)
  assert.deepEqual(await calendar.read(document.id), document, "final sync fence preserves pending=null and original daily high-water")
  assert.equal(nativeCalls, 0)
})
