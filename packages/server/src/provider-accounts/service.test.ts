import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { OpenCode, type CredentialEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { SettingsService } from "../settings/service"
import { AccountSelectionFailed, ProviderAccountsService, quotaState } from "./service"

const quota = (used = 25, resetAt: number | null = Date.now() + 3600000) => ({ windows: {
  "5h": { usedPercent: used, remainingPercent: 100 - used, windowSeconds: 18000, resetAt },
} })
const credential = (id: string, active = false): CredentialEntry => ({
  id, integrationID: "openai", label: "default", active,
  value: { type: "oauth", methodID: "chatgpt-browser", access: `secret-${id}`, refresh: "secret-refresh",
    expires: Date.now() + 3600000, metadata: { accountID: `private-${id}`, email: `${id}@example.com` } },
})
export async function accountsFixture() {
  const entries = [credential("one", true), credential("two"), credential("three")]
  const state = { entries, order: ["one", "two", "three"], current: true, directory: "/project", provider: "openai",
    activeFailure: false, needsAuth: new Set<string>(), calls: [] as string[], quotaCalls: [] as string[],
    usage: { one: quota(100), two: quota(20), three: quota(30) } as Record<string, ReturnType<typeof quota>> }
  let policy: Record<string, any> = {}
  const settings = {
    getOwner: () => policy,
    mergePatchOwner: (_kind: string, _owner: string, patch: any) => { policy = { ...policy, ...patch }; return policy },
  } as Pick<SettingsService, "getOwner" | "mergePatchOwner">
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer isolated-secret")
    state.calls.push(`${req.method} ${req.url}`)
    res.setHeader("Content-Type", "application/json")
    if (req.url?.startsWith("/api/session/")) res.end(JSON.stringify({ data: { id: "ses_fixture", projectID: "fixture",
      location: { directory: state.directory }, model: { providerID: state.provider, id: "fixture" }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } } }))
    else if (req.url?.startsWith("/api/provider/")) res.end(JSON.stringify({ location: { directory: state.directory }, data: {
      id: state.provider, integrationID: state.provider, name: "Fixture", activation: "auto", package: "fixture" } }))
    else if (req.url?.startsWith("/api/integration/")) res.end(JSON.stringify({ location: { directory: state.directory }, data: {
      id: "openai", name: "Fixture", methods: [], connections: state.order.map(id => {
        const entry = state.entries.find(entry => entry.id === id)!
        return { type: "credential", id, label: entry.label, method: entry.value.type === "key" ? "key" : "oauth",
          ...(state.needsAuth.has(id) ? { status: { status: "needs_auth", message: "private-error" } } : {}) }
      }),
    } }))
    else if (req.url === "/api/credential") res.end(JSON.stringify({ data: state.entries }))
    else if (req.url?.endsWith("/activate")) {
      if (state.activeFailure) { res.statusCode = 500; res.end(JSON.stringify({ error: "secret-provider-error" })); return }
      const id = req.url.split("/")[3]
      state.order = [id, ...state.order.filter(item => item !== id)]
      for (const entry of state.entries) entry.active = entry.id === id
      res.statusCode = 204; res.end()
    } else { res.statusCode = 404; res.end("{}") }
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headers: { authorization: "Bearer isolated-secret" } })
  const connection = { client, assertCurrent: () => { if (!state.current) throw new Error("Stale fixture") } } as ServiceConnection
  const service = new ProviderAccountsService(settings, async (_access, accountID, signal) => {
    signal.throwIfAborted(); state.quotaCalls.push(accountID)
    return state.usage[accountID.slice(8)] ?? { windows: {} }
  })
  return { state, settings, service, connection,
    send: (validate: (directory: string) => Promise<boolean> = async directory => directory === "/project") =>
      service.beforeSend(connection, "ses_fixture", AbortSignal.timeout(3000), validate),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

test("opt-in is absent by default and only exhausted supported OAuth rotates", async () => {
  const f = await accountsFixture()
  try {
    await f.send(); assert.equal(f.state.calls.length, 0)
    f.service.setEnabled(true)
    f.state.usage.one = quota(99); await f.send()
    assert.deepEqual(f.state.order, ["one", "two", "three"])
    assert.deepEqual(f.state.quotaCalls, ["private-one"])
    f.state.usage.one = quota(100); await f.send()
    assert.deepEqual(f.state.order, ["two", "one", "three"])
    assert.equal(f.state.calls.filter(call => call.includes("/activate")).length, 1)
    assert.deepEqual(f.settings.getOwner("config", "providerAccounts").autoSelect, { openai: true })
  } finally { await f.close() }
})

test("unknown/reset quotas, key/expired/needs-auth candidates and all-exhausted catalogs never switch", async () => {
  const f = await accountsFixture()
  try {
    f.service.setEnabled(true)
    f.state.usage.one = quota(100, 1); await f.send()
    assert.deepEqual(f.state.quotaCalls, ["private-one"])
    f.state.usage.one = quota(100)
    f.state.entries[1].value = { type: "key", key: "secret-key" }
    f.state.needsAuth.add("three"); await f.send()
    assert.equal(f.state.quotaCalls.length, 2)
    f.state.entries[1] = credential("two")
    f.state.entries[2].value = { ...credential("three").value, type: "oauth", methodID: "chatgpt-browser",
      access: "secret-three", refresh: "secret-refresh", expires: 1 }
    f.state.usage.two = { windows: {} } as any; await f.send()
    f.state.usage.two = quota(100); await f.send()
    assert.equal(f.state.calls.filter(call => call.includes("/activate")).length, 0)
    assert.equal(f.state.order[0], "one")
    assert.equal(quotaState({ windows: {} }), "unknown")
    assert.equal(quotaState(quota(100)), "exhausted")
    assert.equal(quotaState(quota(20)), "available")
  } finally { await f.close() }
})

test("manual away-and-back and policy changes fence a pending decision", async () => {
  for (const change of ["manual", "policy"] as const) {
    const f = await accountsFixture()
    try {
      f.service.setEnabled(true)
      let checks = 0
      await f.send(async () => {
        if (++checks === 2) {
          if (change === "manual") f.service.manual(f.connection)()
          else { f.service.setEnabled(false); f.service.setEnabled(true) }
        }
        return true
      })
      assert.equal(f.state.order[0], "one")
      assert.equal(f.state.calls.filter(call => call.includes("/activate")).length, 0)
    } finally { await f.close() }
  }
})

test("concurrent workspaces serialize; connection and location changes cannot activate", async () => {
  const f = await accountsFixture()
  try {
    f.service.setEnabled(true)
    await Promise.all([f.send(), f.send()])
    assert.equal(f.state.calls.filter(call => call.includes("/activate")).length, 1)
    f.state.order = ["one", "two", "three"]
    for (const entry of f.state.entries) entry.active = entry.id === "one"
    let checks = 0
    await f.send(async () => { if (++checks === 2) f.state.directory = "/foreign"; return f.state.directory === "/project" })
    assert.equal(f.state.calls.filter(call => call.includes("/activate")).length, 1)
    f.state.directory = "/project"; checks = 0
    await assert.rejects(f.send(async () => { if (++checks === 2) f.state.current = false; return true }), /Stale fixture/)
    assert.equal(f.state.calls.filter(call => call.includes("/activate")).length, 1)
  } finally { await f.close() }
})

test("failed activation is redacted and never retried with another account", async () => {
  const f = await accountsFixture()
  try {
    f.service.setEnabled(true); f.state.activeFailure = true
    await assert.rejects(f.send(), error => error instanceof AccountSelectionFailed && !String(error).includes("secret"))
    assert.equal(f.state.calls.filter(call => call.includes("/activate")).length, 1)
    assert.equal(f.state.order[0], "one")
  } finally { await f.close() }
})

test("Settings snapshots disclose only fallback logins and preserve aliases", async () => {
  const f = await accountsFixture()
  try {
    f.state.entries[1].label = "Team alias"
    const snapshot = await f.service.snapshot(f.connection, "/project", "openai", AbortSignal.timeout(3000))
    assert.deepEqual(snapshot, { supported: true, enabled: false, logins: { one: "one@example.com", three: "three@example.com" } })
    const raw = JSON.stringify(snapshot)
    for (const forbidden of ["secret", "private-", "access", "refresh", "expires"]) assert.equal(raw.includes(forbidden), false)
    f.state.calls = []
    assert.deepEqual(await f.service.snapshot(f.connection, "/project", "anthropic", AbortSignal.timeout(3000)),
      { supported: false, enabled: false, logins: {} })
    assert.equal(f.state.calls.length, 0)
    f.state.provider = "anthropic"; f.service.setEnabled(true); await f.send()
    assert.equal(f.state.quotaCalls.length, 0)
  } finally { await f.close() }
})
