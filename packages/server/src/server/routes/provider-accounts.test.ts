import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerProviderAccountsRoutes } from "./provider-accounts"
import { ProviderAccountsService } from "../../provider-accounts/service"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

async function fixture() {
  const app = Fastify()
  const workspace = { id: "w", path: "D:/project" }
  const state = { current: true, reads: 0, owned: true, available: true, supported: true, enabled: false, fail: false,
    integrations: [] as string[], policy: {} as Record<string, boolean> }
  const connection = { client: {}, assertCurrent: () => { if (!state.current) throw new Error("private-native-detail") } }
  const accounts = {
    snapshot: async (_connection: unknown, directory: string, integrationID: string) => {
      state.reads++; assert.equal(directory, "/project")
      state.integrations.push(integrationID)
      if (state.fail) throw new Error("secret-access-token")
      return { supported: state.supported, enabled: state.enabled, logins: { one: "one@example.com" } }
    },
    supports: (integrationID: string) => ["openai", "opencode-go", "opencode"].includes(integrationID),
    setEnabled: (enabled: boolean, integrationID = "openai") => { state.enabled = enabled; state.policy[integrationID] = enabled },
  } as unknown as ProviderAccountsService
  const fence = new WorktreeDeletionFence()
  registerProviderAccountsRoutes(app, { accounts, worktreeDeletionFence: fence, workspaceManager: {
    get: id => id === "w" && state.available ? workspace as never : undefined,
    getSharedServiceConnection: async () => connection as never,
    getServiceDirectoryForPath: async (_id, directory) => directory === "D:/project" ? "/project" : undefined,
    ownsLocation: async () => state.owned,
    getWorktreeIdentityForPath: async () => "owned-root",
  } })
  return { app, state, fence, url: "/api/workspaces/w/provider-accounts/openai" }
}

test("account settings require owned exact location before accessing native credentials", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.app.inject({ url: `${f.url}?directory=/foreign` })).statusCode, 403)
    assert.equal(f.state.reads, 0)
    const read = await f.app.inject({ url: `${f.url}?directory=D:/project` })
    assert.equal(read.statusCode, 200)
    assert.equal(read.headers["cache-control"], "no-store")
    assert.deepEqual(read.json().logins, { one: "one@example.com" })
    const invalid = await f.app.inject({ method: "PUT", url: f.url, payload: { directory: "D:/project", enabled: "yes" } })
    assert.equal(invalid.statusCode, 400)
    assert.equal(f.state.enabled, false)
  } finally { await f.app.close() }
})

test("opt-in writes are explicit, supported-only and fenced against deletion", async () => {
  const f = await fixture()
  try {
    f.state.supported = false
    const write = () => f.app.inject({ method: "PUT", url: f.url, payload: { directory: "D:/project", enabled: true } })
    assert.equal((await write()).statusCode, 409)
    assert.equal(f.state.enabled, false)
    f.state.supported = true
    assert.equal((await write()).json().enabled, true)
    let release!: () => void
    const deleting = f.fence.run("owned-root", ["owned-root"], () => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    assert.equal((await write()).statusCode, 409)
    release()
    await deleting
    f.state.supported = false
    const disabled = await f.app.inject({ method: "PUT", url: f.url, payload: { directory: "D:/project", enabled: false } })
    assert.equal(disabled.statusCode, 200)
    assert.equal(f.state.enabled, false)
  } finally { await f.app.close() }
})

test("any registered integration reads and writes its own policy; unregistered ones refuse writes", async () => {
  const f = await fixture()
  try {
    const go = "/api/workspaces/w/provider-accounts/opencode-go"
    const read = await f.app.inject({ url: `${go}?directory=D:/project` })
    assert.equal(read.statusCode, 200)
    assert.deepEqual(f.state.integrations, ["opencode-go"])
    const write = await f.app.inject({ method: "PUT", url: go, payload: { directory: "D:/project", enabled: true } })
    assert.equal(write.statusCode, 200)
    assert.deepEqual(f.state.policy, { "opencode-go": true })
    for (const enabled of [true, false]) {
      const refused = await f.app.inject({ method: "PUT", url: "/api/workspaces/w/provider-accounts/deepinfra",
        payload: { directory: "D:/project", enabled } })
      assert.equal(refused.statusCode, 409)
    }
    assert.deepEqual(f.state.policy, { "opencode-go": true })
  } finally { await f.app.close() }
})

test("reconnect and credential failures disclose no upstream details or mutate policy", async () => {
  const f = await fixture()
  try {
    for (const failure of ["fail", "current"] as const) {
      f.state.fail = failure === "fail"; f.state.current = failure !== "current"
      const response = await f.app.inject({ method: "PUT", url: f.url, payload: { directory: "D:/project", enabled: true } })
      assert.equal(response.statusCode, 503)
      assert.equal(response.body.includes("secret"), false)
      assert.equal(response.body.includes("private"), false)
      assert.equal(f.state.enabled, false)
    }
  } finally { await f.app.close() }
})
