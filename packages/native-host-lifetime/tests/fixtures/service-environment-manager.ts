// Actual compiled SDK/private native control + unchanged real BackendProcess IPC.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFile, appendFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { NativeRuntimeBinding } from "../../../server/src/host-lifetime/native-runtime-binding"
import { RuntimeTransport, RuntimeOpcode, memberRequest } from "../../../server/src/host-lifetime/native-runtime-transport"
import { BackendHarness } from "../../../../scripts/host-lifetime-node-ipc/protocol-suite"

const timer = setTimeout(() => process.exit(99), 30000)
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const envHash = (env: Record<string, string>) => hash(JSON.stringify(Object.entries(env)
  .map(([key, value]) => [key.toUpperCase(), value]).sort(([a], [b]) => a.localeCompare(b))))
async function main() {
  const file = process.env.CN_ENV_FIXTURE_BINDING!
  const binding = await NativeRuntimeBinding.load(file, hash(await readFile(file)))
  const sdk = createRequire(import.meta.url)(file) as { fixtureAuthorizeNestedResponse(session: object, bytes: Buffer): Promise<Buffer> }
  const opened = await binding.sdk.openManager(randomBytes(32))
  const launch = JSON.parse(opened.launch.toString())
  await assert.rejects(binding.sdk.verifyManager(opened.nativeSession, randomBytes(32), hash(opened.launch), opened.attestation))
  const transport = new RuntimeTransport(opened.channel, opened.key, launch.scope.key, launch.generation)
  const attempts = path.join(launch.root, "attempts.jsonl")
  const log = async (value: object) => appendFile(attempts, JSON.stringify(value) + "\n")
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
  const completeEnv = (count: number, phase: string) => {
    // Complete intended execution snapshot; exclude the test loader injection only.
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key, value]) => value !== undefined && key !== "NODE_OPTIONS") as [string, string][])
    env.CN_ENV_PHASE = phase
    assert.equal(env.CN_ENV_INHERITED_SENTINEL, launch.inheritedSentinel)
    for (let i = 0; Object.keys(env).length < count; i++) env[`CN_ENV_PAD_${i}`] = "fixture"
    assert.equal(Object.keys(env).length, count)
    return env
  }
  const call = async (env: Record<string, string>, phase: string, invalid: boolean) => {
    const bytes = Buffer.from(JSON.stringify({ request: { ...launch.fixtureServiceRequest, env }, deadline: Date.now() + 4000 }))
    const digest = hash(bytes)
    await log({ phase, stage: "request", environmentCount: Object.keys(env).length, environmentSha256: envHash(env), requestDigest: digest })
    let permit: Buffer
    try { permit = await sdk.fixtureAuthorizeNestedResponse(opened.nativeSession, bytes) }
    catch (error) {
      assert.equal(invalid, true)
      assert.equal((error as Error).message, "native-runtime-request-refused")
      assert.equal(lost, false); assert.equal(transport.available, true)
      await observe(backend.child.pid!)
      assert.deepEqual(await harness.request(backend, "native"), { correlated: true })
      await log({ phase, stage: "local-refused", error: "native-runtime-request-refused", runtimeAndBackendAlive: true })
      return
    }
    await log({ phase, stage: "permit-issued" })
    const handoff = Buffer.from(JSON.stringify({ permit: permit.toString("hex"), bytes: bytes.toString("hex") }))
    const response = await transport.request(RuntimeOpcode.serviceStart, Buffer.concat([Buffer.alloc(4), handoff]), Date.now() + 4000)
    const end = 4 + response.readUInt32LE()
    const output = JSON.parse(response.subarray(end).toString())
    assert.equal(invalid, false)
    assert.deepEqual(output, { stdout: "private-environment-preserved", stderr: "" })
    // Nested placement remains counterproof, never independent service authority.
    await assert.rejects(binding.sdk.verifyService(opened.nativeSession, digest, response.subarray(4, end)), { message: "native-runtime-request-refused" })
    await log({ phase, stage: "success", runtimeAndBackendAlive: true })
  }
  await call(completeEnv(512, "valid-before"), "valid-before", false)
  await call(completeEnv(513, "invalid-513"), "invalid-513", true)
  const duplicate = completeEnv(512, "invalid-folded-512")
  delete duplicate.CN_ENV_PAD_1; duplicate.cn_env_pad_0 = duplicate.CN_ENV_PAD_0
  assert.equal(Object.keys(duplicate).length, 512)
  await call(duplicate, "invalid-folded-512", true)
  await call(completeEnv(512, "valid-after"), "valid-after", false)
  assert.equal(lost, false); assert.equal(transport.available, true)
  await observe(backend.child.pid!)
  assert.deepEqual(await harness.request(backend, "native"), { correlated: true })
  await writeFile(path.join(launch.root, "manager-proof.json"), JSON.stringify({ localRefusals: 2, serviceSuccesses: 2,
    managerAndBackendAliveAfterRefusals: true, subsequentValidRequestWorks: true, independentLaunchQualified: false }))
  await harness.cleanup()
  assert.equal((await transport.request(RuntimeOpcode.stopDrained, Buffer.alloc(0), Date.now() + 4000)).length, 0)
  clearTimeout(timer); transport.close(); binding.sdk.release(opened.nativeSession); process.exit(0)
}
main().catch(() => process.exit(98))
