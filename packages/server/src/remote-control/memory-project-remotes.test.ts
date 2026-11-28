import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import { once } from "node:events"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { CodeNomadServerCredentials } from "../codenomad-servers/credentials"
import { RELAY_AUTHORITY_HEADER as AUTHORITY, RELAY_BOOTSTRAP } from "../codenomad-servers/relay-authority"
import { resolveConfigLocation } from "../config/location"
import { CODENOMAD_API_CONTRACT } from "../meta-contract"
import type { MemoryEntry } from "../memory/model"
import { resolveMemoryProjectIdentity } from "../memory/project-identity"
import { MemoryStore } from "../memory/store"
import { SettingsService } from "../settings/service"
import { resolveHttpsOptions } from "../server/tls"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

const HTTPS = "https://project-memory.test"
const LAN = "http://project-memory-lan.test"
const RC = `https://${FAKE_TUNNEL_HOST}`
const WORKSPACE = "same-workspace"
const ENTRY = "same-entry"
const SESSION = "same-session"
const logger = { child() { return this }, warn() {}, info() {}, debug() {}, error() {} }
type Caller = { target: string; headers: Record<string, string>; ca?: string }

function call(caller: Caller, pathname: string, method = "GET", payload?: unknown, headers: Record<string, string> = {}) {
  const target = new URL(caller.target.includes("://") ? caller.target : `http://${caller.target}`)
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = (target.protocol === "https:" ? https : http).request({ hostname: target.hostname, port: target.port,
      path: pathname, method, agent: false, ca: caller.ca,
      headers: { ...caller.headers, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers } }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk })
      response.on("error", reject)
      response.on("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }))
    })
    request.setTimeout(10_000, () => request.destroy(new Error("Project memory request timed out")))
    request.on("error", reject)
    request.end(payload === undefined ? undefined : JSON.stringify(payload))
  })
}

