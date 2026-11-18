import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { NativeScheduleActivationRefused } from "../../opencode/native-schedule-settings-activation"
import { missionScheduleActivationRefusal } from "./mission-schedule-activation-refusal"

test("refusal exposes editor actions only for exact existing global inventory membership", () => {
  for (const extension of ["json", "jsonc"]) {
    const file = path.join(os.homedir(), ".config", "opencode", `opencode.${extension}`)
    const refusal = missionScheduleActivationRefusal(new NativeScheduleActivationRefused({
      reason: "explicit-off", provenance: "experimental-block", layer: "global", path: file }))
    assert.equal(refusal?.openable, true)
    assert.equal(refusal?.configFileID, extension === "json" ? "opencode-global-config" : "opencode-global-config-jsonc")
  }
  for (const file of [path.resolve("project/.opencode/opencode.jsonc"), "/remote/config/opencode.json"]) {
    const refusal = missionScheduleActivationRefusal(new NativeScheduleActivationRefused({
      reason: "explicit-off", provenance: "experimental-block", layer: "inherited", path: file }))
    assert.equal(refusal?.openable, false); assert.equal(refusal?.configFileID, undefined)
  }
  assert.deepEqual(missionScheduleActivationRefusal(new NativeScheduleActivationRefused({
    reason: "explicit-off", provenance: "environment", layer: "environment" })),
  { reason: "explicit-off", provenance: "environment", layer: "environment", openable: false })
})
