import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test, { type TestContext } from "node:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import type { ConfigGetOutput, OpenCodeEvent, PermissionRule, SessionInfo } from "@opencode/client"
import Fastify from "fastify"
import pino from "pino"
import { resolveConfigLocation } from "../../config/location"
import { EventBus } from "../../events/bus"
import { SessionPermissionModes } from "../../permissions/session-mode"
import { supervisedRules } from "../../permissions/session-mode-rules"
import { SESSION_PERMISSION_BLOCKS_OWNER, SettingsService } from "../../settings/service"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { nativeEventConnections, type ServiceConnection } from "../../workspaces/opencode-service"
import { SessionCleanupFence } from "../session-cleanup-fence"
import { registerInstanceProxyRoutes } from "../http-server"
import { recordPermissionFork, registerSessionPermissionModeRoutes, sessionPermissionTarget } from "./session-permission-mode"
import { connectSessionPermissionRefresh } from "./session-permission-refresh"
import { registerSettingsRoutes } from "./settings"

const shell = (effect: PermissionRule["effect"], resource = "*"): PermissionRule => ({ action: "shell", resource, effect })
const edit = (effect: PermissionRule["effect"], resource = "*"): PermissionRule => ({ action: "edit", resource, effect })
const read: PermissionRule = { action: "read", resource: "*.txt", effect: "allow" }
const external: PermissionRule = { action: "external_directory", resource: "*", effect: "deny" }
const config: ConfigGetOutput = [
  { type: "directory", path: "/global" },
  { type: "document", info: { permissions: [{ action: "*", resource: "*", effect: "deny" }, read],
    agents: { plan: { permissions: [edit("deny")] } } } },
  { type: "document", info: { permissions: [shell("allow", "echo *"), shell("deny", "rm *"), edit("ask", "notes/*")] } },
]
const block = [edit("ask"), shell("ask"), edit("deny"), shell("deny"), shell("ask", "echo *"), shell("deny", "rm *"), edit("ask", "notes/*")]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

test("projects native config patterns in source order and leaves other actions and agents alone", () => {
  assert.deepEqual(supervisedRules(config, false), block)
  assert.deepEqual(supervisedRules([{ type: "document", info: { permissions: [{ action: "Sh?ll", effect: "deny", resource: "rm *" }] } }], true),
    [edit("ask"), shell("ask"), shell("deny", "rm *")])
  assert.throws(() => supervisedRules([{ type: "document", info: { permissions: [edit("deny", "~/private/*")] } }], false))
})

