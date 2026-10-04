import test from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { canonicalScope, HostError, type Registration } from "./protocol"
import { HostStorage, privateStorage } from "./storage"
import { HostLifetimeClient } from "./client"
import { BootstrapProofs } from "./bootstrap"
import { TokenManager } from "../auth/token-manager"
import { lookupProcess, ownerState } from "./process-identity"
import { fixtureStoragePolicy } from "./test-fixture"
import { hostRequest } from "./transport"

const fixture = fileURLToPath(new URL("./test-fixture.ts", import.meta.url))
const temporaryRoot = process.platform === "win32" ? "C:/Users/Admin/AppData/Local/Temp/opencode" : tmpdir()
async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(temporaryRoot, "host-lifetime-"))
  await chmod(root, 0o700)
  return root
}
async function backendRequest(origin: string, route: string, body: object): Promise<{ status: number; value: any }> {
  const response = await fetch(`${origin}${route}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) })
  return { status: response.status, value: await response.json() }
}
async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture child exit deadline")), 10_000)
    child.once("exit", () => { clearTimeout(timer); resolve() })
  })
}

test("actual process host: parallel singleton, proofs, detach/reattach, routing, stop isolation", { timeout: 120_000 }, async () => {
  const root = await privateRoot()
  const scope = canonicalScope("dev", path.join(root, "profile/config.json"), root, root)
  const storage = new HostStorage(root, scope, fixtureStoragePolicy)
  const children: ChildProcess[] = []
  const output: string[] = []
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })
  const marker = path.join(root, "shared-daemon-sentinel")
  await writeFile(marker, "externally-owned\n")
  const launch = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, "manager", root, JSON.stringify(scope)],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    children.push(child)
    child.stdout?.on("data", data => output.push(data.toString()))
    child.stderr?.on("data", data => output.push(data.toString()))
  }
  let attached: HostLifetimeClient[] = []
  try {
    attached = await Promise.all(Array.from({ length: 8 }, () => HostLifetimeClient.attach({ storage, launch, deadlineMs: 60_000 })))
    assert.equal(new Set(attached.map(client => client.attachment.generation)).size, 1)
    assert.equal(new Set(attached.map(client => client.attachment.backendPid)).size, 1)
    const first = attached[0]
    const registration = (await storage.registration())!
    const secret = await storage.secret(registration.generation)
    assert.equal((await backendRequest(first.attachment.origin, "/consume", { proof: first.attachment.bootstrapProof })).value.accepted, true)
    assert.equal((await backendRequest(first.attachment.origin, "/consume", { proof: first.attachment.bootstrapProof })).value.accepted, false)
    // Parallel attach does not invalidate another window's bootstrap.
    assert.equal((await backendRequest(first.attachment.origin, "/consume", { proof: attached[1].attachment.bootstrapProof })).value.accepted, true)
    await assert.rejects(hostRequest(registration.controlOrigin, "0".repeat(64), scope.key, registration.generation, "/status", {}))
    await assert.rejects(hostRequest(registration.controlOrigin, secret, "0".repeat(64), registration.generation, "/status", {}))
    const controller = new AbortController()
    const serving = first.serveNative(async call => ({ window: first.attachment.windowId, method: call.method }), controller.signal)
    const routed = await backendRequest(first.attachment.origin, "/native", { method: "browser.screenshot", windowId: first.attachment.windowId })
    assert.equal(routed.status, 200)
    assert.equal(routed.value.window, first.attachment.windowId)
    controller.abort(); await serving
    await Promise.all(attached.map(client => client.detach()))
    assert.equal((await first.status()).automationAvailable, false)
    const before = Date.now()
    assert.equal((await backendRequest(first.attachment.origin, "/native", { method: "browser.screenshot", windowId: first.attachment.windowId })).status, 503)
    assert.ok(Date.now() - before < 1_000, "headless UI fails immediately")
    const service = await backendRequest(first.attachment.origin, "/native", { method: "opencode.service.start" })
    assert.equal(service.value.fixture, "persistent-service-route")
    await assert.rejects(hostRequest(registration.controlOrigin, secret, scope.key, registration.generation, "/poll",
      { windowId: first.attachment.windowId, capability: first.attachment.capability }), /window-capability-revoked/)
    const reattached = await HostLifetimeClient.attach({ storage, launch })
    attached.push(reattached)
    assert.equal(reattached.attachment.generation, first.attachment.generation)
    assert.equal(reattached.attachment.backendPid, first.attachment.backendPid)
    const onDisk = await readFile(path.join(storage.directory, "host.json"), "utf8")
    assert.ok(!onDisk.includes(secret) && !onDisk.includes("bootstrapProof") && !onDisk.includes("capability"))
    // Kill only the fixture's exact manager handle; IPC loss must terminate child.
    const ownerChild = children.find(child => child.pid === reattached.attachment.managerPid)!
    assert.ok(ownerChild)
    ownerChild.kill()
    await waitExit(ownerChild)
    const crashDeadline = Date.now() + 5_000
    while ((await lookupProcess(reattached.attachment.backendPid)).state !== "dead") {
      assert.ok(Date.now() < crashDeadline, "backend must fail safe on manager channel loss")
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const recovered = await HostLifetimeClient.attach({ storage, launch, deadlineMs: 60_000 })
    attached.push(recovered)
    assert.notEqual(recovered.attachment.generation, reattached.attachment.generation)
    assert.notEqual(recovered.attachment.backendPid, reattached.attachment.backendPid)
    assert.deepEqual(await recovered.stopAuthority(), { stopped: true })
    await Promise.all(children.map(waitExit))
    assert.equal(await storage.registration(), undefined)
    assert.equal((await lookupProcess(first.attachment.backendPid)).state, "dead")
    assert.equal(sentinel.exitCode, null)
    assert.equal(await readFile(marker, "utf8"), "externally-owned\n")
    assert.ok(!output.join("").includes("fixture-secret-never-log"))
    assert.ok(!(await readdir(storage.directory)).some(name => name.endsWith(".secret")))
  } finally {
    // Only process handles spawned by this fixture; never shared daemon/PID trees.
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    sentinel.kill()
    await Promise.all(children.map(child => waitExit(child).catch(() => undefined)))
    await waitExit(sentinel)
    await rm(root, { recursive: true, force: true })
  }
})

test("owner identity gates: unknown/live unreachable fail closed, dead atomic recovery", { timeout: 30_000 }, async () => {
  const root = await privateRoot()
  const scope = canonicalScope("stable", root, root, root)
  const storage = new HostStorage(root, scope, fixtureStoragePolicy)
  await storage.initialize()
  const generation = randomUUID()
  const identity = await lookupProcess(process.pid)
  assert.equal(identity.state, "live")
  if (identity.state !== "live") return
  const owner = { pid: process.pid, startIdentity: identity.startIdentity }
  const registration: Registration = { v: 1, scope, generation, owner, backend: owner,
    origin: "http://127.0.0.1:1", controlOrigin: "http://127.0.0.1:1" }
  let launches = 0
  const launch = async () => { launches++ }
  try {
    await storage.atomic("host.json", registration)
    await storage.atomic(`${generation}.secret`, "1".repeat(64))
    await assert.rejects(HostLifetimeClient.attach({ storage, launch, lookup: async () => ({ state: "unknown" }) }), /unknown-owner/)
    await assert.rejects(HostLifetimeClient.attach({ storage, launch }), /host-unreachable/)
    assert.equal(launches, 0)
    assert.equal(await storage.claim(owner, randomUUID(), lookupProcess), false, "missing lock cannot steal live registration")
    await storage.atomic("owner.json", { owner, generation })
    const replacement = randomUUID()
    const claims = await Promise.all(Array.from({ length: 8 }, () => storage.claim(owner, replacement,
      async pid => pid === owner.pid ? { state: "dead" } : { state: "unknown" })))
    assert.equal(claims.filter(Boolean).length, 1)
    assert.equal(await storage.registration(), undefined)
    assert.ok((await readdir(storage.directory)).includes(`${generation}.stale`))
    await assert.rejects(ownerState({ pid: process.pid, startIdentity: "" }, lookupProcess), /invalid-owner/)
    assert.equal(await ownerState({ pid: process.pid, startIdentity: "reused-old-identity" }, lookupProcess), "dead")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("private registry rejects malformed, symlink and unsafe permissions; bounded one-shot proofs", async () => {
  const root = await privateRoot()
  const scope = canonicalScope("dev", root, root, root)
  const storage = new HostStorage(root, scope, fixtureStoragePolicy)
  try {
    await storage.initialize()
    const file = path.join(storage.directory, "host.json")
    await writeFile(file, "not-json", { mode: 0o600 })
    await assert.rejects(storage.registration(), /malformed-storage/)
    await rm(file)
    const target = path.join(root, "target")
    await writeFile(target, "{}", { mode: 0o600 })
    try {
      await symlink(target, file)
      await assert.rejects(storage.registration(), /unsafe-type/)
      await rm(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error
      // Windows without symlink privilege: junction ancestor tested below.
      const alias = path.join(root, "alias")
      await symlink(storage.directory, alias, "junction")
      const aliased = new HostStorage(alias, scope, fixtureStoragePolicy)
      await assert.rejects(aliased.initialize(), /unsafe-storage-ancestor/)
      await rm(alias)
    }
    // Native Windows ACL evidence now has its own adapter regression suite; these
    // process fixtures intentionally make no production DACL qualification claim.
    if (process.platform !== "win32") {
      await chmod(root, 0o755)
      await assert.rejects(privateStorage.verify(root, true), /unsafe-storage-permissions/)
      await chmod(root, 0o700)
    }
    let now = 0
    const tokens = new TokenManager(60_000)
    const proofs = new BootstrapProofs({ issueBootstrapToken: () => tokens.generate(), consumeBootstrapToken: token => tokens.consume(token) }, 10, () => now)
    const proof = proofs.issue("a")
    assert.equal(proofs.consume(proof), true); assert.equal(proofs.consume(proof), false)
    const revoked = proofs.issue("b"); proofs.revoke("b"); assert.equal(proofs.consume(revoked), false)
    const expired = proofs.issue("c"); now = 11; assert.equal(proofs.consume(expired), false)
    for (let index = 0; index < 32; index++) proofs.issue("d")
    assert.throws(() => proofs.issue("e"), /Too many pending bootstrap requests/)
    assert.equal(canonicalScope("dev", path.join(root, "config.json"), root, root).key,
      canonicalScope("dev", path.join(root, "config.yaml"), root, root).key)
    assert.throws(() => canonicalScope("Invalid Channel", root, root, root), HostError)
  } finally { await rm(root, { recursive: true, force: true }) }
})
