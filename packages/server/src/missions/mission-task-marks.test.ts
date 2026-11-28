import assert from "node:assert/strict"
import { test } from "node:test"
import type { MissionTask } from "./model"
import { missionTaskMarks, missionTaskMarksCover, missionTaskMarksSchema } from "./mission-task-marks"

test("marks come in attention order, so the first windows cover what a reader has not seen", () => {
  const task = (key: string, status: string, updatedAt: number, replacedByTaskKey?: string) =>
    ({ id: `id-${key}`, key, status, updatedAt, ...(replacedByTaskKey ? { replacedByTaskKey } : {}) }) as MissionTask
  const marks = missionTaskMarks([task("old", "completed", 10), task("replaced", "ready", 40, "queued"), task("failed", "failed", 30),
    task("queued", "queued", 5), task("new", "completed", 50), task("blocked", "blocked", 1), task("withdrawn", "withdrawn", 20)])
  // Live tasks keep the plan's order; the others follow from the newest change.
  assert.deepEqual(marks.map(mark => mark.key), ["queued", "blocked", "new", "replaced", "failed", "withdrawn", "old"])

  // A reader that saw everything through 30 needs the marks up to the first one at or below it.
  assert.equal(missionTaskMarksCover(marks.slice(0, 2), 30), false, "a window ending on a live task says nothing of what follows")
  assert.equal(missionTaskMarksCover(marks.slice(0, 4), 30), false, "a task changed since may be followed by another")
  assert.equal(missionTaskMarksCover(marks.slice(0, 5), 30), true)
  assert.equal(missionTaskMarksCover(marks.slice(0, 3), Infinity), true, "nothing finished can show before the first observation")
  assert.equal(missionTaskMarksCover([], 30), false)
})

test("directory task marks retain exact completion versions and actor identity without task bodies", () => {
  const task = { id: "task", key: "work", status: "completed", updatedAt: 42, actorSessionId: "actor", brief: "private", report: { summary: "private" } } as MissionTask
  const marks = missionTaskMarks([task])
  assert.deepEqual(marks, [{ id: "task", key: "work", status: "completed", updatedAt: 42, actorSessionId: "actor" }])
  assert.deepEqual(missionTaskMarksSchema.parse(marks), marks)
  assert.equal(missionTaskMarksSchema.safeParse([...marks, ...marks]).success, false)
  assert.equal(missionTaskMarksSchema.safeParse([{ ...marks[0], brief: "private" }]).success, false)
})
