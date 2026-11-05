import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import pino from "pino"
import { EventBus } from "../../events/bus"
import { WorkspaceManager } from "../../workspaces/manager"
import { ExplicitWorkspace } from "../../workspaces/explicit-workspace"
import { ForgeWorkItems } from "../../forge/work-items"
import { FORGE_APIS } from "../../forge/providers"
import { PanelExtensionStore } from "../../panel-extensions/store"
import { readPanelExtensionArchive } from "../../panel-extensions/archive"
import { fixtureArchive } from "../../panel-extensions/archive-fixture"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "../../remote-control/test-support/surface"

const ORIGIN = `https://${FAKE_TUNNEL_HOST}`
const METHODS = ["workItems", "workItemUrl"] as const
const DENIED = { error: "explicit_capability_unavailable", code: "explicit_capability_unavailable", capability: "git", reason: { code: "localOnly" } }

// Real HTTP for both the local listener and the Remote Control ingress. Only
// fixture-owned loopback sockets are dialed, as the tunnel's TLS terminator does.
function send(target: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  const [hostname, port] = target.split(":")
  return new Promise<{ status: number; body: any; cookie?: string }>((resolve, reject) => {
    const request = http.request({ hostname, port: Number(port), path: pathname, method: body === undefined ? "GET" : "POST",
      headers: { host: FAKE_TUNNEL_HOST, "content-type": "application/json", ...headers } }, response => {
      let text = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { text += chunk })
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text),
        cookie: response.headers["set-cookie"]?.[0]?.split(";")[0] }))
    })
    request.on("error", reject)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

