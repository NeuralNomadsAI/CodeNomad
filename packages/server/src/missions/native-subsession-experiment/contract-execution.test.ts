import assert from "node:assert/strict"
import test from "node:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { parseExecution } from "../execution"
import {
  assertActualExecution, prepareNativeContractExecution,
  type ContractBinding, type ContractExecutionReads, type ContractReference, type NativeContractContext, type NativeContractTask,
} from "./contract-execution"

// Structural policy doubles only. No native execution, plugin registration,
// storage, SDK service, provider, database or authentication is exercised here.
function fixture() {
  const old: ContractBinding = { missionID: "experiment", revision: 1, taskKey: "old-task", parentID: "parent", childID: "child", callID: "call-old", messageID: "message-old", depth: 1 }
  const ref: ContractReference = { missionID: "experiment", revision: 1, taskKey: "new-task" }
  const model = Model.Info.default("fixture" as Model.Info["providerID"], Model.ID.make("family/reasoner"))
  const execution = parseExecution({ agent: "explore", model: { providerID: "fixture", id: "family/reasoner", variant: "high" } })!
  const task: NativeContractTask = { key: ref.taskKey, execution, reuseFromTaskKey: old.taskKey }
  const nativeInput: Record<string, unknown> = { agent: "explore", model: "fixture/family/reasoner#high", sessionID: "child", prompt: "unchanged", description: "unchanged" }
  const sessions = new Map<string, Awaited<ReturnType<NativeContractContext["session"]["get"]>>>([
    ["parent", { id: "parent", projectID: "project", location: { directory: "/owned" } }],
    ["child", { id: "child", parentID: "parent", projectID: "project", location: { directory: "/owned" }, ...execution }],
  ])
  let current: ContractBinding | undefined = old
  let report: Awaited<ReturnType<ContractExecutionReads["readReport"]>> = { id: "report-old", contract: { ...old }, sessionId: "child", outcome: "completed" }
  let receipt: Awaited<ReturnType<ContractExecutionReads["readReturned"]>> = { ...old, contract: { ...old }, nativeReturned: true, reportID: "report-old" }
  const catalogLocations: string[] = []
  const agents: Array<{ id: Agent.Info["id"]; mode: Agent.Info["mode"]; hidden: boolean }> = [{ id: Agent.ID.make("explore"), mode: "subagent", hidden: false }]
  const models = [{ ...model, enabled: Boolean(model.enabled),
    capabilities: { ...model.capabilities, tools: Boolean(model.capabilities.tools) },
    variants: [{ id: Model.VariantID.make("high") }] }]
  let idleChecks = 0
  const ctx: NativeContractContext = {
    location: { directory: "/owned", project: { id: "project" } },
    agent: { list: async input => { catalogLocations.push(input.location.directory); return { data: agents } } },
    model: { list: async input => { catalogLocations.push(input.location.directory); return { data: models } } },
    session: { get: async ({ sessionID }) => { const session = sessions.get(sessionID); if (!session) throw new Error("unknown native session"); return session } },
  }
  const reads: ContractExecutionReads = {
    readCurrent: async () => current,
    readReport: async () => report,
    readReturned: async () => receipt,
    assertNativeIdle: async () => { idleChecks++ },
  }
  return { old, ref, task, nativeInput, sessions, ctx, reads, agents, models, catalogLocations,
    get idleChecks() { return idleChecks },
    get current() { return current }, set current(value) { current = value },
    get report() { return report }, set report(value) { report = value },
    get receipt() { return receipt }, set receipt(value) { receipt = value },
    prepare: () => prepareNativeContractExecution(ctx, task, ref, "parent", nativeInput, reads),
  }
}

test("native subagent mode and slash-containing model ID/variant map without input mutation", async () => {
  const f = fixture(), original = structuredClone(f.nativeInput)
  const prepared = await f.prepare()
  try {
    assert.deepEqual(prepared.request, f.task.execution)
    await prepared.revalidateBeforeNative()
    await prepared.assertProgressChild("child")
    assert.equal(f.idleChecks, 1)
    assert.deepEqual(f.nativeInput, original)
    assert.deepEqual(f.catalogLocations, Array(4).fill("/owned"))
  } finally { prepared.release() }
})

