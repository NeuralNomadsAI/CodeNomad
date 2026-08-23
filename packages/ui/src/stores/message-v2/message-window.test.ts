import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_SESSION_MEMORY_MESSAGE_LIMIT,
  emptyLatestWindow,
  parseNewerCursors,
  parseSessionMemoryMessageLimit,
  planNewerWindow,
  planOlderWindow,
  serializeNewerCursors,
  windowFromSnapshot,
  withOlderCursor,
} from "./message-window.ts"

test("invalid memory limits fall back to 200", () => {
  assert.equal(parseSessionMemoryMessageLimit(undefined), DEFAULT_SESSION_MEMORY_MESSAGE_LIMIT)
  assert.equal(parseSessionMemoryMessageLimit("nope"), DEFAULT_SESSION_MEMORY_MESSAGE_LIMIT)
})

test("memory limits stay positive integers", () => {
  assert.equal(parseSessionMemoryMessageLimit(200.8), 200)
  assert.equal(parseSessionMemoryMessageLimit(1), 1)
  assert.equal(parseSessionMemoryMessageLimit(5000), 5000)
})

test("older pages push a latest sentinel then history cursors", () => {
  const first = planOlderWindow(withOlderCursor(emptyLatestWindow(), "c1"))
  assert.deepEqual(first, {
    cursor: "c1",
    next: { kind: "history", resumeCursor: "c1", newerCursors: [null] },
  })
  const second = planOlderWindow(withOlderCursor(first!.next, "c2"))
  assert.deepEqual(second, {
    cursor: "c2",
    next: { kind: "history", resumeCursor: "c2", newerCursors: [null, "c1"] },
  })
})

test("newer pages walk back to latest", () => {
  const history = withOlderCursor({
    kind: "history",
    resumeCursor: "c2",
    olderCursor: "c3",
    newerCursors: [null, "c1"],
  }, "c3")
  assert.deepEqual(planNewerWindow(history), {
    cursor: "c1",
    next: { kind: "history", resumeCursor: "c1", newerCursors: [null] },
  })
  assert.deepEqual(planNewerWindow(planNewerWindow(history)!.next), {
    next: { kind: "latest", newerCursors: [] },
  })
  assert.equal(planNewerWindow(emptyLatestWindow()), null)
})

test("restore uses the saved page without inventing a newer stack", () => {
  assert.deepEqual(windowFromSnapshot({ windowIsLatest: true }), emptyLatestWindow())
  assert.deepEqual(windowFromSnapshot({ windowCursor: "c1", newerCursors: [null] }), {
    kind: "history",
    resumeCursor: "c1",
    newerCursors: [null],
  })
})

test("newer cursors serialize the latest sentinel", () => {
  assert.deepEqual(serializeNewerCursors([null, "c1"]), ["", "c1"])
  assert.deepEqual(parseNewerCursors(["", "c1"]), [null, "c1"])
})
