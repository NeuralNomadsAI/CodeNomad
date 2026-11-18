import assert from "node:assert/strict"
import test from "node:test"
import { MissionControlError } from "./control-error"
import { MISSION_DEFAULTS_REQUEST_INVALID, missionRecoveryControlError, missionRecoveryError, missionRecoveryRejection } from "./recovery-error"

test("only allowlisted recovery errors cross the bridge, with fixed redacted text", () => {
  const safe = missionRecoveryRejection(new MissionControlError("secret native request", "recovery-busy"))
  assert.equal(safe?.status, 409)
  assert.equal(safe?.code, "recovery-busy")
  assert.ok(!safe?.message.includes("secret"))
  assert.equal(missionRecoveryRejection(new Error("secret provider credentials")), undefined)
  assert.equal(missionRecoveryRejection(new MissionControlError("secret", "foreign-session")), undefined)
  for (const value of ["toString", "__proto__", null, {}, 503]) assert.equal(missionRecoveryError(value), undefined)
})

test("command validation is generic except for its exact allowlisted preference request guidance", () => {
  const generic = missionRecoveryControlError("invalid-execution", "secret backend details")
  assert.ok(!generic.message.includes("creating a mission"))
  assert.ok(!generic.message.includes("secret"))
  const error = missionRecoveryControlError("invalid-execution", MISSION_DEFAULTS_REQUEST_INVALID)
  assert.equal(error.message, MISSION_DEFAULTS_REQUEST_INVALID)
  assert.equal(missionRecoveryRejection(error)?.message, MISSION_DEFAULTS_REQUEST_INVALID)
})
