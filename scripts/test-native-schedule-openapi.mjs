// node --import tsx scripts/test-native-schedule-openapi.mjs <read-only-opencode-checkout>
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { nativeScheduleCapability } from "../packages/server/src/opencode/native-schedule-capability.ts"

const [checkout] = process.argv.slice(2)
assert(checkout && path.isAbsolute(checkout), "Pass an absolute read-only OpenCode source checkout")
for (const tag of ["v2.2.1", "v2.2.2", "v2.2.3"]) {
  const document = JSON.parse(execFileSync("git", ["-C", checkout, "show", `${tag}:packages/protocol/openapi.json`], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }))
  assert.deepEqual(nativeScheduleCapability(document), { available: true }, tag)
  // Optional when still needs the complete consumed timing contract.
  delete document.components.schemas["Schedule.CreatePayload"].properties.when
  assert.deepEqual(nativeScheduleCapability(document), { available: false, reason: "incompatible-contract" }, tag)
  console.log(`PASS ${tag}: consumed schedule shapes, optional when and malformed-when refusal`)
}
