import test from "node:test"
import assert from "node:assert/strict"
import { Duplex } from "node:stream"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { NativeRuntimeBinding, type NativeRuntimeSDK, type NativeManagerFacts, type NativeBirth } from "./native-runtime-binding"
import { NativeRuntimeCapability } from "./native-runtime"
import { RuntimeOpcode } from "./native-runtime-transport"
import { HostLifetimeManager, createHostLifetimeManagerForPrivateFixture } from "./manager"
import { HostStorage } from "./storage"
import { HostLifetimeClient } from "./client"
import { fixtureStoragePolicy } from "./test-fixture"
import { canonicalScope } from "./protocol"
import { lookupProcess } from "./process-identity"
import { createNativeServiceLauncher } from "../workspaces/native-service-launcher"

const OFFSET = 504911232000000000n
const moduleUrl = (name: string) => new URL(name, import.meta.url).href
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const temp = process.platform === "win32" ? "C:/Users/Admin/AppData/Local/Temp/opencode" : tmpdir()
async function identity(pid: number): Promise<NativeBirth> {
  const observed = await lookupProcess(pid)
  if (observed.state !== "live") throw new Error("owned fixture process is not live")
  // Windows reads actual native birth. POSIX stub identity is explicitly NOT a
  // FILETIME/Job qualification; these SDK stubs never mint production authority.
  const filetime = observed.startIdentity.startsWith("win32:") ? BigInt(observed.startIdentity.slice(6)) - OFFSET
    : BigInt(`0x${createHash("sha256").update(observed.startIdentity).digest("hex").slice(0, 12)}`) + 1n
  return { pid, filetime: filetime.toString() }
}
async function fixture() {
  const root = await mkdtemp(path.join(temp, "native-runtime-sdk-"))
  await chmod(root, 0o700)
  await mkdir(path.join(root, "profile"), { mode: 0o700 })
  await writeFile(path.join(root, "profile", "package.json"), '{"type":"module"}')
  const entry = path.join(root, "profile", "index.ts")
  await writeFile(entry, `
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { AuthManager } from ${JSON.stringify(moduleUrl("../auth/manager.ts"))};
import { BootstrapProofs } from ${JSON.stringify(moduleUrl("./bootstrap.ts"))};
import { installBackendHostLifetime } from ${JSON.stringify(moduleUrl("./backend.ts"))};
import { NativeParent } from ${JSON.stringify(moduleUrl("../native-parent.ts"))};
export const HOST_BACKEND_ENTRY_VERSION = 1;
export async function runBackendMain() {
  await writeFile(${JSON.stringify(path.join(root, "auth-started"))}, "after-admission");
  const auth = new AuthManager({ configPath: ${JSON.stringify(path.join(root, "profile", "config.yaml"))},
    username: "private", generateToken: true }, { child() { return this }, info() {}, warn() {}, error() {}, debug() {} });
  const parent = new NativeParent();
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/service") res.end(JSON.stringify(await parent.request("opencode.service.start", {
        file: process.execPath, args: ["-e", "process.stdout.write(process.env.OWNED_VALUE);setTimeout(()=>{},700)"],
        env: { OWNED_VALUE: "preserved-private-value" }, cwd: ${JSON.stringify(root)}, windowsVerbatimArguments: false
      }, 5000)));
      else if (req.url === "/crash") process.exit(7);
      else { const chunks = []; for await (const chunk of req) chunks.push(chunk);
        res.end(JSON.stringify({ accepted: auth.consumeBootstrapToken(JSON.parse(Buffer.concat(chunks).toString()).proof) })); }
    } catch { res.writeHead(503).end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const control = installBackendHostLifetime(new BootstrapProofs(auth), "http://127.0.0.1:" + server.address().port);
  let buffer = "";
  process.stdin.on("data", chunk => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf("\\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line === "codenomad:shutdown") {
        control.beginShutdown(); parent.close();
        server.close(() => process.stdout.write("CODENOMAD_SHUTDOWN_STATUS:complete\\n", () => {
          process.exitCode = 0; process.stdin.destroy(); control.close();
        })); server.closeAllConnections();
      } else parent.handleLine(line);
    }
  });
}
`)
  const scope = canonicalScope("stable", path.join(root, "profile", "config.yaml"), root, root)
  const generation = randomUUID(), key = randomBytes(32)
  const launch = { root, scope, generation, backend: { file: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./backend-entry.ts", import.meta.url))], cwd: process.cwd(),
    env: { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_RUNTIME_DIR: root, CODENOMAD_HOST_BACKEND_ENTRY: entry } } }
  const launchBytes = Buffer.from(JSON.stringify(launch))
  const ownBirth = await identity(process.pid)
  const supervisor = { pid: process.pid + 100, filetime: "100" }, peer = { pid: process.pid + 101, filetime: "101" }
  const runtimeId = "f".repeat(64), events: string[] = [], starts: ChildProcess[] = []
  const state = { denyPeer: false, badLimits: false, denyMember: false, invalidateFresh: false, tamperMac: false,
    onLookup: undefined as ((pid: number) => void) | undefined,
    onMemberReceipt: undefined as (() => void) | undefined,
    onMemberVerify: undefined as (() => Promise<void>) | undefined,
    onInitialOpen: undefined as (() => void) | undefined,
    onInitialVerify: undefined as (() => Promise<void>) | undefined }
  let incoming = Buffer.alloc(0), starter: Promise<NativeBirth> | undefined, released = false
  const channel = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) {
    incoming = Buffer.concat([incoming, chunk]); callback()
    while (incoming.length >= 4 && incoming.length >= 4 + incoming.readUInt32LE()) {
      const length = incoming.readUInt32LE(), frame = incoming.subarray(4, length + 4); incoming = incoming.subarray(length + 4)
      const content = frame.subarray(0, -32)
      assert.ok(frame.subarray(-32).equals(createHmac("sha256", key).update(content).digest()))
      assert.ok(content.subarray(8, 40).equals(Buffer.from(scope.key, "hex")))
      const opcode = content[60], payload = content.subarray(62)
      const reply = async () => {
        let body = Buffer.alloc(0)
        if (opcode === RuntimeOpcode.member) {
          const candidate = payload.readUInt32LE(32)
          events.push(candidate === process.pid ? "manager-native-query" : "member")
          if (candidate !== process.pid) await assert.rejects(readFile(path.join(root, "auth-started")), { code: "ENOENT" })
          body = Buffer.from(JSON.stringify({ pid: payload.readUInt32LE(32), nonce: payload.subarray(0, 32).toString("hex") }))
        } else if (opcode === RuntimeOpcode.serviceStart) {
          events.push("outside-service")
          const bytes = payload.subarray(4 + payload.readUInt32LE()), request = JSON.parse(bytes.toString())
          const digest = createHash("sha256").update(bytes).digest("hex")
          const launcher = createNativeServiceLauncher((file, args, options) => {
            // This owned spawn is ONLY an unqualified SDK/broker fixture, not
            // proof of Windows outside-Job placement or an official daemon start.
            const child = spawn(file, args, options); starts.push(child)
            starter = new Promise(resolve => child.once("spawn", () => { void identity(child.pid!).then(resolve) }))
            return child
          })
          const output = await launcher(request.request, request.deadline)
          const receipt = Buffer.from(digest), size = Buffer.alloc(4); size.writeUInt32LE(receipt.length)
          body = Buffer.concat([size, receipt, Buffer.from(JSON.stringify(output))])
        } else if (opcode === RuntimeOpcode.stopDrained) {
          events.push("stop-drained")
          await assert.rejects(readFile(path.join(root, scope.key, "host.json")), { code: "ENOENT" })
        } else if (opcode === RuntimeOpcode.fatal) events.push(`fatal:${payload.toString()}`)
        else throw new Error("unknown private opcode")
        const header = Buffer.from(content.subarray(0, 62)); header[61] = 1
        const data = Buffer.concat([header, body]), mac = createHmac("sha256", key).update(data).digest()
        if (state.tamperMac) mac[0] ^= 1
        const size = Buffer.alloc(4); size.writeUInt32LE(data.length + 32)
        if (opcode === RuntimeOpcode.member && payload.readUInt32LE(32) !== process.pid) state.onMemberReceipt?.()
        channel.push(Buffer.concat([size, data, mac]))
      }
      void reply()
    }
  } })
  const sdk: NativeRuntimeSDK = {
    abi: "codenomad.runtime.v1",
    async openManager() {
      state.onInitialOpen?.()
      return { channel, nativeSession: {}, key, launch: launchBytes, attestation: Buffer.from("fixture-native-receipt") }
    },
    async verifyManager(_session, nonce, digest, receipt) {
      assert.equal(digest, createHash("sha256").update(launchBytes).digest("hex"))
      events.push("fresh-manager")
      if (receipt.toString() !== "fixture-native-receipt") {
        const value = JSON.parse(receipt.toString())
        assert.equal(value.pid, process.pid); assert.equal(value.nonce, nonce.toString("hex"))
      } else await state.onInitialVerify?.()
      return { nonce: nonce.toString("hex"), generation, scope: { ...scope }, runtimeId, manager: { ...ownBirth }, supervisor: { ...supervisor }, alive: true,
        assignedSuspended: true, supervisorOutsideAllJobs: true, ownerBootstrapVerified: true, soleJobOwnerPid: supervisor.pid, jobHandleInherited: false,
        limitFlags: state.badLimits || state.invalidateFresh ? 0x2800 : 0x2000,
        servicePeer: { ...peer, outsideAllJobs: !state.denyPeer, policyScope: scope.key, launcher: "native-service-launcher-v1" } } as NativeManagerFacts
    },
    async verifyMember(_session, pid, nonce, receipt) {
      const value = JSON.parse(receipt.toString())
      assert.equal(value.pid, pid); assert.equal(value.nonce, nonce.toString("hex"))
      events.push("native-member-verified")
      if (state.denyMember) throw new Error("fixture-native-denial")
      await state.onMemberVerify?.()
      return { nonce: nonce.toString("hex"), runtimeId, member: await identity(pid), alive: true, inherited: true }
    },
    async authorizeService(_session, bytes) {
      const value = JSON.parse(bytes.toString())
      assert.equal(value.request.file, process.execPath); assert.equal(value.request.cwd, root)
      assert.equal(value.request.env.OWNED_VALUE, "preserved-private-value")
      events.push("profile-policy")
      return createHash("sha256").update(bytes).digest()
    },
    async verifyService(_session, digest, receipt) {
      assert.equal(receipt.toString(), digest)
      return { requestDigest: digest, runtimeId, peer: { ...peer }, starter: await starter!, outsideAllJobsBeforeResume: true,
        policyScope: scope.key, originalExecutionPreserved: true }
    },
    release() { released = true; events.push("native-release") },
  }
  const binding = NativeRuntimeBinding.forPrivateFixture(sdk)
  const lookup = async (pid: number) => {
    state.onLookup?.(pid)
    return { state: "live" as const, startIdentity: `win32:${BigInt((await identity(pid)).filetime) + OFFSET}` }
  }
  let manager: HostLifetimeManager | undefined, client: HostLifetimeClient | undefined
  const start = async () => {
    const runtime = await NativeRuntimeCapability.forPrivateFixture(binding)
    const storage = new HostStorage(root, scope, fixtureStoragePolicy)
    manager = createHostLifetimeManagerForPrivateFixture({ storage, backend: runtime.launch.backend, runtime, lookup })
    await manager.start()
    client = await HostLifetimeClient.attach({ storage, lookup, launch: async () => { throw new Error("no replacement") } })
    return { runtime, storage, manager, client }
  }
  const dispose = async () => {
    await client?.stopAuthority().catch(() => undefined)
    if (manager) {
      const owned = manager as unknown as { backend?: { child: ChildProcess }; server: import("node:http").Server }
      owned.server.close(); owned.server.closeAllConnections()
      const child = owned.backend?.child
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exit
      }
    }
    for (const child of starts) if (child.exitCode === null && child.signalCode === null) child.kill()
    channel.destroy(); await rm(root, { recursive: true, force: true })
  }
  return { root, scope, generation, launch, binding, sdk, state, events, lookup, channel, start, dispose, released: () => released }
}