async function fixture(t: TestContext) {
  const temporary = path.join(tmpdir(), "opencode")
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(path.join(temporary, "codenomad-permission-mode-"))
  const app = Fastify()
  const bus = new EventBus()
  const logger = pino({ level: "silent" })
  const settings = new SettingsService(resolveConfigLocation(root), bus, logger)
  const sessionID = "ses_example"
  const session = { id: sessionID, projectID: "test", time: { created: 100, updated: 100 }, location: { directory: "/worktree" }, permissions: [read] } as SessionInfo
  const sessions = new Map([[sessionID, session]])
  const actions: string[] = []
  const reads: string[] = []
  const writes: string[] = []
  let mutate: ((rules: PermissionRule[]) => void | Promise<void>) | undefined
  let configEntries = config
  let dispatched: (() => void) | undefined
  const client = {
    session: {
      environment: async () => {},
      get: async ({ sessionID }: { sessionID: string }) => {
        actions.push("read")
        reads.push(sessionID)
        const selected = sessions.get(sessionID)
        if (!selected) throw Object.assign(new Error("Absent"), { _tag: "SessionNotFoundError", sessionID })
        return structuredClone(selected)
      },
      update: async ({ sessionID, permissions }: { sessionID: string; permissions: PermissionRule[] }) => {
        actions.push("write")
        writes.push(sessionID)
        if (mutate) return mutate(permissions)
        sessions.get(sessionID)!.permissions = permissions
      },
    },
    config: { get: async ({ location }: { location: { directory: string } }) => {
      actions.push("config")
      assert.equal(location.directory, "/worktree")
      return configEntries
    } },
  } as unknown as ServiceConnection["client"]
  const endpoint = { url: "http://127.0.0.1:1" }
  const connection = { client, endpoint, assertCurrent() {}, invalidate() {}, profile: async () => "modern",
    fetch: async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input.endsWith(`/session/${sessionID}`)) {
        actions.push("proxy write")
        session.permissions = JSON.parse(String(init.body)).permissions
        return Response.json({ data: session })
      }
      if (!input.endsWith("/prompt")) return new Response(null, { status: 404 })
      dispatched?.()
      return new Response(null, { status: 204 })
    },
  } as ServiceConnection
  const workspaces = { one: {}, two: {}, foreign: {} } as Record<string, {} | undefined>
  const manager = {
    get: (id: string) => workspaces[id] as never,
    getSharedServiceClient: async () => client,
    getSharedServiceEndpoint: async () => endpoint,
    getSharedServiceConnection: async () => connection,
    getExistingSharedServiceConnection: () => connection,
    getServiceWslDistro: () => undefined,
    getServiceDirectory: () => "/worktree",
    getSessionEnvironment: async () => ({}),
    getInstanceAuthorizationHeader: () => undefined,
    ownsLocation: async (id: string, location: SessionInfo["location"]) => id !== "foreign" && location.directory === "/worktree",
    ownsPath: async () => true,
    ownsDirectory: async (_id: string, directory: string) => directory === "/worktree",
    getWorktreeIdentityForPath: async () => "/worktree",
  }
  const modes = new SessionPermissionModes(settings)
  const worktrees = new WorktreeDeletionFence(), cleanup = new SessionCleanupFence()
  registerSessionPermissionModeRoutes(app, { workspaceManager: manager, modes, worktreeDeletionFence: worktrees, cleanup })
  registerSettingsRoutes(app, { settings, logger })
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
  const url = (id: string, selected: string) => `/api/workspaces/${id}/sessions/${selected}/permission-mode`
  const publish = (value: object) => {
    const event = { id: "evt_fixture", created: 0, ...value } as OpenCodeEvent
    nativeEventConnections.set(event, connection)
    bus.publish({ type: "instance.event", instanceId: "one", event })
  }
  return { app, bus, settings, modes, actions, reads, writes, session, sessions, client, connection, manager, logger, worktrees, cleanup,
    restartModes: () => new SessionPermissionModes(new SettingsService(resolveConfigLocation(root), bus, logger)),
    publish,
    observe: (session: SessionInfo) => publish(session.fork
      ? { type: "session.forked", created: session.time.created, data: { sessionID: session.id, parentID: session.fork.sessionID } }
      : { type: "session.created", created: session.time.created, data: { sessionID: session.id, parentID: session.parentID,
        projectID: session.projectID, location: session.location, permissions: structuredClone(session.permissions) } }),
    mutate: (next: typeof mutate) => { mutate = next },
    onDispatch: (next: () => void) => { dispatched = next },
    replaceConfig: (next: ConfigGetOutput) => { configEntries = next },
    get: (id = "one", selected = sessionID) => app.inject({ url: url(id, selected) }),
    set: (mode: string, id = "one", selected = sessionID) => app.inject({ method: "PUT", url: url(id, selected), payload: { mode } }) }
}

test("the session proxy refreshes before forwarding without a config event and blocks on refresh failure", async t => {
  const f = await fixture(t)
  registerInstanceProxyRoutes(f.app, { workspaceManager: f.manager, logger: f.logger, worktreeDeletionFence: f.worktrees,
    sessionCleanup: f.cleanup, permissionModes: f.modes })
  assert.equal((await f.set("supervised")).statusCode, 200)
  const deny = shell("deny", "fixture *")
  f.replaceConfig([...config, { type: "document", info: { permissions: [deny] } }])
  const sends: Array<PermissionRule[] | undefined> = []
  f.onDispatch(() => sends.push(f.session.permissions))
  const send = () => f.app.inject({ method: "POST", url: `/workspaces/one/instance/api/session/${f.session.id}/prompt`, payload: { text: "fixture" } })
  const sent = await send()
  assert.equal(sent.statusCode, 204, sent.body)
  assert.deepEqual(sends, [[read, ...block, deny]], f.actions.join(", "))
  f.replaceConfig([{ type: "document", info: { permissions: [edit("deny", "~/fixture/*")] } }])
  assert.equal((await send()).statusCode, 503)
  assert.equal(sends.length, 1)
  assert.deepEqual(f.session.permissions, [read, ...block, deny])
})

