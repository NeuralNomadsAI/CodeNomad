import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import replyFrom from "@fastify/reply-from"
import pino from "pino"
import { EventBus } from "../../events/bus"
import { explicitContractFixture } from "../../opencode/compatibility/contract-fixture"
import { OpenCodeServerConnections, type ServerConnection } from "../../opencode/servers/connections"
import { OpenCodeServerCredentials } from "../../opencode/servers/credentials"
import { OpenCodeServerRegistry } from "../../opencode/servers/registry"
import { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerInstanceProxyRoutes } from "../http-server"
import { registerSessionMediaRoutes } from "../routes/session-media"
import { mediaDigest } from "../../opencode/session-media"
import type { OpenCodeServerProfile } from "../../opencode/servers/types"
import { OpenCode, type OpenCodeClient, type LocationRef } from "@opencode/client"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import type { ServerCapability } from "../../opencode/servers/capabilities"
import { EXPLICIT_REQUEST_UNCERTAIN_ERROR_CODE } from "../../api-types"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t: TestContext, directory = "/same/project") {
  const calls: { server: string; path: string; body: any; headers: any; query: string }[] = []
  let override: ((path: string, server: string) => { status?: number; body: unknown; type?: string } | undefined | Promise<{ status?: number; body: unknown; type?: string } | undefined>) | undefined
  const forbidden = () => { throw new Error("Host adapter forbidden") }
  const upstreams: FastifyInstance[] = [], profiles: OpenCodeServerProfile[] = []
  let sessionDirectory = directory, sessionIdentity = "s", pause: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; path: string } | undefined
  const images = { A: `data:image/png;base64,${Buffer.from("image-A").toString("base64")}`, B: `data:image/png;base64,${Buffer.from("image-B").toString("base64")}`, "local-shared": "data:image/png;base64,eA==" }
  let localConnection: ServiceConnection
  for (const server of ["A", "B", "local-shared"] as const) {
    const app = Fastify()
    app.all("/*", async (request, reply) => {
      const url = new URL(request.url, "http://fixture")
      calls.push({ server, path: url.pathname, query: url.search, body: request.body, headers: request.headers })
      if (pause?.path === url.pathname) { const hold = pause; hold.entered.resolve(); await hold.release.promise }
      if (url.pathname === "/openapi.json") return explicitContractFixture()
      if (url.pathname === "/api/location") return { directory, project: { id: "same", directory: "/", canonical: "/" } }
      if (url.pathname === "/api/fs/list") return { location: { directory }, data: [] }
      const supplied = await override?.(url.pathname, server)
      if (supplied) return reply.code(supplied.status ?? 200).type(supplied.type ?? "application/json").send(supplied.body)
      reply.header("set-cookie", "forbidden=secret").header("www-authenticate", "Basic secret").header("proxy-authenticate", "Basic secret").header("location", "https://forbidden.invalid/")
      const session = { id: sessionIdentity, location: { directory: sessionDirectory }, parentID: "foreign-parent", projectID: "same", title: server }
      if (url.pathname === "/api/session" && request.method === "GET") return { data: [session], cursor: {} }
      if (url.pathname === "/api/session/active") return { data: { s: { type: "running" }, foreign: { type: "running" }, gone: { type: "running" } } }
      if (url.pathname === "/api/session/gone") return reply.code(404).send({ _tag: "SessionNotFoundError", sessionID: "gone", message: "missing" })
      if (url.pathname === "/api/session/foreign") return { data: { ...session, id: "foreign", location: { directory: "/sibling" } } }
      if (url.pathname === "/api/session/s" && request.method === "GET") return { data: session }
      const form = url.pathname.match(/^\/api\/session\/(s|global)\/form\/q$/)
      if (form && request.method === "GET") return { data: { id: "q", sessionID: form[1], title: server,
        fields: [{ key: "answer", type: "string" }], state: { status: "pending" } } }
      if (url.pathname === "/api/session" || url.pathname.endsWith("/fork")) return { data: session }
      if (url.pathname === "/api/session/s/message/m") return { data: { id: "m", type: "assistant", content: [{ type: "tool", state: { content: [{ type: "file", mime: "image/png", uri: images[server] }] } }] } }
      if (url.pathname === "/api/session/s/message") return { data: [{ id: "m", type: "assistant", content: [{ type: "tool", state: { content: [{ type: "file", mime: "image/png", uri: images[server] }] } }] }], cursor: {} }
      if (url.pathname === "/api/session/s/prompt") return { data: { id: "inbox", server } }
      if (server === "local-shared" && url.pathname === "/api/rpc/codenomad.missions/scheduleCarrierRead") return { output: { owned: false } }
      if (url.pathname === "/api/session/s/interrupt") return { interrupted: true }
      if (request.method !== "GET") return reply.code(204).send()
      return { marker: server }
    })
    await app.listen({ host: "127.0.0.1", port: 0 })
    upstreams.push(app)
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    if (server !== "local-shared") profiles.push({ id: server, kind: "explicit" as const, label: server, origin })
    else localConnection = { endpoint: { url: origin }, client: OpenCode.make({ baseUrl: origin }), fetch: globalThis.fetch, assertCurrent() {}, invalidate() {}, profile: async () => "modern" }
  }
  const registry = new OpenCodeServerRegistry(() => profiles, forbidden)
  const credentials = new OpenCodeServerCredentials({ profileKey: "proxy-test", configIdentity: "proxy-test" }, registry)
  for (const id of ["A", "B"]) await credentials.set(id, JSON.stringify({ username: id, password: `fixture-${id}` }))
  const connections = new OpenCodeServerConnections({ registry, credentials, local: { acquire: forbidden, existing: forbidden, invalidate: forbidden } })
  const manager = new WorkspaceManager({ rootDir: "C:/forbidden", logger: pino({ level: "silent" }), eventBus: new EventBus(),
    binaryResolver: { resolveDefault: forbidden } as never,
    settings: { getOpenCodeServerConnections: () => connections, getOwner: forbidden, readEnvironmentForAdmission: forbidden, disposeOpenCodeServers: () => connections.dispose() } as never,
    sharedService: { endpoint: forbidden, client: forbidden, headers: forbidden, validateLocation: forbidden, subscribe: forbidden, shutdown: async () => {} },
  })
  const a = (await manager.create(directory, undefined, { serverId: "A" })).workspace
  const b = (await manager.create(directory, undefined, { serverId: "B" })).workspace
  const local = { id: "local", path: directory, binding: { serverId: "local-shared", directory } } as typeof a
  const localSignal = new AbortController().signal
  const get = manager.get.bind(manager), acquire = manager.getSharedServiceConnection.bind(manager), requireCapability = manager.requireWorkspaceCapability.bind(manager), ownsLocation = manager.ownsLocation.bind(manager), translate = manager.getServiceDirectoryForPath.bind(manager)
  t.mock.method(manager, "get", (id: string) => id === "local" ? local : get(id))
  t.mock.method(manager, "getSharedServiceConnection", (id: string) => id === "local" ? Promise.resolve(localConnection) : acquire(id))
  t.mock.method(manager, "requireWorkspaceCapability", (id: string, capability: ServerCapability) => id === "local" ? localSignal : requireCapability(id, capability))
  t.mock.method(manager, "ownsLocation", (id: string, location: LocationRef, client?: OpenCodeClient, signal?: AbortSignal) => id === "local" ? Promise.resolve(location.directory === directory && location.workspaceID === undefined) : ownsLocation(id, location, client, signal))
  t.mock.method(manager, "getServiceDirectoryForPath", (id: string, path: string) => id === "local" ? Promise.resolve(path === directory ? path : undefined) : translate(id, path))
  for (const method of ["getSharedServiceEndpoint", "getSharedServiceClient", "getSharedServiceFetch", "getServicePathForPath", "getHostPathForServicePath", "ownsDirectory", "ownsPath"] as const) t.mock.method(manager, method, forbidden)
  const desktopPluginsReady = t.mock.method(manager, "desktopPluginsReady", forbidden)
  t.mock.method(manager, "getSessionEnvironment", async (id: string) => { if (id !== "local") return forbidden(); return { PATH: "host-sentinel", HOME: "host-sentinel", TOKEN: "host-sentinel" } })
  t.mock.method(manager, "getWorktreeIdentityForPath", async (id: string) => { if (id !== "local") return forbidden(); return "local-identity" })
  const app = Fastify()
  const publication = { onSend: 0, write: 0, end: 0 }
  const observerClosed = deferred()
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "GET" || !/\/form\//.test(request.url)) return
    const raw = reply.raw as any, write = raw.write, end = raw.end
    raw.once("close", observerClosed.resolve)
    raw.write = function (...args: any[]) { publication.write++; return write.apply(this, args) }
    raw.end = function (...args: any[]) { publication.end++; return end.apply(this, args) }
  })
  app.addHook("onSend", async (request, _reply, body) => {
    if (request.method === "GET" && /\/form\//.test(request.url)) publication.onSend++
    return body
  })
  await app.register(replyFrom)
  registerInstanceProxyRoutes(app, { workspaceManager: manager, logger: pino({ level: "silent" }), worktreeDeletionFence: new WorktreeDeletionFence(),
    accounts: { beforeSend: (connection: ServiceConnection) => { if (connection !== localConnection) forbidden() }, manual: forbidden } as never,
    permissionReceipts: { prepare: forbidden, prepareDeletion: forbidden } as never, humanAnswers: forbidden as never })
  registerSessionMediaRoutes(app, { workspaceManager: manager })
  await app.ready()
  t.after(async () => { pause?.release.resolve(); await app.close(); await manager.shutdown(); await Promise.all(upstreams.map(value => value.close())) })
  const url = (id: string, suffix: string) => `/workspaces/${id}/instance/api/${suffix}`
  const nativeClient = (id: string): OpenCodeClient => OpenCode.make({ baseUrl: `http://proxy/workspaces/${id}/instance`, fetch: async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const result = await app.inject({ method: init?.method as "GET", url: url.pathname + url.search, payload: init?.body as string, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return new Response(result.statusCode === 204 ? null : Uint8Array.from(result.rawPayload), { status: result.statusCode, headers: result.headers as Record<string, string> })
  } })
  return { app, manager, connections, credentials, a, b, local, calls, images, url, nativeClient, publication, observerClosed, desktopPluginsReady,
    respond: (value: typeof override) => { override = value },
    move: (value: string) => { sessionDirectory = value }, identity: (value: string) => { sessionIdentity = value },
    hold: (path: string) => { pause = { path, entered: deferred(), release: deferred() }; return pause },
  }
}

test("individual Form GET uses exact captured A/B/global placement, bounds reads and keeps Permission GET closed", async t => {
  const directory = "/é %25 日本"
  const f = await fixture(t, directory)
  for (const workspace of [f.a, f.b]) for (const sessionID of ["s", "global"]) {
    const before = f.calls.length
    const value = await f.nativeClient(workspace.id).session.form.get({ sessionID, formID: "q" }, { headers: {
      "x-codenomad-connection-generation": String(f.manager.get(workspace.id)!.capabilities!.generation),
      ...(sessionID === "global" ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
    } })
    assert.equal(value.title, workspace.binding!.serverId)
    assert.equal(value.state.status, "pending")
    const reads = f.calls.slice(before)
    assert.equal(reads.length, sessionID === "global" ? 1 : 3)
    assert(reads.every(call => call.server === workspace.binding!.serverId))
    assert(reads.every(call => call.headers["x-codenomad-connection-generation"] === undefined))
    if (sessionID === "global") assert.equal(reads[0].headers["x-opencode-directory"], encodeURIComponent(directory))
  }
  const acquire = t.mock.method(f.manager, "getSharedServiceConnection", () => { throw new Error("No permission acquisition") })
  assert.equal((await f.app.inject(f.url(f.a.id, "session/s/permission/p"))).statusCode, 403)
  const stale = f.manager.get(f.a.id)!.capabilities!.generation! + 1
  assert.equal((await f.app.inject({ url: f.url(f.a.id, "session/s/form/q"), headers: { "x-codenomad-connection-generation": String(stale) } })).statusCode, 409)
  assert.equal(acquire.mock.callCount(), 0)
})

test("Form wire failures never escape as usable data or leak native bodies; fresh explicit retry works", async t => {
  const f = await fixture(t)
  const header = { "x-codenomad-connection-generation": String(f.manager.get(f.a.id)!.capabilities!.generation) }
  for (const [status, body] of [[404, { _tag: "PermissionNotFoundError", requestID: "q" }], [200, { data: { unexpected: true } }],
    [404, { _tag: "FormNotFoundError", id: "q", message: "NATIVE-SECRET-SENTINEL" }]] as const) {
    f.respond(path => path.includes("/form/") ? { status, body } : undefined)
    const response = await f.app.inject({ url: f.url(f.a.id, "session/s/form/q"), headers: header })
    assert.equal(response.statusCode, 503); assert.deepEqual(response.json(), { error: "form_verification_indeterminate" })
    assert(!response.body.includes("SENTINEL"))
  }
  f.respond(() => undefined)
  f.move("/foreign")
  const before = f.calls.filter(call => call.path.includes("/form/")).length
  assert.equal((await f.app.inject({ url: f.url(f.a.id, "session/s/form/q"), headers: header })).statusCode, 503)
  assert.equal(f.calls.filter(call => call.path.includes("/form/")).length, before, "mismatched Session never reads a Form")
  f.move("/same/project")
  assert.equal((await f.app.inject({ url: f.url(f.a.id, "session/s/form/q"), headers: header })).statusCode, 200)
})

test("Form pre/post Session responses also have the 4MiB ceiling, and post-read placement fences publication", async t => {
  const f = await fixture(t)
  for (const phase of [1, 2]) {
    let sessions = 0
    const before = f.calls.length
    f.respond(path => path === "/api/session/s" && ++sessions === phase ? { body: JSON.stringify({ data: { id: "s", location: { directory: "/same/project" } } }) + " ".repeat(4 * 1024 * 1024) } : undefined)
    assert.equal((await f.app.inject(f.url(f.a.id, "session/s/form/q"))).statusCode, 503)
    assert.equal(f.calls.slice(before).filter(call => call.path.includes("/form/")).length, phase - 1)
  }
  const pause = f.hold("/api/session/s/form/q")
  f.respond(undefined)
  const pending = f.app.inject(f.url(f.a.id, "session/s/form/q"))
  await pause.entered.promise
  f.move("/foreign"); pause.release.resolve()
  assert.equal((await pending).statusCode, 503)
})

test("one real ten-second Form budget includes acquisition, profile and sequential wire phases", async t => {
  const f = await fixture(t)
  const connection = (await f.manager.getSharedServiceConnection(f.a.id))!
  let profile = 0
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 3500))
  t.mock.method(f.manager, "getSharedServiceConnection", async () => { await delay(); return { ...connection, profile: async () => { profile++; await delay(); return "modern" as const } } })
  f.respond(async path => { if (path.includes("/form/")) await delay(); return undefined })
  const before = f.calls.length, start = Date.now()
  const response = await f.app.inject(f.url(f.a.id, "session/s/form/q"))
  const elapsed = Date.now() - start
  assert.equal(response.statusCode, 503)
  assert(elapsed >= 9900 && elapsed < 12_000, `whole operation took ${elapsed}ms`)
  assert.equal(profile, 1)
  assert.equal(f.calls.slice(before).filter(call => call.path === "/api/session/s").length, 1, "no post-read after deadline")
})

