// Real compiled SDK/Node IPC. Narrow response handoff is NOT production admission.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { writeSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { NativeRuntimeBinding } from "../../packages/server/src/host-lifetime/native-runtime-binding"
import { RuntimeTransport, RuntimeOpcode, memberRequest } from "../../packages/server/src/host-lifetime/native-runtime-transport"
import { BackendHarness } from "./protocol-suite"
let stage = 1
const timer = setTimeout(() => process.exit(1), 20000)
async function main() {
  const file = fileURLToPath(new URL("../../packages/native-host-lifetime/target/debug/codenomad_native_host_lifetime.node", import.meta.url))
  const binding = await NativeRuntimeBinding.load(file, createHash("sha256").update(await readFile(file)).digest("hex"))
  const fixtureSdk = createRequire(import.meta.url)(file) as { fixtureAuthorizeNestedResponse(session: object, bytes: Buffer): Promise<Buffer> }
  const nonce = randomBytes(32), opened = await binding.sdk.openManager(nonce)
  const launch = JSON.parse(opened.launch.toString())
  await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, nonce, createHash("sha256").update(opened.launch).digest("hex"), opened.attestation))
  const facts = JSON.parse(opened.attestation.subarray(0, -32).toString())
  assert.equal(facts.supervisorOutsideAllJobs, false)
  const transport = new RuntimeTransport(opened.channel, opened.key, launch.scope.key, launch.generation)
  let lost = false
  transport.onLoss(() => { lost = true })
  const observe = async (pid: number) => {
    const query = memberRequest(pid)
    const receipt = await transport.request(RuntimeOpcode.member, query.bytes, Date.now() + 4000)
    const member = await binding.sdk.verifyMember(opened.nativeSession, pid, query.nonce, receipt)
    return { pid, creationFiletime: member.member.filetime }
  }
  const harness = new BackendHarness(launch.root, observe), backend = harness.start()
  await harness.ready(backend)
  stage = 2
  const call = async (mode: string) => {
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
    const bytes = Buffer.from(JSON.stringify({ request: { ...launch.fixtureServiceRequest, env: { ...env, CNHL_MOCK_ENV: "unchanged", CNHL_MOCK_MODE: mode } }, deadline: Date.now() + 4000 }))
    const digest = createHash("sha256").update(bytes).digest("hex")
    // Production authorizeService remains fail-closed on this nested host.
    await assert.rejects(binding.sdk.authorizeService(opened.nativeSession, bytes, JSON.parse(bytes.toString()).deadline), { message: "native-runtime-request-refused" })
    const permit = await fixtureSdk.fixtureAuthorizeNestedResponse(opened.nativeSession, bytes)
    // Zero prefix and wrapped permit are accepted ONLY by the native fixture.
    const handoff = Buffer.from(JSON.stringify({ permit: permit.toString("hex"), bytes: bytes.toString("hex") }))
    const response = await transport.request(RuntimeOpcode.serviceStart, Buffer.concat([Buffer.alloc(4), handoff]), Date.now() + 4000)
    const end = 4 + response.readUInt32LE()
    assert.ok(end > 36 && end <= response.length)
    const attestation = response.subarray(4, end), output = JSON.parse(response.subarray(end).toString())
    if (output.error) {
      assert.deepEqual(output, { error: "native-service-failed" })
      const negative = JSON.parse(attestation.subarray(0, -32).toString())
      assert.equal(negative.error, output.error); assert.equal(negative.requestDigest, createHash("sha256").update(bytes).digest("hex"))
      assert.equal(negative.profile, launch.scope.key); assert.equal(negative.generation, launch.generation)
      assert.equal(negative.runtimeId, facts.runtimeId)
      assert.deepEqual(negative.manager, { pid: facts.manager.pid, creationFiletime: facts.manager.filetime })
      assert.equal(negative.outsideAllJobsBeforeResume, undefined) // Never success/qualification facts.
      await assert.rejects(binding.sdk.verifyService(opened.nativeSession, digest, attestation), { message: "native-service-start-failed" })
      // Failure consumed the exact native SDK admission; no second verification.
      await assert.rejects(binding.sdk.verifyService(opened.nativeSession, digest, attestation), { message: "native-runtime-request-refused" })
      throw new Error("native-service-start-failed")
    }
    assert.deepEqual(output, { stdout: "mock-service-started:unchanged", stderr: "" })
    const negative = JSON.parse(attestation.subarray(0, -32).toString())
    assert.equal(negative.outsideAllJobsBeforeResume, false) // S verified it; still not product independence.
    await assert.rejects(binding.sdk.verifyService(opened.nativeSession, digest, attestation), { message: "native-runtime-request-refused" })
    return output
  }
  if (launch.fixtureResponseCase !== "healthy") {
    // Remain live with a registered backend until the native fatal path kills both.
    void call("unchanged").catch(() => {})
    await new Promise(() => {})
  }
  await assert.rejects(call("fail"), { message: "native-service-start-failed" })
  stage = 3
  assert.equal(lost, false); assert.equal(transport.available, true)
  const query = memberRequest(process.pid)
  const managerReceipt = await transport.request(RuntimeOpcode.member, query.bytes, Date.now() + 4000)
  await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, query.nonce, createHash("sha256").update(opened.launch).digest("hex"), managerReceipt))
  await observe(backend.child.pid!)
  assert.deepEqual(await harness.request(backend, "native"), { correlated: true })
  await call("unchanged")
  stage = 4
  await observe(backend.child.pid!)
  assert.equal(lost, false); assert.equal(transport.available, true)
  await harness.cleanup()
  assert.equal((await transport.request(RuntimeOpcode.stopDrained, Buffer.alloc(0), Date.now() + 4000)).length, 0)
  clearTimeout(timer); transport.close(); binding.sdk.release(opened.nativeSession); process.exit(0)
}
main().catch(() => { writeSync(1, Buffer.from([stage])); process.exit(1) })
