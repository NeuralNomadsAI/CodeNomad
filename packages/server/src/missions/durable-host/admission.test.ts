import assert from "node:assert/strict"
import test from "node:test"
import { assignmentInput } from "../inputs"
import { MissionJournal } from "../journal"
import { fixture, existingRootExecution } from "./test-fixture"

const task = (missionID: string) => ({ missionID, taskKey: "task", title: "One", brief: "Private fixture task", role: "worker",
  targetSessionID: "ses_test_actor", blockedBy: [], delivery: "queue", ...existingRootExecution() })

test("real plugin assignments and reports share canonical admitMissionInput transport without direct SDK fallback", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  const missionID = (await f.authority.read())!.binding.missionID
  const assigned = await f.runTool("delegate", task(missionID))
  assert.equal(assigned.mission.tasks[0].actorSessionId, "ses_test_actor")
  assert.equal(f.counts.prompts, 1); assert.equal(f.counts.environments, 2)
  const reported = await f.runTool("report", { missionID, taskKey: "task", outcome: "completed", summary: "Saved native evidence" }, "ses_test_actor")
  assert.equal(reported.mission.reports[0].notificationStatus, "admitted")
  assert.equal(f.counts.synthetics, 2); assert.equal(f.counts.environments, 3)
})

test("protected signer/grant changes during assignment environment preparation stop before environment/prompt", async t => {
  for (const fault of ["signer", "grant"] as const) {
    const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
    const state = (await f.authority.read())!
    f.setEnvironmentPreparation(async () => {
      if (fault === "signer") await f.changeGeneration()
      else await f.authority.revoke(f.request, state.revision)
    })
    await assert.rejects(f.runTool("delegate", task(state.binding.missionID)))
    assert.equal(f.counts.prompts, 0); assert.equal(f.counts.environments, 1)
    const map = (await new MissionJournal(f.storage, "test-project", f.project).snapshot()).missions[0]
    assert(map.tasks[0].admissionId, "saved original assignment identity remains evidence, not a replay trigger")
  }
})

test("signer/grant change in native recovery readiness prevents environment/synthetic and retains reservation", async t => {
  for (const fault of ["signer", "grant"] as const) {
    const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
    f.setReadinessPreparation(async () => {
      if (fault === "signer") await f.changeGeneration()
      else { const state = (await f.authority.read())!; await f.authority.revoke(f.request, state.revision) }
    })
    await assert.rejects(f.action("recover", { target: "coordinator" }))
    assert.equal(f.counts.environments, 1); assert.equal(f.counts.synthetics, 1)
    const native = await f.nativeStore.read()
    assert(native.receipts.some(receipt => receipt.intent.method === "recover" && !receipt.completion))
  }
})

test("assignment native environment ACK cannot conceal protected revocation before actual prompt", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  const state = (await f.authority.read())!
  f.setEnvironmentWrite(async () => { await f.authority.revoke(f.request, state.revision) })
  await assert.rejects(f.runTool("delegate", task(state.binding.missionID)))
  assert.equal(f.counts.environments, 2); assert.equal(f.counts.prompts, 0)
  assert.equal((await f.authority.read())!.state, "revoked")
})

test("an actual live dispatch command is reconstructed from native map, not trusted transport text", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  const missionID = (await f.authority.read())!.binding.missionID
  const execute = f.host.transport.execute.bind(f.host.transport)
  f.host.transport.execute = (request, options) => execute(request.kind === "prompt"
    ? { ...request, input: { ...request.input, text: "forged dispatch" } } : request, options)
  await assert.rejects(f.runTool("delegate", task(missionID)))
  assert.equal(f.counts.prompts, 0); assert.equal(f.counts.environments, 1)
})

test("transport rejects a tampered full grant or input contract and honors the real deletion fence", { timeout: 15_000 }, async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  const state = (await f.authority.read())!
  await f.runTool("delegate", task(state.binding.missionID))
  const map = (await new MissionJournal(f.storage, "test-project", f.project).snapshot()).missions[0]
  const command = { kind: "prompt" as const, coordinatorID: state.binding.coordinatorSessionID,
    input: assignmentInput(map, map.tasks[0]), grant: { ...state.mirror!, epoch: state.epoch + 1 }, intent: null }
  await assert.rejects(f.host.transport.execute(command, { signal: f.signal, assertCurrent: async () => {} }))
  assert.equal(f.counts.prompts, 1)
  await assert.rejects(f.host.transport.execute({ ...command, grant: state.mirror!, input: { ...command.input, text: "browser substitution" } },
    { signal: f.signal, assertCurrent: async () => {} }))
  assert.equal(f.counts.prompts, 1)
  let release!: () => void
  const blocked = f.deps.fence.run("worktree-fixture", ["worktree-fixture"], () => new Promise<void>(resolve => { release = resolve }))
  try {
    // Admission must fail while the real existing fence owns this directory.
    await assert.rejects(f.runTool("delegate", { ...task(state.binding.missionID), taskKey: "blocked-task" }))
  } finally { release(); await blocked }
  assert.equal(f.counts.prompts, 1)
})
