// B: actual management HTTP, two authenticated owner SSE lanes, lifecycle, BundlesActions,
// native configuration/package/RPC IO. Optional pinned real Blender pilot; no renderer claims.
// node --import tsx scripts/test-panel-extension-bundles-management-native.mjs <absolute-cli> [integration-checkout] [blender-executable]
// --installation-state selects the bounded declaration/runtime/progress-producer qualification.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { parse } from "jsonc-parser"
import Fastify from "fastify"
import pino from "pino"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import { fixtureEnvironment, withProductRuntime, writeFixtureServiceRegistration } from "./native-product-fixture.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"
import { writeFakeIntegrationPackage, startFakeHost, assertNoSentinels } from "./fixtures/fake-integration/index.mjs"
import { startFakeNpmRegistry } from "./fixtures/fake-npm-registry.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { PluginSources } from "../packages/server/src/opencode/plugin-sources.ts"
import { PluginPackages } from "../packages/server/src/opencode/plugin-packages.ts"
import { NativeMutationUncertainError } from "../packages/server/src/opencode/native-mutation-authority.ts"
import { IntegrationCatalogSource } from "../packages/server/src/opencode/integrations/catalog.ts"
import { catalogEntry, catalogOf } from "../packages/server/src/opencode/integrations/catalog-fixture.ts"
import { IntegrationsReader } from "../packages/server/src/opencode/integrations/integrations.ts"
import { IntegrationAttachments } from "../packages/server/src/opencode/integrations/attachments.ts"
import { INTEGRATION_ATTACHMENT_METADATA_KEY as Q8 } from "../packages/server/src/integration-types.ts"
import { PanelExtensionStore } from "../packages/server/src/panel-extensions/store.ts"
import { fixtureArchive } from "../packages/server/src/panel-extensions/archive-fixture.ts"
import { readPanelExtensionArchive } from "../packages/server/src/panel-extensions/archive.ts"
import { BundlesActions } from "../packages/server/src/panel-extensions/bundles-actions.ts"
import { BundlesTransport } from "../packages/server/src/panel-extensions/bundles-transport.ts"
import { BundlesLifecycle } from "../packages/server/src/panel-extensions/bundles-lifecycle.ts"
import { registerPanelExtensionBundlesRoutes } from "../packages/server/src/server/routes/panel-extension-bundles.ts"
import { registerPanelExtensionBundlesManagementRoutes } from "../packages/server/src/server/routes/panel-extension-bundles-management.ts"
import { registerEventRoutes } from "../packages/server/src/server/routes/events.ts"
import { registerRequestLogging } from "../packages/server/src/server/request-logging.ts"
import { AuthManager } from "../packages/server/src/auth/manager.ts"
import { EventBus } from "../packages/server/src/events/bus.ts"
import { ClientConnectionManager } from "../packages/server/src/clients/connection-manager.ts"
import { InstanceEventBridge } from "../packages/server/src/workspaces/instance-events.ts"
import { nativeEventConnections } from "../packages/server/src/workspaces/opencode-service.ts"