test("elapsed Form deadline fences response parsing before a delayed timer turn can permit post-read or publication", async t => {
  const f = await fixture(t)
  let elapsed = performance.now()
  t.mock.method(performance, "now", () => elapsed)
  f.respond(path => { if (path.includes("/form/")) elapsed += 10_001; return undefined })
  const before = f.calls.length
  const response = await f.app.inject(f.url(f.a.id, "session/s/form/q"))
  assert.equal(response.statusCode, 503)
  assert.equal(f.calls.slice(before).filter(call => call.path === "/api/session/s").length, 1)
})

test("closing a Form HTTP observer during shared acquisition writes nothing and prevents later native reads", async t => {
  const f = await fixture(t), acquired = deferred(), release = deferred()
  t.after(() => release.resolve())
  const connection = (await f.manager.getSharedServiceConnection(f.a.id))!
  t.mock.method(f.manager, "getSharedServiceConnection", async () => { acquired.resolve(); await release.promise; return connection })
  await f.app.listen({ host: "127.0.0.1", port: 0 })
  const origin = `http://127.0.0.1:${(f.app.server.address() as { port: number }).port}`
  const controller = new AbortController(), before = f.calls.length
  const response = fetch(origin + f.url(f.a.id, "session/s/form/q"), { signal: controller.signal })
  const rejected = assert.rejects(response)
  await acquired.promise; controller.abort(); await rejected
  // Native response close is observed before allowing shared work to return.
  await f.observerClosed.promise
  release.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(f.publication, { onSend: 0, write: 0, end: 0 })
  assert.equal(f.calls.length, before)
})