test("API 3 refuses every explicit binding before host forge entry, including warm caches and paired devices", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-api3-boundary-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const hostEffects: string[] = [], discoveries: string[] = [], attachmentReads: string[] = [], forgeReads: string[] = [], entries: string[] = []
  const forbidden = (label: string) => () => { hostEffects.push(label); throw new Error(`Forbidden ${label}`) }
  // Safety fence BEFORE readForgeRemote: the original identify/Git, credential
  // discovery and provider network must never execute, even on the positive path.
  const identify = t.mock.method(ForgeWorkItems.prototype as any, "identify", async (directory: string) => {
    discoveries.push(directory)
    return { remote: { host: "github.com", path: "fixture/repository" }, api: FORGE_APIS.github,
      transport: { access: "anonymous", request: async (url: string) => {
        forgeReads.push(url)
        return { status: 200, headers: new Headers(), body: JSON.stringify({ total_count: 0, items: [] }) }
      } } }
  })
  assert.notEqual(identify.mock.original, identify)
  for (const method of ["list", "itemUrl"] as const) {
    const original = ForgeWorkItems.prototype[method]
    t.mock.method(ForgeWorkItems.prototype, method, function (this: ForgeWorkItems, ...args: any[]) {
      entries.push(method)
      return (original as Function).apply(this, args)
    })
  }
  const logger = pino({ level: "silent" }), directory = "/synthetic/api3/project"
  let connected = true
  const connection = { serverId: "explicit-fixture", generation: 1, endpoint: { url: "http://attachment.invalid" },
    assertCurrent() {}, fetch: async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname
      attachmentReads.push(pathname)
      if (pathname === "/api/location") return Response.json({ directory, project: { id: "p" } })
      if (pathname === "/api/fs/list") return Response.json({ location: { directory }, data: [] })
      return forbidden("unexpected attachment request")()
    } }
  const connections = { retainProject: () => ({ acquire: async () => connection, published() {}, release() {} }),
    existingForServer: (id: string) => connected && id === connection.serverId ? connection : undefined,
    dispose: async () => {} }
  const manager = new WorkspaceManager({ rootDir: root, logger, eventBus: new EventBus(),
    binaryResolver: { resolveDefault: forbidden("binary resolution") } as never,
    settings: { getOpenCodeServerConnections: () => connections, getOwner: forbidden("host settings"),
      disposeOpenCodeServers: async () => {} } as never,
    sharedService: { endpoint: forbidden("local endpoint"), client: forbidden("local client"), headers: forbidden("local headers"),
      validateLocation: forbidden("local location"), subscribe: forbidden("local subscribe"), shutdown: async () => {} },
  })
  t.after(() => manager.shutdown())
  const workspace = (await manager.create(directory, undefined, { serverId: connection.serverId })).workspace
  assert.deepEqual(workspace.binding, { serverId: connection.serverId, directory })
  // prototype-1236: native Git reads are available; host Git integrations stay refused below.
  assert.throws(() => manager.requireWorkspaceCapability(workspace.id, "worktrees"), { code: "explicit_capability_unavailable" })
  // Only the positive local control is synthetic. Explicit descriptors and their
  // immutable bindings still come from the real owner, online and offline.
  const get = manager.get.bind(manager)
  t.mock.method(manager, "get", (id: string) => id === "local-control"
    ? { ...workspace, id, binding: { serverId: "local-shared", directory } } : get(id))
  const store = new PanelExtensionStore(path.join(root, "extensions"))
  const pkg = await readPanelExtensionArchive(fixtureArchive("<p>Work items</p>", {
    apiVersion: 3, permissions: ["session.context", "repository.workItems.read"],
  }))
  await store.install(pkg)
  await store.activate(pkg.manifest.id, pkg.digest, true)
  const surface = await startRemoteSurface(t, { panelExtensions: { store, workspaceManager: manager } })
  const login = await send(surface.local, "/api/auth/login", { username: "codenomad", password: "local-password" })
  assert.equal(login.status, 200)
  assert.ok(login.cookie)
  const paired = await send(surface.target(), "/api/remote-control/pair", { code: surface.code }, { origin: ORIGIN })
  assert.equal(paired.status, 200)
  assert.ok(paired.cookie)
  const localHeaders = { cookie: login.cookie }, remoteHeaders = { cookie: paired.cookie, origin: ORIGIN }
  const invoke = (method: typeof METHODS[number], extra = {}, encoded = false, target = surface.local, headers: Record<string, string> = localHeaders) =>
    send(target, `/${encoded ? "%61pi" : "api"}/panel-extensions/${encoded ? pkg.manifest.id.replace(".", "%2E") : pkg.manifest.id}/${method}`,
      { instanceId: workspace.id, digest: pkg.digest, kind: "issue",
        ...(method === "workItems" ? { query: "", page: 1, fresh: false } : { number: 7 }), ...extra }, headers)

  await t.test("local positive controls prove interception and warm both page and repository caches", async () => {
    for (const method of METHODS) {
      const response = await invoke(method, { instanceId: "local-control" })
      assert.equal(response.status, 200)
      if (method === "workItems") assert.equal(response.body.status, "ok")
      else assert.deepEqual(response.body, { url: "https://github.com/fixture/repository/issues/7" })
      assert.equal((await invoke(method, { instanceId: "local-control" }, true, surface.target(), remoteHeaders)).status, 200)
    }
    assert.deepEqual(entries, ["list", "list", "itemUrl", "itemUrl"])
    assert.deepEqual(discoveries, [directory], "positive control reached the pre-Git interception exactly once")
    assert.equal(forgeReads.length, 1, "the real page cache reused the synthetic forge read")
    entries.length = discoveries.length = forgeReads.length = 0
  })
  await t.test("auth, digest, disabled permission and missing workspace retain their refusal semantics", async () => {
    for (const encoded of [false, true]) for (const method of METHODS) {
      assert.equal((await invoke(method, {}, encoded, surface.local, {})).status, 401)
      assert.equal((await invoke(method, { digest: "a".repeat(64) }, encoded)).status, 409)
      for (const instanceId of ["missing-workspace", "global", "local-shared"]) {
        assert.equal((await invoke(method, { instanceId }, encoded)).status, 404)
      }
      assert.equal((await invoke(method, { instanceId: undefined }, encoded)).status, 400)
      await store.activate(pkg.manifest.id, pkg.digest, false)
      assert.equal((await invoke(method, {}, encoded)).status, 403)
      await store.activate(pkg.manifest.id, pkg.digest, true)
      assert.deepEqual(entries, [])
    }
  })
  for (const offline of [false, true]) {
    connected = !offline
    for (const encoded of [false, true]) for (const method of METHODS) {
      await t.test(`${method}: encoded=${encoded}, offline=${offline}, warm caches never admit explicit host access`, async () => {
        for (const [target, headers] of [[surface.local, localHeaders], [surface.target(), remoteHeaders]] as const) {
          for (const extra of method === "workItems" ? [{ fresh: false }, { fresh: true }] : [{}]) {
            const response = await invoke(method, extra, encoded, target, headers)
            assert.deepEqual({ status: response.status, body: response.body }, { status: 403, body: DENIED })
          }
          assert.deepEqual(entries, [], "refuse before list/itemUrl, even their warm caches")
          assert.deepEqual(discoveries, [])
          assert.deepEqual(forgeReads, [])
        }
      })
    }
  }
  await t.test("native Git availability never grants host Git integration authority", async () => {
    connected = true
    const capabilities = ExplicitWorkspace.prototype.capabilities
    t.mock.method(ExplicitWorkspace.prototype, "capabilities", function (this: ExplicitWorkspace) {
      const value = capabilities.call(this)
      value.features.git = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
      return value
    })
    assert.doesNotThrow(() => manager.requireWorkspaceCapability(workspace.id, "git"))
    assert.equal(manager.get(workspace.id)?.capabilities?.features.git.state, "available")
    for (const method of METHODS) {
      const response = await invoke(method)
      assert.deepEqual({ status: response.status, body: response.body }, { status: 403, body: DENIED })
    }
    assert.deepEqual(entries, [])
  })
  await t.test("Remote Control keeps pairing, Origin and host-only gates ahead of both encoded routes", async () => {
    for (const encoded of [false, true]) for (const method of METHODS) {
      assert.equal((await invoke(method, {}, encoded, surface.target(), { origin: ORIGIN })).status, 401)
      assert.equal((await invoke(method, {}, encoded, surface.target(), { cookie: paired.cookie! })).status, 403)
      assert.equal((await invoke(method, {}, encoded, surface.target(), { cookie: paired.cookie!, origin: "https://other.tunnel.test" })).status, 403)
    }
    assert.equal((await send(surface.target(), "/%61pi/remote-control/devices", undefined, remoteHeaders)).status, 404)
    const echo = await send(surface.target(), "/api/test/echo", undefined, remoteHeaders)
    assert.equal(echo.status, 200)
    assert.equal(echo.body.loopbackPrivileges, false)
    assert.deepEqual(entries, [])
  })
  await t.test("profile metadata, API 1 context and API 4 preferences remain accessible", async () => {
    const context = await readPanelExtensionArchive(fixtureArchive("<p>Context only</p>", { id: "example.context" }))
    const preferences = await readPanelExtensionArchive(fixtureArchive("<p>Preferences</p>", {
      id: "example.preferences", apiVersion: 4, permissions: ["session.context", "panel.preferences"],
    }))
    for (const entry of [context, preferences]) {
      await store.install(entry)
      await store.activate(entry.manifest.id, entry.digest, true)
    }
    assert.equal((await send(surface.local, "/api/panel-extensions", undefined, localHeaders)).status, 200)
    const panel = await send(surface.local, `/api/panel-extensions/${context.manifest.id}/panel?instanceId=${workspace.id}&digest=${context.digest}`, undefined, localHeaders)
    assert.deepEqual({ status: panel.status, body: panel.body }, { status: 200, body: { html: "<p>Context only</p>" } })
    const value = await send(surface.local, `/api/panel-extensions/${preferences.manifest.id}/preferencesGet`,
      { instanceId: workspace.id, digest: preferences.digest }, localHeaders)
    assert.deepEqual({ status: value.status, body: value.body }, { status: 200, body: { status: "ok", value: {} } })
    assert.deepEqual(entries, [])
  })
  assert.deepEqual(hostEffects, [])
  assert.deepEqual(discoveries, [])
  assert.deepEqual(forgeReads, [])
  assert.deepEqual(attachmentReads, ["/api/location", "/api/fs/list"], "routes never acquire the execution target")
})
