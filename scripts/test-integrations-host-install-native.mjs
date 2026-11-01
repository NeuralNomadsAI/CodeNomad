// Run: node --import tsx scripts/test-integrations-host-install-native.mjs <absolute 2.2.5 CLI> [integration checkout]
// Uses the existing built kit read-only; never launches Blender or installs an application payload.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import { assertNoSentinels, FAKE_INTEGRATION_SENTINELS, fakeIntegrationMarker, startFakeHost } from "./fixtures/fake-integration/index.mjs"
import { fixtureEnvironment, withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { IntegrationCatalogSource } from "../packages/server/src/opencode/integrations/catalog.ts"
import { catalogEntry, catalogOf } from "../packages/server/src/opencode/integrations/catalog-fixture.ts"
import { IntegrationAttachments } from "../packages/server/src/opencode/integrations/attachments.ts"
import { registerIntegrationAttachmentRoutes } from "../packages/server/src/server/routes/integration-attachments.ts"
import { registerRequestLogging } from "../packages/server/src/server/request-logging.ts"

const checkout = path.resolve(process.argv[3] ?? "D:/opencode_bundles-work/opencode-integrations")
const probes = {
  environment: { env: { WSL_DISTRO_NAME: "FixtureWSL" }, version: "Linux version 6.8.0-generic" },
  kernel: { env: {}, version: "Linux version 6.6.87.2-microsoft-standard-WSL2" },
  linux: { env: {}, version: "Linux version 6.8.0-generic" },
}
const ids = Object.keys(probes).map(name => `install-${name}`)
const host = await startFakeHost({ leaky: true })
const check = (value, label) => assertNoSentinels(value, { port: host.port }, label)
let fixtureRoot

async function until(label, probe) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await probe()) return
    await delay(25)
  }
  throw new Error(`Timed out: ${label}`)
}

async function git(args, env) {
  const child = spawn("git", args, { cwd: checkout, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk })
  child.stderr.on("data", chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject) })
  assert.equal(code, 0, "Read-only integration checkout qualification succeeds")
  return output.trim()
}

// Snapshot every readable fixture file. Only the daemon's database, internal cache and log
// files are mutable runtime state; config, catalog, npm and all installer targets stay covered.
async function snapshot(root) {
  const result = {}
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      const relative = path.relative(root, file).replaceAll("\\", "/")
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        try { result[relative] = createHash("sha256").update(await readFile(file)).digest("hex") }
        catch (error) { if (error.code !== "ENOENT") throw error }
      }
    }
  }
  await visit(root)
  return result
}
const runtimeFile = file => /^fixture\.db(?:-shm|-wal)?$/.test(file)
  || /^XDG_(?:CACHE|DATA|STATE)_HOME\/opencode\/(?:log\/|cache\/|[^/]+\.db(?:-shm|-wal)?$)/.test(file)
