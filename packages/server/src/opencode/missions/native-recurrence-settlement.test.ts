import assert from "node:assert/strict"
import test from "node:test"
import { passageFixture } from "./native-passage-test-fixture"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"

// Integrator decision: a business failed report and a native terminal failure
// without a completed report are both failed; a completed final report stands.
for (const [name, report, nativeFailure, outcome] of [
  ["business mission_report(outcome: failed) settles failed", "failed", false, "failed"],
  ["native terminal failure without a completed report settles failed", undefined, true, "failed"],
  ["completed final report stands despite a later native wrap-up failure", "completed", true, "completed"],
] as const) test(name, async () => {
  const f = await passageFixture()
  try {
    await f.start()
    if (report) await f.finish(report)
    if (nativeFailure) f.states.get(f.passage.coordinatorSessionID)!.failed = true
    const settled = await observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!,
      storage: f.storage, native: f.observation, directory: f.root, current: () => true, signal: new AbortController().signal })
    assert.equal(settled?.result.outcome, outcome)
    assert.equal(settled!.result.cursors.length === 0 || outcome === "completed", true, "only completed advances cursors")
  } finally { await f.dispose() }
})

for (const report of [false, true]) test(report ? "REAL mission_report without backend presence settles completed" : "idle passage without a report ends without report", async () => {
  const f = await passageFixture()
  try {
    await f.start()
    if (report) await f.finish()
    const observe = async () => observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!,
      storage: f.storage, native: f.observation, directory: f.root, current: () => true, signal: new AbortController().signal })
    assert.equal((await observe())?.result.outcome, report ? "completed" : "ended-without-report")
    f.pendingForm = true
    assert.equal(await observe(), undefined, "a pending Form blocks even a real final report")
    f.pendingForm = false
    const child = "ses_native_child"
    f.sessions.set(child, { id: child, parentID: f.passage.coordinatorSessionID, projectID: "project", location: { directory: f.root } })
    f.states.set(child, { ...f.states.get(f.passage.coordinatorSessionID)!, id: child, parentID: f.passage.coordinatorSessionID, active: true })
    assert.equal(await observe(), undefined, "background descendant still running")
    f.states.get(child)!.active = false
    assert.equal((await observe())?.result.outcome, report ? "completed" : "ended-without-report")
    f.states.get(child)!.runningTools = 1
    assert.equal(await observe(), undefined, "a live tool still blocks")
  } finally { await f.dispose() }
})