test("session permission events project an inserted deny once and leave explicit trailing rules in place", async t => {
  const f = await fixture(t)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const shellDeny = shell("deny", "echo inserted")
  const editDeny = edit("deny", "private.txt")
  const suffix = shell("allow", "echo other")
  const publish = () => f.publish({ type: "session.permissions", data: { sessionID: f.session.id, permissions: f.session.permissions } })
  let refreshes = 0
  const refresh = f.modes.refresh.bind(f.modes)
  t.mock.method(f.modes, "refresh", async (target: Parameters<typeof refresh>[0]) => {
    refreshes++
    return refresh(target)
  })
  f.mutate(rules => {
    // The native SSE echo can arrive before the write is acknowledged.
    f.session.permissions = rules
    publish()
  })
  const stop = connectSessionPermissionRefresh(f.bus, f.manager, f.modes, f.worktrees, f.cleanup, f.logger)
  t.after(stop)
  f.session.permissions = [read, shellDeny, editDeny, ...block, suffix]
  publish()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(f.session.permissions, [read, shellDeny, editDeny, ...block, shellDeny, editDeny, suffix])
  assert.equal(refreshes, 2, "the echo confirms unchanged rules without rewriting")
  assert.deepEqual(f.writes, [f.session.id, f.session.id])
  assert.equal((await f.set("autonomous")).statusCode, 200)
  assert.deepEqual(f.session.permissions, [read, shellDeny, editDeny, suffix])
})