test("current manager capabilities revoke and restore proxy admission independently for two A occurrences, B and local", async t => {
  const f = await fixture(t)
  const a2 = (await f.manager.create(f.a.path, "second", { serverId: "A" })).workspace
  const historical = f.manager.get(f.a.id)!, b = f.manager.get(f.b.id)!
  await f.credentials.set("A", JSON.stringify({ username: "rotated", password: "fixture-only" }))
  const before = f.calls.length
  for (const id of [f.a.id, a2.id]) {
    assert.equal(f.manager.get(id)!.capabilities!.features.chat.state, "unknown")
    const result = await f.app.inject(f.url(id, "agent"))
    assert.equal(result.statusCode, 403)
    assert.deepEqual(result.json().reason, { code: "contractUnverified" })
  }
  assert.equal(f.calls.length, before)
  assert.equal((await f.app.inject(f.url(f.b.id, "agent"))).json().marker, "B")
  assert.equal((await f.app.inject(f.url(f.local.id, "session/s"))).json().data.title, "local-shared")
  const connection = (await f.manager.acquireForWorkspace(a2.id))!
  for (const id of [f.a.id, a2.id]) {
    const current = f.manager.get(id)!
    assert.equal(current.capabilities!.features.chat.state, "available")
    assert.equal(current.capabilities!.generation, (connection as ServerConnection).generation)
    assert.equal((await f.app.inject(f.url(id, "agent"))).json().marker, "A")
    const image = f.images.A
    const media = await f.app.inject(`/api/workspaces/${id}/session-media/s/m/0/0/${mediaDigest(image)}`)
    assert.equal(media.statusCode, 200)
    assert.equal(media.rawPayload.toString(), "image-A")
  }
  assert.notEqual(historical.capabilities!.generation, f.manager.get(f.a.id)!.capabilities!.generation)
  assert.equal(historical.capabilities!.features.chat.state, "available")
  assert.deepEqual(f.manager.get(f.b.id)!.capabilities, b.capabilities)
})

