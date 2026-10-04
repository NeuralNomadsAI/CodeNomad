import test from "node:test"
import assert from "node:assert/strict"
import { createServer, request as httpRequest, type Server } from "node:http"
import { once } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { BackendProcess } from "./backend"
import { createHostLifetimeManagerForPrivateFixture } from "./manager"
import { HostLifetimeClient } from "./client"
import { HostStorage } from "./storage"
import { fixtureStoragePolicy } from "./test-fixture"
import { canonicalScope, TIMEOUT_MS, type Registration } from "./protocol"
import { hostRequest, readBody } from "./transport"

const temporaryRoot = process.platform === "win32" ? "C:/Users/Admin/AppData/Local/Temp/opencode" : tmpdir()
const moduleUrl = (name: string) => new URL(name, import.meta.url).href
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(temporaryRoot, "host-corrections-"))
  await chmod(root, 0o700)
  return root
}
async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("private child did not exit")), 10_000)
    child.once("exit", () => { clearTimeout(timer); resolve() })
  })
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
}
function privateBackend(root: string, shutdownMs: number): string {
  // Real private Node child + real backend IPC/shutdown modules, never a user's
  // backend/profile/daemon. Every filesystem write is beneath this owned root.
  return `
    import { createServer } from "node:http";
    import { appendFile, writeFile } from "node:fs/promises";
    import { installBackendHostLifetime } from ${JSON.stringify(moduleUrl("./backend.ts"))};
    import { BootstrapProofs } from ${JSON.stringify(moduleUrl("./bootstrap.ts"))};
    import { TokenManager } from ${JSON.stringify(moduleUrl("../auth/token-manager.ts"))};
    import { createServerShutdownHandler } from ${JSON.stringify(moduleUrl("../shutdown.ts"))};
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (req.url === "/emit") {
        const call = JSON.parse(Buffer.concat(chunks).toString());
        process.stdout.write("CODENOMAD_NATIVE_REQUEST:" + JSON.stringify({ v: 1, ...call }) + "\\n");
      }
      res.end("{}");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const tokens = new TokenManager(60000);
    const control = installBackendHostLifetime(new BootstrapProofs({
      issueBootstrapToken: () => tokens.generate(), consumeBootstrapToken: token => tokens.consume(token)
    }), "http://127.0.0.1:" + server.address().port);
    const shutdown = createServerShutdownHandler({
      logger: { info() {}, warn() {}, error() {} },
      shutdown: async () => {
        await new Promise(resolve => setTimeout(resolve, ${shutdownMs}));
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await writeFile(${JSON.stringify(path.join(root, "cleanup-complete"))}, "complete\\n");
      },
      setExitCode: code => { process.exitCode = code; process.stdin.destroy(); if (code === 0) control.close(); }
    });
    let buffer = "";
    process.stdin.on("data", chunk => {
      buffer += chunk.toString(); let end;
      while ((end = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line === "codenomad:shutdown") {
          // Keep observing during cleanup: a duplicate command would force the
          // real shutdown handler's nonzero escalation, rather than be hidden.
          void appendFile(${JSON.stringify(path.join(root, "commands"))}, "shutdown\\n");
          control.beginShutdown();
          process.stdout.write("CODENOMAD_NATIVE_REQUEST:" + JSON.stringify({ v: 1, id: "during-stop",
            method: "browser.screenshot", params: {}, deadline: Date.now() + 10000 }) + "\\n");
          void shutdown("stdin");
        } else if (line.startsWith("CODENOMAD_NATIVE_RESPONSE:")) {
          void appendFile(${JSON.stringify(path.join(root, "responses"))}, line.slice("CODENOMAD_NATIVE_RESPONSE:".length) + "\\n");
        }
      }
    });
  `
}
function launchBackend(root: string, shutdownMs: number) {
  return { file: process.execPath, args: ["--import", "tsx", "--input-type=module", "-e", privateBackend(root, shutdownMs)],
    cwd: process.cwd(), env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, LOCALAPPDATA: root } }
}
class ObservedStorage extends HostStorage {
  releases = 0
  override async release(generation: string): Promise<void> { this.releases++; await super.release(generation) }
}
async function startHost(root: string, shutdownMs: number) {
  const scope = canonicalScope("stable", path.join(root, "private-config.yaml"), root, root)
  const storage = new ObservedStorage(root, scope, fixtureStoragePolicy)
  const manager = createHostLifetimeManagerForPrivateFixture({ storage, backend: launchBackend(root, shutdownMs) })
  assert.equal(await manager.start(), true)
  const client = await HostLifetimeClient.attach({ storage, launch: async () => { throw new Error("must attach existing private host") } })
  const registration = (await storage.registration())!
  const secret = await storage.secret(registration.generation)
  const request = <T>(route: string, body: object) => hostRequest<T>(registration.controlOrigin, secret, scope.key, registration.generation, route, body)
  const windowBody = { windowId: client.attachment.windowId, capability: client.attachment.capability }
  return { storage, manager, client, registration, request, windowBody }
}
async function disposeHost(host: Awaited<ReturnType<typeof startHost>> | undefined): Promise<void> {
  if (!host) return
  await host.client.stopAuthority().catch(() => undefined)
  // Failure-only teardown may inspect handles allocated by THIS private fixture.
  // It never signals a discovered PID, user backend or shared daemon.
  const owned = host.manager as unknown as { server: Server; backend: BackendProcess }
  await closeServer(owned.server)
  const child = owned.backend.child
  if (child.exitCode === null && child.signalCode === null) child.kill()
  await waitExit(child)
}

