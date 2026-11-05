import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createCompactionNoticeClaims, createSessionBubbles } from "./compaction-notice"

const end = (id: string, seq?: number, sessionID = "ses_a") =>
  ({ id, data: { sessionID }, ...(seq === undefined ? {} : { durable: { aggregateID: sessionID, seq } }) })

describe("compaction notices", () => {
  it("notifies once per compaction, whichever project tab or replay delivers it", () => {
    const claim = createCompactionNoticeClaims()
    assert.equal(claim(end("evt_1", 7), "local-shared"), true)
    assert.equal(claim(end("evt_1", 7), "local-shared"), false, "the same event for another tab on the folder")
    assert.equal(claim(end("evt_replayed", 7), "local-shared"), false, "a replay keeps its durable position")
    assert.equal(claim(end("evt_2", 9), "local-shared"), true, "the session's next compaction")
    assert.equal(claim(end("evt_3", 7, "ses_b"), "local-shared"), true, "another session's log")
    assert.equal(claim(end("evt_1", 7), "A"), true)
    assert.equal(claim(end("evt_1", 7), "B"), true)
    assert.equal(claim(end("evt_replayed", 7), "A"), false)
  })

  it("falls back to the event ID without a durable position", () => {
    const claim = createCompactionNoticeClaims()
    assert.equal(claim(end("evt_1"), "local-shared"), true)
    assert.equal(claim(end("evt_1"), "local-shared"), false)
    assert.equal(claim(end("evt_2"), "local-shared"), true)
    assert.equal(claim(end("evt_1"), "A"), true)
    assert.equal(claim(end("evt_1"), "B"), true)
  })

  it("forgets the oldest compactions beyond its bound", () => {
    const claim = createCompactionNoticeClaims(2)
    for (const seq of [1, 2, 3]) assert.equal(claim(end(`evt_${seq}`, seq), "A"), true)
    assert.equal(claim(end("evt_3", 3), "A"), false)
    assert.equal(claim(end("evt_1", 1), "A"), true, "the first one was forgotten")
  })
})

describe("compaction bubbles", () => {
  const setup = () => {
    const expiries: Array<() => void> = [], dismissed: string[] = []
    const bubbles = createSessionBubbles(expire => { expiries.push(expire) })
    const notify = (id: string) => () => ({ id, dismiss: () => { dismissed.push(id) } })
    return { bubbles, expiries, dismissed, notify }
  }

  it("replaces the session's bubble still shown and forgets each one when it expires", () => {
    const { bubbles, expiries, dismissed, notify } = setup()
    bubbles.show("local-shared", "ses_a", 10, notify("first"))
    bubbles.show("local-shared", "ses_b", 10, notify("other"))
    bubbles.show("local-shared", "ses_a", 10, notify("second"))
    assert.deepEqual(dismissed, ["first"])
    assert.equal(bubbles.size, 2)
    expiries[0]()
    assert.equal(bubbles.size, 2, "the replaced bubble's expiry keeps its replacement")
    expiries[1](); expiries[2]()
    assert.equal(bubbles.size, 0)
  })

  it("retains nothing for a notice routed away from the screen", () => {
    const { bubbles, expiries, notify } = setup()
    bubbles.show("local-shared", "ses_a", 10, notify(""))
    assert.equal(bubbles.size, 0)
    assert.equal(expiries.length, 0)
  })
  it("keeps homonymous server bubbles independent through replacement and expiry", () => {
    const { bubbles, expiries, dismissed, notify } = setup()
    for (const server of ["A", "B", "local-shared"]) bubbles.show(server, "same", 10, notify(server))
    bubbles.show("B", "same", 10, notify("B-new"))
    assert.deepEqual(dismissed, ["B"])
    assert.equal(bubbles.size, 3)
    expiries[1]()
    assert.equal(bubbles.size, 3)
    expiries[0](); expiries[2](); expiries[3]()
    assert.equal(bubbles.size, 0)
  })
})