test("a multi-request chat action keeps its captured generation before renderer metadata catches up", async t => {
  const f = await fixture(t)
  const header = "x-codenomad-connection-generation"
  const captured = f.manager.get(f.a.id)!.capabilities!.generation
  const native = f.nativeClient(f.a.id)
  const options = { headers: { [header]: String(captured) } }
  await native.session.instructions.entry.put({ sessionID: "s", key: "placement", value: "native boundary" }, options)
  await f.credentials.set("A", JSON.stringify({ username: "rotated", password: "fixture-only" }))
  await f.manager.acquireForWorkspace(f.a.id)
  assert.notEqual(f.manager.get(f.a.id)!.capabilities!.generation, captured)
  const before = f.calls.length
  for (const [method, path, body] of [
    ["POST", "session/s/prompt", { text: "do not replay" }],
    ["POST", "session/s/command", { name: "review", text: "args" }],
    ["POST", "session/s/shell", { command: "pwd" }],
    ["POST", "session/s/fork", {}], ["POST", "session", {}],
    ["GET", "agent", undefined],
  ] as const) {
    const result = await f.app.inject({ method, url: f.url(f.a.id, path), payload: body, headers: options.headers })
    assert.equal(result.statusCode, 409)
    assert.equal(result.json().error, "explicit_action_superseded")
  }
  assert.equal(f.calls.length, before, "stale action must not even hydrate ownership on the new connection")
  const current = f.manager.get(f.a.id)!.capabilities!.generation
  await native.session.prompt({ sessionID: "s", text: "fresh explicit action" }, { headers: { [header]: String(current) } })
  assert.equal(f.calls.filter(call => call.path.endsWith("/prompt")).length, 1)
  assert.equal(f.calls.at(-2)?.headers[header], undefined, "private generation fence never reaches OpenCode")
  assert.equal((await f.app.inject(f.url(f.b.id, "agent"))).json().marker, "B")
})

