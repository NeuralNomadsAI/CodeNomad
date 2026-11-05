import assert from "node:assert/strict"
import test from "node:test"
import { createServer, type ServerResponse } from "node:http"
import { once } from "node:events"
import fs from "node:fs/promises"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import pino from "pino"
import Fastify from "fastify"
import { explicitContractFixture } from "../opencode/compatibility/contract-fixture"
import { OpenCodeServerConnections, type ServerConnection } from "../opencode/servers/connections"
import { OpenCodeServerCredentials } from "../opencode/servers/credentials"
import { OpenCodeServerRegistry } from "../opencode/servers/registry"
import { EventBus } from "../events/bus"
import { ExplicitWorkspace } from "./explicit-workspace"
import { WorkspaceManager } from "./manager"
import { createInstanceClient } from "./instance-client"
import { registerWorkspaceRoutes } from "../server/routes/workspaces"
import { registerWorktreeRoutes } from "../server/routes/worktrees"
import { registerPendingRequestRoutes } from "../server/routes/pending-requests"
import { WorktreeDeletionFence } from "./worktree-session-evacuation"
import { cloneGitRepository } from "./git-clone"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(platform: NodeJS.Platform = "win32", allowLocal = false) {
  const calls: { path: string; directory?: string; method?: string }[] = []
  const entered = deferred()
  let hold: "location" | "list" | "contract" | undefined
  let contract: unknown = explicitContractFixture()
  const held: (() => void)[] = []
  let locationOverride: string | undefined, listingOverride: string | undefined, oversized = false
  let listingResponse: { value: unknown } | undefined
  let moved = false, stopped = false
  const server = createServer((request, response: ServerResponse) => {
    const url = new URL(request.url!, "http://fixture")
    const directory = url.searchParams.get("location[directory]") ?? undefined
    calls.push({ path: url.pathname, directory, method: request.method })
    response.setHeader("content-type", "application/json")
    const send = (value: unknown) => response.end(JSON.stringify(value))
    if (url.pathname === "/openapi.json") {
      const captured = contract
      if (hold === "contract") { held.push(() => send(captured)); entered.resolve() }
      else send(captured)
      return
    }
    const result = () => {
      if (directory === "/absent" && url.pathname === "/api/location") {
        // Deliberately accept absent paths here: the independent listing must still refuse.
        send({ directory, project: { id: "same-project", directory: "/", canonical: "/" } }); return
      }
      if (url.pathname === "/api/location") {
        send({ directory: locationOverride ?? directory, project: { id: "same-project", directory: "/", canonical: "/" } }); return
      }
      if (url.pathname === "/api/fs/list") {
        if (listingResponse) { send(listingResponse.value); return }
        if (directory === "/absent" || directory === "/inaccessible") { response.statusCode = 500; send({}); return }
        send({ location: { directory: listingOverride ?? directory }, data: oversized ? ["x".repeat(8 * 1024 * 1024)] : [] }); return
      }
      if (url.pathname === "/api/session/same-session") {
        send({ data: { id: "same-session", parentID: "foreign-parent", projectID: "same-project", location: { directory: moved ? "/sibling" : "/exact" } } }); return
      }
      response.statusCode = 404; send({})
    }
    if ((hold === "location" && url.pathname === "/api/location") || (hold === "list" && url.pathname === "/api/fs/list")) {
      held.push(result); entered.resolve(); return
    }
    result()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  let profiles: any[] = ["A", "B"].map(id => ({ id, kind: "explicit", label: id, origin }))
  const registry = new OpenCodeServerRegistry(() => profiles, next => { profiles = next })
  const credentials = new OpenCodeServerCredentials({ profileKey: "test", configIdentity: "test" }, registry)
  for (const id of ["A", "B"]) await credentials.set(id, JSON.stringify({ username: "test", password: "fixture-only" }))
  const forbidden = () => { throw new Error("Host operation forbidden") }
  const connections = new OpenCodeServerConnections({ registry, credentials, local: { acquire: forbidden, existing: forbidden, invalidate: forbidden } })
  const events = new EventBus()
  const manager = new WorkspaceManager({ rootDir: "C:/host", platform, eventBus: events, logger: pino({ level: "silent" }),
    binaryResolver: { resolveDefault: allowLocal ? () => ({ path: process.execPath, label: "isolated local adapter" }) : forbidden } as never,
    settings: { getOpenCodeServerConnections: () => connections, getOwner: allowLocal ? () => ({ environmentVariables: {} }) : forbidden, readEnvironmentForAdmission: forbidden,
      disposeOpenCodeServers: async () => { stopped = true; await connections.dispose() } } as never,
    sharedService: { endpoint: forbidden, client: forbidden, headers: allowLocal ? async () => undefined : forbidden,
      validateLocation: allowLocal ? async location => ({ ...location, project: { id: "local", directory: location.directory, canonical: location.directory } }) : forbidden,
      subscribe: forbidden, shutdown: async () => {} },
    wslHostDirectoryResolver: forbidden, wslServiceDirectoryResolver: forbidden,
  })
  return { manager, connections, credentials, registry, calls, events, entered: entered.promise,
    block(operation: "location" | "list" | "contract") { hold = operation }, finish() { hold = undefined; for (const result of held.splice(0)) result() },
    contract(value: unknown) { contract = value },
    location(value: string) { locationOverride = value }, listing(value: string) { listingOverride = value },
    listResponse(value: unknown) { listingResponse = { value } },
    oversize() { oversized = true }, move() { moved = true },
    async close() { if (!stopped) await manager.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

test("explicit manager preserves cross-host namespace, immutable bindings and exact authority without host operations", async t => {
  const f = await fixture()
  t.after(() => f.close())
  const hostCalls: string[] = []
  const mocks = [
    ...(["realpath", "stat", "lstat", "readdir", "readFile", "writeFile"] as const).map(method =>
      t.mock.method(fs, method, () => { hostCalls.push(method); throw new Error("Host FS forbidden") })),
    ...(["spawn", "spawnSync", "execFile", "execFileSync"] as const).map(method =>
      t.mock.method(childProcess, method, () => { hostCalls.push(method); throw new Error("Host Git/shell forbidden") })),
  ]
  syncBuiltinESMExports()
  t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports() })
  for (const directory of ["/Case/Project", "Z:\\Case\\Project", "//opaque/alias", "/exact"]) {
    const { workspace } = await f.manager.create(directory, undefined, { serverId: "A" })
    assert.equal(workspace.path, directory)
    assert.deepEqual(workspace.binding, { serverId: "A", directory })
    assert.equal(workspace.binaryId, undefined)
    assert.equal(workspace.pid, undefined)
    assert.equal(workspace.port, undefined)
    assert.equal(workspace.capabilities?.features.worktrees.state, "unavailable")
    const record = f.manager.get(workspace.id)!
    assert.throws(() => { (record.binding as { directory: string }).directory = "/changed" })
    assert.throws(() => { record.binding = { serverId: "B", directory } })
    assert.equal(await f.manager.ownsLocation(workspace.id, { directory }), true)
    for (const outside of ["/", "/Case", "/Case/Project2", directory + "/child", directory.toLowerCase(), "/alias"]) {
      if (outside !== directory) assert.equal(await f.manager.ownsDirectory(workspace.id, outside), false)
    }
    assert.equal(await f.manager.ownsLocation(workspace.id, { directory, workspaceID: "retired" }), false)
    assert.equal(await f.manager.getServiceDirectoryForPath(workspace.id, directory), directory)
    for (const operation of [
      () => f.manager.getWorktrees(workspace.id), () => f.manager.getSessionEnvironment(workspace.id),
      () => f.manager.readFile(workspace.id, "secret"), () => f.manager.writeFile(workspace.id, "secret", "data"),
      () => f.manager.listFiles(workspace.id), () => f.manager.searchFiles(workspace.id, "secret"),
      () => f.manager.getHostPathForServicePath(workspace.id, directory), () => f.manager.createWorktree(workspace.id, "branch"),
    ]) await assert.rejects(async () => operation(), { code: "explicit_capability_unavailable" })
    await f.manager.delete(workspace.id)
    assert.equal(f.connections.activeExplicitTargets, 0)
  }
  assert.deepEqual(hostCalls, [])
  assert(f.calls.every(call => ["/openapi.json", "/api/location", "/api/fs/list"].includes(call.path)))
})

test("real Files/Git/worktree routes and manager calls refuse explicit A/B before host IO or RPC", async t => {
  const f = await fixture(); t.after(() => f.close())
  const owners = await Promise.all(["A", "B"].map(serverId => f.manager.create("/exact", undefined, { serverId })))
  const app = Fastify(); t.after(() => app.close())
  const deps = { workspaceManager: f.manager, worktreeDeletionFence: new WorktreeDeletionFence() }
  registerWorkspaceRoutes(app, deps); registerWorktreeRoutes(app, deps)
  registerPendingRequestRoutes(app, deps)
  await app.ready()
  const callsBefore = f.calls.length, hostCalls: string[] = []
  const mocks = [
    ...(["realpath", "stat", "lstat", "readdir", "readFile", "writeFile"] as const).map(method =>
      t.mock.method(fs, method, () => { hostCalls.push(method); throw new Error("Host FS forbidden") })),
    ...(["spawn", "spawnSync", "execFile", "execFileSync"] as const).map(method =>
      t.mock.method(childProcess, method, () => { hostCalls.push(method); throw new Error("Host process forbidden") })),
  ]
  syncBuiltinESMExports()
  t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports() })
  for (const { workspace } of owners) {
    const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`
    // prototype-1236: native read-only Files/Changes reads are covered by explicit-panels.test.ts;
    // every write, history, other folder or host Git path is still refused before host IO.
    const requests = [
      ["GET", "/files?directory=%2Fother", undefined, "files"],
      ["GET", "/files/search?q=secret&directory=%2Fother", undefined, "files"],
      ["GET", "/files/preview?path=secret&directory=%2Fother", undefined, "files"],
      ["GET", "/files/content?path=secret&worktree=other", undefined, "files"],
      ["PUT", "/files/content?path=secret&directory=%2Fexact", { contents: "forbidden" }, "files"],
      ["PUT", "/files/content?path=secret", { contents: "forbidden" }, "files"],
      ["POST", "/git-init", { directory: "/exact" }, "git"],
      ["GET", "/worktrees/other/git-status", undefined, "git"],
      ["GET", "/worktrees/root/git-diff?path=secret&scope=staged", undefined, "git"],
      ["GET", "/worktrees/root/git-history", undefined, "git"],
      ["POST", "/worktrees/root/git-stage", { paths: ["secret"] }, "git"],
      ["POST", "/worktrees/root/git-unstage", { paths: ["secret"] }, "git"],
      ["POST", "/worktrees/root/git-commit", { message: "forbidden" }, "git"],
      ["GET", "/worktrees?fresh=true", undefined, "worktrees"],
      ["POST", "/worktrees", { slug: "branch" }, "worktrees"],
      ["DELETE", "/worktrees/branch?force=true", undefined, "worktrees"],
      ["POST", "/sessions/same-session/worktree", { worktreeSlug: "branch" }, "worktrees"],
      ["GET", "/pending-requests?directories=%2Fexact", undefined, "pendingRecovery"],
    ] as const
    for (const [method, suffix, payload, capability] of requests) {
      const response = await app.inject({ method, url: base + suffix, payload })
      assert.equal(response.statusCode, 403, `${method} ${suffix}: ${response.body}`)
      assert.deepEqual(response.json(), { error: "explicit_capability_unavailable", code: "explicit_capability_unavailable", capability, reason: { code: capability === "pendingRecovery" ? "liveOnly" : "deferred" } })
    }
    for (const operation of [
      () => f.manager.previewFile(workspace.id, "secret", "/exact"),
      () => f.manager.readFileInDirectory(workspace.id, "/exact", "secret"),
      () => f.manager.writeFileInDirectory(workspace.id, "/exact", "secret", "forbidden"),
      () => f.manager.removeWorktree(workspace.id, "/exact", true),
      () => f.manager.initializeGit(workspace.id),
      () => f.manager.getWorktreeIdentityForPath(workspace.id, "/exact"),
    ]) await assert.rejects(async () => operation(), { code: "explicit_capability_unavailable" })
  }
  for (const serverId of ["A", "B", ""]) {
    const payload = { serverId, repositoryUrl: "https://example.invalid/repo", destinationPath: "/exact" }
    assert.equal((await app.inject({ method: "POST", url: "/api/workspaces/clone", payload })).statusCode, 403)
    await assert.rejects(cloneGitRepository(payload), { code: "explicit_capability_unavailable", capability: "git" })
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/workspaces/clone", payload: {
    binding: { serverId: "B", directory: "/exact" }, repositoryUrl: "https://example.invalid/repo", destinationPath: "/exact",
  } })).statusCode, 400)
  assert.deepEqual(hostCalls, [])
  assert.equal(f.calls.length, callsBefore)
})

test("POSIX backend keeps native Windows paths and case byte-for-byte", async t => {
  const f = await fixture("linux"); t.after(() => f.close())
  const directory = "Z:\\Remote Case\\Project"
  const { workspace } = await f.manager.create(directory, undefined, { serverId: "A" })
  assert.equal(workspace.path, directory)
  assert.equal(f.manager.getServiceDirectory(workspace.id), directory)
  assert.equal(f.manager.getServicePathStyle(workspace.id), "win32")
  assert.equal(await f.manager.ownsDirectory(workspace.id, directory.toLowerCase()), false)
  assert.equal(await f.manager.ownsDirectory(workspace.id, "Z:/Remote Case/Project"), false)
})

test("same paths/session IDs on A and B and independent window occurrences never share client authority", async t => {
  const f = await fixture(); t.after(() => f.close())
  const a = await f.manager.create("/exact", "window-1", { serverId: "A" })
  const a2 = await f.manager.create("/exact", "window-2", { serverId: "A" })
  const b = await f.manager.create("/exact", "window-1", { serverId: "B" })
  assert.notEqual(a.workspace.id, a2.workspace.id)
  assert.equal(f.connections.activeExplicitTargets, 2)
  assert.equal(f.calls.filter(call => call.path === "/openapi.json").length, 2)
  const ca = await createInstanceClient(f.manager, a.workspace.id), cb = await createInstanceClient(f.manager, b.workspace.id)
  assert.notEqual(ca, cb)
  assert.equal(await createInstanceClient(f.manager, a2.workspace.id), ca)
  assert.equal(await f.manager.ownsLocation(a.workspace.id, { directory: "/exact" }, cb!), false)
  await f.manager.delete(a.workspace.id)
  assert.equal(f.connections.activeExplicitTargets, 2)
  await f.manager.delete(a2.workspace.id)
  assert.equal(f.connections.activeExplicitTargets, 1)
  await assert.rejects(f.connections.acquireForWorkspace({ serverId: "A", directory: "/exact" }), { code: "disconnected" })
  assert.equal(await f.manager.ownsLocation(b.workspace.id, { directory: "/exact" }, cb!), true)
})

test("native placement alone authorizes each session, including descendants; moving out removes authority", async t => {
  const f = await fixture(); t.after(() => f.close())
  const owner = new ExplicitWorkspace(f.connections, { serverId: "A", directory: "/exact" })
  t.after(() => owner.release())
  await owner.validate(new AbortController().signal)
  assert.equal(await owner.ownsSession("same-session"), true)
  f.move()
  assert.equal(await owner.ownsSession("same-session"), false)
})

for (const directory of ["/absent", "/inaccessible"]) test(`native ${directory} rejects attachment and releases its slot even when location.get accepts`, async t => {
  const f = await fixture(); t.after(() => f.close())
  await assert.rejects(f.manager.create(directory, undefined, { serverId: "A" }), { code: "explicit_location_unavailable" })
  assert.equal(f.manager.list().length, 0)
  assert.equal(f.connections.activeExplicitTargets, 0)
})

const listing = (data: unknown) => ({ location: { directory: "/exact" }, data })
for (const [kind, response] of Object.entries({
  "null entry (QA reproduction)": listing([null]),
  "invalid path and type (QA reproduction)": listing([{ path: 42, type: "invalid" }]),
  "null root": null,
  "array root": [],
  "scalar root": "untrusted-response",
  "missing location": { data: [] },
  "null location": { location: null, data: [] },
  "missing data": { location: { directory: "/exact" } },
  "null data": listing(null),
  "object data": listing({}),
  "scalar data": listing("untrusted-response"),
  "scalar entry": listing(["untrusted-entry"]),
  "array entry": listing([[]]),
  "missing entry path": listing([{ type: "file" }]),
  "null entry path": listing([{ path: null, type: "file" }]),
  "numeric entry path": listing([{ path: 42, type: "file" }]),
  "missing entry type": listing([{ path: "proof.txt" }]),
  "null entry type": listing([{ path: "proof.txt", type: null }]),
  "numeric entry type": listing([{ path: "proof.txt", type: 42 }]),
  "unknown entry type": listing([{ path: "proof.txt", type: "symlink" }]),
  "invalid trailing entry": listing([{ path: "proof.txt", type: "file" }, {}]),
})) test(`malformed native listing ${kind} rejects without publication or mutation and releases its lease`, async t => {
  const f = await fixture(); t.after(() => f.close())
  f.listResponse(response)
  const publications: string[] = []
  f.events.on("workspace.created", () => { publications.push("created") })
  f.events.on("workspace.started", () => { publications.push("started") })
  await assert.rejects(f.manager.create("/exact", undefined, { serverId: "A" }), {
    name: "ExplicitWorkspaceError", code: "explicit_location_unavailable", message: "explicit_location_unavailable",
  })
  assert.deepEqual(publications, [])
  assert.equal(f.manager.list().length, 0)
  assert.equal(f.connections.activeExplicitTargets, 0)
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [
    ["GET", "/openapi.json"], ["GET", "/api/location"], ["GET", "/api/fs/list"],
  ])
})

for (const [kind, data] of Object.entries({
  empty: [],
  native: [{ path: "proof.txt", type: "file" }, { path: "nested folder", type: "directory" }],
  extensible: [{ path: "opaque\\Path", type: "file", futureMetadata: null }, { path: "", type: "directory", futureFlag: true }],
})) test(`valid native listing ${kind} admits without host path rules or extra-field restrictions`, async t => {
  const f = await fixture(); t.after(() => f.close())
  f.listResponse({ ...listing(data), futureMetadata: { supported: true } })
  const { workspace } = await f.manager.create("/exact", undefined, { serverId: "A" })
  assert.equal(workspace.status, "ready")
  await f.manager.delete(workspace.id)
  assert.equal(f.connections.activeExplicitTargets, 0)
})

for (const stage of ["location", "list"] as const) {
  for (const revoke of ["cancel", "rotate", "disconnect", "shutdown"] as const) test(`${stage}: ${revoke} fences late results, releases leases and never publishes ready`, async t => {
    const f = await fixture(); t.after(() => f.close())
    f.block(stage)
    let publications = 0
    f.events.on("workspace.started", () => { publications++ })
    const creation = f.manager.create("/exact", undefined, { serverId: "A", requestId: "opening" })
    const rejected = assert.rejects(creation)
    await f.entered
    assert.equal(f.connections.activeExplicitTargets, 1)
    if (revoke === "cancel") await f.manager.cancelCreationRequest("opening")
    if (revoke === "rotate") await f.credentials.set("A", JSON.stringify({ username: "new", password: "new" }))
    if (revoke === "disconnect") f.connections.disconnect("A")
    if (revoke === "shutdown") await f.manager.shutdown()
    f.finish()
    await rejected
    assert.equal(publications, 0)
    assert.equal(f.manager.list().length, 0)
    assert.equal(f.connections.activeExplicitTargets, 0)
    assert(f.calls.every(call => !/delete|evict|move/i.test(call.path)))
  })
}

test("native mismatch, huge validation response and unknown target fail closed", async t => {
  for (const kind of ["location", "listing", "oversize", "unknown"] as const) {
    const f = await fixture()
    try {
      if (kind === "location") f.location("/sibling")
      if (kind === "listing") f.listing("/sibling")
      if (kind === "oversize") f.oversize()
      await assert.rejects(f.manager.create("/exact", undefined, { serverId: kind === "unknown" ? "missing" : "A" }))
      assert.equal(f.connections.activeExplicitTargets, 0)
      assert.equal(f.manager.list().length, 0)
    } finally { await f.close() }
  }
})

test("pending same-target occurrences share admission; cancelling one retains the other's lease", async t => {
  const f = await fixture(); t.after(() => f.close())
  f.block("location")
  const first = f.manager.create("/exact", undefined, { serverId: "A", requestId: "first" })
  const rejected = assert.rejects(first)
  await f.entered
  const second = f.manager.create("/exact", undefined, { serverId: "A", requestId: "second" })
  await f.manager.cancelCreationRequest("first")
  await rejected
  assert.equal(f.connections.activeExplicitTargets, 1)
  f.finish()
  const result = await second
  assert.equal(f.manager.list().length, 1)
  assert.equal(f.calls.filter(call => call.path === "/openapi.json").length, 1)
  f.manager.releaseCreationRequest(result.workspace.id, "second")
  await f.manager.cancelCreationRequest("second")
  assert.equal(f.manager.list().length, 1)
  await f.manager.delete(result.workspace.id)
  assert.equal(f.connections.activeExplicitTargets, 0)
})

test("shared native project and alias metadata never extend exact authority", async t => {
  const f = await fixture(); t.after(() => f.close())
  const { workspace } = await f.manager.create("/alias", undefined, { serverId: "A" })
  assert.equal(await f.manager.ownsDirectory(workspace.id, "/"), false)
  assert.equal(await f.manager.ownsDirectory(workspace.id, "/exact"), false)
  const other = await f.manager.create("/exact", undefined, { serverId: "A" })
  assert.equal(await f.manager.ownsDirectory(other.workspace.id, "/alias"), false)
  assert.equal(await f.manager.ownsDirectory(workspace.id, "/exact"), false)
})

test("retarget and close during publication release leases and fence unpublished/late ready records", async t => {
  for (const kind of ["retarget", "publication"] as const) {
    const f = await fixture()
    try {
      let ready = 0
      f.events.on("workspace.started", () => { ready++ })
      if (kind === "publication") f.events.on("workspace.created", event => { void f.manager.delete(event.workspace.id) })
      else f.block("list")
      const creation = f.manager.create("/exact", undefined, { serverId: "A" })
      const rejected = assert.rejects(creation)
      if (kind === "retarget") {
        await f.entered
        await f.registry.replace([{ id: "A", kind: "explicit", label: "New URL", origin: "http://127.0.0.1:1" }])
        f.finish()
      }
      await rejected
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(ready, 0)
      assert.equal(f.manager.list().length, 0)
      assert.equal(f.connections.activeExplicitTargets, 0)
    } finally { await f.close() }
  }
})

test("published bindings trust reconnect at the same URL, reject held clients and never reacquire after Disconnect", async t => {
  const f = await fixture(); t.after(() => f.close())
  const { workspace } = await f.manager.create("/exact", undefined, { serverId: "A" })
  const previous = (await f.manager.acquireForWorkspace(workspace.id))!
  await f.credentials.set("A", JSON.stringify({ username: "rotated", password: "fixture-only" }))
  assert.throws(() => previous.assertCurrent(), { code: "stale_connection" })
  const current = (await f.manager.acquireForWorkspace(workspace.id))!
  assert.notEqual(previous.client, current.client)
  assert.deepEqual(f.manager.get(workspace.id)!.binding, { serverId: "A", directory: "/exact" })
  assert.equal(await f.manager.ownsLocation(workspace.id, { directory: "/exact" }, previous.client), false)
  assert.equal(await f.manager.ownsLocation(workspace.id, { directory: "/exact" }, current.client), true)
  f.connections.disconnect("A")
  await assert.rejects(f.manager.acquireForWorkspace(workspace.id), { code: "disconnected" })
  assert.equal(f.connections.activeExplicitTargets, 0)
  assert.equal(f.manager.list().length, 1)
  await f.connections.connect("A")
  assert.equal(await f.manager.ownsDirectory(workspace.id, "/exact"), true)
})

test("empty target IDs fail internally without local fallback", async t => {
  const f = await fixture(); t.after(() => f.close())
  await assert.rejects(f.manager.create("/exact", undefined, { serverId: "" }), { code: "explicit_location_unavailable" })
  assert.equal(f.calls.length, 0)
})

test("manager metadata follows the validated current connection without acquisition and retains historical snapshots", async t => {
  const f = await fixture("win32", true); t.after(() => f.close())
  const emptyLocal = f.manager.attachmentReservations("local-shared")
  const creatingLocal = f.manager.create(process.cwd())
  assert.equal(f.manager.attachmentReceiptCurrent(emptyLocal.receipt), false)
  assert.equal(f.manager.attachmentReservations("local-shared").inFlight, true)
  assert.deepEqual(f.manager.attachmentReservations("local-shared").reservations, [])
  const local = (await creatingLocal).workspace
  assert.equal(f.manager.attachmentReservations("local-shared").inFlight, false)
  assert.equal(f.manager.attachmentReservations("local-shared").reservations[0]!.state, "published")
  const stableLocal = f.manager.get(local.id)!
  const a = (await f.manager.create("/exact", "one", { serverId: "A" })).workspace
  const a2 = (await f.manager.create("/other", "two", { serverId: "A" })).workspace
  const b = (await f.manager.create("/exact", "one", { serverId: "B" })).workspace
  const previous = (await f.manager.acquireForWorkspace(a.id))!
  const old = f.manager.get(a.id)!, stableB = f.manager.get(b.id)!.capabilities
  const inspect = (available: boolean, generation?: number) => {
    const before = f.calls.length
    const acquire = t.mock.method(f.connections, "acquireForServer", () => { throw new Error("Metadata must not acquire") })
    const workspaceAcquire = t.mock.method(f.connections, "acquireForWorkspace", () => { throw new Error("Metadata must not reconnect") })
    const worktrees = t.mock.method(f.manager, "getWorktrees", () => { throw new Error("Metadata must not discover worktrees") })
    const hostCalls: string[] = []
    const mocks = [
      ...(["realpath", "stat", "lstat", "readdir", "readFile", "writeFile"] as const).map(method =>
        t.mock.method(fs, method, () => { hostCalls.push(method); throw new Error("Metadata must not access host files") })),
      ...(["spawn", "spawnSync", "execFile", "execFileSync"] as const).map(method =>
        t.mock.method(childProcess, method, () => { hostCalls.push(method); throw new Error("Metadata must not provision/discover services") })),
    ]
    syncBuiltinESMExports()
    try {
      for (const id of [a.id, a2.id]) {
        const descriptor = f.manager.get(id)!
        assert.deepEqual(descriptor.capabilities, f.manager.list().find(value => value.id === id)!.capabilities)
        for (const feature of ["sessions", "chat", "media", "permissions", "questions", "events"] as const) {
          assert.equal(descriptor.capabilities!.features[feature].state, available ? "available" : "unknown")
        }
        if (generation !== undefined) assert.equal(descriptor.capabilities!.generation, generation)
        if (available) assert.doesNotThrow(() => f.manager.requireWorkspaceCapability(id, "chat"))
        else assert.throws(() => f.manager.requireWorkspaceCapability(id, "chat"), { code: "explicit_capability_unavailable" })
        // prototype-1236: native read-only panels follow the current connection like chat.
        for (const feature of ["files", "git", "backgroundShells", "yolo", "providerUsage", "plugins"] as const) {
          assert.equal(descriptor.capabilities!.features[feature].state, available ? "available" : "unavailable")
        }
        for (const feature of ["worktrees", "terminal", "missions", "automation", "executionSettings"] as const) {
          assert.equal(descriptor.capabilities!.features[feature].state, "unavailable")
          assert.throws(() => f.manager.requireWorkspaceCapability(id, feature), { code: "explicit_capability_unavailable" })
        }
      }
      assert.deepEqual(f.manager.get(b.id)!.capabilities, stableB)
      assert.equal(f.manager.get(local.id), stableLocal)
      assert.equal(f.manager.list().find(value => value.id === local.id), stableLocal)
      assert.doesNotThrow(() => f.manager.requireWorkspaceCapability(local.id, "executionSettings"))
      assert.equal(f.calls.length, before)
      assert.equal(acquire.mock.callCount(), 0)
      assert.equal(workspaceAcquire.mock.callCount(), 0)
      assert.equal(worktrees.mock.callCount(), 0)
      assert.deepEqual(hostCalls, [])
    } finally {
      acquire.mock.restore(); workspaceAcquire.mock.restore(); worktrees.mock.restore()
      for (const mock of mocks) mock.mock.restore()
      syncBuiltinESMExports()
    }
  }
  inspect(true)
  f.connections.invalidateServer("A")
  inspect(false)
  f.contract({})
  await assert.rejects(f.manager.acquireForWorkspace(a.id))
  inspect(false)
  f.contract(explicitContractFixture())
  const current = (await f.manager.acquireForWorkspace(a2.id))!
  inspect(true, (current as ServerConnection).generation)
  assert.notEqual(old.capabilities!.generation, f.manager.get(a.id)!.capabilities!.generation)
  assert.equal(old.capabilities!.features.chat.state, "available")
  assert.equal(old.capabilities!.generation, a.capabilities!.generation)
  const untrusted = f.manager.get(a.id)!
  untrusted.capabilities!.features.worktrees = { state: "available", evidence: "nativeContract", reason: { code: "contractVerified" } }
  assert.throws(() => f.manager.requireWorkspaceCapability(a.id, "worktrees"), { code: "explicit_capability_unavailable" })
  inspect(true)
  const before = f.calls.length
  await assert.rejects(previous.client.session.get({ sessionID: "same-session" }))
  assert.equal(f.calls.length, before)
  await f.credentials.set("A", JSON.stringify({ username: "rotated", password: "fixture-only" }))
  inspect(false)
  await f.manager.acquireForWorkspace(a.id)
  inspect(true)
  await f.credentials.clear("A")
  inspect(false)
  await assert.rejects(f.manager.acquireForWorkspace(a.id), { code: "needs_credentials" })
  inspect(false)
  await f.credentials.set("A", JSON.stringify({ username: "reentered", password: "fixture-only" }))
  await f.manager.acquireForWorkspace(a.id)
  inspect(true)
  f.connections.disconnect("A")
  inspect(false)
  await assert.rejects(f.manager.acquireForWorkspace(a.id), { code: "disconnected" })
  await f.connections.connect("A")
  inspect(true)
  await f.manager.delete(a.id)
  assert.equal(f.connections.activeExplicitTargets, 2)
  await f.manager.delete(a2.id)
  assert.equal(f.connections.activeExplicitTargets, 1)
})

test("pending replacement and late superseded negotiation cannot restore capability authority", async t => {
  const f = await fixture(); t.after(() => { f.finish(); return f.close() })
  const { workspace } = await f.manager.create("/exact", undefined, { serverId: "A" })
  const old = f.manager.get(workspace.id)!
  f.connections.invalidateServer("A")
  f.block("contract")
  const pending = f.manager.acquireForWorkspace(workspace.id)
  const rejected = assert.rejects(pending)
  await f.entered
  assert.equal(f.manager.get(workspace.id)!.capabilities!.features.chat.state, "unknown")
  await f.credentials.set("A", JSON.stringify({ username: "new", password: "fixture-only" }))
  f.finish()
  const current = (await f.manager.acquireForWorkspace(workspace.id))!
  await rejected
  assert.equal(f.manager.get(workspace.id)!.capabilities!.generation, (current as ServerConnection).generation)
  assert.notEqual(old.capabilities!.generation, f.manager.get(workspace.id)!.capabilities!.generation)
})

test("attachment inventory observes real unpublished reservations and never equates a browser or retained shell with full coverage", async t => {
  const f = await fixture(); t.after(() => { f.finish(); return f.close() })
  const before = f.manager.attachmentReservations("A")
  f.block("list")
  const pending = f.manager.create("/exact", undefined, { serverId: "A" })
  await f.entered
  assert.deepEqual(f.manager.list(), [])
  assert.equal(f.manager.attachmentReceiptCurrent(before.receipt), false)
  const during = f.manager.attachmentReservations("A")
  assert.equal(during.reservations.length, 1)
  assert.equal(during.reservations[0]!.state, "reserved")
  assert.equal(f.connections.attachmentReservations("A").reservations.length, 1)
  assert.equal(f.connections.attachmentReservations("A").inFlight, true)
  const browser = await f.manager.readServerAttachments({ available: false, request: async () => { throw new Error("no parent") } }, "A")
  assert.equal(browser.status, "unknown")
  assert.equal(browser.backend!.leases.reservations.length, 1)
  assert.equal(await browser.isCurrent(), false)
  f.finish()
  const { workspace } = await pending
  assert.equal(f.manager.attachmentReceiptCurrent(during.receipt), false)
  assert.equal(f.manager.attachmentReservations("A").reservations[0]!.state, "published")
  assert.equal(f.connections.attachmentReservations("A").reservations[0]!.instanceId, workspace.id)
  await f.manager.delete(workspace.id)
  assert.equal(f.manager.attachmentReservations("A").reservations.length, 0)
  assert.equal(f.connections.attachmentReservations("A").reservations.length, 0)
})

test("inventory captures before private transport await; an old zero reader never adopts a newly attached occurrence", async t => {
  const f = await fixture(); t.after(() => f.close())
  let release!: (value: unknown) => void
  const held = new Promise<unknown>(resolve => { release = resolve })
  const receipt = "11111111-1111-4111-8111-111111111111", ownerId = "22222222-2222-4222-8222-222222222222"
  const metadata = { receipt, status: "unknown", retainedStatus: "complete", owners: [{ ownerId, live: true, retained: true }],
    refs: [{ ownerId, tabId: "33333333-3333-4333-8333-333333333333", source: "retained", serverId: "orphan", directory: "/Saved/Case " }] }
  const parent = { available: true, request: async <T>(method: string): Promise<T> => (method.endsWith(".read") ? held : true) as Promise<T> }
  const old = f.manager.readServerAttachments(parent, "A")
  const { workspace } = await f.manager.create("/exact", undefined, { serverId: "A" })
  release(metadata)
  const stale = await old
  assert.equal(stale.status, "unknown")
  assert.equal(stale.backend, undefined)
  assert.deepEqual(stale.refs, [])
  assert.equal(await stale.isCurrent(), false)
  const fresh = await f.manager.readServerAttachments(parent, "orphan")
  assert.equal(await fresh.isCurrent(), true)
  assert.equal(fresh.status, "unknown")
  assert.equal(fresh.refs[0]!.directory, "/Saved/Case ")
  const before = f.calls.length
  await f.manager.delete(workspace.id)
  assert.equal(await fresh.isCurrent(), false)
  assert.equal(f.calls.length, before)
})

const inventoryCorruption = { credential: "PRIVATE_INVENTORY_CREDENTIAL_SENTINEL", directory: "PRIVATE_INVENTORY_CORRUPT_DIRECTORY\0path" }
function assertNoInventoryCorruption(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const marker of Object.values(inventoryCorruption)) assert.equal(serialized.includes(JSON.stringify(marker).slice(1, -1)), false)
}

test("inventory privacy oracle accepts legitimate UUIDs and detects every exact injected corruption marker", () => {
  const safe = { receipt: "427bad92-e7e1-4f22-bf05-45c9dd5b2fb6", status: "unknown", refs: [] }
  assertNoInventoryCorruption(safe)
  for (const [field, marker] of Object.entries(inventoryCorruption)) {
    assert.throws(() => assertNoInventoryCorruption({ ...safe, [field]: marker }), { code: "ERR_ASSERTION" })
  }
})

test("private inventory refuses unsupported, oversized and forged host projections without granting absence", async t => {
  const f = await fixture(); t.after(() => f.close())
  const receipt = "11111111-1111-4111-8111-111111111111", ownerId = "22222222-2222-4222-8222-222222222222"
  const base = { receipt, status: "unknown", retainedStatus: "complete", owners: [{ ownerId, live: true, retained: true }], refs: [] }
  const ref = { ownerId, tabId: "33333333-3333-4333-8333-333333333333", source: "retained", serverId: "A", directory: "/exact" }
  for (const value of [null, { ...base, status: "complete" }, { ...base, credential: inventoryCorruption.credential },
    { ...base, refs: [{ ...ref, ownerId: "44444444-4444-4444-8444-444444444444" }] },
    { ...base, owners: [base.owners[0], base.owners[0]] }, { ...base, refs: Array(513).fill(ref) },
    { ...base, refs: [{ ...ref, directory: inventoryCorruption.directory }] }, { ...base, refs: [ref, ref] },
    { ...base, refs: [{ ...ref, directory: "x".repeat(8 * 1024 * 1024) }] }]) {
    const parent = { available: true, request: async <T>(): Promise<T> => value as T }
    const result = await f.manager.readServerAttachments(parent, "A")
    assert.equal(result.status, "unknown")
    assert.deepEqual(result.refs, [])
    assert.equal(await result.isCurrent(), false)
    assertNoInventoryCorruption(result)
  }
  const parent = { available: true, request: async <T>(method: string): Promise<T> => (method.endsWith(".read") ? { ...base, refs: [ref] } : true) as T }
  const fresh = await f.manager.readServerAttachments(parent, "A")
  assert.equal(fresh.status, "unknown")
  assert.deepEqual(fresh.refs, [ref])
  assert.equal(await fresh.isCurrent(), true)
  assertNoInventoryCorruption(fresh)
  assert.deepEqual(f.calls, [])
})

test("real manager captures participant admission before private awaits and preserves independent unknown coverage", async t => {
  const f = await fixture(); t.after(() => f.close())
  let release!: (value: unknown) => void
  const held = new Promise<unknown>(resolve => { release = resolve })
  const parent = { available: true, request: async <T>(method: string): Promise<T> => (method.endsWith(".read") ? held : true) as Promise<T> }
  const pending = f.manager.readServerAttachments(parent, "A")
  const participant = f.manager.projectParticipants.register("private-principal", () => true)!
  const declaration = { revision: 1, refs: [{ tabId: "33333333-3333-4333-8333-333333333333", serverId: "A", directory: "Z:\\Opaque\\é/שלום " }] }
  assert.equal(f.manager.projectParticipants.admit(participant.grant.token, "private-principal")!.publish(declaration, () => { assert.fail("no workspace selector") }), true)
  release({ receipt: "11111111-1111-4111-8111-111111111111", status: "unknown", retainedStatus: "unknown", owners: [], refs: [] })
  const stale = await pending
  assert.equal(stale.backend, undefined)
  assert.equal(stale.participants, undefined)
  assert.equal(await stale.isCurrent(), false)
  const fresh = await f.manager.readServerAttachments(parent, "A")
  assert.equal(fresh.status, "unknown")
  assert.equal(fresh.coverage.participants, "unknown")
  assert.equal(fresh.participants!.refs[0]!.directory, declaration.refs[0]!.directory)
  assert.equal(await fresh.isCurrent(), true, "current declarations retain their narrower metadata scope")
  participant.close()
  assert.equal(await fresh.isCurrent(), false)
  assert.deepEqual(f.calls, [])
  assert.doesNotMatch(JSON.stringify(fresh), new RegExp(`${participant.grant.token}|private-principal`))
})

test("native and participant observations share the original owner ceiling without dropping source membership", async t => {
  const f = await fixture(); t.after(() => f.close())
  const participants = Array.from({ length: 32 }, () => f.manager.projectParticipants.register("principal", () => true)!)
  const metadata = { receipt: "11111111-1111-4111-8111-111111111111", status: "unknown", retainedStatus: "unknown",
    owners: [{ ownerId: "22222222-2222-4222-8222-222222222222", live: true, retained: false }], refs: [] }
  const parent = { available: true, request: async <T>(method: string): Promise<T> => (method.endsWith(".read") ? metadata : true) as T }
  const observed = await f.manager.readServerAttachments(parent, "A")
  assert.equal(observed.status, "unknown")
  assert.equal(observed.observationOverflow, true)
  assert.equal(observed.participants, undefined)
  assert.deepEqual(observed.owners, [])
  assert.equal(f.manager.projectParticipants.snapshot("A").owners.length, participants.length)
  assert.deepEqual(f.calls, [])
})
