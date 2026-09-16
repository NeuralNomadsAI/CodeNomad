// Native location authority fixture. Invoke with an absolute CLI path, or call
// testNativeLocationIdentity from an already-isolated native test. No discovery,
// shared daemon, user config or non-fixture database is ever used.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import replyFrom from "@fastify/reply-from"
import pino from "pino"

export async function testNativeLocationIdentity({ client, connection, root }) {
  const { contractProfile, runtimeIdentity } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
  const { locationRequestOptions } = await tsImport("../packages/server/src/opencode/compatibility/location.ts", import.meta.url)
  const profile = connection.profile ? await connection.profile() : contractProfile(runtimeIdentity(connection.endpoint))
  const directory = path.join(root, `identity-project-${randomUUID()}`)
  const worktree = path.join(root, `identity-worktree-${randomUUID()}`)
  await mkdir(directory)
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" })
  git("init")
  git("config", "user.name", "CodeNomad isolated fixture")
  git("config", "user.email", "fixture@example.invalid")
  await writeFile(path.join(directory, "fixture.txt"), "synthetic native identity fixture\n")
  git("add", "fixture.txt")
  git("commit", "-m", "Synthetic native identity fixture")
  git("worktree", "add", "-b", "fixture-worktree", worktree)
  const rootLocation = await client.location.get({ location: { directory } })
  const worktreeLocation = await client.location.get({ location: { directory: worktree } })
  assert.equal(rootLocation.project.id, worktreeLocation.project.id)
  if (profile !== "legacy") {
    await assert.rejects(client.location.get({ location: { directory } }, locationRequestOptions({ directory, workspaceID: "wrk_fixture_one" })))
    console.log("PASS: native modern worktree location and obsolete-selector rejection")
    return
  }
  const locations = ["wrk_fixture_one", "wrk_fixture_two"].map(workspaceID => ({ directory: rootLocation.directory, workspaceID }))
  for (const location of locations) {
    const resolved = await client.location.get({ location: { directory: location.directory } }, locationRequestOptions(location))
    assert.equal(resolved.directory, location.directory)
    assert.equal(resolved.workspaceID, location.workspaceID)
  }
  const { registerInstanceProxyRoutes } = await tsImport("../packages/server/src/server/http-server.ts", import.meta.url)
  const { createInstanceFetch } = await tsImport("../packages/ui/src/lib/sdk-manager.ts", import.meta.url)
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const { InstanceEventBridge } = await tsImport("../packages/server/src/workspaces/instance-events.ts", import.meta.url)
  const { evacuateWorktreeSessions } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
  const logger = pino({ level: "silent" })
  const normal = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
  const ownsDirectory = value => [directory, worktree].some(candidate => normal(candidate) === normal(value))
  const records = locations.map((location, index) => ({ id: String(index), path: directory, location }))
  // A deliberately narrow fixture policy: each logical owner may access only its
  // native workspace identity, including its synthetic linked worktree. Native
  // location resolution, sessions, Form state, cursors and SSE are never mocked.
  const manager = {
    list: () => records,
    get: id => records.find(record => record.id === id),
    getSharedServiceConnection: async () => connection,
    getSharedServiceEndpoint: async () => connection.endpoint,
    getSharedServiceClient: async () => client,
    getInstanceAuthorizationHeader: () => `Basic ${Buffer.from(`${connection.endpoint.auth.username}:${connection.endpoint.auth.password}`).toString("base64")}`,
    getServiceDirectory: () => rootLocation.directory,
    getServiceDirectoryForPath: async (_id, candidate) => ownsDirectory(candidate) ? candidate : undefined,
    getWorktreeIdentityForPath: async (_id, candidate) => ownsDirectory(candidate) ? normal(candidate) : undefined,
    ownsDirectory: async (_id, candidate) => ownsDirectory(candidate),
    ownsPath: async (_id, candidate) => ownsDirectory(candidate),
    ownsLocation: async (id, location) => {
      if (!ownsDirectory(location.directory)) return false
      if (location.workspaceID === undefined) return true
      if (records.find(record => record.id === id)?.location.workspaceID !== location.workspaceID) return false
      const resolved = await client.location.get({ location: { directory: location.directory } }, locationRequestOptions(location))
      return normal(resolved.directory) === normal(location.directory) && resolved.workspaceID === location.workspaceID
    },
    subscribeToSharedService: signal => client.event.subscribe({ signal }),
  }
  const app = Fastify()
  await app.register(replyFrom)
  registerInstanceProxyRoutes(app, { workspaceManager: manager, logger, worktreeDeletionFence: { enter: () => () => {} } })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const proxyClients = records.map(record => {
    const baseUrl = `http://127.0.0.1:${app.server.address().port}/workspaces/${record.id}/instance/`
    return OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
  })
  const bus = new EventBus()
  const routedForms = []
  let connected = false
  bus.on("instance.eventStatus", event => { if (event.status === "connected") connected = true })
  bus.on("instance.event", event => { if (event.event.type === "form.created") routedForms.push(event) })
  const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
  const until = async predicate => {
    const deadline = Date.now() + 15_000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error("Native identity fixture timed out")
      await delay(20)
    }
  }
  const created = []
  const forms = []
  const formOptions = location => ({ headers: {
    "x-opencode-directory": encodeURIComponent(location.directory), ...locationRequestOptions(location)?.headers,
  } })
  try {
    bus.publish({ type: "workspace.started", workspace: records[0] })
    await until(() => connected)
    for (const [index, location] of locations.entries()) {
      const proxy = proxyClients[index]
      const options = locationRequestOptions(location)
      for (let n = 0; n < 2; n++) {
        const session = await proxy.session.create({ location: { directory: location.directory } }, options)
        assert.deepEqual(session.location, location)
        created.push(session)
      }
      const page = await proxy.session.list({ directory: location.directory, limit: 1 }, options)
      assert.equal(page.data.length, 1)
      assert.equal(page.data[0].location.workspaceID, location.workspaceID)
      assert.ok(page.cursor.next)
      const continuation = await proxy.session.list({ cursor: page.cursor.next })
      assert.ok(continuation.data.every(session => session.location.workspaceID === location.workspaceID))
      await assert.rejects(proxyClients[1 - index].session.list({ cursor: page.cursor.next }))
      await assert.rejects(proxyClients[1 - index].session.get({ sessionID: page.data[0].id }))
      for (const directory of [location.directory, worktreeLocation.directory]) {
        const scoped = { ...location, directory }
        const session = await proxy.session.create({ location: { directory } }, locationRequestOptions(scoped))
        created.push(session)
        const form = await client.session.form.create({ sessionID: "global", title: "Synthetic identity Form", fields: [{ key: "answer", type: "string" }] }, formOptions(scoped))
        forms.push({ ...form, location: scoped, owner: index })
      }
    }
    await until(() => routedForms.length === forms.length)
    for (const form of forms) {
      const routes = routedForms.filter(event => event.event.data.form.id === form.id)
      assert.deepEqual(routes.map(event => event.instanceId), [String(form.owner)])
      assert.deepEqual(routes[0].event.location, form.location)
      const proxy = proxyClients[form.owner]
      const list = await proxy.form.list({ location: { directory: form.location.directory } }, locationRequestOptions(form.location))
      assert.ok(list.data.some(item => item.id === form.id))
      const foreign = { ...form.location, workspaceID: locations[1 - form.owner].workspaceID }
      const otherList = await proxyClients[1 - form.owner].form.list({ location: { directory: foreign.directory } }, locationRequestOptions(foreign))
      assert.ok(!otherList.data.some(item => item.id === form.id))
      await assert.rejects(proxyClients[1 - form.owner].session.form.cancel({ sessionID: "global", formID: form.id }, formOptions(form.location)))
      if (form.owner === 0) await proxy.session.form.reply({ sessionID: "global", formID: form.id, answer: { answer: "fixture" } }, formOptions(form.location))
      else await proxy.session.form.cancel({ sessionID: "global", formID: form.id }, formOptions(form.location))
      assert.ok(!(await proxy.form.list({ location: { directory: form.location.directory } }, locationRequestOptions(form.location))).data.some(item => item.id === form.id))
    }
    for (const form of forms) {
      // These real native lists return their resolved location even when empty.
      // Spawning inside an arbitrary workspace ID requires an actual remote
      // workspace provider; this fixture deliberately does not provision one.
      for (const resource of ["shell", "pty"]) {
        const listed = await proxyClients[form.owner][resource].list({ location: { directory: form.location.directory } }, locationRequestOptions(form.location))
        assert.equal(listed.location.directory, form.location.directory)
        assert.equal(listed.location.workspaceID, form.location.workspaceID, `proxy ${resource} list must retain native identity`)
      }
    }
    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: rootLocation.directory, targetDirectory: worktreeLocation.directory, rootDirectory: rootLocation.directory,
      // Like the production manager's resolver, compare filesystem identities:
      // Windows TEMP can be an 8.3 path while Git reports its long canonical root.
      resolveDirectoryIdentity: directory => realpath(directory).catch(() => undefined),
      resolveExactDirectory: directory => realpath(directory).catch(() => undefined),
      remove: async () => {
        for (const original of created.filter(session => session.location.directory === worktreeLocation.directory)) {
          assert.deepEqual((await client.session.get({ sessionID: original.id })).location, { directory: rootLocation.directory })
        }
        throw new Error("Synthetic Git removal refusal")
      },
    }), /Synthetic Git removal refusal/)
    for (const original of created) assert.deepEqual((await client.session.get({ sessionID: original.id })).location, original.location)
    console.log("PASS: native same-directory identities, worktree/global Forms, Shell/PTY list scope, scoped SSE, foreign session/cursor refusal and exact move rollback")
  } finally {
    bridge.shutdown()
    await Promise.allSettled(forms.map(form => client.session.form.cancel({ sessionID: "global", formID: form.id }, formOptions(form.location))))
    await Promise.allSettled(created.map(session => client.session.remove({ sessionID: session.id })))
    await app.close()
  }
}

