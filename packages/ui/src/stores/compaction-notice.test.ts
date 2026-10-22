import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createCompactionNoticeClaims } from "./compaction-notice"

const end = (id: string, seq?: number, sessionID = "ses_a") =>
  ({ id, data: { sessionID }, ...(seq === undefined ? {} : { durable: { aggregateID: sessionID, seq } }) })

describe("compaction notices", () => {
  it("notifies once per compaction, whichever project tab or replay delivers it", () => {
    const claim = createCompactionNoticeClaims()
    assert.equal(claim(end("evt_1", 7)), true)
    assert.equal(claim(end("evt_1", 7)), false, "the same event for another tab on the folder")
    assert.equal(claim(end("evt_replayed", 7)), false, "a replay keeps its durable position")
    assert.equal(claim(end("evt_2", 9)), true, "the session's next compaction")
    assert.equal(claim(end("evt_3", 7, "ses_b")), true, "another session's log")
  })

  it("falls back to the event ID without a durable position", () => {
    const claim = createCompactionNoticeClaims()
    assert.equal(claim(end("evt_1")), true)
    assert.equal(claim(end("evt_1")), false)
    assert.equal(claim(end("evt_2")), true)
  })

  it("forgets the oldest compactions beyond its bound", () => {
    const claim = createCompactionNoticeClaims(2)
    for (const seq of [1, 2, 3]) assert.equal(claim(end(`evt_${seq}`, seq)), true)
    assert.equal(claim(end("evt_3", 3)), false)
    assert.equal(claim(end("evt_1", 1)), true, "the first one was forgotten")
  })
})
