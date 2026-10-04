// Investigative capability proof only. No product fallback or authority grant.
// Run from repository root with node packages/server/src/opencode/missions/autonomous-native-capability.test.mjs.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { ASSIGNED_CLI, privateRoot } from "../../../../../scripts/missions-child-environment/runtime.mjs"

const original = { ...process.env }
let child, closed, server, root, logs = "", providerRequests = 0
try {
  const isolated = await privateRoot(ASSIGNED_CLI)
  root = isolated.root
  const plugin = path.join(root, "capability-plugin")
  const evidenceFile = path.join(root, "plugin-capabilities.json")
  await mkdir(plugin)
  await writeFile(path.join(plugin, "index.mjs"), `import { writeFile } from "node:fs/promises";
export default { id: "private.autonomous.capability", async setup(ctx) {
  const client = ctx.client;
  await writeFile(${JSON.stringify(evidenceFile)}, JSON.stringify({
    version: ctx.app.version,
    contextKeys: Object.keys(ctx).sort(),
    clientPresent: client !== undefined,
    clientEnvironment: typeof client?.session?.environment === "function",
    sessionEnvironment: typeof ctx.session.environment === "function",
    sessionKeys: Object.keys(ctx.session).sort(),
    promptPresent: typeof ctx.session.prompt === "function",
    syntheticPresent: typeof ctx.session.synthetic === "function"
  }, null, 2));
} };`)
  // A local deterministic provider only; no public/free/paid provider or credential read.
  server = createServer((_request, response) => {
    providerRequests++
    response.writeHead(500, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ error: { message: "Capability proof must not invoke models" } }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ update: "disable", snapshots: false,
    model: "fixture/capability", plugins: [plugin],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "private-fixture" },
      models: { capability: {} } } } })
  const systemKeys = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "CHILD_ENV_MARKER"])
  // Do not inherit provider credentials from the invoking agent's environment.
  // All OPENCODE_/XDG_ values here were created by privateRoot above.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    systemKeys.has(key.toUpperCase()) || /^(OPENCODE_|XDG_)/i.test(key)))
  child = spawn(ASSIGNED_CLI, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
    { cwd: root, env: environment, windowsHide: true })
  closed = new Promise(resolve => child.once("close", resolve))
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data).slice(-1024 * 1024) })
  const watchdog = setTimeout(() => child.kill(), 45_000)
  watchdog.unref()
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(logs)) {
    assert(child.exitCode === null && Date.now() < deadline, "Private serve startup failed")
    await delay(50)
  }
  const client = OpenCode.make({ baseUrl: logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0],
    headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })
  const options = { signal: AbortSignal.timeout(10_000) }
  const info = await client.server.info(options)
  assert.equal(info.version, "2.0.22", "Qualification is version-specific")
  const session = await client.session.create({ title: "Private capability proof", location: { directory: isolated.project } }, options)
  // Forces location/plugin activation without admitting a model request.
  await client.plugin.list({ location: { directory: isolated.project } }, options)
  let evidence
  while (!evidence) {
    evidence = await readFile(evidenceFile, "utf8").then(JSON.parse).catch(() => undefined)
    assert(Date.now() < deadline, "Private plugin did not activate")
    if (!evidence) await delay(50)
  }
  assert.equal(evidence.clientPresent, false)
  assert.equal(evidence.clientEnvironment, false)
  assert.equal(evidence.sessionEnvironment, false)
  assert.equal(evidence.promptPresent, true)
  assert.equal(evidence.syntheticPresent, true)
  assert.equal(typeof client.session.environment, "function", "Authenticated HTTP client is distinct from plugin context")
  await client.session.environment({ sessionID: session.id, variables: { AUTONOMOUS_CAPABILITY_MARKER: "owned-client-only" } }, options)
  assert.equal(providerRequests, 0)
  await writeFile(path.join(root, "results.json"), JSON.stringify({ status: "passed-blocker-proof", nativeVersion: info.version,
    plugin: evidence, authenticatedClientEnvironmentWrite: true, providerRequests,
    productFallbackEnabled: false, actualDesktopCloseTest: false,
    limitation: "Plugin context has neither client nor session.environment; prior snapshot does not authorize fresh later send." }, null, 2))
  clearTimeout(watchdog)
  console.log(`PASS private native 2.0.22 capability blocker proof: ${root}`)
} finally {
  if (child && child.exitCode === null) child.kill()
  if (closed) await closed
  if (server) await new Promise(resolve => server.close(resolve))
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
}