test("two wire Stop observers timeout, remain fenced and retry one command/one release to complete zero exit", { timeout: 30_000 }, async () => {
  const root = await privateRoot()
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })
  await writeFile(path.join(root, "sentinel"), "externally-owned\n")
  let host: Awaited<ReturnType<typeof startHost>> | undefined
  try {
    host = await startHost(root, 6_500)
    const observations = await Promise.allSettled([host.client.stopAuthority(), host.client.stopAuthority()])
    for (const observation of observations) {
      assert.equal(observation.status, "rejected")
      if (observation.status === "rejected") assert.equal(observation.reason.code, "backend-stop-unconfirmed", "structured ack is not hidden by HTTP timeout")
    }
    assert.equal(await readFile(path.join(root, "commands"), "utf8"), "shutdown\n")
    assert.equal(host.storage.releases, 0)
    assert.equal((await host.storage.registration())!.generation, host.registration.generation)
    for (const route of ["/status", "/poll", "/detach", "/attach"]) {
      await assert.rejects(host.request(route, { ...host.windowBody, windowId: randomUUID(), clientNonce: "a".repeat(64) }), /host-not-ready/)
    }
    const responses = await readFile(path.join(root, "responses"), "utf8")
    assert.equal(JSON.parse(responses.trim()).error.code, "host-unavailable", "native calls stay fenced while cleanup is pending")
    const retries = await Promise.all([host.client.stopAuthority(), host.client.stopAuthority()])
    assert.deepEqual(retries, [{ stopped: true }, { stopped: true }])
    assert.equal(host.storage.releases, 1)
    assert.equal(await host.storage.registration(), undefined)
    assert.equal(await readFile(path.join(root, "commands"), "utf8"), "shutdown\n")
    assert.equal(await readFile(path.join(root, "cleanup-complete"), "utf8"), "complete\n")
    assert.equal(sentinel.exitCode, null)
    assert.equal(await readFile(path.join(root, "sentinel"), "utf8"), "externally-owned\n")
  } finally {
    await disposeHost(host)
    sentinel.kill(); await waitExit(sentinel)
    await rm(root, { recursive: true, force: true })
  }
})

test("BackendProcess concurrent observers and timeout retries share drained close/complete without resending", { timeout: 10_000 }, async () => {
  const root = await privateRoot()
  const backend = new BackendProcess(launchBackend(root, 250), async () => { throw new Error("no native window") })
  try {
    await backend.ready
    for (const result of await Promise.allSettled([backend.stop(30), backend.stop(30)])) assert.equal(result.status, "rejected")
    await backend.stop(2_000)
    await backend.stop(30)
    assert.equal(backend.child.exitCode, 0)
    assert.equal(await readFile(path.join(root, "commands"), "utf8"), "shutdown\n")
  } finally {
    if (backend.child.exitCode === null && backend.child.signalCode === null) backend.child.kill()
    await waitExit(backend.child)
    await rm(root, { recursive: true, force: true })
  }
})

