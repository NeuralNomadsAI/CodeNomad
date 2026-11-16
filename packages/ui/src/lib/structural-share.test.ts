import assert from "node:assert/strict"
import test from "node:test"

import { shareUnchanged } from "./structural-share"

test("an equal publication keeps the previous object graph", () => {
  const previous = { status: "ready", missions: [{ id: "a", tasks: [{ id: "t", title: "T" }] }], activity: { missions: [{ missionId: "a", actors: [{ sessionId: "s", state: "running" }] }] } }
  const next = structuredClone(previous)
  assert.equal(shareUnchanged(previous, next), previous)
})

test("only the changed mission gets a new object; its unchanged parts and siblings keep theirs", () => {
  const previous = { missions: [{ id: "a", revision: 1, tasks: [{ id: "t1" }, { id: "t2" }] }, { id: "b", revision: 4, tasks: [] }] }
  const next = structuredClone(previous)
  next.missions[0]!.revision = 2
  const shared = shareUnchanged(previous, next)
  assert.notEqual(shared, previous)
  assert.notEqual(shared.missions[0], previous.missions[0])
  assert.equal(shared.missions[0]!.tasks, previous.missions[0]!.tasks)
  assert.equal(shared.missions[1], previous.missions[1])
  assert.equal(shared.missions[0]!.revision, 2)
})

test("keyed items match by identity key across reordering, insertion and removal", () => {
  const previous = [{ id: "a", n: 1 }, { id: "b", n: 2 }, { sessionId: "s", state: "idle" }]
  const next = [{ sessionId: "s", state: "idle" }, { id: "c", n: 3 }, { id: "a", n: 1 }]
  const shared = shareUnchanged(previous, structuredClone(next))
  assert.notEqual(shared, previous)
  assert.equal(shared[0], previous[2])
  assert.deepEqual(shared[1], { id: "c", n: 3 })
  assert.equal(shared[2], previous[0])
})

test("added, removed and undefined keys count as changes; non-plain values compare by identity", () => {
  assert.notEqual(shareUnchanged({ a: 1 }, { a: 1, b: undefined }), undefined)
  const previous = { a: 1, b: undefined as number | undefined }
  assert.notEqual(shareUnchanged(previous, { a: 1 }), previous)
  assert.notEqual(shareUnchanged({ a: 1 }, { a: 1, b: undefined }), { a: 1 })
  const date = new Date(0)
  assert.notEqual(shareUnchanged({ at: date }, { at: new Date(0) }).at, date)
  assert.equal(shareUnchanged([1, 2], [1, 2, 3]).length, 3)
})
