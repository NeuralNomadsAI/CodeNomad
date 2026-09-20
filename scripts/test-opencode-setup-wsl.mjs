// Real Windows -> WSL official lifecycle, authenticated native connection and
// plugin provisioning. The wrapper forces every command into fresh fixture state.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { watch } from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { boundedFixtureOperation } from "./fixtures/wsl-fixture-bounds.mjs"

const deadlineAt = Date.now() + 180_000
const signal = AbortSignal.timeout(180_000)

const [distro, cli, mode = "aliased", check = ""] = process.argv.slice(2)
if (process.platform !== "win32" || !distro || !cli?.startsWith("/")) throw new Error("Pass a WSL distro and absolute Linux CLI path on Windows")
assert.ok(["native", "mounted", "aliased"].includes(mode), "Config mode must be native, mounted or aliased")
assert.ok(check === "" || check === "reload-safety", "Optional check must be reload-safety")
const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`
function wsl(script, cleanup = false) {
  if (!cleanup) signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile("wsl.exe", ["--distribution", distro, "--exec", "/bin/bash", "-s"],
      { encoding: "utf8", timeout: cleanup ? 15_000 : Math.max(1, Math.min(60_000, deadlineAt - Date.now())),
        ...(!cleanup ? { signal } : {}), maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout.trim()))
    child.stdin.end(`set -euo pipefail\n${script}\n`)
  })
}
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const mounted = await mkdtemp(path.join(parent, "codenomad-wsl-setup-"))
const mount = await wsl(`wslpath -au ${quote(mounted)}`)
const root = await wsl('mkdir -p "$HOME/.cache"\nmktemp -d "$HOME/.cache/codenomad-wsl-setup-XXXXXX"')
const password = randomUUID(), wrapper = `${root}/opencode-fixture`
const config = mode === "native" ? `${root}/config` : mode === "mounted" ? `${mount}/config` : `${root}/config-alias`
const unc = directory => `\\\\wsl.localhost\\${distro}${directory.replaceAll("/", "\\")}`
const configFile = mode === "native" ? unc(`${config}/opencode.json`) : path.join(mounted, "config/opencode.json")
// Stable CLI channels default to 49374 even with different XDG roots. Allocate
// an unused Windows port and verify it is unused in Linux before configuring it.
const reservation = createServer()
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve) })
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
await wsl(`mkdir -p ${quote(`${mount}/config`)} ${quote(`${root}/config`)} ${quote(`${root}/home`)} ${quote(`${root}/repo`)}
${mode === "aliased" ? `ln -s ${quote(`${mount}/config`)} ${quote(config)}` : ""}
mkdir -m 700 ${quote(`${root}/runtime`)}
python3 -c ${quote(`import socket; s=socket.socket(); s.bind(('127.0.0.1', ${port})); s.close()`)}`)
const environment = {
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: `${root}/home`, USERPROFILE: `${root}/home`,
  XDG_DATA_HOME: `${root}/data`, XDG_CONFIG_HOME: `${root}/xdg-config`, XDG_STATE_HOME: `${root}/state`,
  XDG_CACHE_HOME: `${root}/cache`, XDG_RUNTIME_DIR: `${root}/runtime`, OPENCODE_TEST_HOME: `${root}/home`, OPENCODE_CONFIG_DIR: config,
  OPENCODE_DB: `${root}/fixture.db`,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [`${root}/probe-plugin`] }),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
}
let reloadProvider, reloadSafety, lifecycle, shared, automation, pruning, configWatcher
let started = false
const evidence = { root, mounted, mode, port }
async function until(predicate, message) {
  const deadline = Math.min(deadlineAt, Date.now() + 30_000)
  while (true) {
    const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) }
    if (await boundedFixtureOperation(() => predicate(options), deadline, message, signal)) return
    await delay(100, undefined, { signal })
  }
}
async function startOrRestart(restart = false) {
  signal.throwIfAborted()
  const startDeadline = Math.min(deadlineAt, Date.now() + 30_000)
  try { return await (restart ? lifecycle.restart(startDeadline) : lifecycle.ensure(startDeadline)) }
  catch (error) {
    if (!error.message.startsWith("Cannot reach the WSL OpenCode service from Windows")) throw error
    // Forwarding may trail Linux readiness. Only rediscover our guarded service.
    let endpoint
    await until(async () => {
      try { endpoint = await lifecycle.discover(Math.min(deadlineAt, Date.now() + 15_000)); return Boolean(endpoint) }
      catch (retry) {
        if (!retry.message.startsWith("Cannot reach the WSL OpenCode service from Windows")) throw retry
        return false
      }
    }, "Fixture WSL localhost forwarding did not become ready")
    return endpoint
  }
}
async function runFixture() {
if (check === "reload-safety") {
  const { startReloadSafetyProvider } = await import("./fixtures/wsl-reload-safety.mjs")
  reloadProvider = await startReloadSafetyProvider({ distro, root, environment, unc, signal })
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    plugins: [`${root}/probe-plugin`], model: "fixture/fixture",
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${reloadProvider.port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } },
  })
}
// Check the isolated registration and Linux process environment before any CLI
// command can probe or stop it. Never infer ownership from an endpoint or PID.
const guard = `import json, os, pathlib, socket
root = pathlib.Path(${JSON.stringify(root)})
registration = root / 'state/opencode/service.json'
if registration.exists():
    info = json.loads(registration.read_text())
    assert info['url'] == 'http://127.0.0.1:${port}', 'Unexpected fixture endpoint'
    env = pathlib.Path('/proc/%s/environ' % info['pid']).read_bytes().split(b'\\0')
    for key, value in json.loads(${JSON.stringify(JSON.stringify(environment))}).items():
        assert (key + '=' + value).encode() in env, 'Fixture process ownership mismatch: ' + key
