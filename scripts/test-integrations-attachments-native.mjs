// C4: real Fastify routes, native sessions/RPC/events, the production relay and read store,
// plus the Blender pilot. Run with: node --import tsx scripts/test-integrations-attachments-native.mjs
// <absolute OpenCode 2.2.5 executable> [pilot checkout] [Blender executable].
// All children have allowlisted/private environments. AC-B4 remains a separate manual check.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import { assertNoSentinels, FAKE_INTEGRATION_SENTINELS, startFakeHost, writeFakeIntegrationPackage } from "./fixtures/fake-integration/index.mjs"
import { fixtureEnvironment, withProductRuntime, writeFixtureServiceRegistration } from "./native-product-fixture.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"
import { EventBus } from "../packages/server/src/events/bus.ts"
import { ClientConnectionManager } from "../packages/server/src/clients/connection-manager.ts"
import { InstanceEventBridge } from "../packages/server/src/workspaces/instance-events.ts"
import { nativeEventConnections } from "../packages/server/src/workspaces/opencode-service.ts"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { IntegrationCatalogSource } from "../packages/server/src/opencode/integrations/catalog.ts"
import { catalogEntry, catalogOf } from "../packages/server/src/opencode/integrations/catalog-fixture.ts"
import { IntegrationsReader } from "../packages/server/src/opencode/integrations/integrations.ts"
import { IntegrationAttachments } from "../packages/server/src/opencode/integrations/attachments.ts"
import { INTEGRATION_ATTACHMENT_METADATA_KEY as Q8 } from "../packages/server/src/integration-types.ts"
import { registerIntegrationRoutes } from "../packages/server/src/server/routes/integrations.ts"
import { registerIntegrationAttachmentRoutes } from "../packages/server/src/server/routes/integration-attachments.ts"
import { registerEventRoutes } from "../packages/server/src/server/routes/events.ts"
import { registerRequestLogging } from "../packages/server/src/server/request-logging.ts"
import { createIntegrationsStore, isIntegrationRefreshEvent } from "../packages/ui/src/stores/integrations-store.ts"

const pilot = path.resolve(process.argv[3] ?? "D:/opencode_bundles-work/opencode-integrations")
const blender = process.argv[4] ?? "D:/build_windows_Release_x64_vc17_Release/bin/Release/blender.exe"
const plugin = path.join(pilot, "integrations/blender/plugin")
const host = await startFakeHost({ leaky: true })
const secretOptions = { port: host.port }
const check = (value, label) => assertNoSentinels(value, secretOptions, label)
let fixtureRoot

async function until(label, probe, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(20)
  }
  throw new Error(`Timed out: ${label}`)
}

// Keep child output private even on failure: native errors can include secret-bearing inputs.
async function command(file, args, env, cwd) {
  const child = spawn(file, args, { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk })
  child.stderr.on("data", chunk => { output += chunk })
  const stopped = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject) })
  const timer = setTimeout(() => child.kill(), 30_000)
  try { return { code: await stopped, output } } finally { clearTimeout(timer) }
}

async function scanLogs(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await scanLogs(file)
    else if (entry.name.endsWith(".log")) check(await readFile(file, "utf8"), "fixture log")
  }
}

