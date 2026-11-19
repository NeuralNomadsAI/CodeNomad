import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import type { ConfigGetOutput, PermissionRule, SessionInfo } from "@opencode/client"
import Fastify from "fastify"
import { resolveConfigLocation } from "../../config/location"
import { EventBus } from "../../events/bus"
import { createLogger } from "../../logger"
import { SessionPermissionModes } from "../../permissions/session-mode"
import { supervisedRules } from "../../permissions/session-mode-rules"
import { SESSION_PERMISSION_BLOCKS_OWNER, SettingsService } from "../../settings/service"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { SessionCleanupFence } from "../session-cleanup-fence"
import { registerSessionPermissionModeRoutes } from "./session-permission-mode"
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
  const logger = createLogger({ level: "silent" })
  const settings = new SettingsService(resolveConfigLocation(root), bus, logger)
  const sessionID = "ses_example"
  const session = { id: sessionID, projectID: "test", time: { created: 100 }, location: { directory: "/worktree" }, permissions: [read] } as SessionInfo
  const sessions = new Map([[sessionID, session]])
  const actions: string[] = []
  const writes: string[] = []
  let mutate: ((rules: PermissionRule[]) => void) | undefined
  let configEntries = config
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        actions.push("read")
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
  const connection = { client, assertCurrent() {} } as ServiceConnection
  const workspaces = { one: {}, two: {}, foreign: {} } as Record<string, {} | undefined>
  const manager = {
    get: (id: string) => workspaces[id] as never,
    getSharedServiceConnection: async () => connection,
    getServiceWslDistro: () => undefined,
    ownsLocation: async (id: string, location: SessionInfo["location"]) => id !== "foreign" && location.directory === "/worktree",
    getWorktreeIdentityForPath: async () => "/worktree",
  }
  const modes = new SessionPermissionModes(settings)
  registerSessionPermissionModeRoutes(app, { workspaceManager: manager, modes,
    worktreeDeletionFence: new WorktreeDeletionFence(), cleanup: new SessionCleanupFence() })
  registerSettingsRoutes(app, { settings, logger })
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
  const url = (id: string, selected: string) => `/api/workspaces/${id}/sessions/${selected}/permission-mode`
  return { app, bus, settings, modes, actions, writes, session, sessions, client, mutate: (next: typeof mutate) => { mutate = next },
    replaceConfig: (next: ConfigGetOutput) => { configEntries = next },
    get: (id = "one", selected = sessionID) => app.inject({ url: url(id, selected) }),
    set: (mode: string, id = "one", selected = sessionID) => app.inject({ method: "PUT", url: url(id, selected), payload: { mode } }) }
}

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

test("finds inherited blocks in native child and fork lineage, and removes only the chosen copy", async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.set("supervised")).json(), { mode: "supervised" })
  const child = { ...f.session, id: "ses_child", parentID: f.session.id }
  const descendant = { ...child, id: "ses_descendant", parentID: child.id, permissions: [external, read, ...block] }
  const fork = { ...child, id: "ses_fork", fork: { sessionID: child.id } } as SessionInfo
  for (const copy of [child, descendant, fork]) f.sessions.set(copy.id, copy)
  for (const copy of [child, descendant, fork]) assert.deepEqual((await f.get("one", copy.id)).json(), { mode: "supervised" })
  assert.deepEqual((await f.set("supervised", "two", child.id)).json(), { mode: "supervised" })
  assert.deepEqual(f.writes, [f.session.id], "selecting the existing mode does not append anything")

  assert.deepEqual((await f.set("autonomous", "two", child.id)).json(), { mode: "autonomous" })
  assert.deepEqual(child.permissions, [read])
  assert.deepEqual(f.session.permissions, [read, ...block])
  assert.deepEqual((await f.set("autonomous")).json(), { mode: "autonomous" })
  assert.deepEqual((await f.get("one", fork.id)).json(), { mode: "supervised" })
  assert.deepEqual((await f.set("autonomous", "one", descendant.id)).json(), { mode: "autonomous" })
  assert.deepEqual(descendant.permissions, [external, read])
  assert.deepEqual(fork.permissions, [read, ...block])
  assert.deepEqual(f.writes, [f.session.id, child.id, f.session.id, descendant.id])
})

test("recognizes earlier copies when a source gets a different supervised block", async t => {
  const f = await fixture(t)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const child = { ...f.session, id: "ses_child", parentID: f.session.id }
  f.sessions.set(child.id, child)
  assert.equal((await f.set("autonomous")).statusCode, 200)
  const newConfig: ConfigGetOutput = [{ type: "document", info: { permissions: [shell("deny", "new *")] } }]
  f.replaceConfig(newConfig)
  assert.equal((await f.set("supervised")).statusCode, 200)
  assert.deepEqual((await f.get("one", child.id)).json(), { mode: "supervised" })
  assert.equal((await f.set("autonomous", "one", child.id)).statusCode, 200)
  assert.deepEqual(child.permissions, [read])
  assert.deepEqual(f.session.permissions, [read, ...supervisedRules(newConfig, false)])
})

test("does not remove ambiguous copies or use ownership records from a foreign source", async t => {
  const f = await fixture(t)
  assert.equal((await f.set("supervised")).statusCode, 200)
  const child = { ...f.session, id: "ses_child", parentID: f.session.id, permissions: [...block, ...block] }
  f.sessions.set(child.id, child)
  assert.deepEqual((await f.get("one", child.id)).json(), { mode: "supervised" })
  assert.equal((await f.set("autonomous", "two", child.id)).statusCode, 409)
  f.session.location = { directory: "/foreign" }
  child.permissions = [...block]
  assert.deepEqual((await f.get("one", child.id)).json(), { mode: "autonomous" })
  assert.deepEqual((await f.set("autonomous", "two", child.id)).json(), { mode: "autonomous" })
  assert.deepEqual(child.permissions, block)
  assert.deepEqual(f.writes, [f.session.id])
})

test("retries an observed post-write conflict from fresh native rules, but never replays a failed transport", async t => {
  const f = await fixture(t)
  f.mutate(() => { f.session.permissions = [external]; f.mutate(undefined) })
  assert.deepEqual((await f.set("supervised")).json(), { mode: "supervised" })
  assert.deepEqual(f.session.permissions, [external, ...block])
  assert.equal(f.actions.filter(action => action === "write").length, 2)
  f.mutate(() => { throw Error("lost response") })
  assert.equal((await f.set("autonomous")).statusCode, 503)
  assert.equal(f.actions.filter(action => action === "write").length, 3)
  assert.deepEqual((await f.get()).json(), { mode: "supervised" })
  f.mutate(rules => { f.session.permissions = rules; throw Error("lost response after mutation") })
  assert.deepEqual((await f.set("autonomous")).json(), { mode: "autonomous" })
  assert.deepEqual(f.session.permissions, [external])
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