test("opaque production gate refuses callback/JSON/fixture authority; no peer/no-breakaway denies before B/auth", async () => {
  const f = await fixture()
  try {
    const storage = new HostStorage(f.root, f.scope, fixtureStoragePolicy)
    if (process.platform === "win32") assert.throws(() => new HostLifetimeManager({ storage, backend: f.launch.backend,
      verifyOwnership: async () => undefined } as any), /native-runtime-capability-required/)
    assert.throws(() => new HostLifetimeManager({ storage, backend: f.launch.backend, runtime: { launch: f.launch } as any }), /native-runtime-capability-required/)
    await assert.rejects(NativeRuntimeCapability.open(f.binding), /native-runtime-binding-unverified/)
    await assert.rejects(NativeRuntimeBinding.load(path.join(f.root, "missing.node"), "0".repeat(64)), /native-runtime-binding-unverified/)
    f.state.denyPeer = true
    await assert.rejects(NativeRuntimeCapability.forPrivateFixture(f.binding), /native-runtime-qualification-failed/)
    await assert.rejects(readFile(path.join(f.root, "auth-started")), { code: "ENOENT" })
  } finally { await f.dispose() }
  const other = await fixture()
  try {
    other.state.badLimits = true
    await assert.rejects(NativeRuntimeCapability.forPrivateFixture(other.binding), /native-runtime-qualification-failed/)
    await assert.rejects(readFile(path.join(other.root, "auth-started")), { code: "ENOENT" })
  } finally { await other.dispose() }
})

