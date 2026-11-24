import assert from "node:assert/strict"
import test from "node:test"
import { assertNativeSchedulePreflight, nativeSchedulePreflight } from "./native-mission-schedule-preflight"

test("the read-only fan-in cutoff is bound to one actual wake and incarnation, not caller time", () => {
  const wake = { missionID: "owned", generation: 1, scheduleID: "sch_owned", sessionID: "ses_owned", run: 1, messageID: "msg_sch_owned_1" }
  const receipt = nativeSchedulePreflight(wake, "service-one", 900, 1000)
  assert.equal(assertNativeSchedulePreflight(receipt, wake, "service-one", 1001), 900)
  for (const value of [{ ...receipt, cutoff: 901 }, { ...receipt, issuedAt: 1001 }, { ...receipt, signature: "0".repeat(64) }])
    assert.throws(() => assertNativeSchedulePreflight(value, wake, "service-one", 1001))
  assert.throws(() => assertNativeSchedulePreflight(receipt, { ...wake, run: 2, messageID: "msg_sch_owned_2" }, "service-one", 1001))
  assert.throws(() => assertNativeSchedulePreflight(receipt, wake, "service-two", 1001))
  assert.throws(() => assertNativeSchedulePreflight(receipt, wake, "service-one", 9000))
  assert.throws(() => assertNativeSchedulePreflight(undefined, wake, "service-one", 1001))
})