test("native input must match every explicitly requested selection BEFORE admission", async () => {
  for (const change of [{ agent: "other" }, { model: "fixture/other#high" }, { model: "fixture/family/reasoner" }, { model: undefined }, { agent: undefined }]) {
    const f = fixture(); Object.assign(f.nativeInput, change)
    await assert.rejects(f.prepare(), /does not match/)
    assert.equal(f.idleChecks, 0)
  }
  for (const model of [{ providerID: "fixture", id: "family/reasoner", variant: "high" }, "fixture/family/reasoner#", "fixture/family/reasoner#high#other"]) {
    const f = fixture(); f.nativeInput.model = model
    await assert.rejects(f.prepare(), /model|reference/i)
  }
})

test("actual context gate checks model variant exactly; role never picks agent", async () => {
  const f = fixture()
  assertActualExecution(parseExecution(f.task.execution), parseExecution(f.task.execution)!)
  assert.throws(() => assertActualExecution(parseExecution(f.task.execution), { agent: "explore", model: Model.Ref.parse("fixture/family/reasoner") }), /does not match/)
  assert.throws(() => assertActualExecution(parseExecution(f.task.execution), { agent: "other", model: Model.Ref.parse("fixture/family/reasoner#high") }), /does not match/)
  f.task.execution = undefined; f.nativeInput.agent = "not-a-role"
  const prepared = await f.prepare()
  assert.equal(prepared.request, undefined); prepared.release()
})

test("catalog rejects primary-only/hidden/unknown agents, disabled/non-tool models and missing variants", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.agents[0].hidden = true }, f => { f.agents.length = 0 }, f => { f.agents[0].mode = "primary" },
    f => { f.models[0].enabled = false }, f => { f.models[0].capabilities = { ...f.models[0].capabilities, tools: false } },
    f => { f.models[0].variants = [] }, f => { f.models.length = 0 },
  ]
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.prepare(), /visible|enabled/) }
  const f = fixture(); f.task.execution = { role: "review" }
  await assert.rejects(f.prepare(), /Unknown execution field/)
  const all = fixture(); all.agents[0].mode = "all"
  const allowed = await all.prepare(); allowed.release()
})

test("cross-task continuation requires explicit same-mission old binding/report/returned receipt", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.task.reuseFromTaskKey = undefined }, f => { f.task.reuseFromTaskKey = "other" },
    f => { f.current = undefined }, f => { f.current = { ...f.old, missionID: "foreign" } },
    f => { f.current = { ...f.old, parentID: "foreign" } }, f => { f.current = { ...f.old, childID: "foreign" } },
    f => { f.report = undefined }, f => { f.report!.outcome = "failed" }, f => { f.report!.outcome = "blocked" },
    f => { f.report!.sessionId = "sibling" }, f => { f.report!.contract = { ...f.old, revision: 999 } },
    f => { f.receipt = undefined }, f => { f.receipt!.nativeReturned = false },
    f => { f.receipt!.callID = "other-call" }, f => { f.receipt!.messageID = "other-message" },
    f => { f.receipt!.contract = { ...f.old, taskKey: "other" } }, f => { f.receipt!.reportID = "other-report" },
  ]
  for (const change of changes) {
    const f = fixture(); change(f)
    const prepared = await f.prepare()
    try { await assert.rejects(prepared.revalidateBeforeNative()) } finally { prepared.release() }
    assert.equal(f.idleChecks, 0)
  }
})

test("exact old receipt may belong to prior revision; same task may not silently change revision", async () => {
  const f = fixture(); f.ref.revision = 2
  const prepared = await f.prepare()
  try { await prepared.revalidateBeforeNative() } finally { prepared.release() }
  f.ref.taskKey = f.old.taskKey; f.task.key = f.old.taskKey
  const sameTask = await f.prepare()
  try { await assert.rejects(sameTask.revalidateBeforeNative(), /exact current contract revision/) } finally { sameTask.release() }
})