const protectedFiles = files => Object.fromEntries(Object.entries(files).filter(([file]) => !runtimeFile(file)))

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
    const privateBlender = Object.fromEntries(["SCRIPTS", "DATAFILES", "PYTHON"].map(key =>
      [`BLENDER_SYSTEM_${key}`, path.join(root, "blender-system", key.toLowerCase())]))
    // Git receives explicit private Blender overrides; the daemon helper scrubs every
    // inherited Blender override and never starts Blender.
    const env = await fixtureEnvironment(root, privateBlender)
    await git(["merge-base", "--is-ancestor", "b6fad3fe", "HEAD"], env)
    console.log(`Real integration kit revision: ${await git(["rev-parse", "HEAD"], env)}`)
    const manifest = JSON.parse(await readFile(path.join(checkout, "packages/integration-kit/package.json"), "utf8"))
    const kit = pathToFileURL(path.join(checkout, "packages/integration-kit", manifest.exports["."].import)).href
    await readFile(new URL(kit))
    const plugins = []
    for (const [name, probe] of Object.entries(probes)) {
      const id = `install-${name}`
      const marker = fakeIntegrationMarker(id)
      const directory = path.join(root, id)
      await mkdir(directory)
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: `@neuralnomads/opencode-${id}`,
        version: "0.1.0", type: "module", exports: { ".": "./index.js" }, opencodeIntegration: marker }))
      await writeFile(path.join(directory, "index.js"), `
import { appendFile } from "node:fs/promises"
import { createIntegrationRpc, sharedOfferRegistry, isWslDaemon } from ${JSON.stringify(kit)}
const marker = ${JSON.stringify(marker)}
const probe = ${JSON.stringify(probe)}
const key = Symbol.for(marker.rpc + ".installer-audit")
const audit = globalThis[key] ??= { callbackCount: 0, installCalls: 0 }
const registry = sharedOfferRegistry(marker.id, { expected: marker.host })
const wsl = () => isWslDaemon({ platform: "linux", env: probe.env, procVersion: () => probe.version })
if (wsl() !== ${name !== "linux"}) throw new Error("The real kit detector must recognize the fixture probe")
export default { id: marker.plugin, async setup(ctx) {
  const rpc = createIntegrationRpc({ marker, version: "0.1.0", registry, wsl,
    inspectHost: async () => ({ kind: "not-found" }),
    installHost: async () => {
      audit.callbackCount++
      await appendFile(${JSON.stringify(path.join(root, `installer-${name}.sentinel`))}, "private installer callback\\n")
      return { outcome: "installed", detail: "Private fixture installation completed" }
    },
  })
  const install = rpc.handlers.installHost
  rpc.handlers.installHost = input => { audit.installCalls++; return install(input) }
  const registration = await ctx.rpc.register(rpc.definition, rpc.handlers)
  const inspection = await ctx.rpc.register({ id: marker.rpc + ".audit", events: {}, methods: { read: {
    input: { type: "object", additionalProperties: false }, output: { type: "object", properties: {
      callbackCount: { type: "integer" }, installCalls: { type: "integer" }, wsl: { type: "boolean" }
    }, required: ["callbackCount", "installCalls", "wsl"], additionalProperties: false }
  } } }, { read: async () => ({ ...audit, wsl: wsl() }) })
  const disconnect = rpc.connect(registration)
  return async () => { disconnect(); await inspection.dispose(); await registration.dispose() }
} }
`)
      plugins.push({ package: directory, options: {} })
    }
    await writeFile(path.join(configDirectory, "opencode.jsonc"), JSON.stringify({ plugins }))
    return {}
  }, async ({ root, env, requests, connection: fixtureConnection }) => {
    assert(Object.keys(env).every(key => !/^BLENDER_|^PYTHON(PATH|HOME)$/.test(key)), "Daemon inherits no user Blender or Python overrides")
    const info = await fixtureConnection.client.server.info()
    assert.equal(info.version, "2.2.5")
    console.log(`Native runtime: ${info.version}`)
    const authorization = `Basic ${Buffer.from(`opencode:${fixtureConnection.endpoint.auth.password}`).toString("base64")}`
    const client = OpenCode.make({ baseUrl: fixtureConnection.endpoint.url, headers: { authorization }, fetch: (input, init) =>
      new URL(input instanceof Request ? input.url : input).pathname === "/api/event" ? fetch(input, init) : fixtureConnection.fetch(input, init) })
    const location = (await client.location.get({ location: { directory: root } })).directory
    const calls = [], logs = [], native = [], frames = [], measurements = []
    const logger = Object.fromEntries(["debug", "trace", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level, args })]))
    logger.isLevelEnabled = () => true
    const connection = { ...fixtureConnection, client: { ...client, rpc: { ...client.rpc, call: (request, options) => {
      calls.push({ rpcID: request.rpcID, method: request.method, input: request.method === "installHost" ? request.input : undefined })
      return client.rpc.call(request, options)
    } } } }
    const manager = {
      get: id => id === "w" ? { id, path: location } : undefined,
      getSharedServiceConnection: async () => connection,
      ownsLocation: async (id, candidate) => id === "w" && candidate.directory === location && candidate.workspaceID === undefined,
      getServiceDirectoryForPath: async (_id, directory) => directory === location ? location : undefined,
      getWorktreeIdentityForPath: async (_id, directory) => directory === location ? location : undefined,
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined,
      getHostPathForServicePath: async (_id, directory) => directory,
    }
    const controls = new PluginControls({ workspaceManager: manager, logger, worktreeDeletionFence: { enter: () => () => {} } })
    const rpc = async (name, method, input = {}, audit = false) => {
      const { output } = await connection.client.rpc.call({ rpcID: `neuralnomads.install-${name}${audit ? ".audit" : ""}`,
        method, input, location: { directory: location } })
      check(output, "native RPC output")
      return output
    }
    await until("three real-kit native plugins active", async () => {
      const snapshot = await controls.read("w", { directory: location })
      return ids.every(id => snapshot.runtime.some(item => item.id === `neuralnomads.${id}` && item.state.status === "active"))
    })
    let catalogBase, catalogRequests = 0, catalogReads = 0
    const document = catalogOf(...ids.map(id => catalogEntry(id)))
    const catalogServer = createServer((request, response) => {
      catalogRequests++
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(request.url === "/releases" ? [{ tag_name: "catalog-v1", draft: false, prerelease: false,
        assets: [{ name: "catalog.json", id: 1, updated_at: "2026-01-01T00:00:00Z", url: `${catalogBase}/catalog` }] }] : document))
    })
    await new Promise(resolve => catalogServer.listen(0, "127.0.0.1", resolve))
    catalogBase = `http://127.0.0.1:${catalogServer.address().port}`
    const sources = new Map()
    const catalogFor = label => {
      if (!sources.has(label)) sources.set(label, new IntegrationCatalogSource({ releasesUrl: `${catalogBase}/releases`,
        stateFile: path.join(root, "catalog-state", `${label}.json`), cacheMs: 0, logger }))
      return { read: options => { catalogReads++; return sources.get(label).read(options) } }
    }
    // Model the GUI's demanded read before installation consent. A zero cache duration
    // makes accidental refreshes during the measured action observable as catalogue HTTP.
    const primeCatalog = async label => {
      const before = catalogRequests
      assert.equal((await catalogFor(label).read()).state, "fresh")
      assert.equal(catalogRequests - before, 2)
      await readFile(path.join(root, "catalog-state", `${label}.json`))
    }
    const streamController = new AbortController()
    const nativeTask = (async () => { for await (const event of client.event.subscribe({ signal: streamController.signal })) {
      check(event, "native event"); native.push(event)
    } })()
    void nativeTask.catch(() => {})
    const stream = await fetch(`${fixtureConnection.endpoint.url}/api/event`, { headers: { authorization }, signal: streamController.signal })
    assert.equal(stream.status, 200)
    const sseTask = (async () => {
      let pending = ""
      const decoder = new TextDecoder()
      for await (const chunk of stream.body) {
        pending += decoder.decode(chunk, { stream: true })
        let end
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2)
          check(frame, "native HTTP SSE frame"); frames.push(frame)
        }
      }
    })()
    void sseTask.catch(() => {})
    await until("both native event streams connected", () => native.length > 0 && frames.length > 0)
    let service
    const app = Fastify({ logger: false })
    registerRequestLogging(app, logger)
    app.addHook("onRequest", async request => { request.log = logger })
    registerIntegrationAttachmentRoutes(app, { attachments: { installHost: (...args) => service.installHost(...args),
      hosts: (...args) => service.hosts(...args), attach: (...args) => service.attach(...args), detach: (...args) => service.detach(...args) } })
    const base = await app.listen({ host: "127.0.0.1", port: 0 })
    const request = async (name, expected, body = {}, query = "") => {
      const response = await fetch(`${base}/api/workspaces/w/integrations/install-${name}/install-host?directory=${encodeURIComponent(location)}${query}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      const text = await response.text()
      check(text, "HTTP response"); check([...response.headers], "HTTP headers")
      assert.equal(response.status, expected, "Actual install-host route status")
      assert.equal(response.headers.get("cache-control"), "no-store")
      return JSON.parse(text)
    }
    const configure = (label, options = {}) => {
      const { selected, ...hostOptions } = options
      service = new IntegrationAttachments({ controls, workspaceManager: { ...manager,
        getServiceWslDistro: () => selected ? "FixtureWSL" : undefined }, catalog: catalogFor(label),
        hostPlatform: "linux", hostEnv: {}, readKernelVersion: async () => probes.linux.version, ...hostOptions })
    }
    const installationCalls = () => calls.filter(call => call.method === "installHost").length
    try {
      for (const name of ["environment", "kernel"]) {
        for (const offered of [false, true]) {
          if (offered) {
            const beforeHello = host.requests.length
            assert.equal((await rpc(name, "advertise", host.advertiseInput())).outcome, "accepted")
            assert.equal(host.requests.length, beforeHello + 1, "The real registry validates an authenticated network hello")
            assert(host.requests.at(-1).authorized && host.requests.at(-1).method === "hello")
          }
          const status = await rpc(name, "status")
          assert.equal(status.host.state, offered ? "ok" : "unsupported")
          assert.equal(status.connection.offers, Number(offered))
          const auditBefore = await rpc(name, "read", {}, true)
          assert.equal(auditBefore.wsl, true)
          for (const guard of ["selected", "backend"]) {
            const label = `${name}-${offered}-${guard}`
            configure(label, guard === "selected" ? { selected: true, hostPlatform: "win32" }
              : { hostEnv: probes[name].env, readKernelVersion: async () => probes[name].version })
            // Authorization/native warmup and offer admission precede the filesystem baseline.
            assert(await manager.ownsLocation("w", { directory: location }))
            const before = await snapshot(root)
            const counters = { reads: catalogReads, requests: catalogRequests, rpc: calls.length, install: installationCalls() }
            assert.equal((await request(name, 409)).code, "unsupported")
            assert.equal(catalogReads, counters.reads, "WSL refusal precedes even catalog.read")
            assert.equal(catalogRequests, counters.requests)
            assert.equal(calls.length, counters.rpc, "Early WSL refusal dispatches zero native RPCs")
            assert.equal(installationCalls(), counters.install)
            const after = await snapshot(root)
            assert.deepEqual(protectedFiles(after), protectedFiles(before), "Early refusal changes no protected fixture file")
            assert.deepEqual(await rpc(name, "read", {}, true), auditBefore)
            const measurement = { label, catalogReads: 0, catalogHTTP: 0, nativeRPC: 0, installRPC: 0, callbacks: 0,
              snapshotFiles: Object.keys(before).length, protectedFileChanges: 0 }
            measurements.push(measurement)
            console.log(`PASS ${JSON.stringify(measurement)}`)
          }
          // A backend without WSL knowledge sees an unsupported status without an offer;
          // the mirrored offer changes status to ok, reaching the real kit installHost guard.
          const label = `${name}-${offered}-kit`
          configure(label)
          await primeCatalog(label)
          const before = await snapshot(root)
          const counters = { reads: catalogReads, requests: catalogRequests, rpc: calls.length }
          const installs = installationCalls()
          const response = await request(name, offered ? 200 : 409)
          assert.deepEqual(response, offered ? { outcome: "refused" } : { error: "Integration attachment unsupported", code: "unsupported" })
          assert.equal(catalogReads - counters.reads, 1, "Installation reads the already-demanded catalogue")
          assert.equal(catalogRequests, counters.requests, "Kit refusal refreshes no catalogue")
          assert.equal(calls.length - counters.rpc, 1 + Number(offered), "Only status and, with an offer, installHost are dispatched")
          assert.equal(installationCalls() - installs, Number(offered))
          let audit = await rpc(name, "read", {}, true)
          assert.equal(audit.callbackCount, 0)
          assert.equal(audit.installCalls - auditBefore.installCalls, Number(offered))
          // Also exercise kit installHost without an offer, independent of the service status gate.
          if (!offered) {
            const direct = await rpc(name, "installHost", { target: "default" })
            assert.equal(direct.outcome, "refused")
            audit = await rpc(name, "read", {}, true)
            assert.equal(audit.callbackCount, 0)
            assert.equal(audit.installCalls - auditBefore.installCalls, 1)
          }
          const after = await snapshot(root)
          assert.equal(catalogRequests, counters.requests)
          assert.deepEqual(protectedFiles(after), protectedFiles(before), "Kit refusal changes no protected fixture file, including the catalogue")
          const measurement = { label, catalogReads: catalogReads - counters.reads, catalogHTTP: catalogRequests - counters.requests,
            routeNativeRPC: 1 + Number(offered), routeInstallRPC: Number(offered), kitInstallRPC: audit.installCalls - auditBefore.installCalls,
            callbacks: audit.callbackCount - auditBefore.callbackCount, snapshotFiles: Object.keys(before).length, protectedFileChanges: 0 }
          measurements.push(measurement)
          console.log(`PASS ${JSON.stringify(measurement)}`)
          if (offered) assert.equal((await rpc(name, "withdraw", { offer_key: FAKE_INTEGRATION_SENTINELS.offerKey, token: host.token })).outcome, "withdrawn")
        }
      }
      configure("linux-positive")
      await primeCatalog("linux-positive")
      const beforePositive = await rpc("linux", "read", {}, true)
      assert.equal(beforePositive.wsl, false)
      const beforeFiles = await snapshot(root)
      const beforeHTTP = catalogRequests
      const installs = installationCalls()
      assert.deepEqual(await request("linux", 200), { outcome: "installed" })
      assert.equal(catalogRequests, beforeHTTP, "Linux installation refreshes no catalogue")
      const positive = await rpc("linux", "read", {}, true)
      assert.equal(positive.callbackCount - beforePositive.callbackCount, 1)
      assert.equal(positive.installCalls - beforePositive.installCalls, 1)
      assert.equal(installationCalls() - installs, 1)
      assert.equal(await readFile(path.join(root, "installer-linux.sentinel"), "utf8"), "private installer callback\n")
      const afterFiles = protectedFiles(await snapshot(root))
      delete afterFiles["installer-linux.sentinel"]
      assert.deepEqual(afterFiles, protectedFiles(beforeFiles), "Linux installation changes only its private installer sentinel")
      console.log("PASS Linux positive: installRPC=1, installer callback=1, private sentinel writes=1, catalogue HTTP/writes=0, HTTP outcome-only projection")
      const beforeInvalidFiles = await snapshot(root)
      const beforeInvalid = calls.length
      const beforeInvalidReads = catalogReads
      await request("linux", 400, { ...FAKE_INTEGRATION_SENTINELS, port: host.port })
      await request("linux", 400, {}, `&offer_key=${FAKE_INTEGRATION_SENTINELS.offerKey}`)
      assert.equal(calls.length, beforeInvalid)
      assert.equal(catalogReads, beforeInvalidReads)
      assert.equal(catalogRequests, beforeHTTP)
      assert.deepEqual(protectedFiles(await snapshot(root)), protectedFiles(beforeInvalidFiles), "Malformed refusals change no protected fixture file")
      for (const call of calls.filter(call => call.method === "installHost")) assert.deepEqual(call.input, { target: "default" })
      assert.equal((await readdir(root)).filter(file => /^installer-.*\.sentinel$/.test(file)).join(), "installer-linux.sentinel")
      await until("genuine kit events received on SDK and raw SSE", () => native.some(event => event.type.startsWith("rpc.neuralnomads.install-"))
        && frames.some(frame => frame.includes("rpc.neuralnomads.install-")))
      check(native, "native stream"); check(frames, "HTTP SSE"); check(logs, "debug/trace route logs")
      for (const level of ["debug", "trace"]) assert(logs.some(entry => entry.level === level && entry.args[1] ===
        (level === "debug" ? "HTTP request completed" : "HTTP request payload")))
      assert.equal(requests.length, 0, "No provider is contacted")
      await writeFile(path.join(root, "host-install-measurements.json"), JSON.stringify({ runtime: info.version, measurements,
        nativeEvents: native.length, sseFrames: frames.length, installRPCs: installationCalls(), providerRequests: requests.length }, null, 2))
      console.log(`PASS sentinel scans: nativeEvents=${native.length}, SSEframes=${frames.length}, routeLogs=${logs.length}; providerRequests=0`)
      console.log("NOT RUN: manual AC-B4 or an installed user's Blender")
    } finally {
      streamController.abort()
      await Promise.allSettled([nativeTask, sseTask])
      await app.close()
      catalogServer.closeAllConnections()
      await new Promise(resolve => catalogServer.close(resolve))
      check(logs, "final route logs")
    }
  })
  await scanLogs(fixtureRoot)
  console.log("PASS native host-install proof; daemon and fixture logs sentinel-free")
} finally {
  await host.close()
}