test("real Node wrapper waits for exact native member before AuthManager; outside service preserves execution; Stop drains before S signal", { timeout: 20_000 }, async () => {
  const f = await fixture()
  try {
    const { client } = await f.start()
    assert.ok(f.events.indexOf("fresh-manager") < f.events.indexOf("member"))
    assert.ok(f.events.includes("native-member-verified"))
    assert.equal(await readFile(path.join(f.root, "auth-started"), "utf8"), "after-admission")
    const auth = await fetch(`${client.attachment.origin}/proof`, { method: "POST", body: JSON.stringify({ proof: client.attachment.bootstrapProof }) })
    assert.equal((await auth.json() as { accepted: boolean }).accepted, true)
    const service = await fetch(`${client.attachment.origin}/service`)
    assert.equal(service.status, 200)
    assert.equal((await service.json() as { stdout: string }).stdout, "preserved-private-value")
    assert.ok(f.events.indexOf("profile-policy") < f.events.indexOf("outside-service"))
    assert.deepEqual(await client.stopAuthority(), { stopped: true })
    for (let attempt = 0; attempt < 50 && !f.released(); attempt++) await delay(10)
    assert.ok(f.events.includes("stop-drained")); assert.equal(f.events.some(value => value.startsWith("fatal:")), false)
    assert.equal(f.released(), true)
  } finally { await f.dispose() }
})

