import assert from "node:assert/strict"
import test from "node:test"
import { assertMissionRecoveryReady, type MissionRecoveryObservation } from "./recovery-readiness"

const idle = (): MissionRecoveryObservation => ({ active: false, inboxCount: 0, pendingForms: 0, pendingPermissions: 0, runningShells: 0, runningChildren: 0 })

test("recovery is admitted only with known idle and no native wait", () => {
  assert.doesNotThrow(() => assertMissionRecoveryReady(idle()))
  assert.throws(() => assertMissionRecoveryReady({ ...idle(), active: true }), /native work/)
  for (const key of ["inboxCount", "pendingForms", "pendingPermissions", "runningShells", "runningChildren"] as const) {
    assert.throws(() => assertMissionRecoveryReady({ ...idle(), [key]: 1 }), /native work/)
    assert.throws(() => assertMissionRecoveryReady({ ...idle(), [key]: undefined }), /unknown/)
    assert.throws(() => assertMissionRecoveryReady({ ...idle(), [key]: -1 }), /unknown/)
  }
  assert.throws(() => assertMissionRecoveryReady({ ...idle(), active: undefined }), /unknown/)
})