test("original same-contract continuation requires idle but not previous completion or receipt", async () => {
  const f = fixture(); f.ref.taskKey = f.old.taskKey; f.task.key = f.old.taskKey; f.task.reuseFromTaskKey = undefined
  f.report = undefined; f.receipt = undefined
  const prepared = await f.prepare()
  try { await prepared.revalidateBeforeNative(); assert.equal(f.idleChecks, 1) } finally { prepared.release() }
})

test("explicit reuse refuses fresh-child input before any reader or native call without mutating input", async () => {
  for (const explicitlyUndefined of [false, true]) {
    const f = fixture()
    if (explicitlyUndefined) f.nativeInput.sessionID = undefined
    else delete f.nativeInput.sessionID
    const original = structuredClone(f.nativeInput)
    Object.freeze(f.nativeInput)
    let readerCalls = 0, nativeCalls = 0
    const unexpectedRead = async () => { readerCalls++; throw new Error("Unexpected reader call") }
    f.ctx.agent.list = unexpectedRead; f.ctx.model.list = unexpectedRead; f.ctx.session.get = unexpectedRead
    f.reads.readCurrent = unexpectedRead; f.reads.readReport = unexpectedRead
    f.reads.readReturned = unexpectedRead; f.reads.assertNativeIdle = unexpectedRead
    await assert.rejects(async () => {
      const prepared = await f.prepare()
      try { await prepared.revalidateBeforeNative(); nativeCalls++ } finally { prepared.release() }
    }, /reuseFromTaskKey requires an explicit native continuation sessionID/)
    assert.equal(readerCalls, 0); assert.equal(nativeCalls, 0)
    assert.deepEqual(f.nativeInput, original)
  }
})

test("plain new task without reuse still admits fresh-child input", async () => {
  const f = fixture(); delete f.nativeInput.sessionID; delete f.task.reuseFromTaskKey
  const original = structuredClone(f.nativeInput)
  const unexpectedEvidence = async () => { throw new Error("Fresh child must not read continuation evidence") }
  f.reads.readCurrent = unexpectedEvidence; f.reads.readReport = unexpectedEvidence
  f.reads.readReturned = unexpectedEvidence; f.reads.assertNativeIdle = unexpectedEvidence
  const prepared = await f.prepare()
  try {
    await prepared.revalidateBeforeNative()
    await prepared.assertProgressChild("child")
    assert.deepEqual(f.nativeInput, original)
  } finally { prepared.release() }
})

test("reused child now bound to the exact current task continues without reselecting its predecessor", async () => {
  const f = fixture(); f.current = { ...f.old, ...f.ref }
  f.report = undefined; f.receipt = undefined
  const unexpectedEvidence = async () => { throw new Error("Current contract must not require predecessor evidence again") }
  f.reads.readReport = unexpectedEvidence; f.reads.readReturned = unexpectedEvidence
  const prepared = await f.prepare()
  try {
    await prepared.revalidateBeforeNative()
    await prepared.assertProgressChild("child")
    assert.equal(f.idleChecks, 1)
    assert.equal(f.task.reuseFromTaskKey, f.old.taskKey)
  } finally { prepared.release() }
})

test("continuation idle injection fails closed on absent/busy/unknown observation", async () => {
  for (const idle of [undefined, async () => { throw new Error("busy") }, async () => { throw new Error("unknown") }]) {
    const f = fixture(); f.reads.assertNativeIdle = idle as ContractExecutionReads["assertNativeIdle"]
    const prepared = await f.prepare()
    try { await assert.rejects(prepared.revalidateBeforeNative(), /unavailable|busy|unknown/) } finally { prepared.release() }
  }
})

test("Location, parent and project ownership are checked from native get", async () => {
  for (const change of [{ parentID: "sibling" }, { projectID: "foreign" }, { location: { directory: "/foreign" } }, { location: { directory: "/owned", workspaceID: "foreign" } }, { id: "foreign" }]) {
    const f = fixture(); Object.assign(f.sessions.get("child")!, change)
    const prepared = await f.prepare()
    try { await assert.rejects(prepared.revalidateBeforeNative(), /ownership mismatch/) } finally { prepared.release() }
  }
  const f = fixture(); f.sessions.get("parent")!.projectID = "foreign"
  const prepared = await f.prepare()
  try { await assert.rejects(prepared.revalidateBeforeNative(), /ownership mismatch/) } finally { prepared.release() }
})