test("fresh pre-spawn revalidation and native member denial fence auth; tampered MAC cannot grant membership", { timeout: 20_000 }, async () => {
  const f = await fixture()
  try {
    const runtime = await NativeRuntimeCapability.forPrivateFixture(f.binding)
    f.state.invalidateFresh = true
    await assert.rejects(runtime.beforeSpawn(), /native-runtime-pre-spawn-denied/)
    await assert.rejects(readFile(path.join(f.root, "auth-started")), { code: "ENOENT" })
  } finally { await f.dispose() }
  for (const flag of ["denyMember", "tamperMac"] as const) {
    const child = await fixture()
    try {
      child.state[flag] = true
      await assert.rejects(child.start())
      await assert.rejects(readFile(path.join(child.root, "auth-started")), { code: "ENOENT" })
    } finally { await child.dispose() }
  }
})

test("unexpected B exit fences M, preserves generation and explicitly notifies native fatal path", { timeout: 10_000 }, async () => {
  const f = await fixture()
  try {
    const { client, storage } = await f.start()
    await fetch(`${client.attachment.origin}/crash`).catch(() => undefined)
    for (let attempt = 0; attempt < 50 && !f.events.some(event => event.startsWith("fatal:")); attempt++) await delay(10)
    assert.ok(f.events.includes("fatal:backend-exit"))
    assert.equal((await storage.registration())!.generation, f.generation)
    assert.equal(f.events.includes("stop-drained"), false)
  } finally { await f.dispose() }
})

test("losing profile election never creates B, queries admission or replaces the winning owner", async () => {
  const f = await fixture()
  try {
    const runtime = await NativeRuntimeCapability.forPrivateFixture(f.binding)
    const storage = new HostStorage(f.root, f.scope, fixtureStoragePolicy)
    await storage.initialize()
    const winningGeneration = randomUUID()
    const own = await f.lookup(process.pid)
    await storage.atomic("owner.json", { owner: { pid: process.pid, startIdentity: own.startIdentity }, generation: winningGeneration })
    const manager = createHostLifetimeManagerForPrivateFixture({ storage, backend: runtime.launch.backend, runtime, lookup: f.lookup })
    assert.equal(await manager.start(), false)
    for (let attempt = 0; attempt < 50 && !f.released(); attempt++) await delay(10)
    assert.ok(f.events.includes("fatal:election-lost"))
    assert.equal(f.events.includes("member"), false)
    assert.equal(f.events.includes("manager-native-query"), false)
    assert.equal((await storage.ownerRecord())!.generation, winningGeneration)
    await assert.rejects(readFile(path.join(f.root, "auth-started")), { code: "ENOENT" })
  } finally { await f.dispose() }
})