test("explicit generation-fence headers reject malformed values before native access", async t => {
  const f = await fixture(t)
  const before = f.calls.length
  for (const value of ["0", "-1", "1.0", "1,2", "9007199254740992"]) {
    assert.equal((await f.app.inject({ url: f.url(f.a.id, "agent"), headers: { "x-codenomad-connection-generation": value } })).statusCode, 400)
  }
  assert.equal(f.calls.length, before)
})

test("the local proxy accepts the ordinary send but strips an injected private generation header", async t => {
  const f = await fixture(t)
  const localReady = t.mock.method(f.manager, "desktopPluginsReady", async () => {})
  const result = await f.app.inject({ method: "POST", url: f.url(f.local.id, "session/s/prompt"),
    headers: { "x-codenomad-connection-generation": "7" }, payload: { text: "local native send" } })
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(localReady.mock.callCount(), 1)
  localReady.mock.restore()
  const prompt = f.calls.find(call => call.server === "local-shared" && call.path === "/api/session/s/prompt")
  assert.ok(prompt)
  assert.equal(prompt.headers["x-codenomad-connection-generation"], undefined)
  assert.ok(f.calls.some(call => call.server === "local-shared" && call.path.endsWith("/environment")))
})

test("explicit handlers isolate homonymous sessions, native sends, catalogues and media without host effects", async t => {
  const f = await fixture(t)
  assert.equal((await f.app.inject(f.url(f.local.id, "session/s"))).json().data.title, "local-shared")
  const localReady = t.mock.method(f.manager, "desktopPluginsReady", async () => {})
  const localPrompt = await f.app.inject({ method: "POST", url: f.url(f.local.id, "session/s/prompt"), payload: { text: "local" } })
  assert.equal(localPrompt.statusCode, 200, localPrompt.body)
  assert.equal(localReady.mock.callCount(), 1)
  localReady.mock.restore()
  for (const [server, workspace] of [["A", f.a], ["B", f.b]] as const) {
    assert.equal((await f.app.inject(f.url(workspace.id, "agent"))).json().marker, server)
    assert.equal((await f.app.inject(f.url(workspace.id, "session"))).json().data[0].title, server)
    assert.equal((await f.app.inject(f.url(workspace.id, "session/s"))).json().data.title, server)
    assert.deepEqual(Object.keys((await f.app.inject(f.url(workspace.id, "session/active"))).json().data), ["s"])
    assert.equal((await f.app.inject({ method: "POST", url: f.url(workspace.id, "session"), payload: { title: server } })).statusCode, 200)
    for (const [operation, payload] of [["prompt", { text: "direct" }], ["prompt", { text: "queued", delivery: "queue" }], ["prompt", { text: "restored", resume: true, files: [{ uri: "data:text/plain;base64,eA==" }] }], ["command", { name: "goal", arguments: "pause" }], ["shell", { command: "echo native" }], ["interrupt", {}], ["form/q/reply", { answers: [] }], ["permission/p/reply", { decision: "once" }]] as const) {
      const response = await f.app.inject({ method: "POST", url: f.url(workspace.id, `session/s/${operation}`), payload })
      assert.equal(response.statusCode, ["prompt", "interrupt"].includes(operation) ? 200 : 204, `${server} ${operation}: ${response.body}`)
    }
    assert.equal((await f.app.inject({ method: "POST", url: f.url(workspace.id, "session/s/fork"), payload: {} })).statusCode, 200)
    assert.equal((await f.app.inject({ method: "POST", url: f.url(workspace.id, "session/s/prompt"), payload: { text: "fork resumed" } })).statusCode, 200)
    const native = f.nativeClient(workspace.id)
    assert.equal((await native.session.get({ sessionID: "s" })).title, server)
    await native.session.prompt({ sessionID: "s", text: "queued using generated wire", delivery: "queue", resume: true })
    await native.session.interrupt({ sessionID: "s", resume: false })
    await native.session.form.reply({ sessionID: "global", formID: "q", answer: {} }, { headers: { "x-opencode-directory": encodeURIComponent("/same/project") } })
    const globalReply = f.calls.filter(call => call.server === server && call.path === "/api/session/global/form/q/reply").at(-1)!
    assert.equal(globalReply.headers["x-opencode-directory"], encodeURIComponent("/same/project"))
    const media = await f.app.inject(`/api/workspaces/${workspace.id}/session-media/s/m/0/0/${mediaDigest(f.images[server])}`)
    assert.equal(media.statusCode, 200)
    assert.equal(media.rawPayload.toString(), `image-${server}`)
    const response = await f.app.inject({ url: f.url(workspace.id, "agent"), headers: { authorization: "Basic browser-secret", cookie: "browser=secret", forwarded: "host=evil", "x-forwarded-host": "evil", "x-internal-secret": "evil" } })
    for (const header of ["set-cookie", "www-authenticate", "proxy-authenticate", "location"]) assert.equal(response.headers[header], undefined)
    const outgoing = f.calls.at(-1)!.headers
    assert.equal(outgoing.authorization, `Basic ${Buffer.from(`${server}:fixture-${server}`).toString("base64")}`)
    for (const header of ["cookie", "forwarded", "x-forwarded-host", "x-internal-secret"]) assert.equal(outgoing[header], undefined)
  }
  assert(f.calls.filter(call => call.server !== "local-shared").every(call => !/environment|instructions|credential|integration|rpc/.test(call.path)))
  assert.deepEqual(f.calls.find(call => call.server === "local-shared" && call.path.endsWith("/environment"))!.body.variables, { PATH: "host-sentinel", HOME: "host-sentinel", TOKEN: "host-sentinel" })
  assert(f.calls.filter(call => call.server !== "local-shared").every(call => !JSON.stringify(call.body)?.includes("host-sentinel")))
  assert.equal((await f.app.inject(`/api/workspaces/${f.a.id}/session-media/s/m/0/0/${mediaDigest(f.images.B)}`)).statusCode, 404)
  assert.equal(f.desktopPluginsReady.mock.callCount(), 0, "explicit projects never await host plugin readiness")
})