test("serialized native proxy PATCH cannot lose an acknowledged deny to a mode write", { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  registerInstanceProxyRoutes(f.app, { workspaceManager: f.manager, logger: f.logger, worktreeDeletionFence: f.worktrees,
    sessionCleanup: f.cleanup, permissionModes: f.modes })
  const modeStarted = deferred(), releaseMode = deferred()
  f.mutate(async rules => {
    modeStarted.resolve()
    await releaseMode.promise
    f.session.permissions = rules
  })
  const changing = f.set("supervised").then(reply => reply)
  await modeStarted.promise
  const patchEntered = deferred()
  const enter = f.cleanup.enterMutation.bind(f.cleanup)
  t.mock.method(f.cleanup, "enterMutation", (id: string) => { patchEntered.resolve(); return enter(id) })
  const deny = shell("deny", "echo proxy")
  const patch = f.app.inject({ method: "PATCH", url: `/workspaces/two/instance/api/session/${f.session.id}`,
    payload: { permissions: [read, deny] } }).then(reply => reply)
  try {
    await patchEntered.promise
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally { releaseMode.resolve() }
  const [modeReply, patchReply] = await Promise.all([changing, patch])
  assert.equal(modeReply.statusCode, 200, modeReply.body)
  assert.equal(patchReply.statusCode, 200, patchReply.body)
  assert.deepEqual(f.session.permissions, [read, deny])
})

test("a mode write queued behind a native PATCH projects the freshly written deny", { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  registerInstanceProxyRoutes(f.app, { workspaceManager: f.manager, logger: f.logger, worktreeDeletionFence: f.worktrees,
    sessionCleanup: f.cleanup, permissionModes: f.modes })
  const patchStarted = deferred(), releasePatch = deferred()
  const fetch = f.connection.fetch
  t.mock.method(f.connection, "fetch", async (...args: Parameters<typeof fetch>) => {
    patchStarted.resolve()
    await releasePatch.promise
    return fetch(...args)
  })
  const deny = shell("deny", "echo proxy first")
  const patch = f.app.inject({ method: "PATCH", url: `/workspaces/two/instance/api/session/${f.session.id}`,
    payload: { permissions: [read, deny] } }).then(reply => reply)
  await patchStarted.promise
  const changing = f.set("supervised").then(reply => reply)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally { releasePatch.resolve() }
  const [patchReply, modeReply] = await Promise.all([patch, changing])
  assert.equal(patchReply.statusCode, 200, patchReply.body)
  assert.equal(modeReply.statusCode, 200, modeReply.body)
  assert.deepEqual(f.session.permissions, [read, deny, ...block, deny])
})

test("refreshes a recorded child with new config denies and never removes its rules", async t => {
  const f = await fixture(t)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const child = { ...f.session, id: "ses_child", parentID: f.session.id }
  const fork = { ...f.session, id: "ses_fork", fork: { sessionID: f.session.id } } as SessionInfo
  for (const copy of [child, fork]) f.sessions.set(copy.id, copy)

  let waiters = new Map<string, () => void>()
  const refresh = f.modes.refresh.bind(f.modes)
  t.mock.method(f.modes, "refresh", async (...args: Parameters<typeof refresh>) => {
    const result = await refresh(...args)
    const session = await args[0].read()
    waiters.get(session.id)?.()
    return result
  })
  const waitFor = (...ids: string[]) => {
    waiters = new Map()
    return Promise.all(ids.map(id => new Promise<void>(resolve => waiters.set(id, resolve))))
  }
  const stop = connectSessionPermissionRefresh(f.bus, f.manager, f.modes, f.worktrees, f.cleanup, f.logger)
  t.after(stop)
  const observed = waitFor(child.id, fork.id)
  f.observe(child)
  f.observe(fork)
  await observed
  assert.deepEqual(f.writes, [f.session.id], "observed copies already match the active configuration")

  const deny = shell("deny", "fixture *")
  const suffix = shell("allow", "explicit *")
  child.permissions = [read, ...block, suffix]
  f.replaceConfig([...config, { type: "document", info: { permissions: [deny] } }])
  f.publish({ type: "config.updated", location: { directory: "/other" }, data: {} })
  const refreshed = waitFor(f.session.id, child.id, fork.id)
  f.publish({ type: "config.updated", location: f.session.location, data: {} })
  await refreshed
  assert.deepEqual(f.session.permissions, [read, ...block, deny])
  assert.deepEqual(child.permissions, [read, ...block, deny, suffix])
  assert.deepEqual(fork.permissions, f.session.permissions)

  f.replaceConfig(config)
  const contracted = waitFor(f.session.id, child.id, fork.id)
  f.publish({ type: "config.updated", location: f.session.location, data: {} })
  await contracted
  assert.deepEqual(child.permissions, [read, ...block, deny, suffix])
  assert.deepEqual(f.session.permissions, [read, ...block])
  assert.deepEqual(fork.permissions, [read, ...block])
  assert.deepEqual((await f.set("autonomous", "two", child.id)).json(), { mode: "autonomous", rootSessionID: f.session.id })
  assert.deepEqual(f.session.permissions, [read])
  assert.deepEqual(child.permissions, [read, ...block, deny, suffix])
  assert.deepEqual((await f.set("autonomous", "two", fork.id)).json(), { mode: "autonomous" })
  assert.deepEqual(fork.permissions, [read])
})

test("connection and config events refresh saved blocks without reopening sessions", { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const missing = { ...f.session, id: "ses_missing" }
  f.sessions.set(missing.id, missing)
  assert.equal((await f.set("supervised", "one", missing.id)).statusCode, 200)
  f.sessions.delete(missing.id)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const child = { ...f.session, id: "ses_child", parentID: f.session.id }
  const fork = { ...f.session, id: "ses_fork", fork: { sessionID: f.session.id } } as SessionInfo
  for (const copy of [child, fork]) f.sessions.set(copy.id, copy)
  const initialRefresh = connectSessionPermissionRefresh(f.bus, f.manager, f.modes, f.worktrees, f.cleanup, f.logger)
  f.observe(child)
  f.observe(fork)
  await f.modes.withSessionLock(sessionPermissionTarget(child, { client: f.client, distro: undefined, signal: t.signal, current() {} }), async () => {})
  await f.get("one", fork.id)
  await initialRefresh()

  const modes = f.restartModes()
  const refresh = modes.refresh.bind(modes)
  let settled: () => void
  let absent: () => void
  const waitForCopies = () => new Promise<void>(resolve => { settled = resolve })
  const waitForMissing = () => new Promise<void>(resolve => { absent = resolve })
  const get = f.client.session.get.bind(f.client.session)
  t.mock.method(f.client.session, "get", async (...args: Parameters<typeof get>) => {
    try { return await get(...args) }
    finally { if (args[0].sessionID === missing.id) absent() }
  })
  t.mock.method(modes, "refresh", async (target: Parameters<typeof refresh>[0]) => {
    const result = await refresh(target)
    if ((await target.read()).id === fork.id) settled()
    return result
  })
  const warn = t.mock.method(f.logger, "warn")
  const changed = (deny: PermissionRule) => f.replaceConfig([...config, { type: "document", info: { permissions: [deny] } }])
  const startupDeny = shell("deny", "after startup *")
  const startup = Promise.all([waitForCopies(), waitForMissing()])
  changed(startupDeny)
  f.bus.publish({ type: "instance.eventStatus", instanceId: "one", status: "connected", generation: 1 })
  const stop = connectSessionPermissionRefresh(f.bus, f.manager, modes, f.worktrees, f.cleanup, f.logger)
  t.after(stop)
  await startup
  for (const copy of [f.session, child, fork]) assert.deepEqual(copy.permissions, [read, ...block, startupDeny])
  assert(f.reads.includes(missing.id))
  assert.equal(warn.mock.callCount(), 0)

  const nextDeny = shell("deny", "after config *")
  changed(nextDeny)
  const updated = waitForCopies()
  f.reads.length = 0
  f.publish({ type: "config.updated", location: { directory: "/other" }, data: {} })
  f.publish({ type: "config.updated", location: f.session.location, data: {} })
  await updated
  for (const root of [f.session, fork]) assert.deepEqual(root.permissions, [read, ...block, nextDeny])
  assert.deepEqual(child.permissions, [read, ...block, startupDeny, nextDeny])
  assert.ok(!f.reads.includes(missing.id), "the missing session's durable record was cleaned on startup")
  assert.equal(warn.mock.callCount(), 0)
})

test("a scoped config event recovers a hash-only block through native pagination", { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const { id, time, location, projectID } = f.session
  f.session.permissions = [read, ...block]
  const key = createHash("sha256").update(JSON.stringify([`host:${process.platform}`, id, time.created])).digest("hex")
  f.settings.setPrivateSessionPermissionBlock(key, block)
  const modes = f.restartModes()
  const locationGet = t.mock.fn(async () => ({ project: { id: projectID } }))
  const list = t.mock.fn(async (input: { cursor?: string }) => input.cursor
    ? { data: [f.session], cursor: {} }
    : { data: [{ ...f.session, id: "ses_untracked" }], cursor: { next: "next" } })
  Object.assign(f.client, { location: { get: locationGet } })
  Object.assign(f.client.session, { list })
  const refresh = modes.refresh.bind(modes)
  let done: () => void
  const updated = new Promise<void>(resolve => { done = resolve })
  t.mock.method(modes, "refresh", async (target: Parameters<typeof refresh>[0]) => {
    const result = await refresh(target)
    done()
    return result
  })
  const deny = shell("deny", "legacy *")
  f.replaceConfig([...config, { type: "document", info: { permissions: [deny] } }])
  t.after(connectSessionPermissionRefresh(f.bus, f.manager, modes, f.worktrees, f.cleanup, f.logger))
  f.publish({ type: "config.updated", location, data: {} })
  await updated
  assert.deepEqual(list.mock.calls.map(call => call.arguments[0]), [
    { project: projectID, directory: location.directory, limit: 100 }, { cursor: "next" },
  ])
  assert.deepEqual(f.writes, [id])
  assert.deepEqual(f.session.permissions, [read, ...block, deny])
  const saved = f.settings.getPrivateSessionPermissionState()[key] as { target: { id: string } }
  assert.equal(saved.target.id, id)
})

test("preserves a verified refresh after a concurrent native addition and an uncertain response", async t => {
  const f = await fixture(t)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const configDeny = shell("deny", "fixture *")
  f.replaceConfig([...config, { type: "document", info: { permissions: [configDeny] } }])
  const signal = AbortSignal.timeout(5_000)
  const target = sessionPermissionTarget(f.session, { client: f.client, distro: undefined, signal, current: () => signal.throwIfAborted() })
  f.mutate(rules => { f.session.permissions = [...rules, external]; throw Error("lost response") })
  await assert.rejects(f.modes.refresh(target), /lost response/)
  assert.equal(f.writes.length, 2, "an uncertain write is not replayed")
  assert.deepEqual((await f.get()).json(), { mode: "supervised" })
  f.mutate(undefined)
  assert.equal((await f.set("autonomous", "two")).statusCode, 200)
  assert.deepEqual(f.session.permissions, [read, external])
})

test("serializes two windows on one session, confirms each mode from native reads and removes only the owned block", async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.get()).json(), { mode: "autonomous" })
  const replies = await Promise.all([f.set("supervised"), f.set("supervised", "two")])
  for (const reply of replies) assert.deepEqual(reply.json(), { mode: "supervised" })
  assert.deepEqual(f.session.permissions, [read, ...block])
  assert.deepEqual(f.actions.filter(action => action !== "read"), ["config", "write"])
  f.session.permissions = [external, ...f.session.permissions, shell("deny", "outside")]
  assert.deepEqual((await f.get("two")).json(), { mode: "supervised" })
  assert.deepEqual((await f.set("autonomous", "two")).json(), { mode: "autonomous" })
  assert.deepEqual(f.session.permissions, [external, read, shell("deny", "outside")])
  assert.deepEqual((await f.get()).json(), { mode: "autonomous" })
})

