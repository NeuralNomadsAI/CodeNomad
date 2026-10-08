import assert from "node:assert/strict"
import test from "node:test"
import { passageFixture } from "./native-passage-test-fixture"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"

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
