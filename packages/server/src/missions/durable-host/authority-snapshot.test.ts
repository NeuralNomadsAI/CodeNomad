import assert from "node:assert/strict"
import test from "node:test"
import { readAuthoritySnapshot } from "./authority-snapshot"
import { controlOperationID } from "../receipt-identity"

const snapshot = () => ({ version: 1, projectID: "project", discardedEvents: 0, generatedAt: 1, missions: [{
  id: "mission", projectID: "project", projectCanonical: "/owned", coordinatorSessionId: "coordinator", revision: 3,
  status: "active", runState: "running", actors: [{ sessionId: "coordinator", kind: "coordinator", location: { directory: "/owned" } }],
  control: { id: controlOperationID("mission", "play"), missionID: "mission", requestID: "play", expectedRevision: 2, completedRevision: 3,
    action: "start", pending: [], targets: [{ sessionID: "coordinator", location: { directory: "/owned" } }] },
}] })

test("native authorization reads validate pending evidence and unique exact coordinator membership", () => {
  const original = snapshot()
  assert.equal(readAuthoritySnapshot(original), original)
  for (const damage of [
    (value: any) => { value.missions[0].control.pending = {} },
    (value: any) => { value.missions[0].control.pending = undefined },
    (value: any) => { value.missions[0].actors.push(value.missions[0].actors[0]) },
    (value: any) => { value.missions.push(value.missions[0]) },
    (value: any) => { value.missions[0].actors[0].kind = "specialist" },
    (value: any) => { value.missions[0].coordinatorSessionId = "substituted" },
    (value: any) => { value.missions[0].control.targets[0].sessionID = "foreign" },
    (value: any) => { value.missions[0].control.targets[0].location.directory = "/foreign" },
    (value: any) => { value.missions[0].control.id = "unrelated-operation" },
    (value: any) => { value.missions[0].control.pending = ["foreign"] },
    (value: any) => { value.missions[0].control.completedRevision = 99 },
    (value: any) => { value.controlUnavailable = "false" },
    (value: any) => { value.discardedEvents = 1 },
  ]) {
    const value = structuredClone(original); damage(value)
    assert.throws(() => readAuthoritySnapshot(value), /observation-unavailable|invalid-intent/)
  }
})