try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
    fixtureRoot = root
    const env = await fixtureEnvironment(root)
    assert.equal((await command("git", ["merge-base", "--is-ancestor", "2a3d1b0", "HEAD"], env, pilot)).code, 0,
      "The Blender pilot includes the reviewed fix")
    await readFile(path.join(plugin, "dist/index.js"))
    await access(blender)
    const fake = await writeFakeIntegrationPackage(path.join(root, "fake-integration"))
    await writeFile(path.join(configDirectory, "opencode.jsonc"), JSON.stringify({
      plugins: [{ package: fake.directory, options: {} }, { package: plugin, options: {} }],
    }))
    return {}
  }, async ({ root, env, connection: fixtureConnection }) => {
    // The product fixture bounds ordinary HTTP calls at 30s. A live event stream instead
    // lasts until subscriber cancellation, like the production shared-service transport.
    const client = OpenCode.make({ baseUrl: fixtureConnection.endpoint.url,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${fixtureConnection.endpoint.auth.password}`).toString("base64")}` },
      fetch: (input, init) => new URL(input instanceof Request ? input.url : input).pathname === "/api/event"
        ? fetch(input, init) : fixtureConnection.fetch(input, init),
    })
    const connection = { ...fixtureConnection, client }
    const info = await client.server.info()
    assert.equal(info.version, "2.2.5", "C4 qualifies the requested native binary")
    console.log(`Native runtime: ${info.version}`)
    await writeFixtureServiceRegistration(env, { ...info, url: connection.endpoint.url, password: connection.endpoint.auth.password })
    const location = (await client.location.get({ location: { directory: root } })).directory
    const other = path.join(root, "other-owned-location")
    const foreign = path.join(root, "unowned-location")
    await mkdir(other)
    await mkdir(foreign)
    const owned = directory => directory === location || directory === other
    const records = [{ id: "fixture", path: location }, { id: "foreign", path: foreign }]
    const calls = [], logs = [], relayed = [], native = [], sseEvents = []
    const logger = Object.fromEntries(["debug", "info", "warn", "error", "trace"].map(level =>
      [level, (...args) => logs.push({ level, args })]))
    logger.isLevelEnabled = () => true
    const recorded = { ...connection, client: { ...client, rpc: { ...client.rpc, call: (request, options) => {
      calls.push({ method: request.method, rpcID: request.rpcID })
      return client.rpc.call(request, options)
    } } } }
    let subscriptionCount = 0
    const manager = {
      get: id => records.find(record => record.id === id), list: () => records,
      getSharedServiceConnection: async () => recorded, getSharedServiceClient: async () => client,
      getServiceDirectoryForPath: async (id, directory) => id === "fixture" && owned(directory) ? directory : undefined,
      ownsLocation: async (id, candidate) => id === "fixture" && candidate.workspaceID === undefined && owned(candidate.directory),
      ownsDirectory: async (id, directory) => id === "fixture" ? owned(directory) : directory === foreign,
      getWorktreeIdentityForPath: async (_id, directory) => owned(directory) ? directory : undefined,
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, directory) => directory,
      invalidateWorktrees() {},
      // Match the workspace-manager/shared-service subscriber contract; this is the real SDK iterable.
      subscribeToSharedService: async signal => (async function* () {
        subscriptionCount++
        for await (const event of client.event.subscribe({ signal })) {
          native.push(event)
          nativeEventConnections.set(event, connection)
          yield event
        }
      })(),
    }
    let catalogBase, catalogRequests = 0
    const catalogDocument = catalogOf(catalogEntry("fixture"), catalogEntry("blender"))
    const catalogServer = createServer((request, response) => {
      catalogRequests++
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(request.url === "/releases" ? [{ tag_name: "catalog-v1", draft: false, prerelease: false,
        assets: [{ name: "catalog.json", id: 1, updated_at: "2026-01-01T00:00:00Z", url: `${catalogBase}/catalog` }] }] : catalogDocument))
    })
    await new Promise(resolve => catalogServer.listen(0, "127.0.0.1", resolve))
    catalogBase = `http://127.0.0.1:${catalogServer.address().port}`
    const catalog = new IntegrationCatalogSource({ releasesUrl: `${catalogBase}/releases`, logger })
    const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger })
    const reader = new IntegrationsReader({ controls, workspaceManager: manager, catalog })
    const attachments = new IntegrationAttachments({ controls, workspaceManager: manager, catalog })
    const bus = new EventBus(logger)
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
    const connections = new ClientConnectionManager(logger)
    // Like the product, disable Fastify's URL logging. Capture the route's own content-free warnings.
    const app = Fastify({ logger: false })
    registerRequestLogging(app, logger)
    app.addHook("onRequest", async request => { request.log = logger })
    registerIntegrationRoutes(app, { integrations: reader })
    registerIntegrationAttachmentRoutes(app, { attachments })
    registerEventRoutes(app, { eventBus: bus, connectionManager: connections, logger, registerClient: () => () => {} })
    const base = await app.listen({ host: "127.0.0.1", port: 0 })
    const controller = new AbortController()
    let sseTask, release, store, blenderChild, blenderStopped, blenderOutput = ""
    const stopFile = path.join(root, "stop-blender")
    const request = async (action, { integration = "fixture", directory = location, body, query = "", expected = 200, raw } = {}) => {
      const url = `${base}/api/workspaces/fixture/integrations${action ? `/${integration}/${action}` : ""}?directory=${encodeURIComponent(directory)}${query}`
      const response = await fetch(url, { method: body !== undefined || raw !== undefined ? "POST" : "GET",
        headers: body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {},
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(15_000) })
      const text = await response.text()
      check(text, "HTTP response")
      check([...response.headers], "HTTP headers")
      assert.equal(response.status, expected, `HTTP ${action || "integrations"} status`)
      assert.equal(response.headers.get("cache-control"), "no-store")
      return JSON.parse(text)
    }
    const rpc = async (method, input = {}, directory = location) => {
      const { output } = await recorded.client.rpc.call({ rpcID: "neuralnomads.fixture", method, input, location: { directory } })
      check(output, "native RPC output")
      return output
    }
    let storeReads = 0
    const unsubscribe = bus.onEvent(event => {
      check(event, "EventBus/relay")
      if (event.type === "instance.event") {
        relayed.push({ ...event, receivedAt: performance.now() })
      }
    })
    try {
      assert.equal((await catalog.read()).state, "fresh")
      assert.equal(catalogRequests, 2, "The catalogue is read from the local release server")
      await until("both native plugins active", async () => {
        const response = await request("")
        return response.integrations.length === 2 && response.integrations.every(item => item.state === "ok")
      }, 90_000)
      bus.publish({ type: "workspace.started", workspace: records[0] })
      await until("native shared stream connected", () => relayed.some(item => item.event.type === "server.connected"))
      // Decode the actual multiplexed SSE route; these relayed frames drive the real read store.
      const stream = await fetch(`${base}/api/events?clientId=c4&connectionId=c4`, { signal: controller.signal })
      assert.equal(stream.status, 200)
      sseTask = (async () => {
        let pending = ""
        for await (const chunk of stream.body) {
          pending += new TextDecoder().decode(chunk)
          let end
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, end)
            pending = pending.slice(end + 2)
            check(frame, "SSE frame")
            const data = frame.split("\n").find(line => line.startsWith("data: "))
            if (!data) continue
            const event = JSON.parse(data.slice(6))
            sseEvents.push(event)
            if (event.type === "instance.event") store?.applyEvent(event.instanceId, event.event.type)
            if (frame.startsWith("event: codenomad.client.ping")) connections.pong({ clientId: "c4", connectionId: "c4" })
          }
        }
      })()
      void sseTask.catch(() => {})
      store = createIntegrationsStore(async (_instance, _directory, signal) => {
        signal.throwIfAborted()
        storeReads++
        return request("")
      })
      release = store.demand("fixture", location)
      await until("initial demanded read", () => store.state("fixture", location).status === "ready")
      await delay(600)
      const idle = { calls: calls.length, reads: storeReads, events: relayed.filter(item => isIntegrationRefreshEvent(item.event.type)).length }
      const quietStart = performance.now()
      await delay(60_000)
      assert(performance.now() - quietStart >= 60_000)
      assert.equal(relayed.filter(item => isIntegrationRefreshEvent(item.event.type)).length, idle.events, "Quiet interval has no invalidation events")
      assert.equal(calls.length, idle.calls, "60 seconds without events produces zero additional native RPCs")
      assert.equal(storeReads, idle.reads)
      console.log("PASS 60s event-free demand: 0 additional HTTP reads / native RPCs")

      const before = { events: relayed.length, reads: storeReads, calls: calls.length }
      const offers = Array.from({ length: 5 }, (_, index) => host.advertiseInput({ offer_key: `${FAKE_INTEGRATION_SENTINELS.offerKey}-${index}` }))
      const results = await Promise.all(offers.map(input => rpc("advertise", input)))
      assert(results.every(result => result.outcome === "accepted"))
      const burstEvents = () => relayed.slice(before.events).filter(item => item.event.type.startsWith("rpc.neuralnomads.fixture."))
      await until("10 genuine plugin events through relay", () => burstEvents().length >= 10)
      const burst = burstEvents()
      assert.equal(burst.length, 10)
      const span = burst.at(-1).receivedAt - burst[0].receivedAt
      assert(span < 300, "Ten native events arrive inside the store's 300 ms coalescing window")
      assert(burst.every(item => item.instanceId === "fixture"), "An unowned recipient gets no integration events")
      assert.equal(native.filter(event => event.type.startsWith("rpc.neuralnomads.fixture.")).length, 10)
      await until("one authoritative reread", () => storeReads === before.reads + 1 && store.state("fixture", location).status === "ready")
      await delay(700)
      assert.equal(storeReads, before.reads + 1)
      assert.equal(calls.length - before.calls, 7, "Five advertise calls plus exactly two status RPCs (one catalogue reread)")
      await until("same 10 integration events in SSE", () => sseEvents.filter(item => item.type === "instance.event" && item.event.type.startsWith("rpc.neuralnomads.fixture.")).length === 10)
      console.log(`PASS 10 genuine native events in ${Math.round(span)}ms: 1 HTTP reread / 2 status RPCs; ownership relay and SSE`)
      release(); release = undefined
      store.clearInstance("fixture")
      store = undefined

      const session = await client.session.create({ location: { directory: location }, title: "C4 fixture" })
      const metadata = { fixture: { keep: true }, unrelated: "preserve" }
      await client.session.update({ sessionID: session.id, metadata })
      const listed = await request("hosts")
      assert.equal(listed.offers.length, 5)
      assert(listed.offers.every(offer => Object.keys(offer).sort().join(",") === "label,offerID,protocol"), "Leaky display fields are stripped")
      const offerID = listed.offers[0].offerID
      assert.deepEqual(await request("attach", { body: { offerID, sessionID: session.id } }), { outcome: "attached" })
      assert.equal((await request("")).integrations.find(item => item.id === "fixture").status.connection.attachedSessions, 1)
      const attached = await client.session.get({ sessionID: session.id })
      check(attached.metadata, "Q8 metadata")
      assert.deepEqual({ ...attached.metadata, [Q8]: undefined }, { ...metadata, [Q8]: undefined })
      assert.deepEqual(Object.keys(attached.metadata[Q8]).sort(), ["attachedAt", "integration", "label"])
      assert.equal(attached.metadata[Q8].integration, "fixture")
      assert.equal(attached.metadata[Q8].label, "Fixture scene")
      assert(Number.isSafeInteger(attached.metadata[Q8].attachedAt))
      const updatedMetadata = { ...attached.metadata, unrelated: "updated by another native writer", latest: { keep: 2 } }
      await client.session.update({ sessionID: session.id, metadata: updatedMetadata })
      assert.deepEqual(await request("detach", { body: { sessionID: session.id } }), { outcome: "detached" })
      assert.equal((await request("")).integrations.find(item => item.id === "fixture").status.connection.attachedSessions, 0)
      const detached = await client.session.get({ sessionID: session.id })
      const { [Q8]: _hint, ...expectedMetadata } = updatedMetadata
      assert.deepEqual(detached.metadata, expectedMetadata)
      check(detached.metadata, "detached metadata")
      assert.deepEqual(await request("detach", { body: { sessionID: session.id } }), { outcome: "none" })
      console.log("PASS real native session.create/update/get: exact Q8, unrelated metadata retained, detach and none")

      await client.location.get({ location: { directory: other } })
      const otherSession = await client.session.create({ location: { directory: other } })
      await client.session.update({ sessionID: otherSession.id, metadata })
      const beforeRefusal = calls.length
      assert.equal((await request("attach", { body: { offerID, sessionID: otherSession.id }, expected: 403 })).code, "forbidden")
      assert.equal((await request("detach", { body: { sessionID: otherSession.id }, expected: 403 })).code, "forbidden")
      assert.equal((await request("hosts", { directory: foreign, expected: 403 })).code, "forbidden")
      assert.equal(calls.length, beforeRefusal, "Location refusals dispatch no integration RPC")
      assert.deepEqual((await client.session.get({ sessionID: otherSession.id })).metadata, metadata)
      for (const [action, body] of [["attach", { offerID, sessionID: session.id, token: FAKE_INTEGRATION_SENTINELS.token }],
        ["detach", { sessionID: session.id, binding_key: FAKE_INTEGRATION_SENTINELS.bindingKey }],
        ["attach", { offerID: "bad/id", sessionID: session.id }]]) {
        assert.equal((await request(action, { body, expected: 400 })).code, "invalid")
      }
      await request("hosts", { query: `&rpcID=${FAKE_INTEGRATION_SENTINELS.scriptHandle}`, expected: 400 })
      await request("hosts", { query: "&workspaceID=obsolete", expected: 400 })
      // Native Session.ID requires `ses`; reject before a caller-controlled value reaches native URL logging.
      await request("detach", { body: { sessionID: FAKE_INTEGRATION_SENTINELS.scriptHandle }, expected: 400 })
      const removed = await client.session.create({ location: { directory: location } })
      await client.session.remove({ sessionID: removed.id })
      await request("detach", { body: { sessionID: removed.id }, expected: 404 })
      assert.equal(calls.length, beforeRefusal, "Malformed requests and a missing native session dispatch no integration RPC")
      assert.deepEqual(await request("attach", { body: { offerID: "offer_missing", sessionID: session.id } }), { outcome: "gone" })
      for (const input of offers) assert.equal((await rpc("withdraw", { offer_key: input.offer_key, token: input.token })).outcome, "withdrawn")
      assert.deepEqual(await request("hosts"), { offers: [] })
      // The public contract permits this label; the server's display-path guard must still reject it.
      assert.equal((await rpc("advertise", host.advertiseInput({ label: "C:fixture", offer_key: "path-label" }))).outcome, "accepted")
      assert.equal((await request("hosts", { expected: 502 })).code, "non-conforming")
      await rpc("withdraw", { offer_key: "path-label", token: host.token })
      console.log("PASS cross-owned-location refusal, unowned location, strict/malformed inputs, missing/gone sessions/offers, unsafe display refusal")

      const blenderEnv = await fixtureEnvironment(root, { ...Object.fromEntries(Object.entries(env).filter(([key]) =>
        /^(OPENCODE_|XDG_)/.test(key))), BLENDER_USER_RESOURCES: path.join(root, "blender-user"), PYTHONDONTWRITEBYTECODE: "1" })
      assert(Object.keys(blenderEnv).every(key => !/^BLENDER_SYSTEM_|^BLENDER_USER_(SCRIPTS|CONFIG|DATAFILES|EXTENSIONS)$|^PYTHON(PATH|HOME)$/.test(key)),
        "All system/user-script overrides are scrubbed")
      await mkdir(blenderEnv.BLENDER_USER_RESOURCES, { recursive: true })
      const { installAddon } = await tsImport(pathToFileURL(path.join(pilot, "integrations/blender/test/helpers/blender.ts")).href, import.meta.url)
      installAddon({ root, env: blenderEnv, extensions: path.join(blenderEnv.BLENDER_USER_RESOURCES, "extensions/user_default") })
      blenderChild = spawn(blender, ["-b", "--factory-startup", "--python-exit-code", "3", "--python",
        path.join(pilot, "integrations/blender/test/blender/serve.py"), "--", "--offer", "--config-dir", env.OPENCODE_CONFIG_DIR,
        "--seconds", "60", "--off-after", "15", "--stop-file", stopFile],
      { env: blenderEnv, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      blenderChild.stdout.on("data", chunk => { blenderOutput += chunk })
      blenderChild.stderr.on("data", chunk => { blenderOutput += chunk })
      blenderStopped = new Promise((resolve, reject) => { blenderChild.once("close", resolve); blenderChild.once("error", reject) })
      void blenderStopped.catch(() => {})
      const blenderOffers = await until("Blender advertised through fixture registration", async () => {
        assert(blenderChild.exitCode === null, "Blender stays alive while advertising")
        const value = await request("hosts", { integration: "blender" })
        return value.offers.length ? value.offers : undefined
      }, 40_000)
      assert.equal(blenderOffers.length, 1)
      assert.equal(blenderOffers[0].label, "Blender: Untitled")
      assert.equal(blenderOffers[0].protocol, "ok")
      assert.deepEqual(await request("attach", { integration: "blender", body: { offerID: blenderOffers[0].offerID, sessionID: session.id } }), { outcome: "attached" })
      const blenderMetadata = (await client.session.get({ sessionID: session.id })).metadata
      assert.deepEqual(blenderMetadata[Q8].integration, "blender")
      check(blenderMetadata, "Blender Q8")
      assert.deepEqual(await request("detach", { integration: "blender", body: { sessionID: session.id } }), { outcome: "detached" })
      assert.deepEqual((await client.session.get({ sessionID: session.id })).metadata, expectedMetadata)
      await until("Blender consent-off withdrawal", async () => blenderOutput.includes("CONSENT_OFF")
        && (await request("hosts", { integration: "blender" })).offers.length === 0, 35_000)
      await writeFile(stopFile, "stop")
      assert.equal(await blenderStopped, 0, "Blender exits cleanly from its private fixture")
      assert(["OFFERED", "CONSENT_OFF", "SERVED"].every(marker => blenderOutput.includes(marker)), "The pilot completes its consent lifecycle")
      check(blenderOutput, "Blender output")
      console.log("PASS Blender pilot >=2a3d1b0: private factory-startup, explicit config-dir, native advertise, HTTP hosts/attach/detach, consent-off withdraw")
      assert.equal(subscriptionCount, 1, "One native shared-stream subscriber serves both logical recipients")
      check(native, "native stream")
      check(relayed, "relayed events")
      check(sseEvents, "SSE")
      check(logs, "route/relay/SSE logs")
      for (const level of ["debug", "trace"]) assert(logs.some(entry => entry.level === level
        && entry.args[1] === (level === "debug" ? "HTTP request completed" : "HTTP request payload")), `${level} HTTP completion logging is exercised`)
      console.log("PASS no fake token/port/script_handle/offer_key/binding_key sentinel in HTTP, native/relay/EventBus/SSE, logs or Q8")
      console.log("NOT RUN: deferred manual AC-B4")
    } finally {
      release?.()
      store?.clearInstance("fixture")
      bridge.shutdown()
      unsubscribe()
      controller.abort()
      await sseTask?.catch(() => {})
      connections.shutdown()
      if (blenderChild?.exitCode === null) {
        await writeFile(stopFile, "stop")
        await stopFixtureChild(blenderChild, blenderStopped)
      }
      await app.close()
      catalogServer.closeAllConnections()
      await new Promise(resolve => catalogServer.close(resolve))
      check(logs, "final route/relay/SSE logs")
      check(blenderOutput, "final Blender output")
    }
  })
  await scanLogs(fixtureRoot)
  console.log("PASS C4 native attachment proof; daemon and fixture logs sentinel-free")
} finally {
  await host.close()
}