test("child and grandchild modes target only the root, including equal explicit rules", async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.set("supervised")).json(), { mode: "supervised" })
  const explicit = [read, ...block]
  const child = { ...f.session, id: "ses_child", parentID: f.session.id, permissions: explicit }
  const descendant = { ...child, id: "ses_descendant", parentID: child.id, permissions: [external, ...explicit] }
  for (const copy of [child, descendant]) f.sessions.set(copy.id, copy)
  t.after(connectSessionPermissionRefresh(f.bus, f.manager, f.modes, f.worktrees, f.cleanup, f.logger))
  f.observe(child)
  for (const copy of [child, descendant]) {
    assert.deepEqual((await f.get("one", copy.id)).json(), { mode: "supervised", rootSessionID: f.session.id })
  }
  assert.deepEqual((await f.set("autonomous", "two", descendant.id)).json(), { mode: "autonomous", rootSessionID: f.session.id })
  assert.deepEqual(f.session.permissions, [read])
  assert.deepEqual(child.permissions, explicit)
  assert.deepEqual(descendant.permissions, [external, ...explicit])
  assert.deepEqual((await f.set("supervised", "two", child.id)).json(), { mode: "supervised", rootSessionID: f.session.id })
  assert.deepEqual(f.writes, [f.session.id, f.session.id, f.session.id])
})

