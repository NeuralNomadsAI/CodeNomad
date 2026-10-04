/** Standalone bounded native-addon probe. Run only against a freshly built
 * empty-feature addon in an owned temporary Cargo target, never user resources.
 * It never opens bootstrap pipes, launches a supervisor or touches OpenCode. */
import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { NativeRuntimeBinding } from "./native-runtime-binding"
import { NativeMissionsBinding } from "./native-missions-binding"
import { MISSIONS_CHANNEL_METHODS, NATIVE_MISSIONS_PROTOCOL, type NativeMissionsSDK } from "./native-missions-contract"
import { NativeMissionsHostFactory } from "./native-missions-channel"

const file = process.argv[2]
const temporaryRoot = "C:/Users/Admin/AppData/Local/Temp/opencode"
if (process.platform !== "win32" || !file || !path.isAbsolute(file)
  || path.relative(temporaryRoot, file).startsWith("..") || path.extname(file) !== ".node")
  throw new Error("probe requires an explicit owned temporary addon")
const contents = await readFile(file)
const runtime = await NativeRuntimeBinding.load(file, createHash("sha256").update(contents).digest("hex"))
const binding = NativeMissionsBinding.fromRuntimeBinding(runtime)
const sdk = runtime.sdk as unknown as NativeMissionsSDK

test("actual empty-feature native addon exports the complete guardian ABI, not authority qualification", () => {
  assert.equal(sdk.missionsProtocol, NATIVE_MISSIONS_PROTOCOL)
  assert.equal(Object.isFrozen(runtime.sdk), true)
  assert.equal(Object.prototype.hasOwnProperty.call(runtime.sdk, "fixtureAuthorizeNestedResponse"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(runtime.sdk, "missionsAuthorityProtocol"), false)
  for (const name of MISSIONS_CHANNEL_METHODS) assert.equal(typeof sdk[name], "function", name)
})
test("actual native session type tag rejects JSON before any private pipe is read", async () => {
  await assert.rejects(binding.open({ pid: process.pid, available: true }, new AbortController().signal), /native-sdk-session-required/)
})
const assertions: Array<[string, () => unknown]> = [
  ["channel", () => sdk.missionsAssertChannel({})],
  ["inventory loans", () => sdk.missionsInventory({})],
  ["complete inventory", () => sdk.missionsReadWriterInventory({})],
  ["quiescence", () => sdk.missionsAssertQuiescence({})],
  ["registration", () => sdk.missionsAssertRegistration({}, {})],
  ["human lease acquisition", () => sdk.missionsAcquireHumanLease({}, {}, 100)],
  ["human lease", () => sdk.missionsAssertHumanLease({})],
  ["guard acquisition", () => sdk.missionsBeginCommit({}, {}, {})],
  ["commit guard", () => sdk.missionsAssertCommitGuard({})],
  ["publication", () => sdk.missionsCommit({})],
  ["release", () => sdk.missionsRelease({})],
]
for (const [name, call] of assertions) test(`actual native ${name} refuses caller-shaped capabilities`, () => {
  assert.throws(call, /native-missions-tagged-capability-required/)
})
test("native human lease TTL refuses nonintegers, zero, overflow and infinities", () => {
  for (const ttl of [0, -1, 30_001, 1.5, NaN, Infinity])
    assert.throws(() => sdk.missionsAcquireHumanLease({}, {}, ttl), /native-missions-human-lease-deadline-bound/)
})
test("actual production binding cannot make nativeHost.open accept a JS runtime/family producer", async () => {
  const host = new NativeMissionsHostFactory({ binding, runtimeSession: {}, signal: new AbortController().signal,
    families: [{ held: { family: "C:/owned-fixture-family", claim: { assertCurrent: async () => undefined, release: async () => undefined } }, nativeClaim: {} }],
  })
  await assert.rejects(host.open(), /native-sdk-session-required/)
})
