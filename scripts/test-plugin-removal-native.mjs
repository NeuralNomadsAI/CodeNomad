// D25: actual source HTTP routes and real isolated native plugin/session state.
// No shared daemon/configuration, application installation or manual Blender check.
import assert from "node:assert/strict"
import { readFile, writeFile, readdir } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import Fastify from "fastify"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { startFakeHost, packFakeIntegration, assertNoSentinels } from "./fixtures/fake-integration/index.mjs"
import { startFakeNpmRegistry } from "./fixtures/fake-npm-registry.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { PluginSources } from "../packages/server/src/opencode/plugin-sources.ts"
import { registerPluginSourceRoutes } from "../packages/server/src/server/routes/plugin-sources.ts"
import { registerRequestLogging } from "../packages/server/src/server/request-logging.ts"

const registry = await startFakeNpmRegistry()
const host = await startFakeHost()
let file, target, fixtureRoot
try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
    fixtureRoot = root
    const pkg = await packFakeIntegration(root)
    registry.publish(pkg.name, pkg.version, pkg.tarball)
    target = `${pkg.name}@${pkg.version}`
    file = path.join(configDirectory, "opencode.jsonc")
    await writeFile(file, JSON.stringify({ plugins: [{ package: target, options: {} }, "-kept.plugin"], keep: true }))
    return {}
  }, async ({ root, client, connection }) => {
    const location = { directory: (await client.location.get({ location: { directory: root } })).directory }
    const session = await client.session.create({ location })
    const metadata = { "codenomad.integrationAttachment": { integration: "fixture", label: "Fixture", attachedAt: 1 }, keep: "unchanged" }
    await client.session.update({ sessionID: session.id, location, metadata })
    const rpc = async (method, input = {}) => (await client.rpc.call({ location, rpcID: "neuralnomads.fixture", method, input })).output
    for (const deadline = Date.now() + 90_000;;) {
      try { await rpc("status"); break } catch { assert(Date.now() < deadline); await delay(100) }
    }
    assert.equal((await rpc("advertise", host.advertiseInput())).outcome, "accepted")
    const offer = (await rpc("hosts")).offers[0]
    assert.equal((await rpc("attachHost", { offerID: offer.offerID, sessionID: session.id })).outcome, "attached")
    assert.equal((await rpc("status")).connection.attachedSessions, 1)
    const forbidden = []
    const forbiddenCall = name => () => { forbidden.push(name); throw new Error("Forbidden removal census or binding IO") }
    const pinned = { ...connection, client: { ...client,
      rpc: { ...client.rpc, call: forbiddenCall("rpc") },
      session: { ...client.session, list: forbiddenCall("sessions"), get: forbiddenCall("session"), update: forbiddenCall("metadata") },
    } }
    const logs = []
    const logger = Object.fromEntries(["debug", "trace", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level, args })]))
    logger.isLevelEnabled = () => true
    const manager = {
      get: id => id === "fixture" ? {} : undefined,
      getSharedServiceConnection: async () => pinned,
      getServiceDirectoryForPath: async (_id, directory) => directory === location.directory ? directory : undefined,
      ownsLocation: async (_id, candidate) => candidate.directory === location.directory,
      getWorktreeIdentityForPath: async () => "fixture", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
    }
    const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger })
    const sources = new PluginSources({ documents: controls, logger, catalog: { read: forbiddenCall("catalogue") } })
    const app = Fastify({ logger: false })
    registerRequestLogging(app, logger)
    app.addHook("onRequest", async request => { request.log = logger })
    app.addHook("onRequest", async (request, reply) => { if (request.headers.authorization !== "Bearer fixture") return reply.code(401).send({ error: "Unauthorized" }) })
    registerPluginSourceRoutes(app, { sources })
    const base = await app.listen({ host: "127.0.0.1", port: 0 })
    const protectedFiles = [path.join(root, "scene.blend"), path.join(root, "installed-host"), path.join(root, "user-data")]
    for (const protectedFile of protectedFiles) await writeFile(protectedFile, "preserve")
    try {
      const snapshot = await controls.read("fixture", location)
      const declaration = snapshot.configured.sources.find(source => source.target === target)
      const expectedRevision = snapshot.targets.find(target => target.scope === "global").expectedRevision
      assert.match(expectedRevision, /^[a-f0-9]{64}$/)
      const body = { location, scope: "global", target, entryIndex: declaration.entryIndex, expectedRevision }
      const remove = async (payload, authorized = true) => {
        const response = await fetch(`${base}/api/workspaces/fixture/plugin-sources`, { method: "DELETE",
          headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer fixture" } : {}) }, body: JSON.stringify(payload) })
        const text = await response.text()
        assertNoSentinels(text, { port: host.port }, "source response")
        return { status: response.status, body: JSON.parse(text) }
      }
      const original = await readFile(file, "utf8")
      assert.equal((await remove(body, false)).status, 401)
      assert.equal((await remove({ ...body, location: { directory: path.join(root, "foreign") } })).status, 403)
      assert.equal((await remove({ ...body, expectedRevision: undefined })).status, 400)
      const changed = original.replace('"options":{}', '"options":{"changed":true}')
      await writeFile(file, changed)
      assert.equal((await remove(body)).status, 409, "options at the same source/index changed after confirmation")
      assert.equal(await readFile(file, "utf8"), changed)
      await writeFile(file, original)
      assert.equal((await remove(body)).status, 200, "unknown catalogue and a live binding do not block source removal")
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { plugins: ["-kept.plugin"], keep: true })
      assert.deepEqual(forbidden, [], "zero catalogue/status/binding/census/detach/metadata calls during removal")
      assert.deepEqual((await client.session.get({ sessionID: session.id, location })).metadata, metadata, "Q8 and unrelated metadata retained")
      for (const protectedFile of protectedFiles) assert.equal(await readFile(protectedFile, "utf8"), "preserve")
      assertNoSentinels(logs, { port: host.port }, "source debug/trace logs")
      console.log("PASS D25 native HTTP: authenticated exact-source removal with active binding; options stale refusal; no catalogue/status/detach/census/Q8 writes; files preserved")
    } finally { await app.close() }
  }, { registry: registry.url })
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await scan(full)
      else if (entry.name.endsWith(".log")) assertNoSentinels(await readFile(full, "utf8"), { port: host.port }, "native fixture logs")
    }
  }
  await scan(fixtureRoot)
} finally { await host.close(); await registry.close() }