test("explicit deferred operations and malformed scopes reject before acquisition or any upstream effect", async t => {
  const f = await fixture(t)
  const acquire = t.mock.method(f.manager, "getSharedServiceConnection", () => { throw new Error("Acquisition forbidden") })
  const count = f.calls.length
  for (const [method, route, capability] of [
    ["GET", "fs/list", "files"], ["GET", "vcs/status", "git"], ["GET", "session/s/diff", "conversationDiffs"], ["POST", "session/s/move", "worktrees"],
    ["POST", "shell", "backgroundShells"], ["POST", "pty", "terminal"], ["GET", "form", "pendingRecovery"], ["GET", "permission/request", "pendingRecovery"],
    ["POST", "rpc/arbitrary/method", "historyEnrichment"], ["GET", "config", "executionSettings"], ["GET", "credential", "executionSettings"], ["POST", "integration/x/connect/key", "executionSettings"],
    ["POST", "session/s/environment", "sessionEnvironment"], ["POST", "plugin/update", "executionSettings"],
  ] as const) {
    const response = await f.app.inject({ method, url: f.url(f.a.id, route) })
    assert.equal(response.statusCode, 403, route)
    assert.equal(response.json().capability, capability)
    assert.equal(response.json().error, "explicit_capability_unavailable")
  }
  for (const route of ["session?directory=/same/project&directory=/same/project", "session?directory=/same/project&location[directory]=/same/project", "session?project=same", "session?location[workspaceID]=x", "session?location.directory=/same/project", "session?directory=%FF", "session?directory=%252Fsame%252Fproject", "session/s%252Fforeign", "session?cursor=invalid"]) {
    const response = await f.app.inject(f.url(f.a.id, route))
    assert([400, 403].includes(response.statusCode), `${route}: ${response.body}`)
  }
  for (const payload of [{ text: "x", location: { directory: "/sibling" } }, { text: "x", cwd: "/same/project" }, { text: "x", workspaceID: "legacy" }, { text: "x", files: [{ uri: "file:///host/secret" }] }]) {
    const response = await f.app.inject({ method: "POST", url: f.url(f.a.id, "session/s/prompt"), payload })
    assert([400, 403].includes(response.statusCode), response.body)
  }
  for (const headers of [{ "x-opencode-directory": "/sibling" }, { "x-opencode-workspace": "legacy" }, { "x-codenomad-human-answer": "1" }, { "x-codenomad-location": encodeURIComponent(JSON.stringify({ directory: "/sibling" })) }]) {
    assert.equal((await f.app.inject({ url: f.url(f.a.id, "session/s"), headers })).statusCode, 400)
  }
  assert.equal(acquire.mock.callCount(), 0)
  assert.equal(f.calls.length, count)
})

