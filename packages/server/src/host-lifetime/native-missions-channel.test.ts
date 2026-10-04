import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Module, createRequire } from "node:module"
import { NativeRuntimeBinding, type NativeRuntimeSDK } from "./native-runtime-binding"
import { NativeMissionsBinding, NativeMissionsOpening } from "./native-missions-binding"
import { NativeManagedMissionsChannel, NativeMissionsHostFactory } from "./native-missions-channel"
import { MISSIONS_AUTHORITY_METHODS, NATIVE_MISSIONS_PROTOCOL } from "./native-missions-contract"

const temp = process.platform === "win32" ? "C:/Users/Admin/AppData/Local/Temp/opencode" : tmpdir()
const plugin = new URL("../../../../node_modules/@opencode/plugin/", import.meta.url)
function fakeRuntime(): NativeRuntimeSDK {
  const refuse = () => { throw new Error("fixture must never execute") }
  return { abi: "codenomad.runtime.v1", openManager: refuse, verifyManager: refuse,
    verifyMember: refuse, authorizeService: refuse, verifyService: refuse, release: refuse }
}

for (const label of ["plain JSON", "callback shaped native SDK", "prototype object", "production field"]) {
  test(`${label} cannot mint a native Missions binding`, () => {
    const values: Record<string, unknown> = {
      "plain JSON": { missionsProtocol: NATIVE_MISSIONS_PROTOCOL, qualified: true },
      "callback shaped native SDK": { ...fakeRuntime(), missionsProtocol: NATIVE_MISSIONS_PROTOCOL },
      "prototype object": Object.create(NativeRuntimeBinding.prototype),
      "production field": { sdk: fakeRuntime(), production: true },
    }
    assert.throws(() => NativeMissionsBinding.fromRuntimeBinding(values[label] as NativeRuntimeBinding), /native-runtime-binding-unverified/)
  })
}
test("existing nominal private SDK fixtures cannot qualify Missions, even with all ABI method names", () => {
  const sdk = Object.assign(fakeRuntime(), {
    missionsProtocol: NATIVE_MISSIONS_PROTOCOL,
    openMissionsChannel: async () => ({ qualified: true }),
    missionsAssertChannel: () => undefined,
    missionsRelease: () => undefined,
  }, Object.fromEntries(MISSIONS_AUTHORITY_METHODS.map(name => [name, () => undefined])))
  const fixture = NativeRuntimeBinding.forPrivateFixture(sdk)
  assert.equal(fixture.production, false)
  assert.throws(() => NativeMissionsBinding.fromRuntimeBinding(fixture), /native-runtime-binding-unverified/)
})
test("a caller-minted opening cannot borrow a different nominal binding or a factory mint", () => {
  const sdk = { missionsProtocol: NATIVE_MISSIONS_PROTOCOL, openMissionsChannel: async () => ({}),
    missionsRelease() {}, missionsAssertChannel() {} } as const
  assert.throws(() => new NativeMissionsOpening({} as NativeMissionsBinding, sdk as never, {}, Symbol("native-missions-opening")), /native-missions-channel-required/)
  assert.throws(() => new NativeManagedMissionsChannel({} as NativeMissionsOpening, {} as never,
    {}, [], new AbortController().signal, Symbol("native-missions-qualified-channel")), /native-missions-authority-unavailable/)
})
test("prototype invocation cannot bypass factory admission to execute a caller opening", async () => {
  let calls = 0
  const fake = { input: { binding: { open() { calls++; throw new Error("bait") } } } }
  await assert.rejects(NativeMissionsHostFactory.prototype.open.call(fake as unknown as NativeMissionsHostFactory), /native-missions-authority-unavailable/)
  assert.equal(calls, 0)
})
test("native factory refuses caller-supplied process, inventory and family JSON", () => {
  const fake = { production: true, open: async () => ({
    authority: () => ({ sdk: {}, handle: { pid: process.pid, inventory: [], family: "C:/physical" } }),
  }) }
  assert.throws(() => new NativeMissionsHostFactory({ binding: fake as unknown as NativeMissionsBinding,
    runtimeSession: {}, signal: new AbortController().signal,
    families: [{ held: { family: "C:/physical", claim: { assertCurrent: async () => undefined, release: async () => undefined } }, nativeClaim: {} }],
  }), /native-missions-binding-required/)
})
test("Missions artifact loading refuses absent native bytes without any authority path", async () => {
  const root = await mkdtemp(path.join(temp, "missions-addon-negative-"))
  try {
    await assert.rejects(NativeMissionsBinding.load(path.join(root, "absent.node"), "0".repeat(64)), /native-runtime-binding-unverified/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test("hash-matching nonnative .node cannot use global caches or extension hooks to become authority", async () => {
  const root = await mkdtemp(path.join(temp, "missions-loader-negative-"))
  const file = path.join(root, "not-native.node"), content = Buffer.from("not an addon")
  const extensions = (Module as unknown as { _extensions: Record<string, (module: NodeModule, file: string) => void> })._extensions
  const require = createRequire(import.meta.url), original = extensions[".node"]
  let calls = 0
  try {
    await writeFile(file, content)
    const bait = { exports: { ...fakeRuntime(), missionsProtocol: NATIVE_MISSIONS_PROTOCOL } }
    require.cache[file] = bait as NodeModule
    extensions[".node"] = () => { calls++ }
    await assert.rejects(NativeMissionsBinding.load(file, createHash("sha256").update(content).digest("hex")), /native-runtime-binding-unverified/)
    assert.equal(calls, 0)
    assert.equal(require.cache[file], bait)
  } finally {
    extensions[".node"] = original
    delete require.cache[file]
    await rm(root, { recursive: true, force: true })
  }
})
test("installed plugin Context has no runtime-native writer/family/guardian producer", async () => {
  const context = await readFile(new URL("dist/promise/plugin.d.ts", plugin), "utf8")
  const registration = await readFile(new URL("dist/promise/registration.d.ts", plugin), "utf8")
  assert.doesNotMatch(context, /readonly\s+(?:nativeMissions|managedWriter|guardian|authorityInventory|familyClaim)\s*:/)
  assert.doesNotMatch(registration, /incarnationID|disposalReceipt|artifactDigest|daemonStorageID/)
  assert.match(registration, /dispose:\s*\(\)\s*=>\s*Promise<void>/)
})
test("installed plugin storage ABI cannot supply synchronous guarded publication", async () => {
  const storage = await readFile(new URL("dist/promise/storage.d.ts", plugin), "utf8")
  assert.match(storage, /set:\s*\(key: string, value: Schema.Json\)\s*=>\s*Promise<void>/)
  assert.match(storage, /remove:\s*\(key: string\)\s*=>\s*Promise<void>/)
  assert.doesNotMatch(storage, /transaction|commitGuard|compareAndSwap|guardian/)
})
