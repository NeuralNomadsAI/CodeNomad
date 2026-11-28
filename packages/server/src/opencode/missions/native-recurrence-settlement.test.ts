import assert from "node:assert/strict"
import test from "node:test"
import { passageFixture } from "./native-passage-test-fixture"
import { passageFamilyRoots } from "./native-recurrence-settlement"

test("native-bound child actors are reached through their parent, never seeded as walk roots", async () => {
  const parents: Record<string, string | undefined> = { ses_coordinator: undefined, ses_child_actor: "ses_coordinator",
    ses_grandchild_actor: "ses_root_actor", ses_root_actor: undefined }
  const native = { session: async (id: string) => ({ parentID: parents[id] }) as never }
  assert.deepEqual(await passageFamilyRoots(native, "ses_coordinator",
    ["ses_coordinator", "ses_child_actor", "ses_grandchild_actor", "ses_root_actor", "ses_child_actor"]),
  ["ses_coordinator", "ses_root_actor"])
})

// Integrator decision: a business failed report and a native terminal failure
// without a completed report are both failed; a completed final report stands.
for (const [name, report, nativeFailure, outcome] of [
  ["business mission_report(outcome: failed) settles failed", "failed", false, "failed"],
  ["native terminal failure without a completed report settles failed", undefined, true, "failed"],
  ["completed final report stands despite a later native wrap-up failure", "completed", true, "completed"],
] as const) test(name, async () => {
  const f = await passageFixture()
  await f.start()
  if (report) await f.finish(report)
  if (nativeFailure) f.states.get(f.passage.coordinatorSessionID)!.failed = true
  const settled = await f.observe()
  assert.equal(settled?.outcome, outcome)
})

for (const report of [false, true]) test(report ? "a final report without backend presence settles completed" : "idle passage without a report ends without report", async () => {
  const f = await passageFixture()
  await f.start()
  if (report) await f.finish()
  const observe = async () => f.observe()
  assert.equal((await observe())?.outcome, report ? "completed" : "ended-without-report")
  f.pendingForm = true
  assert.equal(await observe(), undefined, "a pending Form blocks even a real final report")
  f.pendingForm = false
  const child = "ses_native_child"
  f.sessions.set(child, { id: child, parentID: f.passage.coordinatorSessionID, projectID: "project", location: { directory: f.root } })
  f.states.set(child, { ...f.states.get(f.passage.coordinatorSessionID)!, id: child, parentID: f.passage.coordinatorSessionID, active: true })
  assert.equal(await observe(), undefined, "background descendant still running")
  f.states.get(child)!.active = false
  assert.equal((await observe())?.outcome, report ? "completed" : "ended-without-report")
  f.states.get(child)!.runningTools = 1
  assert.equal(await observe(), undefined, "a live tool still blocks")
})

test("a completed business report cannot override an old claim or missing native terminal evidence", async () => {
  const f = await passageFixture()
  await f.start(); await f.finish()
  const state = f.states.get(f.passage.coordinatorSessionID)!
  const observe = async () => f.observe()
  const before = await f.document()
  for (const orphaned of [false, true]) {
    state.suspended = true; state.orphaned = orphaned
    for (let wake = 0; wake < 3; wake++) assert.equal(await observe(), undefined)
  }
  state.suspended = false
  delete state.terminal
  assert.equal(await observe(), undefined, "no terminal proof remains uncertain")
  state.terminal = { inputMessageID: "msg_unrelated", messageID: "msg_idle", outcome: "succeeded" }
  assert.equal(await observe(), undefined, "another input's proof cannot close the pending original")
  state.terminal.inputMessageID = f.passage.messageID
  const child = "ses_old_claim_child"
  f.sessions.set(child, { id: child, parentID: state.id, projectID: "project", location: { directory: f.root } })
  f.states.set(child, { ...structuredClone(state), id: child, parentID: state.id, suspended: true, orphaned: true })
  for (let wake = 0; wake < 3; wake++) assert.equal(await observe(), undefined, "every old family claim blocks, even with coordinator report and terminal")
  assert.deepEqual(await f.document(), before)
  assert.equal(f.counts().sends, 1, "observation sends no replacement or continuation")
})

test("an external reused root keeps settlement uncertain even with quiet sessions and terminal idles", async () => {
  const f = await passageFixture()
  await f.start()
  const id = "ses_reused_external"
  f.sessions.set(id, { id, projectID: "project", location: { directory: f.root }, agent: "build", model: { providerID: "unit", id: "model" },
    metadata: { "codenomad.mission": { missionID: f.passage.missionID, document: { missionID: "schedule", passageID: f.passage.passageID } } } })
  f.states.set(id, { ...structuredClone(f.states.get(f.passage.coordinatorSessionID)!), id })
  await f.business(control => control.delegate(f.passage.coordinatorSessionID, { taskKey: "external", title: "Reused root", brief: "Bounded work",
    role: "specialist", blockedBy: [], delivery: "queue", targetSessionID: id,
    executionMode: { kind: "independent", reason: "existing-root", explanation: "Explicitly reusing an external root" } }))
  assert.equal(await f.observe(), undefined)
})

test("a terminal changing during the asynchronous family recheck keeps the original pending", async () => {
  const f = await passageFixture()
  await f.start(); await f.finish()
  const read = f.observation.session
  let reads = 0
  f.observation.session = async (id, messageID) => {
    if (++reads === 2) f.states.get(id)!.terminal!.messageID = "msg_later_terminal"
    return read(id, messageID)
  }
  assert.equal(await f.observe(), undefined)
  assert.ok((await f.document()).pending)
  assert.equal(f.counts().sends, 1)
})