for (const finishes of [true, false]) test(finishes
  ? "successful Stop drains an authenticated observer whose body finishes after cleanup without repeating shutdown"
  : "Stop bounds drainage even when an authenticated peer keeps its unfinished body active", { timeout: 15_000 }, async () => {
  const root = await privateRoot()
  let host: Awaited<ReturnType<typeof startHost>> | undefined
  let slow: ReturnType<typeof httpRequest> | undefined
  let drip: NodeJS.Timeout | undefined
  try {
    host = await startHost(root, 0)
    const secret = await host.storage.secret(host.registration.generation)
    const body = JSON.stringify({ intent: "stop-profile-backend" })
    const server = (host.manager as unknown as { server: Server }).server
    const headersRead = once(server, "request")
    const result = new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
      slow = httpRequest(`${host!.registration.controlOrigin}/stop`, { method: "POST", headers: {
        authorization: `Bearer ${secret}`, "x-host-scope": host!.storage.scope.key,
        "x-host-generation": host!.registration.generation, "content-length": finishes ? Buffer.byteLength(body) : 10_000,
        connection: "close",
      } }, response => {
        const chunks: Buffer[] = []
        response.on("data", chunk => chunks.push(Buffer.from(chunk)))
        response.on("end", () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
          catch (error) { reject(error) }
        })
        response.on("error", reject)
      })
      slow.on("error", reject)
      slow.setTimeout(10_000, () => slow!.destroy(new Error("private Stop observer timeout")))
      slow.write(body.slice(0, 8))
    })
    void result.catch(() => undefined) // Failure remains observed while the fast peer settles.
    await headersRead
    assert.deepEqual(await host.client.stopAuthority(), { stopped: true })
    assert.equal(server.listening, false, "new connections close before slow observers finish")
    if (finishes) {
      slow!.end(body.slice(8))
      assert.deepEqual(await result, { status: 200, body: { stopped: true } })
    } else {
      const started = Date.now()
      // Avoid an idle socket timeout: even continuously progressing peers must
      // not hold the already-stopped manager beyond its absolute drain deadline.
      drip = setInterval(() => { slow!.write(" ") }, 100)
      await assert.rejects(result, { code: "ECONNRESET" })
      assert.ok(Date.now() - started <= TIMEOUT_MS + 1_500)
    }
    assert.equal(host.storage.releases, 1)
    assert.equal(await readFile(path.join(root, "commands"), "utf8"), "shutdown\n")
    assert.equal((host.manager as unknown as { backend: BackendProcess }).backend.child.exitCode, 0)
    assert.equal(await host.storage.registration(), undefined)
  } finally {
    clearInterval(drip)
    slow?.destroy()
    await disposeHost(host)
    await rm(root, { recursive: true, force: true })
  }
})

test("native wire poll drops expired queue entries, carries effective cap and rejects stale correlations for reused IDs", { timeout: 15_000 }, async context => {
  const root = await privateRoot()
  let host: Awaited<ReturnType<typeof startHost>> | undefined
  try {
    host = await startHost(root, 0)
    const emit = async (id: string, deadline: number, marker: string) => {
      const response = await fetch(`${host!.client.attachment.origin}/emit`, { method: "POST", body: JSON.stringify({ id, deadline,
        method: "browser.screenshot", params: { windowId: host!.client.attachment.windowId, marker } }), signal: AbortSignal.timeout(3_000) })
      await response.arrayBuffer()
      // Child's stdout/control data and the HTTP acknowledgement are separate.
      await delay(30)
    }
    const poll = () => host!.request<{ calls: Array<{ id: string; requestToken: string; deadline: number; params: { marker: string } }> }>("/poll", host!.windowBody)
    await emit("expired", Date.now() + 100, "expired")
    await emit("live", Date.now() + 5_000, "original")
    await emit("live", Date.now() + 5_000, "duplicate")
    await delay(150)
    const batch = await poll()
    assert.deepEqual(batch.calls.map(call => call.id), ["live"])
    assert.equal(batch.calls[0].params.marker, "original", "duplicate admission cannot replace a pending call")
    await host.request("/result", { ...host.windowBody, ...batch.calls[0], ok: true, result: "live" })
    // Advance Date only, not setTimeout: poll must independently refuse expired
    // work even when its real cancellation timer has not run yet.
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() })
    try {
      await emit("late-poll", Date.now() + 500, "late-poll")
      context.mock.timers.tick(501)
      assert.deepEqual((await poll()).calls, [])
    } finally { context.mock.timers.reset() }
    await emit("reused", Date.now() + 150, "old")
    const old = (await poll()).calls[0]
    await delay(180)
    const originalDeadline = Date.now() + 90_000
    await emit("reused", originalDeadline, "new")
    const current = (await poll()).calls[0]
    assert.equal(current.id, "reused")
    assert.notEqual(current.requestToken, old.requestToken)
    assert.ok(current.deadline <= Date.now() + 30_000 && current.deadline < originalDeadline - 50_000)
    await assert.rejects(host.request("/result", { ...host.windowBody, id: old.id, requestToken: old.requestToken, ok: true, result: "stale" }), /native-request-revoked/)
    await host.request("/result", { ...host.windowBody, id: current.id, requestToken: current.requestToken, ok: true, result: "current" })
    assert.deepEqual((await poll()).calls, [])
    await host.client.stopAuthority()
  } finally {
    context.mock.timers.reset()
    await disposeHost(host)
    await rm(root, { recursive: true, force: true })
  }
})