const installationOnly = process.argv.includes("--installation-state")
const [cli, checkout, blender] = process.argv.slice(2).filter(value => value !== "--installation-state")
assert(cli && path.isAbsolute(cli) && await stat(cli).then(x => x.isFile(), () => false), "Pass an existing absolute private CLI executable")
assert.equal(Boolean(checkout), Boolean(blender), "Supply both the integration checkout and Blender executable, or neither")
const pin = "54d6e5d0f4c22e74d228822fcaaa0912818a8b46"
const registry = await startFakeNpmRegistry(), host = await startFakeHost({ leaky: true })
const check = (value, label) => assertNoSentinels(value, { port: host.port }, label)
const secrets = new Set()
const absent = (value, needles, label) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  for (const needle of needles) assert(!text.includes(needle), `${label} omits private value`)
}
async function until(label, probe, timeout = 30_000) {
  const end = Date.now() + timeout
  do { const value = await probe(); if (value) return value; await delay(40) } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
async function command(file, args, env, cwd) {
  const child = spawn(file, args, { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk }); child.stderr.on("data", chunk => { output += chunk })
  const stopped = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject) })
  const timer = setTimeout(() => child.kill(), 60_000)
  try { assert.equal(await stopped, 0, "Private child command succeeds (output retained privately)"); return output }
  finally { clearTimeout(timer) }
}
async function scanLogs(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await scanLogs(file)
    else if (entry.name.endsWith(".log")) {
      const text = await readFile(file, "utf8"); check(text, "fixture log"); absent(text, secrets, "fixture log")
    }
  }
}
let fixtureRoot, configFile, pilot, plugin, laterPackage
try {
  await withProductRuntime(cli, async ({ root, configDirectory }) => {
    fixtureRoot = root; configFile = path.join(configDirectory, "opencode.jsonc")
    const env = await fixtureEnvironment(root)
    await writeFile(path.join(root, ".npmrc"), `registry=${registry.url}\naudit=false\nfund=false\n`)
    for (const version of ["0.1.0", "0.1.1", "0.1.2"]) {
      const staging = path.join(root, `pack-${version}`), directory = path.join(staging, "package")
      const pkg = await writeFakeIntegrationPackage(directory, { version })
      const tarball = path.join(root, `${version}.tgz`)
      await command("tar", ["-czf", tarball, "-C", staging, "package"], env, root)
      const bytes = await readFile(tarball)
      if (version === "0.1.0") registry.publish(pkg.name, version, bytes)
      else (laterPackage ??= new Map()).set(version, { name: pkg.name, bytes })
    }
    if (checkout) {
      assert(path.isAbsolute(checkout) && path.isAbsolute(blender))
      const archive = path.join(root, "integration-pin.tar")
      await command("git", ["archive", "--format=tar", `--output=${archive}`, pin], env, checkout)
      pilot = path.join(root, "integration-pin"); await mkdir(pilot)
      await command("tar", ["-xf", archive, "-C", pilot], env, root)
      assert.equal(createHash("sha256").update(await readFile(path.join(pilot, "spec/schemas/rpc.schema.json"))).digest("hex"),
        "291ee28dd4f286b400ef914e85b69c6d6331272b07f0c648e32e0176285bbc47")
      assert.equal(JSON.parse(await readFile(path.join(checkout, "node_modules/semver/package.json"), "utf8")).version, "7.8.5")
      plugin = path.join(pilot, "integrations/blender/plugin")
      const options = { entryPoints: [path.join(plugin, "src/plugin.ts")], outfile: path.join(plugin, "dist/index.js"),
        bundle: true, format: "esm", platform: "node", target: "node22", external: ["@opencode/plugin", "@opencode/plugin/*"],
        nodePaths: [path.join(checkout, "node_modules")],
        banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } }
      await command(process.execPath, ["--input-type=module", "-e",
        `import { build } from ${JSON.stringify(import.meta.resolve("esbuild"))}; await build(${JSON.stringify(options)});`], env, root)
    }
    await writeFile(configFile, JSON.stringify({ plugins: plugin ? [{ package: plugin, options: {} }] : [] }, null, 2))
    return {}
  }, async ({ root, env, connection: original }) => {
    const client = OpenCode.make({ baseUrl: original.endpoint.url,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${original.endpoint.auth.password}`).toString("base64")}` },
      fetch: (input, init) => new URL(input instanceof Request ? input.url : input).pathname === "/api/event" ? fetch(input, init) : original.fetch(input, init) })
    const info = await client.server.info(); assert.equal(info.version, "2.2.5")
    console.log(`Native runtime: ${info.version}`)
    const location = { directory: (await client.location.get({ location: { directory: root } })).directory }
    const other = path.join(root, "foreign-project"); await mkdir(other)
    const foreignLocation = await client.location.get({ location: { directory: other } })
    const session = await client.session.create({ location, title: "B displayed conversation" })
    const foreign = await client.session.create({ location: { directory: foreignLocation.directory }, title: "FOREIGN_DOCUMENT_SENTINEL" })
    await client.session.update({ sessionID: foreign.id, metadata: { secret: "FOREIGN_METADATA_SENTINEL" } })
    secrets.add("FOREIGN_METADATA_SENTINEL"); secrets.add("PRIVATE_D25_OPTIONS")
    secrets.add("PRIVATE_CACHE_KEEP"); secrets.add("PRIVATE_APPLICATION_KEEP")
    const metadata = { unrelated: { keep: "B preservation sentinel" } }
    await client.session.update({ sessionID: session.id, metadata })
    const calls = [], updates = [], logs = [], native = [], relayed = [], projected = [], dispatches = []
    const logger = pino({ level: "trace" }, { write: line => logs.push(line) })
    let selectedWsl, uncertainUpdate = false, preparations = 0, catalogReads = 0, removals = 0, skew = 0
    const connection = { ...original, client: { ...client,
      rpc: { ...client.rpc, call: (request, options) => {
        calls.push({ method: request.method, rpcID: request.rpcID, input: request.input }); return client.rpc.call(request, options)
      } }, plugin: { ...client.plugin, update: async (request, options) => {
        updates.push(request); const value = await client.plugin.update(request, options)
        if (uncertainUpdate) throw new Error("Private transport uncertainty after actual native update")
        return value
      } },
    } }
    const owned = directory => directory === location.directory || directory === foreignLocation.directory
    const record = { id: "fixture", path: location.directory }
    const manager = {
      get: id => id === "fixture" ? record : undefined, list: () => [record],
      getSharedServiceConnection: async () => connection, getSharedServiceClient: async () => client,
      getServiceDirectoryForPath: async (_id, directory) => owned(directory) ? directory : undefined,
      ownsLocation: async (id, candidate) => id === "fixture" && candidate.workspaceID === undefined && owned(candidate.directory),
      ownsDirectory: async (_id, directory) => owned(directory),
      getWorktreeIdentityForPath: async (_id, directory) => owned(directory) ? directory : undefined,
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix", getServiceWslDistro: () => selectedWsl,
      getHostPathForServicePath: async (_id, directory) => directory, invalidateWorktrees() {},
      subscribeToSharedService: async signal => (async function* () {
        for await (const event of client.event.subscribe({ signal })) { check(event, "native event"); native.push(event); nativeEventConnections.set(event, connection); yield event }
      })(),
    }
    let catalogBase
    const catalogServer = createServer((request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(request.url === "/releases" ? [{ tag_name: "catalog-v1", draft: false, prerelease: false,
        assets: [{ name: "catalog.json", id: 1, updated_at: "2026-10-31T00:00:00Z", url: `${catalogBase}/catalog` }] }]
        : catalogOf(catalogEntry("fixture"), ...(plugin ? [catalogEntry("blender")] : []))))
    })
    await new Promise(resolve => catalogServer.listen(0, "127.0.0.1", resolve))
    catalogBase = `http://127.0.0.1:${catalogServer.address().port}`
    const source = new IntegrationCatalogSource({ releasesUrl: `${catalogBase}/releases`, stateFile: path.join(root, "catalog.json"), logger })
    const catalog = { snapshot: () => source.snapshot(), read: options => { catalogReads++; return source.read(options) } }
    const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger })
    const integrations = new IntegrationsReader({ controls, workspaceManager: manager, catalog })
    const attachments = new IntegrationAttachments({ controls, workspaceManager: manager, catalog })
    const sources = new PluginSources({ documents: controls, logger, catalog })
    let uncertainRemoval = false
    const remove = sources.remove.bind(sources); sources.remove = async (...args) => {
      removals++; const value = await remove(...args)
      if (uncertainRemoval) throw new Error("Private lost response after actual source removal")
      return value
    }
    const packages = new PluginPackages({ controls, workspaceManager: manager })
    const actions = new BundlesActions({ workspaceManager: manager, catalog, controls, sources, packages, attachments })
    const observedActions = { accepts: action => actions.accepts(action), prepare: async (...args) => {
      preparations++
      const prepared = await actions.prepare(...args)
      return { ...prepared, dispatch: async (...dispatchArgs) => {
        const trace = { action: args[1].action, done: false, error: undefined }; dispatches.push(trace)
        try { return await prepared.dispatch(...dispatchArgs) } catch (error) { trace.error = error; throw error } finally { trace.done = true }
      } }
    } }
    const store = new PanelExtensionStore(path.join(root, "panel-extensions"))
    const pkg = await readPanelExtensionArchive(fixtureArchive("<p>Private B qualification</p>", { apiVersion: 4,
      permissions: ["session.context", "bundles.read", "bundles.manage"] }))
    await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
    const auth = new AuthManager({ configPath: path.join(root, "auth/config.yaml"), username: "fixture", password: "private-b-only", generateToken: false }, logger)
    const cookie = `${auth.getCookieName()}=${auth.createSession("fixture").id}`
    const foreignCookie = `${auth.getCookieName()}=${auth.createSession("foreign").id}`
    const bus = new EventBus(logger), connections = new ClientConnectionManager(logger)
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
    const unsubscribe = bus.onEvent(event => { check(event, "relay"); relayed.push(event) })
    // Advance only between settled cases to keep the real sliding management budget from
    // making this focused native runner wait minutes. Guard/timers retain real elapsed time.
    const lifecycle = new BundlesLifecycle({ now: () => Date.now() + skew, setTimeout, clearTimeout })
    const transport = new BundlesTransport({ auth, store, workspaceManager: manager, actions: observedActions, eventBus: bus, lifecycle, catalog })
    const app = Fastify({ logger: false })
    registerRequestLogging(app, logger); app.addHook("onRequest", async request => { request.log = logger })
    registerPanelExtensionBundlesRoutes(app, { store, workspaceManager: manager, catalog, integrations, attachments, budget: lifecycle.budget })
    registerPanelExtensionBundlesManagementRoutes(app, { transport })
    registerEventRoutes(app, { eventBus: bus, connectionManager: connections, logger, registerClient: () => () => {}, bundlesTransport: transport })
    const base = await app.listen({ host: "127.0.0.1", port: 0 })
    const lanes = []
    let blenderChild, blenderStopped, blenderOutput = ""
    const post = async (method, body, expected = 200, sessionCookie = cookie) => {
      const response = await fetch(`${base}/api/panel-extensions/${pkg.manifest.id}/bundles/${method}`, { method: "POST",
        headers: { "content-type": "application/json", cookie: sessionCookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
      const text = await response.text(); check(text, "HTTP response"); check([...response.headers], "HTTP headers")
      assert.equal(response.status, expected, `${method} status: ${text}`)
      assert.equal(response.headers.get("cache-control"), "no-store")
      return JSON.parse(text)
    }
    const read = async (method, fields = {}) => {
      const result = await post(method, { instanceId: "fixture", digest: pkg.digest, sessionID: session.id, ...fields })
      projected.push(result); check(result, "extension projection")
      absent(result, [...secrets, root, root.replaceAll("\\", "/"), foreign.id, "FOREIGN_DOCUMENT_SENTINEL", "attachedSessions", "authority", "serviceGeneration", "registryGeneration", "ownerProof"], "extension projection")
      return result
    }
    const openLane = async (name, sessionCookie) => {
      const lane = { frames: [], events: [], owner: undefined, controller: new AbortController(), task: undefined }
      lanes.push(lane)
      const response = await fetch(`${base}/api/events?clientId=${name}&connectionId=${name}`, { headers: { cookie: sessionCookie }, signal: lane.controller.signal })
      assert.equal(response.status, 200)
      lane.task = (async () => {
        const decoder = new TextDecoder(); let pending = ""
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true }); let end
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2)
            check(frame, "SSE frame"); lane.frames.push(frame)
            const data = frame.split("\n").find(line => line.startsWith("data: "))
            if (!data) continue
            const value = JSON.parse(data.slice(6))
            if (frame.startsWith("event: codenomad.bundles.owner")) { lane.owner = value.owner; secrets.add(value.owner) }
            if (frame.startsWith("event: codenomad.bundles.event")) lane.events.push(value)
            if (frame.startsWith("event: codenomad.client.ping")) connections.pong({ clientId: name, connectionId: name })
          }
        }
      })().catch(error => { if (!lane.controller.signal.aborted) throw error })
      void lane.task.catch(() => {})
      await until("authenticated SSE owner", () => lane.owner)
      return lane
    }
    const mount = async (lane, sessionCookie = cookie) => {
      const result = await post("mount", { owner: lane.owner, instanceId: "fixture", digest: pkg.digest, sessionID: session.id }, 200, sessionCookie)
      secrets.add(result.mountID); return { owner: lane.owner, mountID: result.mountID }
    }
    const manage = (mounted, method, input, sessionCookie = cookie) => post("manage", { ...mounted, method, input }, 200, sessionCookie)
    const control = (mounted, command, fields = {}, sessionCookie = cookie) => post("control", { ...mounted, command, ...fields }, 200, sessionCookie)
    const terminal = (lane, requestID) => until("private request terminal", () => lane.events.find(event => event.change?.requestID === requestID)?.change)
    const plan = (lane, requestID) => until("private confirmation", () => lane.events.find(event => event.view?.requestID === requestID)?.view)
    const begin = async (mounted, lane, method, input) => {
      const before = preparations, eventCount = lane.events.length
      const ack = await manage(mounted, method, input); assert.equal(ack.outcome, "confirming"); secrets.add(ack.requestID)
      await delay(50)
      assert.equal(preparations, before, "ACK alone starts no preparation")
      assert.equal(lane.events.length, eventCount, "ACK alone sends no view or result")
      await control(mounted, "start", { requestID: ack.requestID })
      return ack
    }
    const approve = async (mounted, lane, view, expected = 200) => {
      secrets.add(view.planID)
      await control(mounted, "displayed", { planID: view.planID })
      const before = dispatches.length
      await control(mounted, "confirm", { planID: view.planID })
      assert.equal(dispatches.length, before, "600 ms guard refuses immediate confirmation")
      await delay(650)
      await post("control", { ...mounted, command: "confirm", planID: view.planID }, expected)
      const result = await terminal(lane, view.requestID)
      if (result.outcome === "confirmed") await until("native dispatch settles (not merely admitted)", () => dispatches.slice(before).find(value => value.done))
      return result
    }
    const execute = async (mounted, lane, method, input) => {
      const ack = await begin(mounted, lane, method, input), view = await plan(lane, ack.requestID)
      assert.equal((await approve(mounted, lane, view)).outcome, "confirmed")
      assert.equal(dispatches.at(-1).error, undefined, "Actual native dispatch completed")
      skew += 61_000
      return view
    }
    const runtime = async (version, active = true) => until(`native fixture ${version} ${active ? "active" : "disabled"}`, async () => {
      const snapshot = await controls.read("fixture", location)
      const item = snapshot.runtime.find(entry => entry.id === "neuralnomads.fixture")
      if (!active) return !item && snapshot.controls.some(entry => entry.id === "neuralnomads.fixture" && !entry.effectiveEnabled)
      return item?.state.status === "active" && item.source.version === version ? item : undefined
    }, 90_000)
    const requestInput = action => ({ action, integration: "fixture", scope: "global" })
    const rpc = async (integration, method, input = {}, directory = location.directory) => (await client.rpc.call({ rpcID: `neuralnomads.${integration}`, method, input, location: { directory } })).output
    try {
      assert.equal((await catalog.read()).state, "fresh")
      bus.publish({ type: "workspace.started", workspace: record })
      await until("real native subscription and production relay", () => native.length && relayed.some(event => event.type === "instance.event" && event.event.type === "server.connected"))
      // Two windows of the same signed-in user still have distinct stream ownership.
      const owner = await openLane("b-owner", cookie), outsider = await openLane("b-outsider", cookie)
      assert.notEqual(owner.owner, outsider.owner)
      let mounted = await mount(owner)
      const otherMount = await mount(outsider)
      await post("manage", { ...mounted, method: "request", input: requestInput("install") }, 503, foreignCookie)
      await post("manage", { ...otherMount, owner: owner.owner, method: "request", input: requestInput("install") }, 503)
       const empty = await read("state"); assert.equal(empty.integrations.find(item => item.id === "fixture").state, "absent")
       assert.deepEqual(empty.integrations.find(item => item.id === "fixture").plugin, { declared: false, runtime: "unloaded" })
      const view = await execute(mounted, owner, "request", requestInput("install"))
      assert.equal(view.version, "^0.1")
       await runtime("0.1.0")
       const observed = await read("state"), installed = observed.integrations.find(item => item.id === "fixture")
       assert.deepEqual(installed.plugin, { declared: true, runtime: "active" }, "HTTP producer carries only native facts, never local progress")
       assert.equal(view.installation.target, observed.tracking.sources.find(source => source.integration === "fixture").target,
         "private prepared target exactly matches the observed native declaration")
       assert.equal(view.installation.directory, location.directory)
       assert.equal((await controls.read("fixture", location)).configured.sources.find(source => source.target === "@neuralnomads/opencode-fixture@^0.1").trackingTarget,
         view.installation.target, "native Plugins and bridge observe the same opaque source identity")
      assert(parse(await readFile(configFile, "utf8")).plugins.includes("@neuralnomads/opencode-fixture@^0.1"), "Installed source is the catalogue range, never frame-selected")
      console.log("PASS B install: real HTTP ACK/start/guard/confirm, catalog-derived range, native registry load 0.1.0")

      await execute(mounted, owner, "setActive", { integration: "fixture", scope: "global", enabled: false })
       await runtime("0.1.0", false)
       const disabled = (await read("state")).integrations.find(item => item.id === "fixture")
       assert.deepEqual(disabled.plugin, { declared: true, runtime: "unloaded" })
       assert.equal(disabled.activation.effective, "disabled")
      await execute(mounted, owner, "setActive", { integration: "fixture", scope: "global", enabled: true })
      await runtime("0.1.0")
      const next = laterPackage.get("0.1.1"); registry.publish(next.name, "0.1.1", next.bytes)
      const exact = (await runtime("0.1.0")).source.target
      await execute(mounted, owner, "request", requestInput("update")); await runtime("0.1.1")
      assert.equal(updates.length, 1); assert.deepEqual(updates[0].targets, [exact])
      await execute(mounted, owner, "installHost", { integration: "fixture" })
      assert.equal(calls.filter(call => call.method === "installHost").length, 1)
      assert.deepEqual(calls.find(call => call.method === "installHost").input, { target: "default" })
      // Installed fixture payload with a closed application has unknown availability.
      assert.deepEqual((await read("state")).integrations.find(item => item.id === "fixture").status.host,
        { state: "unknown", expectedRange: "^0.1.0" })
       console.log("PASS B disable/enable native reload, exact-target package.update to 0.1.1, one installHost(default) with actual status read-back")
       if (installationOnly) {
         check([empty, observed, disabled, logs, relayed], "installation-state HTTP/events/logs")
         await scanLogs(root)
         console.log("PASS installation-state slice: declaration/runtime/normalized disable, exact private source correlation, no server progress, HTTP/event/log sentinel scans")
         return
       }

      assert.equal((await rpc("fixture", "advertise", host.advertiseInput())).outcome, "accepted")
      const offers = await read("hosts", { integration: "fixture" }); assert.equal(offers.offers.length, 1)
      // Real foreign-only attachment before the displayed-session attach proves exact binding projection.
      assert.equal((await rpc("fixture", "attachHost", { offerID: offers.offers[0].offerID, sessionID: foreign.id }, foreignLocation.directory)).outcome, "attached")
      assert.deepEqual((await read("state")).integrations.find(item => item.id === "fixture").attachment, { state: "none" })
      await execute(mounted, owner, "attach", { integration: "fixture", offerID: offers.offers[0].offerID })
      assert.deepEqual((await read("state")).integrations.find(item => item.id === "fixture").attachment, { state: "attached", label: "Fixture scene" })
      const attached = await client.session.get({ sessionID: session.id })
      assert.deepEqual(attached.metadata.unrelated, metadata.unrelated)
      assert.deepEqual(Object.keys(attached.metadata[Q8]).sort(), ["attachedAt", "integration", "label"])
      assert.equal(attached.metadata[Q8].integration, "fixture"); assert.equal(attached.metadata[Q8].label, "Fixture scene")
      assert(Number.isSafeInteger(attached.metadata[Q8].attachedAt)); check(attached.metadata, "native Q8 metadata")
      absent(attached.metadata, [...secrets, root, foreign.id, "authority", "attachedSessions"], "native Q8 metadata")
      const beforeInvalid = { calls: calls.length, removals, config: await readFile(configFile, "utf8") }
      assert.deepEqual(await manage(mounted, "detach", { integration: "fixture" }), { outcome: "invalid" })
      assert.equal(calls.length, beforeInvalid.calls); assert.equal(removals, beforeInvalid.removals)
      assert.equal(await readFile(configFile, "utf8"), beforeInvalid.config)
      console.log("PASS B attach: real binding/Q8 read-back with unrelated metadata; foreign-only binding stays none; public detach invalid with zero native RPC/removal")

      // Cancellation and the backend-wide arbiter operate through actual owner HTTP/SSE.
      const cancelAck = await begin(mounted, owner, "setActive", { integration: "fixture", scope: "global", enabled: false })
      const cancelView = await plan(owner, cancelAck.requestID); secrets.add(cancelView.planID)
      assert.deepEqual(await manage(otherMount, "setActive", { integration: "fixture", scope: "global", enabled: false }), { outcome: "busy" })
      const dispatchCount = dispatches.length
      await control(mounted, "cancel", { planID: cancelView.planID })
      assert.equal((await terminal(owner, cancelAck.requestID)).outcome, "cancelled")
      await post("control", { ...mounted, command: "confirm", planID: cancelView.planID }, 409); assert.equal(dispatches.length, dispatchCount)
      skew += 61_000
      const staleAck = await begin(mounted, owner, "setActive", { integration: "fixture", scope: "global", enabled: false })
      const staleView = await plan(owner, staleAck.requestID)
      await writeFile(configFile, (await readFile(configFile, "utf8")) + "\n")
      assert.equal((await approve(mounted, owner, staleView, 409)).outcome, "failed")
      assert.equal(dispatches.length, dispatchCount); skew += 61_000
      const projectBefore = { config: await readFile(configFile, "utf8"), dispatches: dispatches.length }
      assert.deepEqual(await manage(mounted, "request", { action: "install", integration: "fixture", scope: "project" }), { outcome: "invalid" })
      assert.deepEqual(await manage(mounted, "setActive", { integration: "fixture", scope: "project", enabled: false }), { outcome: "invalid" })
      assert.equal(dispatches.length, projectBefore.dispatches); assert.equal(await readFile(configFile, "utf8"), projectBefore.config)
      skew += 61_000
      selectedWsl = "FixtureWSL"
      const wslBefore = { catalogReads, calls: calls.length, config: await readFile(configFile, "utf8") }
      const wslAck = await begin(mounted, owner, "installHost", { integration: "fixture" })
      assert.equal((await terminal(owner, wslAck.requestID)).outcome, "failed")
      assert.equal(catalogReads, wslBefore.catalogReads); assert.equal(calls.length, wslBefore.calls)
      assert.equal(await readFile(configFile, "utf8"), wslBefore.config); selectedWsl = undefined; skew += 61_000
      console.log("PASS B private cancellation/global concurrency, stale document fails before dispatch, native Project refusal, selected-WSL refusal before catalogue/RPC/config effects")

      const revokeAck = await begin(mounted, owner, "setActive", { integration: "fixture", scope: "global", enabled: false })
      const revokeView = await plan(owner, revokeAck.requestID); secrets.add(revokeView.planID)
      await store.activate(pkg.manifest.id, pkg.digest, false)
      assert.equal((await terminal(owner, revokeAck.requestID)).outcome, "failed")
      await post("control", { ...mounted, command: "confirm", planID: revokeView.planID }, 409)
      assert.equal(dispatches.length, dispatchCount)
      await store.activate(pkg.manifest.id, pkg.digest, true); mounted = await mount(owner); skew += 61_000
      const last = laterPackage.get("0.1.2"); registry.publish(last.name, "0.1.2", last.bytes)
      uncertainUpdate = true
      const uncertainAck = await begin(mounted, owner, "request", requestInput("update"))
      const uncertainView = await plan(owner, uncertainAck.requestID)
      assert.equal((await approve(mounted, owner, uncertainView)).outcome, "confirmed", "Confirmed means transmission, not completion")
      assert(dispatches.at(-1).error instanceof NativeMutationUncertainError)
      await runtime("0.1.2"); assert.equal(updates.length, 2)
      await post("control", { ...mounted, command: "confirm", planID: uncertainView.planID }, 409); await delay(200)
      assert.equal(updates.length, 2, "Uncertain native submission is not replayed")
      uncertainUpdate = false; skew += 61_000
      console.log("PASS B consent revocation blocks dispatch; actual package update then injected transport failure is uncertain, version 0.1.2 reconciled, no replay")

      if (plugin) {
        await writeFixtureServiceRegistration(env, { ...info, url: original.endpoint.url, password: original.endpoint.auth.password })
        const blenderEnv = await fixtureEnvironment(root, { ...Object.fromEntries(Object.entries(env).filter(([key]) => /^(OPENCODE_|XDG_)/.test(key))),
          BLENDER_USER_RESOURCES: path.join(root, "blender-user"), PYTHONDONTWRITEBYTECODE: "1" })
        await mkdir(blenderEnv.BLENDER_USER_RESOURCES, { recursive: true })
        const version = /Blender (\d+\.\d+)/.exec(await command(blender, ["--version"], blenderEnv, root))?.[1]
        assert(version, "Blender exposes its shipped resource version")
        for (const part of ["scripts", "datafiles", "python", "extensions"]) {
          const destination = path.join(root, "blender-system", part)
          await cp(path.join(path.dirname(blender), version, part), destination, { recursive: true })
          blenderEnv[`BLENDER_SYSTEM_${part.toUpperCase()}`] = destination
        }
        const { installAddon } = await tsImport(pathToFileURL(path.join(pilot, "integrations/blender/test/helpers/blender.ts")).href, import.meta.url)
        installAddon({ root, env: blenderEnv, extensions: path.join(blenderEnv.BLENDER_USER_RESOURCES, "extensions/user_default") })
        blenderChild = spawn(blender, ["-b", "--factory-startup", "--python-exit-code", "3", "--python",
          path.join(pilot, "integrations/blender/test/blender/serve.py"), "--", "--offer", "--config-dir", env.OPENCODE_CONFIG_DIR,
          "--seconds", "90", "--stop-file", path.join(root, "stop-blender")],
        { env: blenderEnv, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        blenderChild.stdout.on("data", chunk => { blenderOutput += chunk }); blenderChild.stderr.on("data", chunk => { blenderOutput += chunk })
        blenderStopped = new Promise((resolve, reject) => { blenderChild.once("close", resolve); blenderChild.once("error", reject) })
        void blenderStopped.catch(() => {})
        const offers = await until("real pinned Blender offer", async () => {
          assert.equal(blenderChild.exitCode, null, "Private Blender remains running")
          const value = await attachments.hosts("fixture", "blender", location)
          return value.offers.length ? value.offers : undefined
        }, 45_000)
        assert.equal(offers[0].protocol, "ok")
        await execute(mounted, owner, "attach", { integration: "blender", offerID: offers[0].offerID })
        assert.deepEqual(await attachments.bindingRead("fixture", "blender", location, { sessionID: session.id }), { state: "attached", label: offers[0].label })
        assert.deepEqual((await read("state")).integrations.find(item => item.id === "blender").attachment, { state: "attached", label: offers[0].label })
        const actual = await client.session.get({ sessionID: session.id })
        assert.equal(actual.metadata[Q8].integration, "blender"); assert.equal(actual.metadata[Q8].label, offers[0].label)
        assert.deepEqual(actual.metadata.unrelated, metadata.unrelated); check(actual.metadata, "real Blender Q8")
        absent(actual.metadata, [...secrets, root, foreign.id, "authority", "attachedSessions"], "real Blender Q8")
        console.log(`PASS B real Blender ${version}: immutable kit ${pin}, private payload/resources, management attach, real binding and Q8 read-back`)
      } else console.log("GAP B real Blender pilot omitted: supply integration checkout and executable; fake host install/attach only")

      // D25: same authenticated mount/plan lane, actual source service, no binding/status gate.
      skew += 61_000
      const cacheCanary = path.join(env.XDG_CACHE_HOME, "d25-keep"), appCanary = path.join(root, "application-keep")
      await mkdir(env.XDG_CACHE_HOME, { recursive: true })
      await writeFile(cacheCanary, "PRIVATE_CACHE_KEEP"); await writeFile(appCanary, "PRIVATE_APPLICATION_KEEP")
      const beforeMetadata = (await client.session.get({ sessionID: session.id })).metadata
      const beforeForeign = (await client.session.get({ sessionID: foreign.id })).metadata
      const beforeRemoval = removals, beforeCalls = calls.length
      const cancelled = await begin(mounted, owner, "request", requestInput("remove"))
      const cancelRemovalView = await plan(owner, cancelled.requestID)
      await control(mounted, "cancel", { planID: cancelRemovalView.planID })
      assert.equal((await terminal(owner, cancelled.requestID)).outcome, "cancelled")
      assert.equal(removals, beforeRemoval); assert.equal(calls.length, beforeCalls); skew += 61_000
      const drift = await begin(mounted, owner, "request", requestInput("remove")), driftView = await plan(owner, drift.requestID)
      const originalConfig = await readFile(configFile, "utf8")
      const changedConfig = parse(originalConfig)
      changedConfig.plugins = changedConfig.plugins.map(entry => entry === exact ? { package: exact, options: { token: "PRIVATE_D25_OPTIONS" } } : entry)
      await writeFile(configFile, JSON.stringify(changedConfig, null, 2))
      assert.equal((await approve(mounted, owner, driftView, 409)).outcome, "failed")
      assert.equal(removals, beforeRemoval); assert.equal(calls.length, beforeCalls)
      await writeFile(configFile, originalConfig); await runtime("0.1.2"); skew += 61_000
      await until("native source/options reconciliation before fresh removal consent", async () =>
        (await controls.read("fixture", location)).targets.find(target => target.scope === "global")?.expectedRevision)
      uncertainRemoval = true
      const uncertainRemove = await begin(mounted, owner, "request", requestInput("remove"))
      const uncertainRemoveView = await plan(owner, uncertainRemove.requestID)
      assert.equal((await approve(mounted, owner, uncertainRemoveView)).outcome, "failed")
      await until("real removal dispatch finishes", () => dispatches.at(-1)?.done)
      assert(dispatches.at(-1).error instanceof NativeMutationUncertainError)
      assert.equal(removals, beforeRemoval + 1); assert.equal(calls.length, beforeCalls, "remove submits zero status, binding, detach or census RPCs")
      assert(!parse(await readFile(configFile, "utf8")).plugins.some(entry => (typeof entry === "string" ? entry : entry.package) === exact))
      await post("control", { ...mounted, command: "confirm", planID: uncertainRemoveView.planID }, 409)
      await delay(200); assert.equal(removals, beforeRemoval + 1, "lost removal acknowledgement never replays")
      assert.deepEqual((await client.session.get({ sessionID: session.id })).metadata, beforeMetadata)
      assert.deepEqual((await client.session.get({ sessionID: foreign.id })).metadata, beforeForeign)
      assert.equal(await readFile(cacheCanary, "utf8"), "PRIVATE_CACHE_KEEP"); assert.equal(await readFile(appCanary, "utf8"), "PRIVATE_APPLICATION_KEEP")
      uncertainRemoval = false; skew += 61_000
      // A new explicit action and consent installs again; this is separate from the lost removal request.
      await until("native configuration sees the removed source", async () => !(await controls.read("fixture", location)).configured.sources.some(source => source.target === exact))
      await execute(mounted, owner, "request", requestInput("install")); await runtime("0.1.2")
      const removeCalls = calls.length
      const removedView = await execute(mounted, owner, "request", requestInput("remove"))
      assert.equal(removedView.action, "remove"); assert.equal(removedView.scope, "global")
      assert.equal(calls.length, removeCalls)
      assert(!parse(await readFile(configFile, "utf8")).plugins.some(entry => (typeof entry === "string" ? entry : entry.package) === exact))
      assert.deepEqual((await client.session.get({ sessionID: session.id })).metadata, beforeMetadata)
      assert.deepEqual((await client.session.get({ sessionID: foreign.id })).metadata, beforeForeign)
      assert.equal(await readFile(cacheCanary, "utf8"), "PRIVATE_CACHE_KEEP"); assert.equal(await readFile(appCanary, "utf8"), "PRIVATE_APPLICATION_KEEP")
      console.log("PASS D25 removal: private HTTP/SSE confirmation, cancellation/options drift, exact source observed, postdispatch lost response uncertain without replay, Q8/foreign metadata/cache/application sentinels preserved, zero status/detach/census RPCs")

      await delay(200)
      const ownerPrivate = [...secrets].filter(value => value !== outsider.owner && value !== otherMount.mountID)
      absent(outsider.frames, ownerPrivate, "foreign SSE lane")
      absent(owner.frames, [outsider.owner, otherMount.mountID], "owner SSE lane")
      assert.equal(outsider.events.length, 0, "No owner view/result is broadcast to a foreign authenticated stream")
      for (const lane of lanes) for (const event of lane.events) {
        if (event.change) {
          projected.push(event.change); check(event.change, "extension terminal projection")
          absent(event.change, [root, foreign.id, "authority", "attachedSessions", "planID", "mountID", "owner"], "extension terminal projection")
        }
      }
      check([logs, native, relayed, projected], "all captured production boundaries")
      assert(native.some(event => event.type === "rpc.neuralnomads.fixture.status_changed"), "Real native integration event captured")
      assert(relayed.some(event => event.type === "instance.event" && event.event.type === "rpc.neuralnomads.fixture.status_changed"), "Real integration event crosses the production relay")
      assert(lanes.every(lane => lane.frames.some(frame => frame.includes("rpc.neuralnomads.fixture.status_changed"))), "Both actual SSE streams receive normal native invalidations")
      absent(logs, secrets, "DEBUG/TRACE logs"); absent(relayed, secrets, "EventBus relay")
      assert(logs.map(line => JSON.parse(line)).some(line => line.level === 10 && line.msg === "HTTP request payload"))
      await writeFile(path.join(root, "backend.log"), logs.join(""))
      await writeFile(path.join(root, "evidence.json"), JSON.stringify({ runtime: info.version, blender: Boolean(plugin), pin: plugin ? pin : null,
        nativeUpdates: updates.length, completedDispatches: dispatches.filter(item => item.done && !item.error).length,
        uncertainDispatches: dispatches.filter(item => item.error instanceof NativeMutationUncertainError).length,
        foreignPrivateEvents: outsider.events.length, projectionCount: projected.length, registryRequests: registry.requested.length }, null, 2))
      console.log("PASS B confidentiality: two real authenticated SSE owners; zero foreign private views/results; extension HTTP/changes, Q8, DEBUG/TRACE and relay scanned")
    } finally {
      if (blenderChild) {
        await writeFile(path.join(root, "stop-blender"), "stop")
        await stopFixtureChild(blenderChild, blenderStopped)
        await writeFile(path.join(root, "blender.log"), blenderOutput)
      }
      for (const lane of lanes) lane.controller.abort()
      transport.dispose(); bridge.shutdown(); unsubscribe(); connections.shutdown()
      await Promise.all(lanes.map(lane => lane.task)); await app.close()
      catalogServer.closeAllConnections(); await new Promise(resolve => catalogServer.close(resolve))
    }
  }, { registry: registry.url })
  await scanLogs(fixtureRoot)
  console.log("PASS B fixture daemon/backend/Blender logs: host sentinels and private owner/mount/plan/request identities absent")
  console.log("GAPS B: renderer focus/MessagePort acceptance, full desktop mutation/privacy, real Blender installer, backend-kernel WSL variants and dispatched cancellation terminality remain separate; manual GUI/B4 gates retained")
} finally { await host.close(); await registry.close() }
