import assert from "node:assert/strict"
import test from "node:test"
import { passageFixture } from "./native-passage-test-fixture"
import { admitNativeRecurrencePassage } from "./native-recurrence-admission"

test("original admission checks native session/message before starting its reserved identity", async () => {
  const f = await passageFixture()
  try {
    assert.equal((await f.calendar.read("schedule"))!.pending!.admission, null)
    await f.start()
    assert.deepEqual(f.counts(), { creates: 1, sends: 1, environments: 1 })
    await f.start()
    assert.deepEqual(f.counts(), { creates: 1, sends: 1, environments: 1 })
  } finally { await f.dispose() }
})

test("lost native ACK reconciles delivered message without sending twice", async () => {
  const f = await passageFixture()
  try {
    f.crashAfterSend = true
    await assert.rejects(admitNativeRecurrencePassage(await f.input()), /Crash after native admission/)
    assert.equal((await f.calendar.read("schedule"))!.pending!.admission, null)
    await f.start()
    assert.deepEqual(f.counts(), { creates: 1, sends: 1, environments: 1 })
  } finally { await f.dispose() }
})

test("pause after pending write never creates a native session", async () => {
  const f = await passageFixture()
  try {
    const doc = (await f.calendar.read("schedule"))!
    await f.calendar.setState(doc.id, doc.revision, "paused", () => true)
    await assert.rejects(f.start(), /dispatch is not running/)
    assert.equal(f.counts().sends, 0)
  } finally { await f.dispose() }
})
