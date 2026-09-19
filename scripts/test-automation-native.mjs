// Explicit isolated CLI only: no service discovery, real provider, or user database.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { watch } from "node:fs"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute CLI executable path for isolated testing")
const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim().replace(/^opencode2? v/, "")
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await realpath(await mkdtemp(path.join(temporary, "codenomad-automation-native-")))
const project = path.join(root, "arbitrary-project")
await mkdir(project)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_|CODENOMAD_)/.test(key)))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
Object.assign(env, {
  USERPROFILE: root, HOME: root, OPENCODE_TEST_HOME: root, LOCALAPPDATA: root, XDG_RUNTIME_DIR: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_SERVER_PASSWORD: "isolated-automation-fixture", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
})
delete env.WSL_DISTRO_NAME
await mkdir(env.OPENCODE_CONFIG_DIR)
const { DesktopPluginLifecycle, prepareDesktopPluginPresence } = await tsImport("../packages/server/src/opencode/desktop-plugin-lifecycle.ts", import.meta.url)
const { resolveDesktopPluginPaths } = await tsImport("../packages/server/src/opencode/desktop-plugin-paths.ts", import.meta.url)
const { createAutomationBridgeRegistration, publishAutomationBridge } = await tsImport("../packages/server/src/opencode/automation-plugin.ts", import.meta.url)
const { registerAutomationPluginRoute } = await tsImport("../packages/server/src/server/routes/automation-plugin.ts", import.meta.url)
const oldEnv = Object.fromEntries(["LOCALAPPDATA", "XDG_RUNTIME_DIR", "WSL_DISTRO_NAME",
  "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].map(key => [key, process.env[key]]))
process.env.LOCALAPPDATA = root
process.env.XDG_RUNTIME_DIR = root
delete process.env.WSL_DISTRO_NAME
// The existing daemon has a different environment from this new backend and
// any proposed future-start overrides. Only its authenticated config API counts.
process.env.OPENCODE_CONFIG_DIR = path.join(root, "next-start-config")
process.env.XDG_CONFIG_HOME = path.join(root, "next-start-xdg-config")
process.env.XDG_DATA_HOME = path.join(root, "next-start-data")
const configFile = path.join(env.OPENCODE_CONFIG_DIR, "opencode.json")
await writeFile(configFile, "{}\n")

let client, developer = false, callBrowser = false, providerError
let observedTools = []
const nativeCalls = []
const bridge = Fastify()
let registration = createAutomationBridgeRegistration("http://127.0.0.1")
registerAutomationPluginRoute(bridge, {
  bridgeToken: registration.token,
  authManager: { isLoopbackRequest: request => request.ip === "127.0.0.1" },
  workspaceManager: {
    getSharedServiceClient: async () => client,
    list: () => [{ id: "unrelated" }, { id: "fixture" }],
    ownsLocation: async (id, location) => {
      if (id === "unrelated") throw new Error("Synthetic unavailable unrelated native inventory")
      return path.resolve(location.directory).toLowerCase() === project.toLowerCase()
    },
  },
  nativeParent: {
    available: true,
    request: async (method, params) => {
      if (method === "developer.status") return { status: developer
        ? { state: "ready", cdpUrl: "http://127.0.0.1:1", runId: "fixture", nativeIdentity: "fixture", windowId: "fixture" }
        : { state: "stopped" } }
      nativeCalls.push({ method, params })
      return method === "browser.probe" ? { available: true } : { text: "NATIVE_BROWSER_FIXTURE" }
    },
  },
})
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const primary = request.headers["x-automation-kind"] === "primary"
    if (primary) observedTools = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean)
    const invoke = primary && callBrowser
    if (invoke) {
      assert(observedTools.includes("codenomad_browser"), "Native model catalog must contain the browser tool")
      callBrowser = false
    }
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
      return
    }
    response.setHeader("content-type", "text/event-stream")
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`)
    chunk({ role: "assistant" })
    if (invoke) chunk({ tool_calls: [{ index: 0, id: `fixture-${Date.now()}`, type: "function", function: {
      name: "codenomad_browser", arguments: JSON.stringify({ action: "open", url: "https://example.com" }),
    } }] })
    else chunk({ content: "Done" })
    chunk({}, invoke ? "tool_calls" : "stop")
    response.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; response.destroy(error) }
})
let child, stopped, first, second, removeBridge, output = ""
async function until(predicate) {
  for (let i = 0; i < 600; i++) {
    if (providerError) throw providerError
    if (await predicate()) return
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Isolated CLI exited: ${output}`)
    await delay(100)
  }
  throw new Error(`Isolated condition timed out: ${output.slice(-6000)}`)
}
try {
  await bridge.listen({ host: "127.0.0.1", port: 0 })
  registration = { ...registration, url: `http://127.0.0.1:${bridge.server.address().port}/api/opencode-plugin/automation` }
  removeBridge = await publishAutomationBridge(registration)
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  await mkdir(path.join(root, "fixture-plugin"))
  const setupLog = path.join(root, "plugin-setup.log")
  await writeFile(path.join(root, "fixture-plugin", "index.ts"), `import { appendFile } from 'node:fs/promises'
  export default { id: 'automation-fixture', async setup(ctx) {
    await appendFile(${JSON.stringify(setupLog)}, 'setup\\n')
    await ctx.session.hook('http.request', event => event.request.headers.set('x-automation-kind', event.kind))
  } }`)
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    model: "fixture/fixture", permissions: [{ action: "*", resource: "*", effect: "allow" }],
    providers: { fixture: { package: `${version === "0.0.0-beta-19271" ? "@opencode-ai" : "@opencode"}/ai/providers/openai-compatible`,
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } },
    plugins: [path.join(root, "fixture-plugin")],
  })
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  // Reuse production contract negotiation without ever performing service discovery.
  const { OpenCodeCliService } = await tsImport("../packages/server/src/workspaces/opencode-cli-service.ts", import.meta.url)
  const { OpenCodeSharedService } = await tsImport("../packages/server/src/workspaces/opencode-service.ts", import.meta.url)
  const lifecycle = new OpenCodeCliService({ label: "Isolated automation", timeoutMs: 5000,
    command: args => ({ command: cli, args, options: {} }),
  }, { execFile: async (_file, args) => ({ stdout: args.join(" ") === "service get password" ? env.OPENCODE_SERVER_PASSWORD : baseUrl, stderr: "" }) })
  const shared = new OpenCodeSharedService()
  client = await shared.client({ kind: "lifecycle", identity: "isolated-automation", lifecycle })
  const openPresence = async () => {
    const backend = new OpenCodeSharedService()
    const automation = new DesktopPluginLifecycle("automation")
    const pruning = new DesktopPluginLifecycle("session-pruning")
    try {
      await backend.client({ kind: "lifecycle", identity: "isolated-backend", lifecycle,
        prepareDesktopPlugins: async connection => {
          const paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: cli })
          assert.equal(paths.config, env.OPENCODE_CONFIG_DIR)
          await prepareDesktopPluginPresence(paths, connection.assertCurrent, { pruning, automation })
          return true
        },
      })
      return async () => { await automation.stop(); await pruning.stop(); await backend.shutdown() }
    } catch (error) {
      await automation.stop(); await pruning.stop(); await backend.shutdown()
      throw error
    }
  }
  const location = { directory: project }
  const session = await client.session.create({ location })
  const sample = async () => {
    await client.session.prompt({ sessionID: session.id, text: "Conclude briefly." })
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) })
    if (providerError) throw providerError
    return observedTools.filter(name => name.startsWith("codenomad_")).sort()
  }
  assert.deepEqual(await sample(), [], "No automation definitions before backend provisioning")
  first = await openPresence()
  assert.equal(await readFile(configFile, "utf8"), "{}\n", "Provisioning preserves the daemon's user configuration")
  for (const directory of [process.env.OPENCODE_CONFIG_DIR, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME]) {
    await assert.rejects(readFile(path.join(directory, "plugins", "codenomad-automation.ts")), { code: "ENOENT" })
  }
  await until(async () => (await client.plugin.list({ location })).data.some(plugin => plugin.id === "codenomad.automation" && plugin.state.status === "active"))
  await until(async () => (await client.plugin.list({ location })).data.some(plugin => plugin.id === "codenomad-session-pruning" && plugin.state.status === "active"))
  await until(async () => (await sample()).includes("codenomad_browser"))
  const allTools = ["codenomad_act", "codenomad_browser", "codenomad_inspect", "codenomad_screenshot"]
  assert.deepEqual(await sample(), allTools, "Backend presence exposes all tools independently of Developer Mode")
  // Keep project discovery disabled to exclude real ancestor configuration.
  // That also disables OpenCode's config watcher, so explicitly observe the
  // same directory with an OS watcher rather than accept a false-positive test.
  await delay(2_500)
  const setupBeforeHeartbeat = await readFile(setupLog, "utf8")
  const configChanges = []
  const configWatcher = watch(env.OPENCODE_CONFIG_DIR, { recursive: true }, (event, filename) => configChanges.push({ event, filename }))
  try {
    await delay(5_000)
    assert.deepEqual(configChanges, [], "Backend heartbeats must not modify the watched configuration tree")
  } finally {
    configWatcher.close()
  }
  assert.equal(await readFile(setupLog, "utf8"), setupBeforeHeartbeat, "Backend heartbeats must not reload native configuration/plugins")
  const skills = await client.skill.list({ location })
  assert(JSON.stringify(skills).includes("codenomad-browser"), "Bundled skill is visible in an arbitrary project")
  callBrowser = true
  await sample()
  assert.equal(nativeCalls.length, 1)
  assert.equal(nativeCalls[0].method, "browser.execute")
  assert.equal(nativeCalls[0].params.sessionID, session.id)
  const denied = await bridge.inject({ method: "POST", url: "/api/opencode-plugin/automation",
    headers: { "x-codenomad-automation-token": registration.token },
    payload: { mode: "developer-execute", sessionID: session.id, command: { action: "inspect" } },
  })
  assert.equal(denied.statusCode, 404)
  second = await openPresence()
  await first(); first = undefined
  await delay(2_100)
  assert.deepEqual(await sample(), allTools)
  await second(); second = undefined
  await until(async () => (await sample()).length === 0)
  assert(!JSON.stringify(await client.skill.list({ location })).includes("codenomad-browser"))
  first = await openPresence()
  await until(async () => (await sample()).length === 4)
  assert.deepEqual(await sample(), allTools)
  console.log(`PASS ${version}: connected-daemon discovery despite backend environment mismatch, automation and pruning provisioning, stable native plugins across heartbeats, late native discovery, arbitrary project, all definitions without Developer Mode, browser execution, native target fences, independent leases, clean shutdown and reopening`)
} finally {
  await first?.(); await second?.(); await removeBridge?.()
  child?.kill()
  if (stopped) await stopped
  await bridge.close()
  await new Promise(resolve => provider.close(() => resolve()))
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