test("private owner channel loss fences attach and service with retained generation, never a replacement/daemon action", { timeout: 10_000 }, async () => {
  const f = await fixture()
  try {
    const { storage, runtime } = await f.start()
    f.channel.destroy()
    await delay(25)
    await assert.rejects(runtime.beforeSpawn(), /native-runtime-pre-spawn-denied/)
    const record = await storage.registration()
    assert.equal(record!.generation, f.generation)
    let replacements = 0
    await assert.rejects(HostLifetimeClient.attach({ storage, lookup: f.lookup, launch: async () => { replacements++ } }))
    assert.equal(replacements, 0)
    assert.equal(f.events.includes("outside-service"), false)
    assert.equal(f.events.includes("stop-drained"), false)
    assert.equal(f.released(), true)
  } finally { await f.dispose() }
})

test("initial process lookup consumes inherited child budget; expiry cannot start member admission or import AuthManager", { timeout: 10_000 }, async context => {
  const f = await fixture()
  const realNow = Date.now.bind(Date)
  let elapsed = 0
  context.mock.method(Date, "now", () => realNow() + elapsed)
  try {
    f.state.onLookup = pid => { if (pid !== process.pid) elapsed += 5_001 }
    await assert.rejects(f.start())
    assert.equal(f.events.includes("member"), false)
    assert.equal(f.events.includes("native-member-verified"), false)
    await assert.rejects(readFile(path.join(f.root, "auth-started")), { code: "ENOENT" })
    assert.equal(await new HostStorage(f.root, f.scope, fixtureStoragePolicy).registration(), undefined)
  } finally { context.mock.restoreAll(); await f.dispose() }
})

test("child lookup + member query + held native verification share one expiry: late valid identity never grants Auth/readiness", { timeout: 10_000 }, async context => {
  const f = await fixture()
  const realNow = Date.now.bind(Date)
  let elapsed = 0, verifying!: () => void, resume!: () => void
  const reached = new Promise<void>(resolve => { verifying = resolve })
  const held = new Promise<void>(resolve => { resume = resolve })
  context.mock.method(Date, "now", () => realNow() + elapsed)
  try {
    f.state.onLookup = pid => { if (pid !== process.pid) elapsed += 2_000 }
    f.state.onMemberReceipt = () => { elapsed += 1_000 }
    f.state.onMemberVerify = async () => { verifying(); await held }
    const pending = assert.rejects(f.start())
    await reached
    await assert.rejects(readFile(path.join(f.root, "auth-started")), { code: "ENOENT" })
    // Advance the clock across the ORIGINAL expiry without executing the real
    // scheduled timer. A fresh post-query 5s budget would wrongly accept this.
    elapsed += 2_100
    resume()
    await pending
    assert.ok(f.events.includes("native-member-verified"))
    await assert.rejects(readFile(path.join(f.root, "auth-started")), { code: "ENOENT" })
    assert.equal(await new HostStorage(f.root, f.scope, fixtureStoragePolicy).registration(), undefined)
    assert.equal(f.events.includes("outside-service"), false)
  } finally { resume(); context.mock.restoreAll(); await f.dispose() }
})

test("initial open + held manager verification use one absolute qualification budget and release without minting", async context => {
  const f = await fixture()
  const realNow = Date.now.bind(Date)
  let elapsed = 0, verifying!: () => void, resume!: () => void
  const reached = new Promise<void>(resolve => { verifying = resolve })
  const held = new Promise<void>(resolve => { resume = resolve })
  context.mock.method(Date, "now", () => realNow() + elapsed)
  try {
    f.state.onInitialOpen = () => { elapsed += 3_000 }
    f.state.onInitialVerify = async () => { verifying(); await held }
    const pending = assert.rejects(NativeRuntimeCapability.forPrivateFixture(f.binding), /native-runtime-qualification-failed/)
    await reached
    elapsed += 2_100
    resume()
    await pending
    assert.equal(f.released(), true)
    assert.equal(f.channel.destroyed, true)
    await assert.rejects(readFile(path.join(f.root, "auth-started")), { code: "ENOENT" })
  } finally { resume(); context.mock.restoreAll(); await f.dispose() }
})

test("readiness process identity uses inherited child expiry and cannot publish a late owner registration", { timeout: 10_000 }, async context => {
  const f = await fixture()
  const realNow = Date.now.bind(Date)
  let elapsed = 0, childLookups = 0
  context.mock.method(Date, "now", () => realNow() + elapsed)
  try {
    f.state.onLookup = pid => { if (pid !== process.pid && ++childLookups === 2) elapsed += 5_001 }
    await assert.rejects(f.start())
    assert.equal(childLookups, 2)
    assert.ok(f.events.includes("native-member-verified"))
    assert.equal(await new HostStorage(f.root, f.scope, fixtureStoragePolicy).registration(), undefined)
  } finally { context.mock.restoreAll(); await f.dispose() }
})
