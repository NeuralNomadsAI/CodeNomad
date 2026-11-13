import assert from "node:assert/strict"
import { test } from "node:test"
import type { MissionTask } from "./model"
import { missionTaskMarks, missionTaskMarksSchema } from "./mission-task-marks"

test("directory task marks retain exact completion versions and actor identity without task bodies", () => {
  const task = { id: "task", key: "work", status: "completed", updatedAt: 42, actorSessionId: "actor", brief: "private", report: { summary: "private" } } as MissionTask
  const marks = missionTaskMarks([task])
  assert.deepEqual(marks, [{ id: "task", key: "work", status: "completed", updatedAt: 42, actorSessionId: "actor" }])
  assert.deepEqual(missionTaskMarksSchema.parse(marks), marks)
  assert.equal(missionTaskMarksSchema.safeParse([...marks, ...marks]).success, false)
  assert.equal(missionTaskMarksSchema.safeParse([{ ...marks[0], brief: "private" }]).success, false)
})