test("native client skips an expired first call and returns the live call's correlated capability", { timeout: 5_000 }, async () => {
  const controller = new AbortController()
  const generation = randomUUID()
  const scope = canonicalScope("stable", path.join(temporaryRoot, "client-only.yaml"), temporaryRoot, temporaryRoot)
  const seen: string[] = []
  const returned: unknown[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request) as Record<string, unknown>
      assert.equal(body.windowId, generation); assert.equal(body.capability, "a".repeat(64))
      if (request.url === "/poll") response.end(JSON.stringify({ calls: [
        { id: "expired-first", method: "browser.screenshot", params: {}, deadline: Date.now() - 1, requestToken: "b".repeat(64) },
        { id: "live-second", method: "browser.screenshot", params: {}, deadline: Date.now() + 3_000, requestToken: "c".repeat(64) },
      ] }))
      else { returned.push(body); controller.abort(); response.end('{"accepted":true}') }
    })()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const registration: Registration = { v: 1, scope, generation, owner: { pid: process.pid, startIdentity: "client-only" },
    backend: { pid: process.pid, startIdentity: "client-only" }, origin, controlOrigin: origin }
  const client = new HostLifetimeClient(registration, "d".repeat(64), { generation, managerPid: process.pid, backendPid: process.pid,
    origin, windowId: generation, capability: "a".repeat(64), bootstrapProof: "unused-client-only" })
  const deadline = setTimeout(() => controller.abort(), 1_500)
  try {
    await client.serveNative(async call => { seen.push(call.id); return "live-result" }, controller.signal)
    assert.deepEqual(seen, ["live-second"])
    assert.equal((returned[0] as any).requestToken, "c".repeat(64))
    assert.equal((returned[0] as any).result, "live-result")
  } finally { clearTimeout(deadline); controller.abort(); await closeServer(server) }
})

test("every present falsy registration/owner and malformed owner field refuses attach/election without altering bytes", { timeout: 10_000 }, async () => {
  const root = await privateRoot()
  const malformed = ["null", "false", "0", '""']
  const extraOwners = [
    { owner: { pid: "12", startIdentity: "identity" }, generation: randomUUID() },
    { owner: { pid: 12, startIdentity: 4 }, generation: randomUUID() },
    { owner: { pid: 12, startIdentity: "identity" }, generation: 7 },
    { owner: { pid: 12, startIdentity: "identity" }, generation: "" },
  ]
  let launches = 0
  try {
    let index = 0
    for (const [name, bytes] of [
      ...["host.json", "owner.json"].flatMap(name => malformed.map(bytes => [name, bytes] as const)),
      ...extraOwners.map(value => ["owner.json", JSON.stringify(value)] as const),
    ]) {
      const scope = canonicalScope("stable", path.join(root, `profile-${index++}.yaml`), root, root)
      const storage = new HostStorage(root, scope, fixtureStoragePolicy)
      await storage.initialize()
      const file = path.join(storage.directory, name)
      await writeFile(file, bytes, { mode: 0o600 })
      const lookup = async (): Promise<never> => { throw new Error("invalid record must reject before native lookup") }
      await assert.rejects(HostLifetimeClient.attach({ storage, lookup, launch: async () => { launches++ }, deadlineMs: 50 }), /invalid-(registration|owner)/)
      await assert.rejects(storage.claim({ pid: process.pid, startIdentity: "caller-only" }, randomUUID(), lookup), /invalid-(registration|owner)/)
      assert.equal(await readFile(file, "utf8"), bytes)
    }
    assert.equal(launches, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
