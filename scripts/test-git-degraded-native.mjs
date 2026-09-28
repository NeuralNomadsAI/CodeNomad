// Explicit isolated CLI, private database and local provider: never shared services.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import Fastify from "fastify"
import pino from "pino"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "codenomad-git-degraded-"))
const project = path.join(root, "project"), emptyPath = path.join(root, "empty-path")
await mkdir(project)
await mkdir(emptyPath)
execFileSync("git", ["init", project], { stdio: "ignore" })
const original = { ...process.env }
const env = Object.fromEntries(Object.entries(original).filter(([key]) => !/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key) && key.toLowerCase() !== "path"))
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
const password = randomUUID()
Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root, PATH: emptyPath,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_SERVER_PASSWORD: password })
await mkdir(env.OPENCODE_CONFIG_DIR)
const requests = []
let providerError
const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    if (!body.stream) {
      res.setHeader("Content-Type", "application/json")
      return res.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Git installation help" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    }
    res.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
    }) + "\n\n")
    chunk({ role: "assistant", content: "Git installation help" }); chunk({}, "stop"); res.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; res.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", providers: { fixture: {
  package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} },
} } })
let output = "", spawnError, app, manager
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.on("error", error => { spawnError = error })
child.stdout.on("data", data => { output += data })
child.stderr.on("data", data => { output += data })
try {
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(output)
    await delay(25)
  }
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
  const endpoint = { url, auth: { type: "basic", username: "opencode", password } }
  const boundedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) })
  const native = OpenCode.make({ baseUrl: url, headers, fetch: boundedFetch })
  const info = await native.server.info()
  const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const { WorkspaceManager } = await tsImport("../packages/server/src/workspaces/manager.ts", import.meta.url)
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const { registerInstanceProxyRoutes } = await tsImport("../packages/server/src/server/http-server.ts", import.meta.url)
  const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
  const logger = pino({ level: "silent" })
  manager = new WorkspaceManager({ rootDir: root, settings: { getOwner: () => ({ environmentVariables: {} }) },
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "isolated" }) }, eventBus: new EventBus(), logger,
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }),
  })
  const { workspace } = await manager.create(project)
  assert.equal((await manager.getWorktrees(workspace.id, "fresh")).gitAvailable, false)
  app = Fastify()
  registerInstanceProxyRoutes(app, { workspaceManager: manager, logger, worktreeDeletionFence: new WorktreeDeletionFence() })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const proxy = OpenCode.make({ baseUrl: `http://127.0.0.1:${app.server.address().port}/workspaces/${workspace.id}/instance/`, fetch: boundedFetch })
  const session = await proxy.session.create({ location: { directory: project } })
  await proxy.session.instructions.entry.remove({ sessionID: session.id, key: "codenomad.voice-mode" })
  await proxy.session.instructions.entry.put({ sessionID: session.id, key: "codenomad.session-placement", value: "Keep the chosen directory." })
  await proxy.session.prompt({ sessionID: session.id, text: "Help me install Git for this machine." })
  await proxy.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
  if (providerError) throw providerError
  assert.ok(requests.some(body => body.stream && JSON.stringify(body.messages).includes("CodeNomad cannot run Git")), "the real model request must include degraded context")
  assert.match(JSON.stringify(await proxy.message.list({ sessionID: session.id, limit: 100 })), /Git installation help/)
  assert.ok((await native.session.instructions.entry.list({ sessionID: session.id })).some(entry => entry.key === "codenomad.git-availability"))
  // Recover backend PATH only; no shared/native daemon restart is needed for the check.
  delete process.env.PATH
  for (const [key, value] of Object.entries(original)) if (key.toLowerCase() === "path") process.env[key] = value
  await proxy.session.prompt({ sessionID: session.id, text: "Continue the conversation." })
  await proxy.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
  const entries = await native.session.instructions.entry.list({ sessionID: session.id })
  assert.ok(!entries.some(entry => entry.key === "codenomad.git-availability"))
  assert.ok(entries.some(entry => entry.key === "codenomad.session-placement"))
  assert.equal((await native.server.info()).pid, info.pid)
  console.log(`PASS OpenCode ${info.version}: no Git in backend or daemon PATH; workspace + instructions + prompt + model context + answer; context removed after backend PATH recovery`)
} finally {
  await app?.close()
  await manager?.shutdown()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, original)
  try { await stopFixtureChild(child, stopped) } finally {
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    await writeFile(path.join(root, "daemon.log"), output)
    console.log(`Isolated fixture: ${root}`)
  }
}
