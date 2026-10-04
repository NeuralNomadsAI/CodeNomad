// Private real compiled SDK consumer, not NativeRuntimeBinding.forPrivateFixture.
import assert from "node:assert/strict"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { writeSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { NativeRuntimeBinding } from "../../packages/server/src/host-lifetime/native-runtime-binding"
import { RuntimeOpcode, RuntimeTransport, memberRequest } from "../../packages/server/src/host-lifetime/native-runtime-transport"
import { BackendHarness, exerciseProtocol } from "./protocol-suite"

const deadline = setTimeout(() => process.exit(1), 45_000)
let stage = 1
async function main() {
  const file = fileURLToPath(new URL("../../packages/native-host-lifetime/target/debug/codenomad_native_host_lifetime.node", import.meta.url))
  const digest = createHash("sha256").update(await readFile(file)).digest("hex")
  const binding = await NativeRuntimeBinding.load(file, digest)
  stage = 2
  assert.equal(binding.production, true) // Compiled loader only; NOT runtime qualification.
  const nonce = randomBytes(32)
  const opened = await binding.sdk.openManager(nonce)
  stage = 3
  const launch = JSON.parse(opened.launch.toString())
  const launchDigest = createHash("sha256").update(opened.launch).digest("hex")
  await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, nonce, launchDigest, opened.attestation))
  // Raw receipt inspection is negative evidence ONLY, never a native capability.
  const facts = JSON.parse(opened.attestation.subarray(0, -32).toString())
  stage = 4
  assert.equal(facts.manager.pid, process.pid)
  assert.equal(facts.assignedSuspended, true)
  assert.equal(facts.supervisorOutsideAllJobs, false)
  assert.equal(facts.ownerBootstrapVerified, false)
  assert.notEqual(facts.servicePeer.pid, process.pid)
  assert.equal(facts.servicePeer.outsideAllJobs, false) // Actual peer, never a manufactured independent proof.
  await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, randomBytes(32), launchDigest, opened.attestation))
  await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, nonce, "0".repeat(64), opened.attestation))
  const corrupted = Buffer.from(opened.attestation); corrupted[0] ^= 1
  await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, nonce, launchDigest, corrupted))
  // The JavaScript wire key must not mint a native attestation.
  const forged = Buffer.from(opened.attestation)
  createHmac("sha256", opened.key).update(forged.subarray(0, -32)).digest().copy(forged, forged.length - 32)
  await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, nonce, launchDigest, forged))
  assert.throws(() => binding.sdk.verifyManager({}, nonce, launchDigest, opened.attestation))
  const transport = new RuntimeTransport(opened.channel, opened.key, launch.scope.key, launch.generation)
  let receivedBytes = 0
  opened.channel.on("data", (bytes: Buffer) => { receivedBytes += bytes.length })
  stage = 5
  const harness = new BackendHarness(launch.root, async pid => {
    const query = memberRequest(pid)
    const receipt = await transport.request(RuntimeOpcode.member, query.bytes, Date.now() + 4000)
    const observed = await binding.sdk.verifyMember(opened.nativeSession, pid, query.nonce, receipt)
    assert.equal(observed.member.pid, pid); assert.equal(observed.inherited, true)
    await assert.rejects(binding.sdk.verifyMember(opened.nativeSession, pid, randomBytes(32), receipt))
    await assert.rejects(binding.sdk.verifyMember(opened.nativeSession, process.pid, query.nonce, receipt))
    return { pid, creationFiletime: observed.member.filetime }
  })
  // Real installed wire, compiled verification and unchanged Node-owned BackendProcess IPC.
  await exerciseProtocol(harness)
  stage = 6
  const queries = Array.from({ length: 16 }, () => memberRequest(process.pid))
  const work = queries.map(query => transport.request(RuntimeOpcode.member, query.bytes, Date.now() + 4000))
  await assert.rejects(transport.request(RuntimeOpcode.member, memberRequest(process.pid).bytes, Date.now() + 4000))
  for (const [i, receipt] of (await Promise.all(work)).entries()) {
    await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, queries[i].nonce, launchDigest, receipt))
  }
  assert.ok(receivedBytes > 8192) // Actual sustained channel, beyond all bootstrap budgets.
  await assert.rejects(binding.sdk.authorizeService(opened.nativeSession, Buffer.from("{}"), Date.now() + 4000))
  if (launch.fixtureMode === "drain") {
    assert.equal((await transport.request(RuntimeOpcode.stopDrained, Buffer.alloc(0), Date.now() + 4000)).length, 0)
    transport.close(); binding.sdk.release(opened.nativeSession); binding.sdk.release(opened.nativeSession)
    assert.throws(() => binding.sdk.verifyManager(opened.nativeSession, nonce, launchDigest, opened.attestation))
    clearTimeout(deadline); process.exit(0)
  }
  stage = 7
  const survivor = harness.start(); await harness.ready(survivor)
  const descendant = await harness.request(survivor, "descendant") as { pid: number }
  const query = memberRequest(descendant.pid)
  const receipt = await transport.request(RuntimeOpcode.member, query.bytes, Date.now() + 4000)
  assert.equal((await binding.sdk.verifyMember(opened.nativeSession, descendant.pid, query.nonce, receipt)).inherited, true)
  clearTimeout(deadline)
  process.exit(77) // Leave actual B/D live: native exact-M watcher is sole cleanup authority.
}
main().catch(() => { writeSync(1, Buffer.from([stage])); process.exit(1) })