test("a fork with a later update timestamp records its creation block and remains independent of the source", async t => {
  const f = await fixture(t)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const fork = { ...f.session, id: "ses_fork", parentID: f.session.id, fork: { sessionID: f.session.id },
    time: { created: 200, updated: 400 } } as SessionInfo
  f.sessions.set(fork.id, fork)
  t.after(connectSessionPermissionRefresh(f.bus, f.manager, f.modes, f.worktrees, f.cleanup, f.logger))
  f.observe(fork)
  assert.deepEqual((await f.get("one", fork.id)).json(), { mode: "supervised" })
  assert.deepEqual((await f.set("autonomous")).json(), { mode: "autonomous" })
  assert.deepEqual((await f.get("one", fork.id)).json(), { mode: "supervised" })
  const trailing = shell("deny", "keep *")
  fork.permissions = [read, ...block, trailing]
  assert.deepEqual((await f.set("autonomous", "two", fork.id)).json(), { mode: "autonomous" })
  assert.deepEqual(fork.permissions, [read, trailing])
})

test("forks keep explicit child denies on a direct return to Autonomous and a refresh before send", async t => {
  const f = await fixture(t)
  registerInstanceProxyRoutes(f.app, { workspaceManager: f.manager, logger: f.logger, worktreeDeletionFence: f.worktrees,
    sessionCleanup: f.cleanup, permissionModes: f.modes })
  t.after(connectSessionPermissionRefresh(f.bus, f.manager, f.modes, f.worktrees, f.cleanup, f.logger))
  const deny = shell("deny", "copied deny")
  const configWith = (rule: PermissionRule): ConfigGetOutput => [...config, { type: "document", info: { permissions: [rule] } }]
  f.replaceConfig(configWith(deny))
  assert.equal((await f.set("supervised")).statusCode, 200)
  const copy = [read, ...block, deny]
  const child = { ...f.session, id: "ses_child", parentID: f.session.id, permissions: [...copy] }
  f.sessions.set(child.id, child)
  f.observe(child)
  const scope = { client: f.client, distro: undefined, signal: t.signal, current() {} }
  await f.modes.withSessionLock(sessionPermissionTarget(child, scope), async () => {})
  assert.ok(f.modes.refreshTargets(undefined).targets.some(target => target.id === child.id))

  f.replaceConfig(config)
  const forkFrom = (source: SessionInfo, id: string) => {
    const fork = { ...source, id, fork: { sessionID: source.id }, permissions: [...source.permissions!] } as SessionInfo
    f.sessions.set(id, fork)
    return fork
  }
  const direct = forkFrom(child, "ses_direct_fork")
  await recordPermissionFork(Response.json({ data: direct }), f.modes, child, scope, async () => true)
  const refuse = async (session: SessionInfo) => {
    const refused = await f.set("autonomous", "two", session.id)
    assert.equal(refused.statusCode, 409)
    assert.equal(refused.json().code, "PERMISSION_BLOCK_UNVERIFIED")
  }
  await refuse(direct)
  assert.deepEqual(direct.permissions, copy)

  const fork = forkFrom(direct, "ses_fork_again")
  f.observe(fork)
  assert.deepEqual((await f.get("two", fork.id)).json(), { mode: "supervised" })
  const nextDeny = shell("deny", "new deny")
  f.replaceConfig(configWith(nextDeny))
  const sends: Array<PermissionRule[] | undefined> = []
  f.onDispatch(() => sends.push(fork.permissions))
  const send = () => f.app.inject({ method: "POST", url: `/workspaces/one/instance/api/session/${fork.id}/prompt`, payload: { text: "fixture" } })
  assert.equal((await send()).statusCode, 204)
  assert.deepEqual(sends, [[...copy, nextDeny]])
  f.replaceConfig([{ type: "document", info: { permissions: [edit("deny", "~/fixture/*")] } }])
  assert.equal((await send()).statusCode, 204, "an optional additive refresh does not block the send")
  assert.deepEqual(sends[1], [...copy, nextDeny])
  await refuse(fork)

  f.replaceConfig(config)
  assert.equal((await f.set("supervised", "one", fork.id)).statusCode, 200)
  assert.deepEqual(fork.permissions?.slice(0, copy.length + 1), [...copy, nextDeny])
  assert.ok(fork.permissions!.length > copy.length + 1)
  assert.equal((await f.set("autonomous", "two", fork.id)).statusCode, 200)
  assert.deepEqual(fork.permissions, [...copy, nextDeny])
  await refuse(fork)
  assert.deepEqual(direct.permissions, copy)
  assert.deepEqual(child.permissions, copy)
})

