// C3A read-only qualification: real isolated OpenCode, npm registry, controls/catalog,
// consent store, Fastify routes, native binding registry and local production SSE relay.
// Run: node --import tsx scripts/test-panel-extension-bundles-native.mjs <absolute-cli-executable>
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import Fastify from "fastify"
import pino from "pino"
import { writeFakeIntegrationPackage, startFakeHost, assertNoSentinels } from "./fixtures/fake-integration/index.mjs"
import { startFakeNpmRegistry } from "./fixtures/fake-npm-registry.mjs"
import { fixtureEnvironment, withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { IntegrationCatalogSource } from "../packages/server/src/opencode/integrations/catalog.ts"
import { catalogEntry, catalogOf } from "../packages/server/src/opencode/integrations/catalog-fixture.ts"
import { IntegrationsReader } from "../packages/server/src/opencode/integrations/integrations.ts"
import { IntegrationAttachments } from "../packages/server/src/opencode/integrations/attachments.ts"
import { PanelExtensionStore } from "../packages/server/src/panel-extensions/store.ts"
import { fixtureArchive } from "../packages/server/src/panel-extensions/archive-fixture.ts"
import { readPanelExtensionArchive } from "../packages/server/src/panel-extensions/archive.ts"
import { registerPanelExtensionBundlesRoutes } from "../packages/server/src/server/routes/panel-extension-bundles.ts"
import { registerRequestLogging } from "../packages/server/src/server/request-logging.ts"
import { EventBus } from "../packages/server/src/events/bus.ts"
import { ClientConnectionManager } from "../packages/server/src/clients/connection-manager.ts"
import { InstanceEventBridge } from "../packages/server/src/workspaces/instance-events.ts"
import { nativeEventConnections } from "../packages/server/src/workspaces/opencode-service.ts"
import { registerEventRoutes } from "../packages/server/src/server/routes/events.ts"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli) || !await stat(cli).then(value => value.isFile(), () => false)) {
  console.error("BLOCKED: pass an existing absolute isolated OpenCode executable; no daemon was started")
  process.exitCode = 2
} else {
  const registry = await startFakeNpmRegistry(), host = await startFakeHost({ leaky: true })
  const check = (value, label) => assertNoSentinels(value, { port: host.port }, label)
  let fixtureRoot
  try {
    await withProductRuntime(cli, async ({ root, configDirectory }) => {
      fixtureRoot = root
      const env = await fixtureEnvironment(root)
      // No Blender is launched. Even packaging children get private resource roots.
      for (const key of ["BLENDER_SYSTEM_SCRIPTS", "BLENDER_SYSTEM_DATAFILES", "BLENDER_SYSTEM_PYTHON"]) {
        env[key] = path.join(root, key); await mkdir(env[key], { recursive: true })
      }
      const packages = []
      for (const id of ["fixture", "missing"]) {
        const staging = path.join(root, `pack-${id}`), directory = path.join(staging, "package")
        const pkg = await writeFakeIntegrationPackage(directory, { id })
        if (id === "missing") {
          const file = path.join(directory, "index.js"), source = await readFile(file, "utf8")
          assert(source.includes("const registration = await ctx.rpc.register"))
          await writeFile(file, source.replace("const registration = await ctx.rpc.register",
            "delete definition.methods.bindingRead; delete rpc.handlers.bindingRead; const registration = await ctx.rpc.register"))
        }
        const tarball = path.join(root, `${id}.tgz`)
        await promisify(execFile)("tar", ["-czf", tarball, "-C", staging, "package"], { env, cwd: root, windowsHide: true, timeout: 5_000 })
        registry.publish(pkg.name, pkg.version, await readFile(tarball)); packages.push(`${pkg.name}@${pkg.version}`)
      }
      await writeFile(path.join(configDirectory, "opencode.jsonc"), JSON.stringify({ plugins: packages }))
      return {}
    }, async ({ client, root, connection, env }) => {
      for (const key of ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
        assert(!path.relative(root, env[key]).startsWith(".."), `${key} remains inside fixture`)
      }
      const location = root, other = path.join(root, "other-project")
      await mkdir(other)
      const nativeLocation = await client.location.get({ location: { directory: location } })
      const otherLocation = await client.location.get({ location: { directory: other } })
      const owned = directory => directory === nativeLocation.directory || directory === otherLocation.directory
      const logs = [], calls = [], relayed = [], nativeEvents = [], sseFrames = []
      const logger = pino({ level: "trace" }, { write: line => logs.push(line) })
      const recorded = { ...connection, client: { ...client, rpc: { ...client.rpc, call: (request, options) => {
        calls.push({ method: request.method, rpcID: request.rpcID, input: request.input })
        return client.rpc.call(request, options)
      } } } }
      const records = [{ id: "fixture", path: nativeLocation.directory }]
      const manager = {
        get: id => records.find(record => record.id === id), list: () => records,
        getSharedServiceConnection: async () => recorded,
        getSharedServiceClient: async () => client,
        getServiceDirectoryForPath: async (_id, directory) => owned(directory) ? directory : undefined,
        ownsLocation: async (id, candidate) => id === "fixture" && candidate.workspaceID === undefined && owned(candidate.directory),
        ownsDirectory: async (_id, directory) => owned(directory),
        getWorktreeIdentityForPath: async (_id, directory) => owned(directory) ? directory : undefined,
        getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
        getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, directory) => directory,
        invalidateWorktrees() {},
        subscribeToSharedService: async signal => (async function* () {
          for await (const event of client.event.subscribe({ signal })) {
            check(event, "native event"); nativeEvents.push(event); nativeEventConnections.set(event, connection); yield event
          }
        })(),
      }
      let origin
      const catalogServer = createServer((request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(request.url === "/releases" ? [{ tag_name: "catalog-v1", draft: false, prerelease: false,
          assets: [{ name: "catalog.json", id: 1, updated_at: "2026-10-31T00:00:00Z", url: `${origin}/catalog` }] }]
          : catalogOf(catalogEntry("fixture"), catalogEntry("missing"))))
      })
      await new Promise(resolve => catalogServer.listen(0, "127.0.0.1", resolve))
      origin = `http://127.0.0.1:${catalogServer.address().port}`
      const catalog = new IntegrationCatalogSource({ releasesUrl: `${origin}/releases`, stateFile: path.join(root, "catalog.json"), logger, timeoutMs: 2_000 })
      const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger })
      const integrations = new IntegrationsReader({ controls, workspaceManager: manager, catalog, timeoutMs: 2_000 })
      const attachments = new IntegrationAttachments({ controls, workspaceManager: manager, catalog, timeoutMs: 2_000 })
      const store = new PanelExtensionStore(path.join(root, "panel-extensions"))
      const pkg = await readPanelExtensionArchive(fixtureArchive("<p>Bundles native fixture</p>", { apiVersion: 4,
        permissions: ["session.context", "bundles.read", "bundles.manage"] }))
      await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
      const bus = new EventBus(logger), connections = new ClientConnectionManager(logger)
      const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
      const unsubscribe = bus.onEvent(event => { check(event, "production relay"); relayed.push(event) })
      const app = Fastify({ logger: false })
      registerRequestLogging(app, logger)
      app.addHook("onRequest", async request => { request.log = logger })
      registerPanelExtensionBundlesRoutes(app, { store, workspaceManager: manager, catalog, integrations, attachments, routeBudgetMs: 5_000 })
      registerEventRoutes(app, { eventBus: bus, connectionManager: connections, logger, registerClient: () => () => {} })
      const base = await app.listen({ host: "127.0.0.1", port: 0 }), controller = new AbortController()
      let streamTask
      const post = async (method, sessionID, fields = {}, expected = 200) => {
        const response = await fetch(`${base}/api/panel-extensions/${pkg.manifest.id}/bundles/${method}`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ instanceId: "fixture", digest: pkg.digest, sessionID, ...fields }),
          signal: AbortSignal.timeout(7_000) })
        const text = await response.text(); check(text, "panel HTTP")
        assert.equal(response.status, expected, `bundles/${method}: ${text}`)
        if (expected !== 404) assert.equal(response.headers.get("cache-control"), "no-store")
        return JSON.parse(text)
      }
      const rpc = async (method, input) => (await client.rpc.call({ rpcID: "neuralnomads.fixture", method, input,
        location: { directory: nativeLocation.directory } }, { signal: AbortSignal.timeout(3_000) })).output
      try {
        const first = await client.session.create({ location: { directory: nativeLocation.directory }, title: "Displayed" })
        const foreign = await client.session.create({ location: { directory: otherLocation.directory }, title: "FOREIGN_PROJECT_DOCUMENT_SENTINEL" })
        // Readiness is bounded and only inspects the fixture daemon.
        for (const deadline = Date.now() + 30_000; ;) {
          const state = await post("state", first.id)
          if (state.integrations.every(item => item.state === "ok")) break
          assert(Date.now() < deadline, "Fixture integration loading deadline"); await delay(100)
        }
        const catalogue = await post("catalog", first.id)
        assert.equal(catalogue.state, "fresh")
        assert(catalogue.integrations.every(item => !item.rpc && !item.plugin && !item.sources && !item.package))
        bus.publish({ type: "workspace.started", workspace: records[0] })
        const stream = await fetch(`${base}/api/events?clientId=c3a&connectionId=c3a`, { signal: controller.signal })
        assert.equal(stream.status, 200)
        streamTask = (async () => {
          const decoder = new TextDecoder(); let pending = ""
          for await (const chunk of stream.body) {
            pending += decoder.decode(chunk, { stream: true })
            let end
            while ((end = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, end); pending = pending.slice(end + 2)
              check(frame, "local SSE"); sseFrames.push(frame)
            }
          }
        })().catch(error => { if (!controller.signal.aborted) throw error })
        // Ensure the native subscription is live before generating integration notifications.
        for (const deadline = Date.now() + 5_000; !nativeEvents.length;) {
          assert(Date.now() < deadline, "Native stream readiness deadline"); await delay(20)
        }
        assert.deepEqual(await rpc("advertise", host.advertiseInput()), { outcome: "accepted" })
        const hosts = await post("hosts", first.id, { integration: "fixture" })
        assert.equal(hosts.offers.length, 1)
        assert.deepEqual(await rpc("attachHost", { offerID: hosts.offers[0].offerID, sessionID: foreign.id }), { outcome: "attached" })
        const before = calls.length
        const displayed = await post("state", first.id), foreignState = await post("state", foreign.id)
        const item = state => state.integrations.find(entry => entry.id === "fixture")
        assert.deepEqual(item(displayed).attachment, { state: "none" }, "A foreign-only binding is never an aggregate attached state")
        assert.deepEqual(item(displayed).status.connection, { offers: 1 })
        assert.deepEqual(item(foreignState).attachment, { state: "attached", label: hosts.offers[0].label })
        for (const state of [displayed, foreignState]) {
          assert.deepEqual(state.integrations.find(entry => entry.id === "missing").attachment, { state: "unknown" }, "Real absent native bindingRead is unknown")
          const text = JSON.stringify(state)
          for (const forbidden of [first.id, foreign.id, "FOREIGN_PROJECT_DOCUMENT_SENTINEL", "authority", "serviceGeneration", "registryGeneration", "attachedSessions", "ownerProof"])
            assert(!text.includes(forbidden), `Projection omits ${forbidden}`)
        }
        const readCalls = calls.slice(before)
        assert(readCalls.every(call => ["status", "bindingRead"].includes(call.method)))
        assert.deepEqual(new Set(readCalls.filter(call => call.method === "bindingRead").map(call => call.input.sessionID)), new Set([first.id, foreign.id]))
        for (const method of ["request", "setActive", "installHost", "attach", "detach"]) await post(method, first.id, { integration: "fixture" }, 404)
        await post("state", first.id, { rpcID: "neuralnomads.arbitrary" }, 400)
        await store.activate(pkg.manifest.id, pkg.digest, false)
        await post("state", first.id, {}, 403)
        for (const deadline = Date.now() + 5_000; !sseFrames.some(frame => frame.includes("status_changed"));) {
          assert(Date.now() < deadline, "Native status_changed must cross real local SSE"); await delay(20)
        }
        check([logs, relayed, nativeEvents, sseFrames], "captured logs/events")
        const logRecords = logs.map(line => JSON.parse(line))
        assert(logRecords.some(record => record.level === 20 && record.msg === "HTTP request completed"))
        assert(logRecords.some(record => record.level === 10 && record.msg === "HTTP request payload"))
        console.log("PASS C3A native: real catalog/controls/routes/consent, two sessions, foreign-only none, absent bindingRead unknown, no mutation routes; host sentinels absent from HTTP, DEBUG/TRACE, native/relay/local SSE")
      } finally {
        controller.abort(); bridge.shutdown(); unsubscribe(); connections.shutdown()
        await streamTask
        await app.close()
        catalogServer.closeAllConnections(); await new Promise(resolve => catalogServer.close(resolve))
      }
    }, { registry: registry.url })
    check(await readFile(path.join(fixtureRoot, "daemon.log"), "utf8"), "fixture daemon log")
    console.log("PASS C3A fixture daemon log confidentiality; read-only slice only, management and renderer acceptance remain separate")
  } finally { await host.close(); await registry.close() }
}
