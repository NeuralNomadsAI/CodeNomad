import assert from "node:assert/strict"
import test from "node:test"
import {
  emptyLatestWindow,
  planNewerWindow,
  planOlderWindow,
  preserveMessageWindowCursor,
  type MessageWindowState,
  windowFromSnapshot,
  withOlderCursor,
} from "./message-window.ts"

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

  let current: MessageWindowState = second!.next
  for (let index = 3; index <= 40; index += 1) current = planOlderWindow(withOlderCursor(current, `c${index}`))!.next
  assert.equal(current.newerCursors.length, 32)
  assert.deepEqual(current.newerCursors.slice(0, 3), [null, null, "c10"])
  assert.equal(planNewerWindow(current)?.cursor, "c39")

  for (let index = 0; index < 30; index += 1) current = planNewerWindow(current)!.next
  assert.deepEqual(planNewerWindow(current), { next: current, seekNewer: "c10" })
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

test("oldest-page forward cursors walk through intermediate pages", () => {
  assert.deepEqual(planNewerWindow({ kind: "history", newerCursors: ["from-oldest"] }), {
    cursor: "from-oldest",
    next: { kind: "history", resumeCursor: "from-oldest", newerCursors: [] },
    forward: true,
  })
  assert.deepEqual(planNewerWindow({ kind: "history", resumeCursor: "last-forward", newerCursors: [] }), {
    next: emptyLatestWindow(),
  })
})

test("restore uses the saved page without inventing a newer stack", () => {
  assert.deepEqual(windowFromSnapshot({ windowIsLatest: true }), emptyLatestWindow())
  assert.deepEqual(windowFromSnapshot({ windowCursor: "c1", newerCursors: [null] }), {
    kind: "history",
    resumeCursor: "c1",
    newerCursors: [null],
  })
})

test("preserves the current window while replacing scroll coordinates", () => {
  assert.deepEqual(preserveMessageWindowCursor(
    { scrollTop: 20, atBottom: false },
    { windowIsLatest: false, windowCursor: "persisted", newerCursors: [null] },
    { kind: "history", resumeCursor: "current", newerCursors: [null, "newer"] },
  ), {
    scrollTop: 20,
    atBottom: false,
    windowIsLatest: false,
    windowCursor: "current",
    newerCursors: [null, "newer"],
  })
})