test("unknown fork and child rules never block sends, and only the fork refuses removal", async t => {
  const f = await fixture(t)
  registerInstanceProxyRoutes(f.app, { workspaceManager: f.manager, logger: f.logger, worktreeDeletionFence: f.worktrees,
    sessionCleanup: f.cleanup, permissionModes: f.modes })
  const rules = [read, ...block, ...block]
  const child = { ...f.session, id: "ses_child", parentID: f.session.id, permissions: rules }
  const fork = { ...child, id: "ses_fork", fork: { sessionID: child.id } } as SessionInfo
  for (const copy of [child, fork]) {
    f.sessions.set(copy.id, copy)
    const sent = await f.app.inject({ method: "POST", url: `/workspaces/one/instance/api/session/${copy.id}/prompt`, payload: { text: "fixture" } })
    assert.equal(sent.statusCode, 204, sent.body)
  }
  assert.equal((await f.set("autonomous", "two", child.id)).statusCode, 200)
  assert.deepEqual((await f.get("one", fork.id)).json(), { mode: "supervised" })
  const refused = await f.set("autonomous", "two", fork.id)
  assert.equal(refused.statusCode, 409)
  assert.equal(refused.json().code, "PERMISSION_BLOCK_UNVERIFIED")
  assert.deepEqual(child.permissions, rules)
  assert.deepEqual(fork.permissions, rules)
  assert.deepEqual(f.writes, [])
})

test("cleans a deleted child's durable record and never records empty observations", async t => {
  const f = await fixture(t)
  const autonomous = { ...f.session, id: "ses_autonomous", parentID: f.session.id }
  f.sessions.set(autonomous.id, autonomous)
  t.after(connectSessionPermissionRefresh(f.bus, f.manager, f.modes, f.worktrees, f.cleanup, f.logger))
  f.observe(autonomous)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const child = { ...f.session, id: "ses_child", parentID: f.session.id, time: { created: 200, updated: 200 } }
  f.sessions.set(child.id, child)
  const target = sessionPermissionTarget(child, { client: f.client, distro: undefined, signal: t.signal, current() {} })
  f.observe(child)
  await f.modes.withSessionLock(target, async () => {})
  assert.deepEqual(f.modes.refreshTargets(undefined).targets.map(target => target.id).sort(), [child.id, f.session.id].sort())
  const modes = f.restartModes()
  const deleted = deferred()
  const forget = f.modes.forgetDeleted.bind(f.modes)
  t.mock.method(f.modes, "forgetDeleted", async (...args: Parameters<typeof forget>) => {
    await forget(...args)
    deleted.resolve()
  })
  f.sessions.delete(child.id)
  f.publish({ type: "session.deleted", data: { sessionID: child.id } })
  await deleted.promise
  assert.equal(Object.keys(f.settings.getPrivateSessionPermissionState()).length, 1)
  assert.deepEqual(modes.refreshTargets(undefined).targets.map(target => target.id), [f.session.id])
})