test("explicit session authority never broadens to parent/project and checks exact native identity", async t => {
  const f = await fixture(t)
  f.move("/same/project/child")
  assert.equal((await f.app.inject({ method: "POST", url: f.url(f.a.id, "session/s/prompt"), payload: { text: "denied" } })).statusCode, 403)
  f.move("/same/project")
  f.identity("different")
  assert.equal((await f.app.inject({ method: "POST", url: f.url(f.a.id, "session/s/prompt"), payload: { text: "denied" } })).statusCode, 403)
  assert(!f.calls.some(call => call.path.endsWith("/prompt")))
})

test("explicit inventory forwards a native-shaped cursor alone on its own target and rejects broader cursor authority", async t => {
  const f = await fixture(t)
  const nativeShape = { order: "desc", archived: "false", type: "directory", directory: "/same/project",
    anchor: { id: "s", time: 1, direction: "next" } }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const cursor = encode(nativeShape)
  for (const [server, workspace] of [["A", f.a], ["B", f.b]] as const) {
    const page = await f.nativeClient(workspace.id).session.list({ cursor })
    assert.equal(page.data[0].title, server)
    const call = f.calls.filter(call => call.server === server && call.path === "/api/session").at(-1)!
    assert.deepEqual([...new URLSearchParams(call.query)], [["cursor", cursor]])
    assert.equal(call.headers["x-opencode-directory"], undefined)
    assert.equal(call.headers["x-codenomad-location"], undefined)
  }
  const before = f.calls.length
  for (const scope of [
    { ...nativeShape, directory: "/" }, { ...nativeShape, directory: "/same" },
    { ...nativeShape, directory: "/same/project/sibling" }, { ...nativeShape, directory: "/same/project/.worktrees/task" },
    { ...nativeShape, type: "project", directory: undefined, project: "same" },
    { ...nativeShape, type: "project", directory: undefined, project: "same", subpath: "child" },
  ]) {
    const denied = await f.app.inject(f.url(f.a.id, `session?cursor=${encode(scope)}`))
    assert.equal(denied.statusCode, 400)
    assert.deepEqual(denied.json(), { error: "Invalid explicit workspace scope" })
  }
  assert.equal((await f.app.inject(f.url(f.a.id, `session?cursor=${encode({ ...nativeShape, subpath: "child" })}`))).statusCode, 400)
  assert.equal(f.calls.length, before)
})

test("explicit native message pages preserve opaque cursors on A/B and reject unknown cursor formats before acquisition", async t => {
  const f = await fixture(t)
  const cursor = Buffer.from(JSON.stringify({ id: "m", order: "desc", direction: "previous" })).toString("base64url")
  for (const workspace of [f.a, f.b]) {
    await f.nativeClient(workspace.id).message.list({ sessionID: "s", limit: 200, cursor })
    const call = f.calls.filter(call => call.path === "/api/session/s/message").at(-1)!
    assert.equal(call.server, workspace.binding!.serverId)
    assert.deepEqual([...new URLSearchParams(call.query)], [["limit", "200"], ["cursor", cursor]])
  }
  const before = f.calls.length
  for (const query of ["cursor=unknown", "cursor=codenomad%3Ahistory-window%3A1%3Aanything",
    `cursor=${cursor}&order=desc`, `cursor=${Buffer.from(JSON.stringify({ id: "m", order: "desc", direction: "next", unknown: true })).toString("base64url")}`,
    "order=sideways", "limit=201"]) {
    const response = await f.app.inject(f.url(f.a.id, `session/s/message?${query}`))
    assert.equal(response.statusCode, 400, query)
  }
  assert.equal(f.calls.length, before, "invalid native-page requests have zero upstream effects")
})

test("published capabilities cannot grant or revoke private workspace authority", async t => {
  const f = await fixture(t)
  f.a.capabilities!.features.worktrees = { state: "available", evidence: "nativeContract", reason: { code: "contractVerified" } }
  f.a.capabilities!.features.chat = { state: "unavailable", evidence: "e1Policy", reason: { code: "deferred" } }
  assert.throws(() => f.manager.requireWorkspaceCapability(f.a.id, "worktrees"), { code: "explicit_capability_unavailable", capability: "worktrees" })
  assert.doesNotThrow(() => f.manager.requireWorkspaceCapability(f.a.id, "chat"))
  assert.equal((await f.app.inject(f.url(f.a.id, "agent"))).statusCode, 200)
})

test("media in flight is revoked per occurrence even when another occurrence retains the same target", async t => {
  for (const retire of ["close", "rotate"] as const) {
    const f = await fixture(t)
    await f.manager.create("/same/project", undefined, { serverId: "A" })
    const hold = f.hold("/api/session/s/message/m")
    const read = f.app.inject(`/api/workspaces/${f.a.id}/session-media/s/m/0/0/${mediaDigest(f.images.A)}`)
    await hold.entered.promise
    if (retire === "close") await f.manager.delete(f.a.id)
    else await f.credentials.set("A", JSON.stringify({ username: "A", password: "replacement" }))
    hold.release.resolve()
    const response = await read
    assert.equal(response.statusCode, 502)
    assert(!response.body.includes("image-A"))
    assert.equal((await f.app.inject(f.url(f.b.id, "agent"))).statusCode, 200)
  }
})

