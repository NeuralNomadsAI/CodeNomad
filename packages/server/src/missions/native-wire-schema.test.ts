import assert from "node:assert/strict"
import test from "node:test"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { lifecycleOperationSchema } from "./lifecycle-schema"
import { taskExecutionModeSchema, taskExecutionModeRpcSchema } from "./native-wire-schema"
import { parseExecutionMode } from "./task-execution-mode"
import { parseNativeBinding } from "./native-report-provenance"

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
})

test("native snapshot decoder admits coordinator business readout as distinct delivery", () => {
  const schema = JSON.stringify(CODENOMAD_MISSIONS_RPC)
  assert(schema.includes('"enum":["coordinator-notification","native-return","coordinator-readout"]'))
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
