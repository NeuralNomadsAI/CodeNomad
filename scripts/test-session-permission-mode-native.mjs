// No discovery or shared daemon. Invoke with an absolute OpenCode executable.
import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import Fastify from "fastify"
import pino from "pino"
import { register } from "tsx/esm/api"
import { setTimeout as delay } from "node:timers/promises"
import { runIsolated } from "./test-opencode-location-native.mjs"

// Use the same module instance as the relay's native event attribution map.
const { import: tsImport } = register({ namespace: "session-permission-mode-native" })
const rule = (action, resource, effect) => ({ action, resource, effect })
const config = { permissions: [
  rule("read", "*", "allow"), rule("shell", "*", "allow"), rule("shell", "rm *", "deny"),
] }

await runIsolated(process.argv[2], async ({ client, connection: native, root }) => {
  const { registerInstanceProxyRoutes } = await tsImport("../packages/server/src/server/http-server.ts", import.meta.url)
  const { registerSessionPermissionModeRoutes } = await tsImport("../packages/server/src/server/routes/session-permission-mode.ts", import.meta.url)
  const { connectSessionPermissionRefresh } = await tsImport("../packages/server/src/server/routes/session-permission-refresh.ts", import.meta.url)
  const { SessionPermissionModes } = await tsImport("../packages/server/src/permissions/session-mode.ts", import.meta.url)
  const { nativeEventConnections } = await tsImport("../packages/server/src/workspaces/opencode-service.ts", import.meta.url)
  const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
  const { SessionCleanupFence } = await tsImport("../packages/server/src/server/session-cleanup-fence.ts", import.meta.url)
  const { resolveConfigLocation } = await tsImport("../packages/server/src/config/location.ts", import.meta.url)
  const { SettingsService } = await tsImport("../packages/server/src/settings/service.ts", import.meta.url)
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const logger = pino({ level: "silent" })
  const profile = path.join(root, "codenomad-profile")
  await mkdir(profile)
  const profileLocation = resolveConfigLocation(profile)
  const bus = new EventBus()
  const settings = new SettingsService(profileLocation, bus, logger)
  const modes = new SessionPermissionModes(settings)
  const worktreeDeletionFence = new WorktreeDeletionFence(), cleanup = new SessionCleanupFence()
  const app = Fastify()
  const configPath = path.join(root, "config", "opencode.json")
  await writeFile(configPath, JSON.stringify(config))
  await client.location.reload({ location: { directory: root } })
  const location = await client.location.get({ location: { directory: root } })
  const directory = location.directory
  const otherDirectory = path.join(directory, "other")
  await mkdir(otherDirectory)
  const otherLocation = await client.location.get({ location: { directory: otherDirectory } })
  const workspaces = Object.fromEntries(["a", "b"].map(id => [id, { id, path: directory }]))
  const owns = candidate => [directory, otherLocation.directory].some(owned => path.resolve(candidate) === path.resolve(owned))
  let modeWriteGate, proxyAdmission
  const connection = {
    ...native,
    profile: async () => "modern",
    client: { ...client, session: { ...client.session, update: async (input, options) => {
      if (input.sessionID === modeWriteGate?.sessionID) {
        modeWriteGate.started()
        await modeWriteGate.released
      }
      return client.session.update(input, options)
    } } },
  }
  const workspaceManager = {
    get: id => workspaces[id],
    getSharedServiceConnection: async () => connection,
    getSharedServiceClient: async () => client,
    getInstanceAuthorizationHeader: () => undefined,
    getSessionEnvironment: async () => ({}),
    getServiceDirectory: () => directory,
    getServiceWslDistro: () => undefined,
    getWorktreeIdentityForPath: async (id, candidate) => {
      if (id === "b") proxyAdmission?.()
      return owns(candidate) ? directory : undefined
    },
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
    const localDeny = rule("shell", "echo blocked", "deny")
    const deniedAtCreation = await create({ permissions: [localDeny] })
    assert.deepEqual(deniedAtCreation.permissions, [localDeny, ...expected, localDeny])
    assert.equal((await nativePermission(deniedAtCreation.id, "shell", "echo blocked")).effect, "deny")
    assert.equal(await mode("a", deniedAtCreation.id, "autonomous"), "autonomous")
    assert.deepEqual((await client.session.get({ sessionID: deniedAtCreation.id }, options)).permissions, [localDeny])
    assert.equal(await mode("a", deniedAtCreation.id, "supervised"), "supervised")
    assert.equal((await nativePermission(deniedAtCreation.id, "shell", "echo blocked")).effect, "deny")
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

    const started = Promise.withResolvers(), gate = Promise.withResolvers(), admitted = Promise.withResolvers()
    modeWriteGate = { sessionID: original.id, started: started.resolve, released: gate.promise }
    proxyAdmission = admitted.resolve
    const changing = mode("a", original.id, "supervised")
    const proxyDeny = rule("shell", "echo proxy-race", "deny")
    let patch
    try {
      await Promise.race([started.promise, changing.then(() => assert.fail("mode write did not reach gate"))])
      patch = app.inject({ method: "PATCH", url: `/workspaces/b/instance/api/session/${original.id}`,
        payload: { permissions: [initial, appended, proxyDeny] } }).then(reply => reply)
      await Promise.race([admitted.promise, patch.then(reply => assert.fail(`proxy failed admission: ${reply.statusCode}`))])
      assert.equal(await Promise.race([patch.then(() => "answered"), delay(350, "waiting")]), "waiting",
        "the native PATCH must wait for the in-flight mode update")
    } finally {
      gate.resolve()
      await Promise.allSettled([changing, patch])
      modeWriteGate = proxyAdmission = undefined
    }
    const patched = await patch
    assert.equal(patched.statusCode, 204, patched.body)
    assert.equal(await changing, "supervised")
    assert.deepEqual((await read()).permissions, [initial, appended, proxyDeny])
    assert.equal((await nativePermission(original.id, "shell", proxyDeny.resource)).effect, "deny")
    console.log("PASS: same-backend native PATCH waits for the in-flight mode write and retains its deny")

    const stopRefresh = connectSessionPermissionRefresh(bus, workspaceManager, modes, worktreeDeletionFence, cleanup, logger)
    const watching = new AbortController()
    const refreshStream = client.event.subscribe({ signal: AbortSignal.any([watching.signal, AbortSignal.timeout(15_000)]),
      types: ["config.updated", "session.permissions"] })[Symbol.asyncIterator]()
    try {
      assert.equal((await refreshStream.next()).value.type, "server.connected")
      const nextPermissions = async (sessionID = created.id) => {
        for (;;) {
          const { value: event, done } = await refreshStream.next()
          if (done) assert.fail("native permission event did not arrive")
          nativeEventConnections.set(event, connection)
          bus.publish({ type: "instance.event", event, instanceId: "a" })
          if (event.type === "session.permissions" && event.data.sessionID === sessionID) return event.data.permissions
        }
      }
      const deny = rule("shell", "echo refresh-fixture", "deny")
      await writeFile(configPath, JSON.stringify({ permissions: [...config.permissions, deny] }))
      assert.deepEqual(await nextPermissions(), [initial, ...expected, deny])
      assert.equal((await nativePermission(created.id, "shell", deny.resource)).effect, "deny")
      const insertedShell = rule("shell", "echo inserted", "deny")
      const insertedEdit = rule("edit", path.join(directory, "private.txt"), "deny")
      const revisedChild = await client.session.create({ parentID: created.id }, options)
      const childRules = [initial, insertedEdit, ...expected, deny, appended]
      await client.session.update({ sessionID: revisedChild.id, permissions: childRules }, options)
      assert.deepEqual(await nextPermissions(revisedChild.id), childRules)
      const grandchildRules = [initial, insertedEdit, ...expected, deny, insertedEdit, appended]
      assert.deepEqual(await nextPermissions(revisedChild.id), grandchildRules)
      const grandchild = await client.session.create({ parentID: revisedChild.id }, options)
      assert.deepEqual(grandchild.permissions, grandchildRules)
      assert.equal(await mode("a", grandchild.id), "supervised")
      assert.equal((await nativePermission(grandchild.id, "edit", insertedEdit.resource)).effect, "deny")
      const prompt = await app.inject({ method: "POST", url: `/workspaces/a/instance/api/session/${grandchild.id}/prompt`,
        payload: { text: "Inherited permissions fixture", resume: false } })
      const restore = await app.inject({ method: "PUT", url: `/api/workspaces/b/sessions/${grandchild.id}/permission-mode`,
        payload: { mode: "autonomous" } })
      assert.deepEqual([prompt.statusCode, restore.statusCode], [200, 200], `${prompt.body}\n${restore.body}`)
      assert.deepEqual((await client.session.get({ sessionID: grandchild.id }, options)).permissions, [initial, insertedEdit, appended])
      assert.deepEqual((await client.session.get({ sessionID: revisedChild.id }, options)).permissions, grandchildRules)
      console.log("PASS: native grandchild admits a prompt, keeps the edit deny and removes only its copied block")

      const prefix = [initial, insertedShell, insertedEdit]
      const otherClientRules = [...prefix, ...expected, deny, appended]
      await client.session.update({ sessionID: created.id, permissions: otherClientRules }, options)
      const unprojected = await nativePermission(created.id, "shell", insertedShell.resource)
      assert.equal(unprojected.effect, "ask")
      await client.permission.reply({ sessionID: created.id, requestID: unprojected.id, decision: "reject" }, options)
      assert.deepEqual(await nextPermissions(), otherClientRules)
      assert.deepEqual(await nextPermissions(), [...prefix, ...expected, deny, insertedShell, insertedEdit, appended])
      for (const inserted of [insertedShell, insertedEdit]) {
        assert.equal((await nativePermission(created.id, inserted.action, inserted.resource)).effect, "deny")
      }
      assert.equal(await mode("a", created.id, "autonomous"), "autonomous")
      assert.deepEqual((await client.session.get({ sessionID: created.id })).permissions, [...prefix, appended])
      console.log("PASS: native permission event makes inserted shell and edit denies effective and autonomous retains them")
    } finally {
      watching.abort()
      await refreshStream.return?.()
      await stopRefresh()
    }
    console.log("PASS: native root default, config deny/read, two clients and SSE, preserved rules, saved approval, independent child/fork modes and pending request")
  } finally { await app.close() }
})
