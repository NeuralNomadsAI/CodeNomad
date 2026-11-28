import assert from "node:assert/strict"
import test from "node:test"
import { SchemaRepresentation } from "effect"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { lifecycleOperationSchema } from "./lifecycle-schema"
import { taskExecutionModeSchema, taskExecutionModeRpcSchema } from "./native-wire-schema"
import { parseExecutionMode } from "./task-execution-mode"
import { parseNativeBinding } from "./native-report-provenance"
import { MISSION_BRIEFING_RESPONSES_MAX, missionBriefingResponsesSchema, missionBriefingSnapshotSchema } from "./briefing"
import { scheduleToolWire } from "./schedule-tool"
import { missionProgramWire } from "./program-tool"
import { projectReadWire } from "./project-read-tool"
import { projectControlWire, projectConfigureWire, projectDeleteWire } from "./project-control-tool"
import { missionSettingsInput, missionSettingsWire } from "./settings-tool"

test("Missions settings advertises a portable tool schema and still rejects mixed scopes", () => {
  assert.equal(Reflect.get(missionSettingsWire, "type"), "object")
  for (const key of ["oneOf", "anyOf", "allOf"]) assert.equal(Object.hasOwn(missionSettingsWire, key), false, key)
  const expectation = "a".repeat(64)
  assert.equal(missionSettingsInput.safeParse({ scope: "configurations", action: "read" }).success, true)
  assert.equal(missionSettingsInput.safeParse({ scope: "preferences", action: "read", field: "missionDeleteSessions" }).success, true)
  assert.equal(missionSettingsInput.safeParse({ scope: "depth", action: "save", expectation, depth: null }).success, true)
  assert.equal(missionSettingsInput.safeParse({ scope: "depth", action: "save", expectation, depth: 2, deleteSessions: true }).success, false)
  assert.equal(missionSettingsInput.safeParse({ scope: "preferences", action: "read" }).success, false)
  assert.equal(missionSettingsInput.safeParse({ scope: "depth", action: "save", depth: 2 }).success, false)
})

test("Missions native RPC schemas avoid unsupported not and pattern keywords", () => {
  const visit = (value: unknown, path = "rpc") => {
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      assert.notEqual(key, "not", path)
      assert.notEqual(key, "pattern", path)
      visit(child, `${path}.${key}`)
    }
  }
  visit(CODENOMAD_MISSIONS_RPC)
  visit(scheduleToolWire, "mission.schedule")
  visit(missionProgramWire, "mission.program")
  visit(missionSettingsWire, "mission.settings")
  visit(projectReadWire, "mission.inspect.project")
  for (const wire of [projectControlWire, projectConfigureWire, projectDeleteWire]) visit(wire, "mission.project-controls")
})

test("every Missions RPC schema converts through the native schema representation", () => {
  for (const schema of [projectControlWire, projectConfigureWire, projectDeleteWire, missionSettingsWire, missionProgramWire])
    assert.doesNotThrow(() => SchemaRepresentation.fromJsonSchemaDocument({ dialect: "draft-2020-12", schema, definitions: {} }))
  assert.doesNotThrow(() => SchemaRepresentation.fromJsonSchemaDocument({
    dialect: "draft-2020-12", schema: scheduleToolWire, definitions: {},
  }), "mission.schedule")
  assert.doesNotThrow(() => SchemaRepresentation.fromJsonSchemaDocument({
    dialect: "draft-2020-12", schema: projectReadWire, definitions: {},
  }), "mission.inspect.project")
  for (const [name, method] of Object.entries(CODENOMAD_MISSIONS_RPC.methods)) {
    for (const side of ["input", "output"] as const) {
      assert.doesNotThrow(() => SchemaRepresentation.fromJsonSchemaDocument({
        dialect: "draft-2020-12", schema: method[side], definitions: {},
      }), `${name}.${side}`)
    }
  }
  for (const [name, event] of Object.entries(CODENOMAD_MISSIONS_RPC.events)) {
    assert.doesNotThrow(() => SchemaRepresentation.fromJsonSchemaDocument({
      dialect: "draft-2020-12", schema: event.schema, definitions: {},
    }), `events.${name}`)
  }
})

test("native snapshot decoder admits coordinator business readout as distinct delivery", () => {
  const schema = JSON.stringify(CODENOMAD_MISSIONS_RPC)
  assert(schema.includes('"enum":["coordinator-notification","native-return","coordinator-readout"]'))
})

test("native snapshot and mutation output decoders retain the same optional project briefing contract", () => {
  const snapshotMission = CODENOMAD_MISSIONS_RPC.methods.snapshot.output.properties.missions.items
  assert.deepEqual(snapshotMission.properties.briefing, missionBriefingSnapshotSchema)
  assert.ok(!snapshotMission.required.some(key => key === "briefing" as string), "existing missions may lack a briefing")
  assert.deepEqual(CODENOMAD_MISSIONS_RPC.methods.lifecycle.output.properties.mission.properties.briefing, missionBriefingSnapshotSchema)
  assert.deepEqual(snapshotMission.properties.briefingResponses, missionBriefingResponsesSchema)
  assert.ok(!snapshotMission.required.some(key => key === "briefingResponses" as string), "older journals project no responses")
  assert.deepEqual(CODENOMAD_MISSIONS_RPC.methods.lifecycle.output.properties.mission.properties.briefingResponses, missionBriefingResponsesSchema)
  assert.equal(missionBriefingResponsesSchema.maxItems, MISSION_BRIEFING_RESPONSES_MAX)
  assert.equal(missionBriefingSnapshotSchema.additionalProperties, false)
  assert.equal(missionBriefingSnapshotSchema.properties.achieved.maxItems, 3)
})

test("RPC acknowledgement branches keep known evidence required and unknown evidence absent", () => {
  const [known, unknown] = lifecycleOperationSchema.properties.receipts.items.oneOf
  assert.equal(known.properties.acknowledgementState.const, "known")
  assert(known.required.includes("nativeAcknowledgement"))
  assert.equal(known.additionalProperties, false)
  assert.equal(unknown.properties.acknowledgementState.const, "unknown")
  assert.equal("nativeAcknowledgement" in unknown.properties, false)
  assert.equal(unknown.additionalProperties, false)
})

test("RPC shape compatibility does not relax domain or model-facing validation", () => {
  assert.equal(taskExecutionModeSchema.oneOf[0].properties.reuseFromTaskKey.pattern, "^[a-z0-9][a-z0-9._-]{1,63}$")
  assert.equal(taskExecutionModeRpcSchema.oneOf[0].properties.reuseFromTaskKey.maxLength, 64)
  assert.throws(() => parseExecutionMode({ kind: "native", parentTaskKey: "Bad Key" }))
  assert.throws(() => parseExecutionMode({ kind: "independent", reason: "playbook", explanation: "  " }))
  assert.equal(parseNativeBinding({ generation: 1, parentSessionID: "bad id", toolCallID: "tool", parentMessageID: "message" }), undefined)
  assert.deepEqual(parseExecutionMode({ kind: "native", parentTaskKey: null }), { kind: "native", parentTaskKey: null })
})
