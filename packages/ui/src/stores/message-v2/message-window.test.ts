import assert from "node:assert/strict"
import test from "node:test"

import { completeMessageWindow, latestMessageWindow, planNewerMessageWindow, planOlderMessageWindow, preserveMessageWindowCursor } from "./message-window.ts"

test("moves backward and forward through bounded transcript windows", () => {
  const latest = completeMessageWindow(latestMessageWindow(), "older")
  const older = planOlderMessageWindow(latest)
  assert.deepEqual(older, { cursor: "older", newerCursors: [null] })
  assert.deepEqual(planNewerMessageWindow(older!), latestMessageWindow())
})

test("preserves historical cursors while replacing ordinary scroll coordinates", () => {
  assert.deepEqual(preserveMessageWindowCursor(
    { scrollTop: 20, atBottom: false },
    { windowCursor: "persisted", newerCursors: [null] },
    { cursor: "current", newerCursors: [null, "newer"] },
  ), {
    scrollTop: 20,
    atBottom: false,
    windowCursor: "current",
    newerCursors: [null, "newer"],
  })
})
