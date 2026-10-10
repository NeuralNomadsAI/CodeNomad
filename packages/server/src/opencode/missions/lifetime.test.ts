import assert from "node:assert/strict"
import test from "node:test"
import type { MissionMap, MissionSnapshot, MissionTask } from "../../missions/model"
import { missionWorkRemains, retainMissionWork } from "./lifetime"

const idle = (): MissionSnapshot => ({ version: 1, projectID: "project", generatedAt: 1,
  missions: [], discardedEvents: 0 })
const mission = (status: MissionMap["status"]): MissionMap => ({ status, tasks: [], reports: [] } as unknown as MissionMap)

test("idle and settled terminal missions need no presence retention", () => {
  assert.equal(missionWorkRemains(idle()), false)
  for (const status of ["completed", "failed", "stopped"] as const) {
    assert.equal(missionWorkRemains({ ...idle(), missions: [mission(status)] }), false)
  }
})

test("active mission remains registered independently of desktop presence", () => {
  assert.equal(missionWorkRemains({ ...idle(), missions: [mission("active")] }), true)
})

test("readouts already delivered to the coordinator do not create pending notification work", () => {
  for (const delivery of ["coordinator-readout", "native-return"] as const) {
    const value = { ...mission("completed"), reports: [{ delivery, notificationStatus: "pending" }] } as MissionMap
    assert.equal(missionWorkRemains({ ...idle(), missions: [value] }), false)
  }
})

test("terminal status is not proof of settled execution or notifications", () => {
  for (const extra of [
    { tasks: [{ outstandingExecution: true }] },
    { reports: [{ notificationStatus: "pending" }] },
    { control: { pending: ["ses_target"] } },
  ]) {
    const value = { ...mission("completed"), ...extra } as MissionMap
    assert.equal(missionWorkRemains({ ...idle(), missions: [value] }), true)
  }
  assert.equal(missionWorkRemains({ ...idle(), cleanups: [{ pending: 1 }] } as MissionSnapshot), true)
})

test("unknown/damaged observations retain without dispatch or replay", async () => {
  assert.equal(await retainMissionWork(async () => { throw new Error("Unreadable storage") }), true)
  for (const extra of [{ discardedEvents: 1 }, { controlUnavailable: true },
    { notificationUnavailable: true }, { cleanupUnavailable: true }]) {
    assert.equal(missionWorkRemains({ ...idle(), ...extra }), true)
  }
})

test("completed missions retain tracked unsettled native calls even without the derived outstanding flag", () => {
  const binding = { generation: 1, parentSessionID: "ses_parent", parentMessageID: "msg_parent", toolCallID: "call_child" }
  const retains = (task: Partial<MissionTask>) => missionWorkRemains({ ...idle(),
    missions: [{ ...mission("completed"), tasks: [{ outstandingExecution: false, ...task } as MissionTask] }] })
  assert.equal(retains({ nativeBinding: binding }), true, "missing observation is unknown")
  assert.equal(retains({ nativeBinding: binding, nativeExecution: { binding,
    launch: { mode: "foreground", state: "called" } } }), true)
  assert.equal(retains({ nativeBinding: binding, nativeExecution: { binding,
    launch: { mode: "background", state: "returned" }, childExecution: { state: "unknown", observedOutcome: "succeeded" } } }), true,
    "uncorrelated child success does not qualify background settlement")
  assert.equal(retains({ nativeBinding: binding, nativeExecution: { binding,
    ended: "returned", observationConflict: true } }), true)
  assert.equal(retains({ nativeBinding: binding, nativeExecution: { binding,
    launch: { mode: "foreground", state: "returned" }, ended: "returned" } }), false)
})