else:
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', ${port}))
    s.close()
`
const script = `#!/bin/sh\nset -eu\n/usr/bin/python3 ${quote(`${root}/guard.py`)}\ncd ${quote(`${root}/repo`)}\nexec env -i ${Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${quote(cli)} "$@"\n`
await wsl(`cat > ${quote(wrapper)} <<'CODENOMAD_FIXTURE'
${script}CODENOMAD_FIXTURE
cat > ${quote(`${root}/guard.py`)} <<'CODENOMAD_GUARD'
${guard}CODENOMAD_GUARD
chmod 700 ${quote(wrapper)}`)
await wsl(`mkdir ${quote(`${root}/probe-plugin`)}
cat > ${quote(`${root}/probe-plugin/index.ts`)} <<'CODENOMAD_PLUGIN'
import { appendFile } from 'node:fs/promises'
export default { id: 'wsl-fixture-probe', async setup(ctx) {
  await appendFile(${JSON.stringify(`${root}/plugin-setup.log`)}, 'setup\\n')
  await ctx.session.hook('http.request', event => event.request.headers.set('x-reload-kind', event.kind))
} }
CODENOMAD_PLUGIN`)
await wsl(`${quote(wrapper)} service set port ${port}
${quote(wrapper)} service set password ${quote(password)}`)
await writeFile(configFile, "{}\n")
const { WslOpenCodeService } = await tsImport("../packages/server/src/workspaces/wsl-opencode-service.ts", import.meta.url)
const { OpenCodeSharedService } = await tsImport("../packages/server/src/workspaces/opencode-service.ts", import.meta.url)
const { resolveDesktopPluginPaths } = await tsImport("../packages/server/src/opencode/desktop-plugin-paths.ts", import.meta.url)
const { DesktopPluginLifecycle, prepareDesktopPluginPresence } = await tsImport("../packages/server/src/opencode/desktop-plugin-lifecycle.ts", import.meta.url)
lifecycle = new WslOpenCodeService({ distro, binary: wrapper, timeoutMs: 30_000 })
shared = new OpenCodeSharedService({ headers: Service.headers, makeClient: options => OpenCode.make({ ...options,
  fetch: (input, init) => options.fetch(input, { ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
  }),
}) })
automation = new DesktopPluginLifecycle("automation")
pruning = new DesktopPluginLifecycle("session-pruning")
  assert.equal(await lifecycle.discover(Math.min(deadlineAt, Date.now() + 15_000)), undefined, "Fresh fixture must never discover an existing service")
  started = true
  const endpoint = await startOrRestart()
  assert.equal(endpoint.url, `http://127.0.0.1:${port}`)
  const options = { kind: "lifecycle", identity: `wsl-fixture:${root}`, lifecycle }
  const client = await shared.client(options, { deadlineAt })
  const before = await client.server.info()
  evidence.started = { endpoint: endpoint.url, pid: before.pid, version: before.version }
  console.log(`Authenticated isolated ${distro} service: ${endpoint.url}, PID ${before.pid}; ${root}`)
  assert.equal(before.version, "2.0.11")
  const connection = await shared.acquire()
  const assertCurrent = () => { signal.throwIfAborted(); connection.assertCurrent() }
  const paths = await resolveDesktopPluginPaths({ ...connection, assertCurrent }, { kind: "wsl", distro, binary: wrapper }, Math.min(deadlineAt, Date.now() + 15_000))
  evidence.paths = paths
  if (mode === "native") assert.ok(paths.config.startsWith(`\\\\wsl.localhost\\${distro}\\`))
  else assert.equal(paths.config.toLowerCase(), path.dirname(configFile).toLowerCase(), "Mounted discovery roots, including symlink aliases, need Windows-native access paths")
  assert.equal(await readFile(path.join(paths.config, "opencode.json"), "utf8"), "{}\n")
  assert.ok(!paths.data.startsWith(`${paths.config}\\`), "Presence leases must stay outside the aliased/mounted config tree")
  const location = { directory: `${root}/repo` }
  await client.location.get({ location })
  await until(async request => (await client.plugin.list({ location }, request)).data.some(plugin => plugin.id === "wsl-fixture-probe" && plugin.state.status === "active"), "Probe plugin did not activate")
  assert.ok(!(await client.plugin.list({ location })).data.some(plugin => plugin.id === "codenomad.automation"), "Location must be loaded before desktop plugins are installed")
  if (reloadProvider) {
    const { prepareReloadSafety } = await import("./fixtures/wsl-reload-safety.mjs")
    reloadSafety = await prepareReloadSafety({ client, root, unc, provider: reloadProvider })
    evidence.reloadSafety = { before: reloadSafety.before }
  }
  await prepareDesktopPluginPresence(paths, assertCurrent, { automation, pruning })
  await delay(1_500)
  evidence.beforeExplicitReload = (await client.plugin.list({ location })).data
    .filter(plugin => plugin.id.startsWith("codenomad"))
    .map(plugin => ({ id: plugin.id, status: plugin.state.status }))
  // This explicitly tests the informed recovery action. It is never evidence
  // of automatic watcher discovery; pre-reload native state is recorded above.
  await client.location.reload({ signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
  if (reloadSafety) evidence.reloadSafety = await reloadSafety.observe()
  await until(async request => {
    const plugins = (await client.plugin.list({ location }, request)).data
    evidence.plugins = plugins.filter(plugin => plugin.id.startsWith("codenomad") || plugin.id === "wsl-fixture-probe")
      .map(plugin => ({ id: plugin.id, status: plugin.state.status }))
    return ["codenomad.automation", "codenomad-session-pruning"].every(id => plugins.some(plugin => plugin.id === id && plugin.state.status === "active"))
  }, "Late plugin discovery after native reload failed")
  const changes = []
  const watcher = mode === "native" ? undefined : watch(path.dirname(configFile), { recursive: true }, (event, filename) => changes.push({ event, filename }))
  configWatcher = watcher
  if (watcher) {
    try {
      const probe = path.join(path.dirname(configFile), ".watch-probe")
      await writeFile(probe, "")
      await rm(probe)
      await until(async () => changes.some(change => change.filename === ".watch-probe"), "Windows config observer did not receive its control event")
    } catch (error) { watcher.close(); throw error }
  }
  await delay(2_500)
  const setupBefore = await readFile(unc(`${root}/plugin-setup.log`), "utf8")
  const leasePaths = (await Promise.all(["automation", "session-pruning"].map(async feature => {
    const directory = path.join(paths.data, feature, "presence")
    return (await readdir(directory)).filter(name => name.endsWith(".lease")).map(name => path.join(directory, name))
  }))).flat()
  assert.equal(leasePaths.length, 2)
  const leaseBefore = await Promise.all(leasePaths.map(async file => (await stat(file)).mtimeMs))
  changes.length = 0
  try {
    // Windows ReadDirectoryChangesW cannot watch native WSL UNC directories.
    // Observe Linux inotify there instead, including existing nested folders.
    if (mode === "native") {
      const events = await wsl(`python3 - ${quote(config)} ${quote(`${root}/runtime`)} <<'CODENOMAD_WATCH'
import ctypes, json, os, select, sys, time
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK)
assert fd >= 0
# Prove this observer is live before measuring the real heartbeat interval.
control = libc.inotify_add_watch(fd, os.fsencode(sys.argv[2]), 0x00000fce)
assert control >= 0
probe = os.path.join(sys.argv[2], '.watch-probe')
open(probe, 'w').close()
os.unlink(probe)
assert select.select([fd], [], [], 2)[0]
os.read(fd, 1048576)
libc.inotify_rm_watch(fd, control)
os.read(fd, 1048576)
for directory, _, _ in os.walk(sys.argv[1]):
    assert libc.inotify_add_watch(fd, os.fsencode(directory), 0x00000fce) >= 0
deadline = time.monotonic() + 5
events = []
while time.monotonic() < deadline:
    if select.select([fd], [], [], max(0, deadline-time.monotonic()))[0]:
        events.append(os.read(fd, 1048576).hex())
os.close(fd)
print(json.dumps(events))
CODENOMAD_WATCH`)
      changes.push(...JSON.parse(events))
    } else await delay(5_000)
  } finally { watcher?.close() }
  const leaseAfter = await Promise.all(leasePaths.map(async file => (await stat(file)).mtimeMs))
  assert.ok(leaseAfter.every((time, index) => time > leaseBefore[index]), "Both backend leases must actually heartbeat")
  assert.deepEqual(changes, [], "Heartbeats must leave the entire watched config tree unchanged")
  assert.equal(await readFile(unc(`${root}/plugin-setup.log`), "utf8"), setupBefore, "Heartbeats must not rerun plugin setup")
  assert.equal((await client.server.info()).pid, before.pid)
  evidence.heartbeat = { durationMs: 5_000, leaseBefore, leaseAfter, changes, stableSetup: true }
  evidence.nativeWatcherFailures = (await readFile(unc(`${root}/data/opencode/log/opencode.log`), "utf8"))
    .split("\n").filter(line => line.includes('message="failed to subscribe"')).slice(-4)
  await automation.stop(); await pruning.stop(); await shared.shutdown()
  await startOrRestart(true)
  const replacement = await shared.client(options, { deadlineAt })
  evidence.restarted = { pid: (await replacement.server.info()).pid }
  assert.notEqual(evidence.restarted.pid, before.pid)
  assert.equal((await replacement.location.get({ location })).directory, location.directory)
  evidence.passed = true
  console.log(`PASS Windows→${distro} (${mode}): real service start/authentication/restart/reconnect, translated filesystem provisioning, late plugin discovery after explicit native reload and measured heartbeat stability; ${mounted}`)
}
try {
  await boundedFixtureOperation(runFixture, deadlineAt, "WSL native fixture", signal)
} catch (error) {
  evidence.error = error.message
  throw error
} finally {
  configWatcher?.close()
  const cleanupDeadline = Date.now() + 20_000
  const cleanups = [
    ["reload observer", () => reloadSafety?.dispose()], ["local provider", () => reloadProvider?.stop()],
    ["automation presence", () => automation?.stop()], ["pruning presence", () => pruning?.stop()],
    ["native client", () => shared?.shutdown()],
    ["isolated daemon", () => started ? wsl(`${quote(wrapper)} service stop`, true) : undefined],
  ]
  const results = await Promise.allSettled(cleanups.map(([label, operation]) => boundedFixtureOperation(operation, cleanupDeadline, label)))
  evidence.cleanup = results.map((result, index) => ({ operation: cleanups[index][0], status: result.status,
    ...(result.status === "rejected" ? { error: String(result.reason) } : {}) }))
  await boundedFixtureOperation(() => writeFile(path.join(mounted, "evidence.json"), JSON.stringify(evidence, null, 2)), Date.now() + 5_000, "write evidence")
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, "Isolated WSL fixture cleanup failed")
}
