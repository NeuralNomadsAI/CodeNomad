import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import type { MissionConfiguration } from "./launch-policy"
import { missionScheduleActions, missionScheduleID, missionSchedulePayloadDigest, missionScheduleRequestSchema,
  missionScheduleRpcMethods } from "./mission-schedule-contract"

const configuration: MissionConfiguration = { title: "Owned", objective: "Work", template: "custom", taskMode: "native", profileID: null, executionHost: null,
  roots: [{ mode: "directory-only", directory: "/owned" }], watchedConversationIDs: [],
  launch: { timing: { kind: "immediate" }, condition: null, ends: { maxLaunches: null, afterMs: null, at: null } } }
const identity = { missionID: missionScheduleID("project", "/owned", "request"), requestID: "request", expectedRevision: 0 }
function request(action: typeof missionScheduleActions[number]) {
  const payload = { ...identity, action, ...(["create", "configure"].includes(action) ? { configuration } : {}) }
  const transport = { sessionID: "human", workspaceID: "workspace", requestID: identity.requestID, location: { directory: "/owned" },
    scheduleID: identity.missionID, expectedRevision: 0, action, profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/profile/config.yaml" },
    issuedAt: 1, digest: "a".repeat(64), proof: "b".repeat(64),
    ...(["create", "configure", "delete"].includes(action) ? { configDigest: missionSchedulePayloadDigest(payload as never) } : {}) }
  return { ...payload, transport }
}

test("schedule mutations bind exact action, revision, configuration and cleanup option before any effect", () => {
  const wire = new Ajv().compile(missionScheduleRpcMethods.scheduleControl.input)
  for (const action of missionScheduleActions) {
    const input = request(action)
    assert.equal(wire(input), true, JSON.stringify(wire.errors))
    assert.equal(missionScheduleRequestSchema.parse(input).action, action)
    for (const mutate of [
      (value: any) => { value.transport.requestID = "different" },
      (value: any) => { value.transport.action = "forged" },
      (value: any) => { value.transport.expectedRevision++ },
      (value: any) => { value.transport.scheduleID = "another" },
      (value: any) => { value.extra = true },
    ]) {
      const invalid = structuredClone(input); mutate(invalid)
      assert.equal(missionScheduleRequestSchema.safeParse(invalid).success, false)
    }
  }
  const edit = request("configure")
  edit.configuration!.objective = "Changed after approval"
  assert.equal(missionScheduleRequestSchema.safeParse(edit).success, false)
  const deletion = { ...request("delete"), deleteManagedSessions: true }
  assert.equal(missionScheduleRequestSchema.safeParse(deletion).success, false)
  deletion.transport.configDigest = missionSchedulePayloadDigest(deletion)
  assert.equal(missionScheduleRequestSchema.safeParse(deletion).success, true)
  assert.equal(missionScheduleRequestSchema.safeParse({ ...request("play"), configuration }).success, false)
  assert.equal(missionScheduleRequestSchema.safeParse({ ...request("play"), transport: undefined }).success, false)
  assert.notEqual(identity.missionID, missionScheduleID("project", "/foreign", "request"))
})
