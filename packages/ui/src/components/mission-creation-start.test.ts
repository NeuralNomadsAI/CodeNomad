import assert from "node:assert/strict"
import test from "node:test"
import { createRoot } from "solid-js"
import type { MissionMap, MissionPanelMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { MissionLifecycleRequestError, type MissionLifecycleInput } from "../lib/mission-lifecycle-request"
import { missionLifecycleIntents, missionLifecycleSource } from "../stores/mission-lifecycle-intents"
import { createMissionCreationStart } from "./mission-creation-start"

const mission = (id: string) => ({ id, projectID: "project", projectCanonical: "/fixture", revision: 1,
  status: "active", runState: "prepared", coordinatorSessionId: "ses_coordinator",
  actors: [{ sessionId: "ses_coordinator", kind: "coordinator", location: { directory: "/fixture" } }] }) as MissionPanelMap
const source = (value: MissionPanelMap) => missionLifecycleSource("fixture", value, {})
function setup() {
  let dispose!: () => void, active = true, epoch = 0, refreshes = 0
  const capture = createRoot(cleanup => {
    dispose = cleanup
    return createMissionCreationStart({ instanceId: "fixture", projectID: "project", directory: "/fixture",
      active: () => active, captureView: () => { const before = epoch; return () => epoch === before }, refresh: () => { refreshes++ } })
  })
  return { capture, dispose, hide: () => { active = false }, navigate: () => { epoch++ }, get refreshes() { return refreshes } }
}
const ack = (value: MissionPanelMap, input: MissionLifecycleInput) => ({ mission: { ...value, runState: "running",
  control: { requestID: input.requestId, action: input.action, expectedRevision: input.expectedRevision, pending: [] } } as unknown as MissionMap })

test("one direct creation continuation sends one exact Start and cannot repeat after its ACK", async t => {
  const f = setup(), value = mission("confirmed"), calls: MissionLifecycleInput[] = []
  t.mock.method(serverApi, "controlMission", async (_instance: string, id: string, input: MissionLifecycleInput) => {
    assert.equal(id, value.id); calls.push(input); return ack(value, input)
  })
  try {
    const start = f.capture(true)
    await Promise.all([start(value), start(value)])
    await start(value)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].action, "start"); assert.equal(calls[0].expectedRevision, value.revision)
    assert.equal(missionLifecycleIntents.retry(source(value)), undefined)
    assert.equal(f.refreshes, 1)
  } finally { f.dispose() }
})

test("unchecked, departed and disposed creation intentions send nothing", async t => {
  let calls = 0
  t.mock.method(serverApi, "controlMission", async () => { calls++; throw new Error("unexpected") })
  for (const mode of ["unchecked", "hidden", "navigated", "disposed"] as const) {
    const f = setup(), start = f.capture(mode !== "unchecked")
    if (mode === "hidden") f.hide()
    if (mode === "navigated") f.navigate()
    if (mode === "disposed") f.dispose()
    await start(mission(mode)); f.dispose()
    assert.equal(f.refreshes, 0)
  }
  assert.equal(calls, 0)
})

test("lost Start ACK retains its exact lifecycle identity across remount without another launch", async t => {
  const value = mission("unknown"), f = setup(), calls: MissionLifecycleInput[] = []
  t.mock.method(serverApi, "controlMission", async (_instance: string, _id: string, input: MissionLifecycleInput) => {
    calls.push(input); throw new TypeError("lost acknowledgement")
  })
  await f.capture(true)(value); f.dispose()
  const held = missionLifecycleIntents.retry(source(value))!
  assert.deepEqual(held.input, calls[0]); assert.equal(missionLifecycleIntents.busy(source(value)), false)
  const remount = setup()
  try {
    await remount.capture(true)(value)
    assert.equal(calls.length, 1); assert.equal(missionLifecycleIntents.retry(source(value)), held)
  } finally { remount.dispose(); missionLifecycleIntents.finish(held, "acknowledged") }
})

test("foreign, partial and mismatched successful HTTP replies retain uncertainty", async t => {
  for (const mode of ["foreign", "request", "revision", "pending"] as const) {
    const f = setup(), value = mission(mode)
    t.mock.method(serverApi, "controlMission", async (_instance: string, _id: string, input: MissionLifecycleInput) => {
      const result = ack(value, input)
      if (mode === "foreign") result.mission.id = "another"
      if (mode === "request") result.mission.control!.requestID = "another"
      if (mode === "revision") result.mission.control!.expectedRevision++
      if (mode === "pending") result.mission.control!.pending = ["ses_coordinator"]
      return result
    })
    try {
      await f.capture(true)(value)
      const held = missionLifecycleIntents.retry(source(value))
      assert.ok(held, mode); missionLifecycleIntents.finish(held, "acknowledged")
    } finally { f.dispose() }
  }
})

test("certified revision rejection leaves selected-Mission feedback and no uncertain input", async t => {
  const f = setup(), value = mission("rejected")
  t.mock.method(serverApi, "controlMission", async () => { throw new MissionLifecycleRequestError(409, "revision-conflict") })
  try {
    await f.capture(true)(value)
    assert.equal(missionLifecycleIntents.retry(source(value)), undefined)
    assert.equal(missionLifecycleIntents.rejection(source(value), value.id)?.reason, "rejected")
  } finally { f.dispose() }
})

test("late exact Start ACK settles only its original holder after the creating view leaves", async t => {
  const f = setup(), value = mission("late")
  let resolve!: (result: { mission: MissionMap }) => void, input!: MissionLifecycleInput
  t.mock.method(serverApi, "controlMission", async (_instance: string, _id: string, original: MissionLifecycleInput) => {
    input = original; return new Promise<{ mission: MissionMap }>(yes => { resolve = yes })
  })
  const running = f.capture(true)(value)
  assert.ok(missionLifecycleIntents.retry(source(value)))
  f.navigate(); f.dispose(); resolve(ack(value, input)); await running
  assert.equal(missionLifecycleIntents.retry(source(value)), undefined)
  assert.equal(f.refreshes, 0)
})
