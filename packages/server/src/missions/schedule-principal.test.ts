import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { Schema, SchemaRepresentation } from "effect"
import { authorityDigest } from "./authority-protocol"
import { recurrenceControlProofSchema, recurrenceControlRequestDigest, recurrenceSchedulePrincipal,
  signNativeRecurrenceControl, type SchedulePrincipal } from "./recurrence-control-proof"
import { missionSchedulePayloadDigest, missionScheduleRequestSchema, missionScheduleRpcMethods } from "./mission-schedule-contract"
import { automaticMissionStartID } from "./preparation-result"
import { assertMissionScheduleAgentRequest } from "../opencode/missions/native-mission-schedule-authority"
import { assertRecurrenceBridgeProof } from "../opencode/missions/native-mission-schedule-authority"
import type { MissionDocument } from "./mission-document"

const author = { coordinatorSessionID: "ses_author", missionID: "source_mission" }
const principal: SchedulePrincipal = { kind: "agent", author, creationRequestID: "original", creationDigest: "c".repeat(64) }
const identity = { workspaceID: "workspace", requestID: automaticMissionStartID("original"),
  scheduleID: "scheduled", expectedRevision: 1, action: "play" as const, location: { directory: "/owned" },
  profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/profile/config.yaml" }, issuedAt: Date.now() }
const proof = () => { const body = { ...identity, principal }; return { ...body, digest: recurrenceControlRequestDigest(body), proof: "a".repeat(64) } }
const request = () => missionScheduleRequestSchema.parse({ missionID: identity.scheduleID, requestID: identity.requestID,
  expectedRevision: identity.expectedRevision, action: identity.action, transport: proof() })
const creation = () => ({ requestID: "original", digest: "c".repeat(64), author: structuredClone(author),
  input: { objective: "Work", template: "custom" as const, startOnCreation: true },
  automaticStart: { requestID: identity.requestID, attempted: false } })
const document = () => ({ id: identity.scheduleID, revision: 1, firstPlayedAt: null, state: "paused", pending: null,
  creation: creation() }) as MissionDocument

test("signed principal preserves explicit human compatibility and refuses mixed identities", () => {
  const old = { ...identity, sessionID: "real-cookie" }, signed = { ...old, digest: recurrenceControlRequestDigest(old) }
  assert.equal(signed.digest, authorityDigest(old))
  assert.deepEqual(recurrenceSchedulePrincipal(recurrenceControlProofSchema.parse(signed)), { kind: "human", sessionID: "real-cookie" })
  const human = { ...identity, principal: { kind: "human" as const, sessionID: "real-cookie" } }
  assert.equal(recurrenceControlProofSchema.safeParse({ ...human, digest: recurrenceControlRequestDigest(human) }).success, true)
  const agent = proof()
  const { proof: _proof, ...body } = agent
  assert.notEqual(signNativeRecurrenceControl(body, "secret"),
    signNativeRecurrenceControl({ ...body, principal: { ...principal, creationDigest: "d".repeat(64) } }, "secret"))
  const wire = new Ajv().compile(missionScheduleRpcMethods.scheduleControl.input)
  assert.equal(wire(request()), true, JSON.stringify(wire.errors))
  const mixed = { ...request(), transport: { ...agent, sessionID: author.coordinatorSessionID } }
  assert.equal(wire(mixed), true, "principal exclusivity is enforced by the domain parser")
  assert.equal(missionScheduleRequestSchema.safeParse(mixed).success, false)
})

test("portable wire keeps strict principal validation before authentication or effects", async () => {
  const wire = Schema.decodeUnknownSync(Schema.toType(SchemaRepresentation.fromJsonSchemaDocument({
    dialect: "draft-2020-12", schema: missionScheduleRpcMethods.scheduleControl.input, definitions: {},
  })), { onExcessProperty: "error" })
  assert.deepEqual(wire(request()), request())
  for (const transport of [
    { ...proof(), sessionID: author.coordinatorSessionID },
    (({ principal: _principal, ...rest }) => rest)(proof()),
    { ...proof(), principal: { ...principal, author: { ...author, missionID: "bad mission" } } },
    { ...proof(), principal: { ...principal, creationDigest: "z".repeat(64) } },
  ]) {
    const value = { ...request(), transport }
    assert.deepEqual(wire(value), value)
    assert.equal(missionScheduleRequestSchema.safeParse(value).success, false)
    await assert.rejects(assertRecurrenceBridgeProof(transport, { allowAgent: true }), { name: "ZodError" })
  }
})

test("agent controls stop at exact own creation and unconsumed first Play", async () => {
  assert.doesNotThrow(() => assertMissionScheduleAgentRequest(request(), document()))
  for (const patch of [
    (doc: MissionDocument) => { doc.firstPlayedAt = 10 },
    (doc: MissionDocument) => { doc.creation!.automaticStart!.attempted = true },
    (doc: MissionDocument) => { doc.creation!.author!.coordinatorSessionID = "ses_foreign" },
    (doc: MissionDocument) => { doc.creation!.digest = "d".repeat(64) },
    (doc: MissionDocument) => { doc.creation!.input!.startOnCreation = false },
    (doc: MissionDocument) => { doc.revision++ },
  ]) {
    const doc = document(); patch(doc)
    assert.throws(() => assertMissionScheduleAgentRequest(request(), doc))
  }
  for (const action of ["pause", "resume", "stop", "check", "run-now", "configure", "delete"] as const) {
    const value = { ...request(), action }
    assert.throws(() => assertMissionScheduleAgentRequest(value, document()), /agent control refused/)
    await assert.rejects(assertRecurrenceBridgeProof({ ...proof(), action }, { allowAgent: true }), /agent control refused/)
  }
  await assert.rejects(assertRecurrenceBridgeProof(proof()), /agent control refused/, "agents need the explicit allowance, before bridge I/O")
})

test("creation metadata is create-only and is signed with the configuration", () => {
  const configuration = { title: "Owned", objective: "Work", template: "custom", taskMode: "native",
    profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/owned" }],
    watchedConversationIDs: [], launch: { when: [] } }
  const payload = { configuration, creation: creation() }
  assert.notEqual(missionSchedulePayloadDigest(payload as never), missionSchedulePayloadDigest({ configuration } as never))
  assert.equal(missionSchedulePayloadDigest({ configuration } as never),
    missionSchedulePayloadDigest({ configuration, creation: undefined } as never))
  const value = { ...request(), action: "create", requestID: "original", expectedRevision: 0, ...payload,
    transport: { ...proof(), action: "create", requestID: "original", expectedRevision: 0, configDigest: missionSchedulePayloadDigest(payload as never) } }
  assert.equal(missionScheduleRequestSchema.safeParse(value).success, true)
  assert.doesNotThrow(() => assertMissionScheduleAgentRequest(missionScheduleRequestSchema.parse(value)))
  value.creation.digest = "e".repeat(64)
  assert.equal(missionScheduleRequestSchema.safeParse(value).success, false)
  assert.equal(missionScheduleRequestSchema.safeParse({ ...request(), creation: creation() }).success, false)
})