async function runIsolated(cli) {
  if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute isolated CLI executable path")
  const temporaryRoot = path.join(os.tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(path.join(temporaryRoot, "codenomad-location-native-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("XDG_")))
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
  const password = randomUUID()
  Object.assign(env, {
    HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
    OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_CONFIG_CONTENT: "{}",
  })
  await mkdir(env.OPENCODE_CONFIG_DIR)
  let output = ""
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "debug", "--print-logs"], {
    cwd: root, env, windowsHide: true,
  })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  console.log(`Isolated location fixture: ${root}`)
  try {
    const deadline = Date.now() + 30_000
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Isolated daemon failed to start: ${output}`)
      await delay(20)
    }
    const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const endpoint = { url: baseUrl, auth: { type: "basic", username: "opencode", password } }
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    let discovery = "status"
    let response = await fetch(`${baseUrl}/api/status`, { headers: { authorization } })
    if (response.status === 404) { discovery = "health"; response = await fetch(`${baseUrl}/api/health`, { headers: { authorization } }) }
    assert.equal(response.status, 200)
    const identity = await response.json()
    const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
    const { createRuntimeTransport } = await tsImport("../packages/server/src/opencode/compatibility/transport.ts", import.meta.url)
    rememberRuntime(endpoint, { version: identity.version, pid: identity.pid, discovery })
    const transport = createRuntimeTransport(endpoint)
    const client = OpenCode.make({ baseUrl, fetch: transport.fetch })
    const connection = { endpoint, client, ...transport, assertCurrent() {}, invalidate() {} }
    console.log(`Testing official runtime ${identity.version}`)
    await testNativeLocationIdentity({ client, connection, root })
  } finally {
    child.kill()
    await stopped
    await writeFile(path.join(root, "daemon.log"), output)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runIsolated(process.argv[2])
