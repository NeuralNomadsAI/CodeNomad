// No discovery or shared daemon. Invoke with an absolute OpenCode executable.
import assert from "node:assert/strict"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import Fastify from "fastify"
import pino from "pino"
import { tsImport } from "tsx/esm/api"
import { runIsolated } from "./test-opencode-location-native.mjs"

const rule = (action, resource, effect) => ({ action, resource, effect })
const config = { permissions: [
  rule("read", "*", "allow"), rule("shell", "*", "allow"), rule("shell", "rm *", "deny"),
] }

await runIsolated(process.argv[2], async ({ client, connection: native, root }) => {
  const { registerInstanceProxyRoutes } = await tsImport("../packages/server/src/server/http-server.ts", import.meta.url)
  const { registerSessionPermissionModeRoutes } = await tsImport("../packages/server/src/server/routes/session-permission-mode.ts", import.meta.url)
  const { SessionPermissionModes } = await tsImport("../packages/server/src/permissions/session-mode.ts", import.meta.url)
  const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
  const { SessionCleanupFence } = await tsImport("../packages/server/src/server/session-cleanup-fence.ts", import.meta.url)
  const { resolveConfigLocation } = await tsImport("../packages/server/src/config/location.ts", import.meta.url)
  const { SettingsService } = await tsImport("../packages/server/src/settings/service.ts", import.meta.url)
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const logger = pino({ level: "silent" })
  const profile = path.join(root, "codenomad-profile")
  await mkdir(profile)
  const profileLocation = resolveConfigLocation(profile)
  const settings = new SettingsService(profileLocation, new EventBus(), logger)
  const modes = new SessionPermissionModes(settings)
  const worktreeDeletionFence = new WorktreeDeletionFence(), cleanup = new SessionCleanupFence()
  const app = Fastify()
  const location = await client.location.get({ location: { directory: root } })
  const directory = location.directory
  const otherDirectory = path.join(directory, "other")
  await mkdir(otherDirectory)
  const otherLocation = await client.location.get({ location: { directory: otherDirectory } })
  const workspaces = Object.fromEntries(["a", "b"].map(id => [id, { id, path: directory }]))
  const owns = candidate => [directory, otherLocation.directory].some(owned => path.resolve(candidate) === path.resolve(owned))
  const connection = { ...native, profile: async () => "modern" }
  const workspaceManager = {
    get: id => workspaces[id],
    getSharedServiceConnection: async () => connection,
    getSharedServiceClient: async () => client,
    getInstanceAuthorizationHeader: () => undefined,
    getServiceDirectory: () => directory,
    getServiceWslDistro: () => undefined,
    getWorktreeIdentityForPath: async (_id, candidate) => owns(candidate) ? directory : undefined,
    ownsDirectory: async (_id, candidate) => owns(candidate),
    ownsLocation: async (_id, candidate) => owns(candidate.directory),
    ownsPath: async () => true,
  }
  registerInstanceProxyRoutes(app, { workspaceManager, logger, worktreeDeletionFence, sessionCleanup: cleanup, permissionModes: modes })
  registerSessionPermissionModeRoutes(app, { workspaceManager, modes, cleanup, worktreeDeletionFence })
  const create = async (payload = {}, query = "") => {
    const reply = await app.inject({ method: "POST", url: `/workspaces/a/instance/api/session${query}`, payload })
    assert.equal(reply.statusCode, 200, reply.body)
    return reply.json().data
  }
  const mode = async (instance, sessionID, next) => {
    const reply = await app.inject({ method: next ? "PUT" : "GET", url: `/api/workspaces/${instance}/sessions/${sessionID}/permission-mode`,
      ...(next ? { payload: { mode: next } } : {}) })
    assert.equal(reply.statusCode, 200, reply.body)
    return reply.json().mode
  }
  const initial = rule("external_directory", "*", "deny")
  const appended = rule("read", "other.txt", "deny")
  const expected = [rule("edit", "*", "ask"), rule("shell", "*", "ask"), rule("shell", "*", "ask"), rule("shell", "rm *", "deny")]
  const options = { headers: { "x-opencode-directory": encodeURIComponent(directory) }, signal: AbortSignal.timeout(15_000) }
  try {
    const original = await create({ permissions: [initial] })
    assert.deepEqual(original.permissions, [initial])
    assert.equal(await mode("a", original.id), "autonomous")
    await client.session.remove({ sessionID: original.id }, options)
    await client.session.import({ info: original, messages: [
      { id: "msg_permission_fixture", type: "user", text: "Fork fixture", time: { created: original.time.created } },
    ] }, options)
    const setting = value => settings.mergePatchOwner("config", "ui", { settings: { newConversationPermissions: value } })
    setting("supervised")
    const created = await create({ permissions: [initial] })
    assert.deepEqual(created.permissions, [initial, ...expected])
    assert.equal(await mode("b", created.id), "supervised")
    assert.equal(await mode("b", original.id), "autonomous")
    const elsewhere = await create({ location: { directory: otherLocation.directory } }, `?directory=${encodeURIComponent(directory)}`)
    assert.equal(elsewhere.location.directory, otherLocation.directory, "the create body owns the config and placement")
    assert.equal(await mode("a", elsewhere.id), "supervised")
    const read = () => client.session.get({ sessionID: original.id }, options)
    const nativePermission = (sessionID, action, resource, extra) =>
      client.permission.create({ sessionID, action, resources: [resource], agent: "build", ...extra }, options)
    assert.equal((await nativePermission(created.id, "shell", "rm fixture")).effect, "deny")
    assert.equal((await nativePermission(created.id, "read", "fixture.txt")).effect, "allow")
    const observed = new AbortController()
    const stream = client.event.subscribe({ signal: AbortSignal.any([observed.signal, options.signal]) })[Symbol.asyncIterator]()
    try {
      assert.equal((await stream.next()).value.type, "server.connected")
      const settledEvent = (async () => {
        for (;;) {
          const { value, done } = await stream.next()
          if (done) return
          if (value.type === "session.permissions" && value.data.sessionID === original.id) return value
        }
      })()
      void settledEvent.catch(() => {})
      assert.deepEqual(await Promise.all([mode("a", original.id, "supervised"), mode("b", original.id, "supervised")]),
        ["supervised", "supervised"])
      assert.deepEqual((await settledEvent)?.data.permissions, [initial, ...expected])
    } finally { observed.abort(); await stream.return?.() }
    assert.deepEqual((await read()).permissions, [initial, ...expected])
    const child = await client.session.create({ parentID: original.id }, options)
    assert.deepEqual(child.permissions, [initial, ...expected])
    const fork = await client.session.fork({ sessionID: original.id }, options)
    assert.equal(fork.fork?.sessionID, original.id)
    assert.deepEqual(fork.permissions, [initial, ...expected])
    assert.equal(await mode("a", child.id), "supervised")
    assert.equal(await mode("b", fork.id), "supervised")
    const secondChild = await client.session.create({ parentID: original.id }, options)
    assert.equal(await mode("b", secondChild.id, "autonomous"), "autonomous")
    assert.deepEqual((await client.session.get({ sessionID: secondChild.id }, options)).permissions, [initial])
    assert.deepEqual((await read()).permissions, [initial, ...expected])
    const save = await nativePermission(original.id, "shell", "echo saved", { save: ["echo saved"] })
    assert.equal(save.effect, "ask")
    await client.permission.reply({ sessionID: original.id, requestID: save.id, decision: "always" }, options)
    assert.equal((await nativePermission(original.id, "shell", "echo saved")).effect, "allow")
    const pending = await nativePermission(original.id, "edit", path.join(directory, "fixture.txt"))
    assert.equal(pending.effect, "ask")
    await client.session.update({ sessionID: original.id, permissions: [initial, ...expected, appended] }, options)
    assert.equal(await mode("b", original.id, "autonomous"), "autonomous")
    assert.deepEqual((await read()).permissions, [initial, appended])
    assert.equal(await mode("a", original.id), "autonomous")
    assert.deepEqual((await client.session.get({ sessionID: child.id })).permissions, [initial, ...expected])
    for (const copy of [child, fork]) {
      const get = () => client.session.get({ sessionID: copy.id }, options)
      assert.equal(await mode("a", copy.id), "supervised")
      await client.session.update({ sessionID: copy.id, permissions: [initial, ...expected, appended] }, options)
      assert.equal(await mode("b", copy.id, "autonomous"), "autonomous")
      assert.deepEqual((await get()).permissions, [initial, appended])
      assert.equal(await mode("a", copy.id), "autonomous")
    }
    assert.deepEqual((await read()).permissions, [initial, appended])
    assert.ok((await client.permission.list({ sessionID: original.id }, options)).some(request => request.id === pending.id))
    await client.permission.reply({ sessionID: original.id, requestID: pending.id, decision: "reject" }, options)
    console.log("PASS: native root default, config deny/read, two clients and SSE, preserved rules, saved approval, independent child/fork modes and pending request")
  } finally { await app.close() }
}, config)
