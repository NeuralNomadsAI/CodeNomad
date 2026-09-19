// Explicit isolated CLI only. Never discovers or restarts the user's service.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import pino from "pino"
import { tsImport } from "tsx/esm/api"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute OpenCode CLI executable path")
const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-session-environment-"))
const exec = promisify(execFile)
for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
Object.assign(process.env, {
  HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_CONFIG_DIR: path.join(root, "config"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_CONFIG_CONTENT: "{}",
})
const project = path.join(root, "project")
await mkdir(project)
await mkdir(process.env.OPENCODE_CONFIG_DIR)
for (const name of ["base", "first", "changed"]) await mkdir(path.join(root, name))
Object.assign(process.env, { TEMP: path.join(root, "base"), TMP: path.join(root, "base"), TMPDIR: path.join(root, "base") })
await writeFile(path.join(project, "probe.cjs"), `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR,tmpdir:require('node:os').tmpdir(),path:!!process.env.PATH}))`)
const run = async args => (await exec(cli, args, { cwd: root, env: process.env, timeout: 45_000, windowsHide: true })).stdout.trim()
const listener = net.createServer()
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
console.log(`Isolated fixture: ${root}`)
let started = false
let app, manager
try {
  assert.equal(await run(["service", "status"]), "stopped")
  await run(["service", "set", "port", String(port)])
  started = true
  const url = await run(["service", "start"])
  const registration = JSON.parse(await readFile(path.join(process.env.XDG_STATE_HOME, "opencode", "service.json"), "utf8"))
  assert.equal(new URL(url).port, String(port))
  assert.equal(new URL(registration.url).port, String(port))
  const password = await run(["service", "get", "password"])
  const endpoint = { url, auth: { type: "basic", username: "opencode", password } }
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
  const info = await (await fetch(`${url}/api/info`, { headers })).json()
  const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  const { WorkspaceManager } = await tsImport("../packages/server/src/workspaces/manager.ts", import.meta.url)
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const { registerInstanceProxyRoutes } = await tsImport("../packages/server/src/server/http-server.ts", import.meta.url)
  const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
  let variables = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map(key => [key, path.join(root, "first")]))
  const logger = pino({ level: "silent" })
  manager = new WorkspaceManager({
    rootDir: root, settings: { getOwner: () => ({ environmentVariables: variables }) },
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Isolated fixture" }) },
    eventBus: new EventBus(), logger,
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }),
  })
  const { workspace } = await manager.create(project)
  const native = await manager.getSharedServiceClient()
  app = Fastify()
  registerInstanceProxyRoutes(app, { workspaceManager: manager, logger, worktreeDeletionFence: new WorktreeDeletionFence() })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const baseUrl = `http://127.0.0.1:${app.server.address().port}/workspaces/${workspace.id}/instance/`
  const proxy = OpenCode.make({ baseUrl, fetch: (input, init) => {
    const request = new URL(input instanceof Request ? input.url : input)
    return fetch(new URL(request.pathname.replace(/^\/+/, "") + request.search, baseUrl), init)
  } })
  const a = await proxy.session.create({ location: { directory: project } })
  const b = await proxy.session.create({ location: { directory: project } })
  const probe = async (client, session, label, command) => {
    await client.session.shell({ sessionID: session.id, command: command ?? `node probe.cjs ${label}.json` })
    const result = JSON.parse(await readFile(path.join(project, `${label}.json`), "utf8"))
    console.log(label, JSON.stringify(result))
    assert.equal(result.path, true)
    return result
  }
  // Creation and viewing do not modify native environment state.
  await proxy.session.get({ sessionID: a.id })
  assert.equal((await probe(native, a, "read-only-baseline")).tmpdir, path.join(root, "base"))
  for (const [session, label] of [[a, "first-A"], [b, "first-B"]]) {
    assert.equal((await probe(proxy, session, label)).tmpdir, path.join(root, "first"))
  }
  variables = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map(key => [key, path.join(root, "changed")]))
  await proxy.session.get({ sessionID: a.id })
  assert.equal((await probe(native, a, "settings-not-yet-sent")).tmpdir, path.join(root, "first"))
  assert.equal((await probe(proxy, a, "changed-A")).tmpdir, path.join(root, "changed"))
  assert.equal((await probe(native, b, "B-before-next-send")).tmpdir, path.join(root, "first"))
  assert.equal((await probe(proxy, b, "changed-B")).tmpdir, path.join(root, "changed"))
  if (process.platform === "win32") {
    assert.equal((await probe(proxy, a, "bash-A", "& 'C:/Program Files/Git/bin/bash.exe' -c 'node probe.cjs bash-A.json'")).tmpdir, path.join(root, "changed"))
  }
  variables = {}
  assert.equal((await probe(proxy, a, "removed-overrides")).tmpdir, path.join(root, "base"))
  assert.equal((await native.server.status()).pid, info.pid)
  console.log(`PASS OpenCode ${info.version}: real manager + proxy + native shells; next-send updates, both conversations, removal, no writes on read, unchanged daemon PID`)
} finally {
  await app?.close()
  await manager?.shutdown()
  if (started) {
    await run(["service", "stop"])
    assert.equal(await run(["service", "status"]), "stopped")
    console.log("Isolated service stopped")
  }
}
