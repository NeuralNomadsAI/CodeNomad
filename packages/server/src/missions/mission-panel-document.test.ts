import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { followedPreparationFixture, scheduledPreparation } from "./mission-preparation-test-fixture"
import { missionScheduleRpcMethods } from "./mission-schedule-contract"
import { missionScheduleView } from "./mission-schedule-view"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { stableToken } from "./receipt-identity"

test("document ownership and frozen-input digests survive the declared full and paged RPC wires", async () => {
  const f = await followedPreparationFixture(), ajv = new Ajv({ allErrors: true })
  const valid = (schema: object, value: unknown) => {
    const validate = ajv.compile(schema)
    assert.ok(validate(JSON.parse(JSON.stringify(value))), JSON.stringify(validate.errors))
  }
  const configured = await f.control.configurePreparation({ ...f.request,
    configuration: { ...scheduledPreparation(f), watchedConversationIDs: [f.source.id] } }, f.native, () => true)
  const dormant = await f.control.snapshot()
  assert.equal(dormant.missions[0].document?.dormant, true)
  valid(CODENOMAD_MISSIONS_RPC.methods.snapshot.output, dormant)
  valid(missionScheduleRpcMethods.scheduleRead.output, missionScheduleView(configured))
  await f.control.configurePreparation({ ...f.request, requestID: "return_immediate", expectedRevision: configured.revision,
    configuration: { ...f.request.configuration, taskMode: "native", watchedConversationIDs: [f.source.id] } }, f.native, () => true)
  let mission = (await f.control.snapshot()).missions[0]
  const played = await f.control.lifecycle({ missionID: mission.id, requestID: "play_followed", expectedRevision: mission.revision, action: "start" })
  valid(CODENOMAD_MISSIONS_RPC.methods.lifecycle.output, played)
  mission = played.mission
  const digest = stableToken(f.admissions[0].text, 64)
  assert.equal(mission.document?.firstPlay?.inputDigest, digest)
  // Three ordinary revisions put the document-backed plan beyond the first task window.
  for (let round = 0; round < 3; round++) mission = (await f.control.revise(mission.coordinatorSessionId, {
    missionID: mission.id, requestID: `tasks_${round}`, expectedRevision: mission.revision, reason: "More work",
    retireTasks: [], dependencyUpdates: [], addTasks: Array.from({ length: 24 }, (_, index) => ({
      taskKey: `work-${round}-${index}`, title: "Work", brief: "Whole brief", role: "developer", blockedBy: [],
      executionMode: { kind: "native" as const, parentTaskKey: null } })),
  })).mission
  const updated = await f.control.update({ missionID: mission.id, requestID: "exact_edit", expectedRevision: mission.revision,
    objective: "Edited instructions", notes: "Exact note" })
  valid(CODENOMAD_MISSIONS_RPC.methods.update.output, updated)
  const listed = await f.control.list(), read = await f.control.mission(mission.id), full = await f.control.snapshot()
  for (const [method, value] of [["list", listed], ["mission", read], ["snapshot", full]] as const)
    valid(CODENOMAD_MISSIONS_RPC.methods[method].output, value)
  for (const panel of [listed.missions[0], read.mission!]) {
    assert.equal(panel.tasks.length, 50)
    assert.equal(panel.taskPage?.total, 72)
    assert.deepEqual(panel.document, full.missions[0].document)
    assert.equal(panel.document?.firstPlay?.inputDigest, digest)
    assert.equal(panel.history.at(-1)?.requestID, "exact_edit")
  }
  const page = await f.control.tasks({ missionID: mission.id, order: read.mission!.taskPage!.order, offset: 50 })
  valid(CODENOMAD_MISSIONS_RPC.methods.tasks.output, page)
  assert.ok("tasks" in page)
  assert.equal(page.tasks.length, 22)
  assert.equal(full.missions[0].tasks.length, 72)
  assert.equal(full.missions[0].tasks[71].brief, "Whole brief")
  assert.equal(full.missions[0].bodies, undefined)
  assert.equal(f.admissions.length, 1, "display and edit reconciliation never launch another passage")
})
