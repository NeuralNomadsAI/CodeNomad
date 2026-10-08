import assert from "node:assert/strict"
import test from "node:test"
import { passageFixture } from "./native-passage-test-fixture"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"

test("native terminal failure settles failed and never advances watched cursors", async () => {
  const f = await passageFixture()
  try {
    await f.start()
    f.states.get(f.passage.coordinatorSessionID)!.failed = true
    const result = await observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!, storage: f.storage,
      native: f.observation, directory: f.root, current: () => true, signal: new AbortController().signal })
    assert.equal(result?.result.outcome, "failed")
    await f.calendar.finish("schedule", result!.result as never, 30, result!.current)
    const doc = (await f.calendar.read("schedule"))!
    assert.equal(doc.pending, null)
    assert.deepEqual(doc.cursors, [])
  } finally { await f.dispose() }
})