test("real A/B project memory retains destination ownership, revisions and cleanup eligibility over RC/HTTPS/LAN", { timeout: 180_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-memory-project-remotes-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const settingsAt = (name: string) => {
    const directory = path.join(root, name)
    fs.mkdirSync(directory)
    const location = resolveConfigLocation(directory)
    fs.writeFileSync(location.configYamlPath, "server:\n  memoryEnabled: true\nui:\n  settings:\n    multiBackend: true\n")
    return { directory, location, settings: new SettingsService(location, undefined, logger as never) }
  }
  const destinations: Array<{ id: string; directory: string; store: MemoryStore;
    namespace: { scope: "project"; projectId: string }; surface: Awaited<ReturnType<typeof startRemoteSurface>>;
    config: ReturnType<typeof settingsAt>; logins(): number; requests: http.IncomingHttpHeaders[] }> = []
  for (const id of ["A", "B"]) {
    const config = settingsAt(id)
    const project = path.join(config.directory, "project")
    fs.mkdirSync(project)
    const directory = fs.realpathSync(project)
    const store = new MemoryStore(config.directory)
    const identity = await resolveMemoryProjectIdentity({ directory })
    const namespace = { scope: "project" as const, projectId: identity.id }
    const serverId = config.settings.getServerId()
    assert.ok(serverId)
    let logins = 0
    const requests: http.IncomingHttpHeaders[] = []
    const surface = await startRemoteSurface(t, {
      settings: config.settings, memoryStore: store, password: "local-password",
      serverIdentity: { serverId, apiContract: CODENOMAD_API_CONTRACT },
      workspaceManager: {
        get: (workspaceId: string) => workspaceId === WORKSPACE ? { id: WORKSPACE, path: directory } : undefined,
        list: () => [{ id: WORKSPACE, path: directory }],
        getServiceDirectoryForPath: async (workspaceId: string, requested: string) =>
          workspaceId === WORKSPACE && requested === directory ? directory : undefined,
        getServiceWslDistro: () => undefined,
      },
      configureApp: app => app.addHook("onRequest", (request, _reply, done) => {
        if (request.url === "/api/auth/login") logins++
        if (request.url.startsWith("/api/memory")) requests.push({ ...request.headers })
        done()
      }),
    })
    destinations.push({ id, directory, store, namespace, surface, config, logins: () => logins, requests })
  }
  assert.notEqual(destinations[0]!.namespace.projectId, destinations[1]!.namespace.projectId)
  const host = settingsAt("host")
  fs.writeFileSync(host.location.stateYamlPath, JSON.stringify({ ui: { remoteServers: destinations.map(destination => ({
    id: destination.id, baseUrl: `http://${destination.surface.local}`, skipTlsVerify: false,
  })) } }))
  const credentials = new CodeNomadServerCredentials(path.join(host.directory, "remote-server-credentials.json"))
  for (const destination of destinations) credentials.set(destination.id, `http://${destination.surface.local}`, {
    kind: "password", username: "codenomad", password: "local-password",
  })
  const surface = await startRemoteSurface(t, { settings: host.settings, bindHost: "0.0.0.0", allowedOrigins: [HTTPS, LAN] })
  const tls = resolveHttpsOptions({ enabled: true, configDir: host.directory, host: new URL(HTTPS).hostname, logger: logger as never })!
  const proxy = https.createServer(tls.httpsOptions, (request, response) => {
    const upstream = http.request(`http://${surface.local}`, {
      path: request.url, method: request.method, headers: request.headers,
    }, reply => { response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response) })
    upstream.on("error", error => response.destroy(error))
    request.pipe(upstream)
  })
  proxy.listen(0, "127.0.0.1")
  await once(proxy, "listening")
  t.after(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())) })
  const httpsTarget = `https://localhost:${(proxy.address() as { port: number }).port}`
  const ca = fs.readFileSync(tls.caCertPath!, "utf8")
  const paired = await call({ target: surface.target(), headers: { host: FAKE_TUNNEL_HOST, origin: RC } },
    "/api/remote-control/pair", "POST", { code: surface.code })
  assert.equal(paired.status, 200, paired.body)
  const address = Object.values(os.networkInterfaces()).flat().find(value => value?.family === "IPv4" && !value.internal)?.address
  assert.ok(address, "a real non-loopback interface is required")
  const sessionCookie = () => `${surface.authManager.getCookieName()}=${surface.authManager.createSession("codenomad").id}`
  const callers: Array<[string, Caller]> = [
    ["RC", { target: surface.target(), headers: { host: FAKE_TUNNEL_HOST, origin: RC,
      cookie: paired.headers["set-cookie"]![0]!.split(";")[0]! } }],
    ["HTTPS", { target: httpsTarget, ca, headers: { host: new URL(HTTPS).host, origin: HTTPS, cookie: sessionCookie() } }],
    ["LAN", { target: `${address}:${new URL(`http://${surface.local}`).port}`,
      headers: { host: new URL(LAN).host, origin: LAN, cookie: sessionCookie() } }],
  ]
  for (const [channel, caller] of callers) await t.test(channel, async () => {
    const proofs = new Map<string, Record<string, string>>()
    for (const destination of destinations) {
      const entry: MemoryEntry = { id: ENTRY, sessionId: SESSION, title: "Project command", type: "fact",
        text: `${destination.id} ${channel} original`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
      await destination.store.mutate(destination.namespace, () => ({ kind: "save", entry, result: undefined }))
      const bootstrap = await call(caller, `/api/backends/${destination.id}/api/meta`, "GET", undefined, { [AUTHORITY]: RELAY_BOOTSTRAP })
      assert.equal(bootstrap.status, 200, bootstrap.body)
      assert.equal(JSON.parse(bootstrap.body).serverId, destination.config.settings.getServerId())
      const proof = String(bootstrap.headers[AUTHORITY])
      assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
      proofs.set(destination.id, { [AUTHORITY]: proof })
    }
    for (const destination of destinations) {
      const prefix = `/api/backends/${destination.id}/api/memory`
      const proof = proofs.get(destination.id)!
      const context = { workspaceId: WORKSPACE, directory: destination.directory }
      const ui = (operation: object, selectedContext: object = context) => call(caller, prefix, "POST", { operation, context: selectedContext }, proof)
      const listed = await ui({ action: "list", scope: "project" })
      assert.equal(listed.status, 200, listed.body)
      const snapshot = JSON.parse(listed.body)
      assert.equal(snapshot.scopeKey, destination.namespace.projectId)
      assert.equal(snapshot.cleanupWritable, true, "Tidy up eligibility comes from the destination's real Git/filesystem probe")
      assert.equal(snapshot.cleanupDirectory, destination.directory)
      assert.equal(snapshot.entries.length, 1)
      const displayed = snapshot.entries[0]
      assert.equal(displayed.id, ENTRY)
      assert.equal(displayed.sessionId, SESSION)
      assert.equal(displayed.text, `${destination.id} ${channel} original`)
      const read = await ui({ action: "read", scope: "project", query: ENTRY })
      assert.equal(read.status, 200, read.body)
      assert.deepEqual(JSON.parse(read.body).entry, displayed)
      const other = destinations.find(value => value.id !== destination.id)!
      for (const badContext of [
        { workspaceId: WORKSPACE, directory: other.directory }, { workspaceId: "missing" },
        { workspaceId: WORKSPACE, directory: destination.directory, projectId: destination.namespace.projectId },
      ]) {
        const refused = await ui({ action: "list", scope: "project" }, badContext)
        assert.equal(refused.status, 400, refused.body)
        assert.equal(JSON.parse(refused.body).code, "invalid")
      }
      const badSchema = await ui({ action: "list", scope: "project", projectId: destination.namespace.projectId })
      assert.equal(badSchema.status, 400, badSchema.body)
      assert.equal(JSON.parse(badSchema.body).code, "invalid")
      const invalidSettings = await call(caller, `${prefix}/settings`, "PUT", { enabled: true, unexpected: true }, proof)
      assert.equal(invalidSettings.status, 400, invalidSettings.body)
      const edited = await ui({ action: "save", scope: "project", id: ENTRY, revision: displayed.revision,
        content: { title: displayed.title, type: displayed.type, text: `${destination.id} ${channel} edited` } })
      assert.equal(edited.status, 200, edited.body)
      assert.notEqual(JSON.parse(edited.body).revision, displayed.revision)
      assert.equal((await ui({ action: "delete", scope: "project", id: ENTRY, revision: displayed.revision })).status, 409)
      const fresh = JSON.parse((await ui({ action: "read", scope: "project", query: ENTRY })).body).entry
      assert.equal(fresh.text, `${destination.id} ${channel} edited`)
      assert.equal(fresh.sessionId, SESSION)
      assert.equal((await destination.store.listForUI(destination.namespace))[0]!.text, fresh.text)
      const otherEntries = await other.store.listForUI(other.namespace)
      assert.equal(otherEntries.some(value => value.text === fresh.text), false, "identical IDs never cross destination stores")
      const forgotten = await ui({ action: "delete", scope: "project", id: ENTRY, revision: fresh.revision })
      assert.equal(forgotten.status, 200, forgotten.body)
      assert.deepEqual(await destination.store.listForUI(destination.namespace), [])
      const afterDelete = JSON.parse((await ui({ action: "list", scope: "project" })).body)
      assert.deepEqual(afterDelete.entries, [])
      assert.equal(afterDelete.cleanupWritable, false)
      assert.equal(afterDelete.cleanupDirectory, destination.directory)
    }
    for (const destination of destinations) for (const headers of destination.requests) {
      assert.equal(headers[AUTHORITY], undefined)
      assert.equal(headers.origin, undefined)
      assert.notEqual(headers.cookie, caller.headers.cookie)
      assert.ok(headers.cookie, "the destination requires its privately authenticated session")
    }
  })
  for (const destination of destinations) assert.ok(destination.logins() > 0, `${destination.id} used its real private password login`)
})
