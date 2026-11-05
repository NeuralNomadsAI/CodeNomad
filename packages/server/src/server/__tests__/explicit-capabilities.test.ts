import assert from "node:assert/strict"
import test from "node:test"
import { initialServerCapabilities, requireServerCapability, SERVER_CAPABILITY_NAMES } from "../../opencode/servers/capabilities"

test("closed capability policy rejects unknown and limited explicit authority; local initial semantics stay unchanged", () => {
  const explicit = initialServerCapabilities({ kind: "explicit", id: "A", label: "A", origin: "https://a.invalid" }, 1)
  const local = initialServerCapabilities({ kind: "local-shared", id: "local-shared" }, 1)
  for (const capability of SERVER_CAPABILITY_NAMES) {
    assert.throws(() => requireServerCapability(capability, explicit.features[capability]), error => {
      assert.equal((error as any).code, "explicit_capability_unavailable")
      assert.equal((error as any).capability, capability)
      assert.deepEqual((error as any).reason, explicit.features[capability].reason)
      return true
    })
    assert.doesNotThrow(() => requireServerCapability(capability, local.features[capability], true))
  }
  assert.doesNotThrow(() => requireServerCapability("chat", { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }))
})