test("revalidate catches stale binding before and after awaited idle preparation", async () => {
  const f = fixture(), prepared = await f.prepare()
  f.current = { ...f.old, callID: "replaced" }
  try { await assert.rejects(prepared.revalidateBeforeNative(), /changed/); assert.equal(f.idleChecks, 0) } finally { prepared.release() }
  const g = fixture(), second = await g.prepare()
  g.reads.assertNativeIdle = async () => { g.current = { ...g.old, callID: "replaced" } }
  try { await assert.rejects(second.revalidateBeforeNative(), /changed/) } finally { second.release() }
})

test("provided previous binding cannot disagree with authoritative storage", async () => {
  const f = fixture()
  await assert.rejects(prepareNativeContractExecution(f.ctx, f.task, f.ref, "parent", f.nativeInput, f.reads, { ...f.old, callID: "stale" }), /binding changed/)
})

test("input and catalog are rechecked at admission; preparation is single-use", async () => {
  const f = fixture(), prepared = await f.prepare(); f.nativeInput.agent = "other"
  try { await assert.rejects(prepared.revalidateBeforeNative(), /does not match/); await assert.rejects(prepared.revalidateBeforeNative(), /single-use/) } finally { prepared.release() }
  const g = fixture(), second = await g.prepare(); g.agents[0].hidden = true
  try { await assert.rejects(second.revalidateBeforeNative(), /visible/) } finally { second.release() }
})

test("new-child async preparation cannot bless mutated input or admit progress early", async () => {
  for (const change of [{ agent: "other" }, { sessionID: "child" }]) {
    const f = fixture(); delete f.nativeInput.sessionID; delete f.task.reuseFromTaskKey
    const prepared = await f.prepare()
    const get = f.ctx.session.get
    f.ctx.session.get = async input => {
      await assert.rejects(prepared.assertProgressChild("child"), /not admitted/)
      Object.assign(f.nativeInput, change)
      return get(input)
    }
    try { await assert.rejects(prepared.revalidateBeforeNative(), /does not match|input changed/) } finally { prepared.release() }
  }
})

test("different task keys cannot concurrently claim one child; release permits next attempt", async () => {
  const f = fixture(), first = await f.prepare()
  const second = await prepareNativeContractExecution(f.ctx, { ...f.task, key: "sibling-task" }, { ...f.ref, taskKey: "sibling-task" }, "parent", f.nativeInput, f.reads)
  try {
    await first.revalidateBeforeNative()
    await assert.rejects(second.revalidateBeforeNative(), /already claimed/)
    await first.assertProgressChild("child")
  } finally { first.release(); second.release() }
  const next = await f.prepare()
  try { await next.revalidateBeforeNative() } finally { next.release() }
})

test("new-child claim starts at progress, validates actual selection, and stays until finally release", async () => {
  const f = fixture(); delete f.nativeInput.sessionID; delete f.task.reuseFromTaskKey
  const first = await f.prepare(), second = await f.prepare()
  try {
    await first.revalidateBeforeNative(); await second.revalidateBeforeNative()
    assert.equal(f.idleChecks, 0)
    await first.assertProgressChild("child")
    await assert.rejects(second.assertProgressChild("child"), /already claimed/)
    f.sessions.get("child")!.agent = "wrong"
    await assert.rejects(first.assertProgressChild("child"), /does not match/)
    await assert.rejects(first.assertProgressChild("parent"), /own parent/)
    await assert.rejects(first.assertProgressChild("other"), /changed its actual child/)
  } finally { first.release(); second.release() }
  await assert.rejects(first.assertProgressChild("child"), /released/)
})

test("ancestor/own session and changed progress identity refuse without waiting", async () => {
  const f = fixture(); f.nativeInput.sessionID = "parent"
  const prepared = await f.prepare()
  try { await assert.rejects(prepared.revalidateBeforeNative(), /own parent/) } finally { prepared.release() }
  const g = fixture(), second = await g.prepare()
  try {
    await assert.rejects(second.assertProgressChild("child"), /not admitted/)
    await second.revalidateBeforeNative()
    await assert.rejects(second.assertProgressChild("different"), /different child/)
  } finally { second.release() }
})
