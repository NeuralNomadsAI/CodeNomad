import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_SESSION_HISTORY,
  findSessionHistoryStep,
  moveSessionHistory,
  recordSessionVisit,
  type SessionHistoryState,
} from "./session-navigation-history.ts"

const visit = (...ids: string[]) => ids.reduce<SessionHistoryState>((state, id) => recordSessionVisit(state, id), EMPTY_SESSION_HISTORY)
const always = () => true

test("visits append, and re-showing the current entry records nothing", () => {
  const state = visit("a", "b", "b", "c")
  assert.deepEqual(state, { entries: ["a", "b", "c"], index: 2 })
  assert.equal(recordSessionVisit(state, "c"), state)
})

test("an empty history has nowhere to go", () => {
  assert.equal(findSessionHistoryStep(EMPTY_SESSION_HISTORY, -1, null, always), null)
  assert.equal(findSessionHistoryStep(EMPTY_SESSION_HISTORY, 1, null, always), null)
  const single = visit("a")
  assert.equal(findSessionHistoryStep(single, -1, "a", always), null)
  assert.equal(findSessionHistoryStep(single, 1, "a", always), null)
})

test("back and forward move the cursor without pushing entries", () => {
  let state = visit("a", "b", "c")
  const back = findSessionHistoryStep(state, -1, "c", always)!
  assert.equal(back, 1)
  state = moveSessionHistory(state, back)
  // The selection the move causes is then observed as a visit of the cursor entry.
  state = recordSessionVisit(state, "b")
  assert.deepEqual(state, { entries: ["a", "b", "c"], index: 1 })
  assert.equal(findSessionHistoryStep(state, 1, "b", always), 2)
  assert.equal(findSessionHistoryStep(state, -1, "b", always), 0)
})

test("a new selection after going back truncates the forward stack", () => {
  let state = moveSessionHistory(visit("a", "b", "c"), 0)
  state = recordSessionVisit(state, "d")
  assert.deepEqual(state, { entries: ["a", "d"], index: 1 })
  assert.equal(findSessionHistoryStep(state, 1, "d", always), null)
})

test("deleted or unavailable sessions and the shown session are skipped", () => {
  const state = visit("a", "gone", "b", "gone-too")
  const available = (id: string) => !id.startsWith("gone")
  assert.equal(findSessionHistoryStep(state, -1, "gone-too", available), 2)
  const atStart = moveSessionHistory(state, 0)
  assert.equal(findSessionHistoryStep(atStart, 1, "a", available), 2)
  assert.equal(findSessionHistoryStep(moveSessionHistory(state, 2), 1, "b", available), null)
  // A revisit of the shown session earlier in the stack is not a destination.
  const loop = visit("a", "b", "a")
  assert.equal(findSessionHistoryStep(loop, -1, "a", available), 1)
  assert.equal(findSessionHistoryStep(loop, -1, "a", id => id !== "b"), null)
})

test("Info and the draft are not entries: Back returns to the cursor entry", () => {
  const state = visit("a", "b")
  assert.equal(findSessionHistoryStep(state, -1, "info", always), 1)
  assert.equal(findSessionHistoryStep(state, -1, null, always), 1)
  assert.equal(findSessionHistoryStep(state, 1, "info", always), null)
  assert.equal(findSessionHistoryStep(moveSessionHistory(state, 0), 1, "info", always), 1)
})

test("history is bounded and keeps the most recent entries", () => {
  let state = EMPTY_SESSION_HISTORY
  for (let i = 0; i < 60; i += 1) state = recordSessionVisit(state, `s${i}`, 50)
  assert.equal(state.entries.length, 50)
  assert.equal(state.entries[0], "s10")
  assert.equal(state.index, 49)
  const back = moveSessionHistory(state, 20)
  const next = recordSessionVisit(back, "new", 50)
  assert.deepEqual(next.entries.slice(-2), ["s30", "new"])
  assert.equal(next.index, next.entries.length - 1)
})