test("projects ordered session rules after config and restores the exact original rules", async t => {
  const f = await fixture(t)
  const original = [read, shell("allow", "echo *"), edit("ask", "notes/*"), external,
    shell("deny", "echo blocked"), { action: "*", resource: "secret.txt", effect: "deny" as const }]
  f.session.permissions = original
  assert.deepEqual((await f.set("supervised")).json(), { mode: "supervised" })
  assert.deepEqual(f.session.permissions, [...original, ...block,
    shell("ask", "echo *"), edit("ask", "notes/*"), shell("deny", "echo blocked"), edit("deny", "secret.txt"), shell("deny", "secret.txt")])
  assert.deepEqual((await f.set("autonomous")).json(), { mode: "autonomous" })
  assert.deepEqual(f.session.permissions, original)
})

test("cannot set a family's mode via a child if the parent is outside the workspace", async t => {
  const f = await fixture(t)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const child = { ...f.session, id: "ses_child", parentID: f.session.id, permissions: [...block, ...block] }
  f.sessions.set(child.id, child)
  f.session.location = { directory: "/foreign" }
  assert.equal((await f.get("one", child.id)).statusCode, 409)
  assert.equal((await f.set("autonomous", "two", child.id)).statusCode, 409)
  assert.deepEqual(child.permissions, [...block, ...block])
  assert.deepEqual(f.writes, [f.session.id])
})

test("retries an observed post-write conflict from fresh native rules, but never replays a failed transport", async t => {
  const f = await fixture(t)
  const nativeRules = [external, shell("deny", "echo blocked")]
  f.mutate(() => { f.session.permissions = nativeRules; f.mutate(undefined) })
  assert.deepEqual((await f.set("supervised")).json(), { mode: "supervised" })
  assert.deepEqual(f.session.permissions, [...nativeRules, ...block, shell("deny", "echo blocked")])
  assert.equal(f.actions.filter(action => action === "write").length, 2)
  f.mutate(() => { throw Error("lost response") })
  assert.equal((await f.set("autonomous")).statusCode, 503)
  assert.equal(f.actions.filter(action => action === "write").length, 3)
  assert.deepEqual((await f.get()).json(), { mode: "supervised" })
  f.mutate(rules => { f.session.permissions = rules; throw Error("lost response after mutation") })
  assert.deepEqual((await f.set("autonomous")).json(), { mode: "autonomous" })
  assert.deepEqual(f.session.permissions, nativeRules)
})

test("refuses ambiguous, foreign or malformed changes without touching native permissions", async t => {
  const f = await fixture(t)
  f.session.permissions = [...block]
  assert.deepEqual((await f.get()).json(), { mode: "autonomous" })
  assert.equal((await f.set("supervised")).statusCode, 409)
  assert.equal((await f.set("supervised", "foreign")).statusCode, 403)
  assert.equal((await f.set("invalid")).statusCode, 400)
  assert.equal((await f.set("supervised", "absent")).statusCode, 404)
  assert.equal(f.actions.filter(action => action === "write").length, 0)
})

test("validates the default setting and keeps the ownership record outside the public state API and events", async t => {
  const f = await fixture(t)
  const target = { client: f.client, location: f.session.location, distro: undefined, signal: t.signal }
  assert.equal(await f.modes.newRootRules(target), undefined)
  const url = "/api/storage/config/ui"
  const save = (mode: unknown) => f.app.inject({ method: "PATCH", url, payload: { settings: { newConversationPermissions: mode } } })
  assert.equal((await save("always")).statusCode, 400)
  assert.equal((await save("supervised")).statusCode, 200)
  assert.deepEqual(await f.modes.newRootRules(target), block)
  const events: unknown[] = []
  f.bus.on("storage.stateChanged", event => events.push(event.value))
  f.session.permissions = [...block]
  f.modes.confirmNewRoot(f.session, undefined, block, [])
  assert.deepEqual((await f.get()).json(), { mode: "supervised" })
  assert.deepEqual(events, [])
  const state = "/api/storage/state"
  assert.equal((await f.app.inject({ url: state })).json()[SESSION_PERMISSION_BLOCKS_OWNER], undefined)
  assert.equal((await f.app.inject({ url: `${state}/${SESSION_PERMISSION_BLOCKS_OWNER}` })).statusCode, 403)
  assert.equal((await f.app.inject({ method: "PATCH", url: state, payload: { [SESSION_PERMISSION_BLOCKS_OWNER]: null } })).statusCode, 403)
  assert.equal((await save(null)).statusCode, 200)
  assert.equal(await f.modes.newRootRules(target), undefined)
  assert.deepEqual((await f.get()).json(), { mode: "supervised" }, "default changes only new roots")
})