test("a native move while a mutation waits yields an uncertain failure without replay", async t => {
  const f = await fixture(t), hold = f.hold("/api/session/s/prompt")
  const send = f.app.inject({ method: "POST", url: f.url(f.a.id, "session/s/prompt"), payload: { text: "only once" } })
  await hold.entered.promise
  f.move("/sibling")
  hold.release.resolve()
  const result = await send
  assert.equal(result.statusCode, 502)
  assert.equal(result.json().error, EXPLICIT_REQUEST_UNCERTAIN_ERROR_CODE)
  assert.match(result.body, /do not replay/)
  assert.equal(f.calls.filter(call => call.path.endsWith("/prompt")).length, 1)
})

test("close and credential rotation while ownership waits fence sends and media; B stays usable", async t => {
  for (const retire of ["close", "rotate"] as const) {
    const f = await fixture(t), hold = f.hold("/api/session/s")
    const send = f.app.inject({ method: "POST", url: f.url(f.a.id, "session/s/prompt"), payload: { text: "uncertain" } })
    await hold.entered.promise
    if (retire === "close") await f.manager.delete(f.a.id)
    else await f.credentials.set("A", JSON.stringify({ username: "A", password: "rotated" }))
    hold.release.resolve()
    assert([403, 502].includes((await send).statusCode))
    assert(!f.calls.some(call => call.path.endsWith("/prompt")))
    assert.equal((await f.app.inject(f.url(f.b.id, "agent"))).statusCode, 200)
  }
})

// prototype-1236: background shells, branch and MCP runtime controls reach only the project's folder; secrets never.
test("explicit proxy serves the shell panel inside the folder only and never relays credentials or config", async t => {
  const f = await fixture(t)
  const shell = (id: string, cwd: string) => ({ id, command: "npm test", cwd, status: "running", time: { created: 1 } })
  f.respond((path) => {
    if (path === "/api/shell") return { body: { location: { directory: "/same/project" }, data: [shell("in", "/same/project"), shell("child", "/same/project/web"), shell("out", "/same/projectx"), shell("up", "/same")] } }
    if (path === "/api/shell/in" || path === "/api/shell/in/output") return { body: { location: { directory: "/same/project" }, data: path.endsWith("output") ? { output: "ok", cursor: 2, size: 2, truncated: false } : shell("in", "/same/project") } }
    if (path === "/api/shell/out") return { body: { location: { directory: "/same/project" }, data: shell("out", "/elsewhere") } }
    if (path === "/api/vcs") return { body: { location: { directory: "/same/project" }, data: { provider: "git", branch: { current: "main" } } } }
    if (path === "/api/credential") return { body: { data: [{ value: { key: "secret-value" } }] } }
    return undefined
  })
  for (const workspace of [f.a, f.b]) {
    const list = await f.app.inject(f.url(workspace.id, "shell"))
    assert.equal(list.statusCode, 200, list.body)
    assert.deepEqual(list.json().data.map((value: { id: string }) => value.id), ["in", "child"])
    assert.equal((await f.app.inject(f.url(workspace.id, "shell/in/output?cursor=0&limit=10"))).json().data.output, "ok")
    assert.equal((await f.app.inject(f.url(workspace.id, "shell/out"))).statusCode, 403)
    assert.equal((await f.app.inject({ method: "DELETE", url: f.url(workspace.id, "shell/out") })).statusCode, 403)
    assert.ok((await f.app.inject({ method: "DELETE", url: f.url(workspace.id, "shell/in") })).statusCode < 300)
    assert.equal(f.calls.filter(call => call.path === "/api/shell/out" && call.server === workspace.binding!.serverId).length, 2, "ownership read only, no DELETE dispatched")
    assert.equal((await f.app.inject(f.url(workspace.id, "vcs"))).json().data.branch.current, "main")
    assert.equal((await f.app.inject({ method: "POST", url: f.url(workspace.id, "shell"), payload: { command: "rm -rf /" } })).statusCode, 403)
  }
  const before = f.calls.length
  for (const route of ["credential", "config", "vcs/status", "vcs/diff?mode=working", "experimental/config", "fs/read/secret", "experimental/fs/write"]) {
    for (const method of ["GET", "POST", "PATCH"] as const) {
      const response = await f.app.inject({ method, url: f.url(f.a.id, route), ...(method === "GET" ? {} : { payload: {} }) })
      assert.equal(response.statusCode, 403, `${method} ${route}`)
      assert(!response.body.includes("secret-value"))
    }
  }
  assert.equal(f.calls.length, before, "refused routes have zero upstream effects")
  assert(f.calls.every(call => call.path !== "/api/credential"))
  assert(f.calls.filter(call => call.path.startsWith("/api/shell")).every(call => new URLSearchParams(call.query).get("location[directory]") === "/same/project"))
})
