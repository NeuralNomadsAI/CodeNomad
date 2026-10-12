import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { OpenCode, type CredentialEntry } from "@opencode/client"
import { EventBus } from "../events/bus"
import { nativeEventConnections, type ServiceConnection } from "../workspaces/opencode-service"
import type { SettingsService } from "../settings/service"
import type { ProviderUsage } from "../usage/types"
import { ProviderHttpError } from "../usage/shared"
import { createSelectionAdapters } from "./adapters"
import { quotaMarkTtl } from "./quota-marks"
import { observeProviderQuotaFailures, quotaFailure } from "./quota-observer"
import { definiteRejection, ProviderAccountsService } from "./service"

const usage = (used: number): ProviderUsage => ({ windows: { "5h": { usedPercent: used, remainingPercent: 100 - used, windowSeconds: 18_000, resetAt: Date.now() + 3_600_000 } } })
const goKey = (id: string, active = false): CredentialEntry => ({ id, integrationID: "opencode-go", label: id, active, value: { type: "key", key: `secret-${id}` } })

// Isolated fake daemon; never the shared OpenCode service.
async function goFixture(options: { integrationID?: string; providerID?: string; entries?: CredentialEntry[] } = {}) {
  const integrationID = options.integrationID ?? "opencode-go"
  const entries = options.entries ?? [goKey("one", true), goKey("two"), goKey("three")]
  const state = { entries, order: entries.map(entry => entry.id), provider: options.providerID ?? "opencode-go", calls: [] as string[],
    reads: [] as string[], quota: {} as Record<string, ProviderUsage | number | undefined>,
    onCredentialList: undefined as (() => void) | undefined }
  let policy: Record<string, any> = {}
  const settings = {
    getOwner: () => policy,
    mergePatchOwner: (_kind: string, _owner: string, patch: any) => {
      policy = { ...policy, autoSelect: { ...policy.autoSelect, ...patch.autoSelect } }; return policy
    },
  } as Pick<SettingsService, "getOwner" | "mergePatchOwner">
  const server = createServer((req, res) => {
    state.calls.push(`${req.method} ${req.url}`)
    res.setHeader("Content-Type", "application/json")
    if (req.url?.startsWith("/api/session/")) res.end(JSON.stringify({ data: { id: "ses_go", projectID: "fixture",
      location: { directory: "/project" }, model: { providerID: state.provider, id: "fixture" }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } } }))
    else if (req.url?.startsWith("/api/provider/")) res.end(JSON.stringify({ location: { directory: "/project" }, data: {
      id: state.provider, integrationID, name: "Fixture", activation: "auto", package: "fixture" } }))
    else if (req.url?.startsWith("/api/integration/")) res.end(JSON.stringify({ location: { directory: "/project" }, data: {
      id: integrationID, name: "Fixture", methods: [], connections: state.order.map(id => {
        const entry = state.entries.find(entry => entry.id === id)!
        return { type: "credential", id, label: entry.label, method: entry.value.type === "key" ? "key" : "oauth" }
      }) } }))
    else if (req.url === "/api/credential") { res.end(JSON.stringify({ data: state.entries })); state.onCredentialList?.() }
    else if (req.url?.endsWith("/activate")) {
      const id = req.url.split("/")[3]
      state.order = [id, ...state.order.filter(item => item !== id)]
      for (const entry of state.entries) entry.active = entry.id === id
      res.statusCode = 204; res.end()
    } else { res.statusCode = 404; res.end("{}") }
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  const connection = { client, assertCurrent: () => {} } as unknown as ServiceConnection
  const service = new ProviderAccountsService(settings, undefined, createSelectionAdapters({
    codexQuota: async () => { throw new Error("Quota unavailable") },
    usage: async () => ({ providerId: "x", providerName: "x", ok: false, configured: true, fetchedAt: Date.now(), usage: null }),
    goQuota: async auth => {
      const id = auth.token.slice(7)
      state.reads.push(id)
      const result = state.quota[id]
      if (typeof result === "number") throw new ProviderHttpError(result)
      if (!result) throw new Error("Quota unavailable")
      return result
    },
  }), 50)
  const bus = new EventBus()
  const stop = observeProviderQuotaFailures(bus, service)
  const emit = (event: Record<string, unknown>) => {
    nativeEventConnections.set(event, connection)
    bus.publish({ type: "instance.event", instanceId: "w", event } as never)
  }
  const activations = () => state.calls.filter(call => call.endsWith("/activate")).length
  return { state, service, connection, emit, activations, integrationID,
    send: () => service.beforeSend(connection, "ses_go", AbortSignal.timeout(3000), async directory => directory === "/project"),
    mark: (failedAt = Date.now(), limitName = "5 hour", watermark?: number) => service.markQuotaFailure(connection,
      { sessionID: "ses_go", failedAt, limitName, ...(watermark === undefined ? {} : { watermark }) }, AbortSignal.timeout(3000)),
    close: () => { stop(); return new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) },
  }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(predicate(), true)
}

test("Go rotates from an exhausted account to an unknown-but-unmarked candidate", async () => {
  const f = await goFixture()
  try {
    await f.send(); assert.equal(f.state.calls.length, 0, "disabled policy makes no native reads")
    f.service.setEnabled(true, "opencode-go")
    f.state.quota.one = usage(100)
    f.state.quota.two = 403 // no Go subscription: never a candidate
    await f.send()
    assert.deepEqual(f.state.order, ["three", "one", "two"])
    assert.equal(f.activations(), 1)
    assert.deepEqual(f.state.reads, ["one", "two", "three"])
  } finally { await f.close() }
})

test("an unknown current quota only rotates after a native quota failure marked it", async () => {
  const f = await goFixture()
  try {
    f.service.setEnabled(true, "opencode-go")
    await f.send()
    assert.equal(f.activations(), 0, "unknown usage is not exhaustion evidence")
    assert.equal(await f.mark(), true)
    await f.send()
    assert.deepEqual(f.state.order, ["two", "one", "three"])
    // Our own switch makes a failure without an observed later step ambiguous.
    assert.equal(await f.mark(), false)
    const started = Date.now() + 1
    f.service.observeStepStart(f.connection, "ses_go", started, "opencode-go")
    // The marked account is skipped while unknown, even though it is next in order.
    assert.equal(await f.mark(started + 1), true)
    await f.send()
    assert.deepEqual(f.state.order, ["three", "two", "one"])
    // A fresh "available" read clears a mark.
    f.state.quota.three = usage(10)
    await f.send()
    assert.equal(f.state.order[0], "three")
  } finally { await f.close() }
})

test("marks are not recorded for disabled policies, ambiguous attribution or manual changes", async () => {
  const f = await goFixture()
  try {
    assert.equal(await f.mark(), false, "policy disabled")
    f.service.setEnabled(true, "opencode-go")
    const failedAt = Date.now()
    f.service.observeStepStart(f.connection, "ses_go", failedAt - 1000, "opencode-go")
    f.service.observeSwitch(f.connection, "opencode-go", failedAt - 500)
    assert.equal(await f.mark(failedAt), false, "a switch during the failing step is ambiguous")
    f.service.observeStepStart(f.connection, "ses_go", failedAt + 1000, "opencode-go")
    assert.equal(await f.mark(failedAt + 2000), true)
    f.service.manual(f.connection)()
    await f.send()
    assert.equal(f.activations(), 0, "a manual account change forgets marks")
  } finally { await f.close() }
})

test("the event observer marks only provider.quota failures, once per failure", async () => {
  const f = await goFixture()
  try {
    f.service.setEnabled(true, "opencode-go")
    const base = Date.now()
    f.emit({ id: "evt_start", type: "session.step.started", created: base - 1000, data: { sessionID: "ses_go", model: { providerID: "opencode-go", id: "m" } } })
    f.emit({ id: "evt_other", type: "session.step.failed", created: base, data: { sessionID: "ses_go", error: { type: "provider.auth", message: "x" } } })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(f.state.calls.length, 0, "other errors are ignored without native reads")
    const body = JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: "limit" }, metadata: { limitName: "5 hour" } })
    const failed = { id: "evt_quota", type: "session.step.failed", created: base, data: { sessionID: "ses_go", assistantMessageID: "msg",
      error: { type: "provider.quota", status: 429, message: "limit", response: { body } } } }
    f.emit(failed); f.emit(failed)
    f.emit({ id: "evt_exec", type: "session.execution.failed", created: base + 5, data: { sessionID: "ses_go", error: failed.data.error } })
    await until(() => f.state.calls.filter(call => call === "GET /api/credential").length === 2)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(f.state.calls.filter(call => call.startsWith("GET /api/session/")).length, 1, "deduplicated")
    await f.send()
    assert.equal(f.state.order[0], "two")
  } finally { await f.close() }
})

test("Console sign-in rotates only the Go provider", async () => {
  const consoleKey = (id: string, active = false): CredentialEntry => ({ id, integrationID: "opencode", label: id, active,
    value: { type: "key", key: `secret-${id}`, metadata: { orgID: `org_${id}` } } })
  const f = await goFixture({ integrationID: "opencode", providerID: "opencode", entries: [consoleKey("one", true), consoleKey("two")] })
  try {
    f.service.setEnabled(true, "opencode")
    f.state.quota.one = usage(100)
    await f.send()
    assert.equal(f.activations(), 0, "Zen pay-as-you-go is not a quota subscription")
    f.state.provider = "opencode-go"
    await f.send()
    assert.equal(f.state.order[0], "two")
    const snapshot = await f.service.snapshot(f.connection, "/project", "opencode", AbortSignal.timeout(3000))
    assert.deepEqual(snapshot, { supported: true, enabled: true, logins: {} })
  } finally { await f.close() }
})

test("reactive marks rotate Claude to an unreadable candidate but never Codex", async () => {
  const account = (integrationID: string, methodID: string) => (id: string, active = false): CredentialEntry => ({
    id, integrationID, label: id, active, value: { type: "oauth", methodID, access: `secret-${id}`, refresh: "secret-refresh",
      expires: Date.now() + 3_600_000, metadata: { accountID: `acct-${id}` } } })
  for (const [integrationID, methodID, rotates] of [["anthropic", "claude", true], ["openai", "chatgpt-browser", false]] as const) {
    const make = account(integrationID, methodID)
    const f = await goFixture({ integrationID, providerID: integrationID === "openai" ? "openai" : "anthropic", entries: [make("one", true), make("two")] })
    try {
      f.service.setEnabled(true, integrationID)
      assert.equal(await f.mark(), true)
      await f.send()
      assert.equal(f.state.order[0], rotates ? "two" : "one", integrationID)
    } finally { await f.close() }
  }
})

test("definite client errors rule candidates out; transport, rate-limit and 5xx stay unknown", async () => {
  const f = await goFixture({ entries: [goKey("one", true), goKey("two"), goKey("three"), goKey("four")] })
  try {
    f.service.setEnabled(true, "opencode-go")
    f.state.quota.one = usage(100)
    // e.g. a Zen key without Go (402), a missing endpoint (404) or a malformed request (400).
    Object.assign(f.state.quota, { two: 402, three: 404, four: 400 })
    await f.send()
    assert.equal(f.activations(), 0, "never switch to a rejected account (or its Zen billing)")
    for (const status of [408, 429, 503]) {
      f.state.quota.four = status
      f.state.order = ["one", "two", "three", "four"]
      for (const entry of f.state.entries) entry.active = entry.id === "one"
      const before = f.activations()
      await f.send()
      assert.equal(f.activations(), before + 1, `HTTP ${status} is not a definite rejection`)
      assert.equal(f.state.order[0], "four")
    }
  } finally { await f.close() }
  for (const [status, rejected] of [[400, true], [402, true], [404, true], [451, true], [408, false], [429, false], [500, false], [503, false]] as const) {
    assert.equal(definiteRejection(status), rejected, String(status))
  }
})

test("a native switch arriving late from another relay queue never marks the new account", async () => {
  const switchTo = (f: Awaited<ReturnType<typeof goFixture>>, id: string) => {
    f.state.order = [id, ...f.state.order.filter(item => item !== id)]
    for (const entry of f.state.entries) entry.active = entry.id === id
  }
  for (const scenario of ["switch read before its event arrives", "switch during the settle wait"] as const) {
    const f = await goFixture()
    try {
      f.service.setEnabled(true, "opencode-go")
      const started = Date.now() - 1000
      f.service.observeStepStart(f.connection, "ses_go", started, "opencode-go")
      let served = 0
      if (scenario === "switch read before its event arrives") {
        // A TUI or another backend already selected healthy "two": attribution reads see it,
        // while its credential.switched event is still queued behind another relay key.
        switchTo(f, "two")
        f.state.onCredentialList = () => {
          if (++served === 1) setTimeout(() => f.service.observeSwitch(f.connection, "opencode-go", Date.now(), "two"), 10)
        }
      } else {
        f.state.onCredentialList = () => { if (++served === 1) setTimeout(() => switchTo(f, "two"), 10) }
      }
      assert.equal(await f.mark(started + 500), false, scenario)
      f.state.onCredentialList = undefined
      // No account was marked: an unknown, unmarked current account never rotates.
      for (const id of ["two", "one"]) {
        switchTo(f, id)
        await f.send()
      }
      assert.equal(f.activations(), 0, scenario)
    } finally { await f.close() }
  }
})

test("attribution follows the account known active at step start and the receipt watermark", async () => {
  const f = await goFixture()
  try {
    f.service.setEnabled(true, "opencode-go")
    const now = Date.now()
    // The last known switch before the step selected "two"; native now reports "one".
    f.service.observeSwitch(f.connection, "opencode-go", now - 10_000, "two")
    f.service.observeStepStart(f.connection, "ses_go", now - 1000, "opencode-go")
    assert.equal(await f.mark(now - 500), false, "selection differs from the account active when the step started")
    f.service.observeSwitch(f.connection, "opencode-go", now - 9_000, "one")
    // A switch observed between receipt and processing fences the mark even with an older timestamp.
    const watermark = f.service.switchWatermark(f.connection)
    f.service.observeSwitch(f.connection, "opencode-go", now - 8_000, "one")
    assert.equal(await f.mark(now - 500, "5 hour", watermark), false, "switch observed after receipt")
    assert.equal(await f.mark(now - 500, "5 hour", f.service.switchWatermark(f.connection)), true)
  } finally { await f.close() }
})

test("quota failure parsing and mark lifetimes", () => {
  const error = (body?: string) => ({ type: "session.step.failed", created: 5, data: { sessionID: "s", error: { type: "provider.quota", message: "m", ...(body === undefined ? {} : { response: { body } }) } } })
  assert.deepEqual(quotaFailure(error(JSON.stringify({ metadata: { limitName: "weekly" } }))), { sessionID: "s", failedAt: 5, limitName: "weekly" })
  assert.deepEqual(quotaFailure(error("not json")), { sessionID: "s", failedAt: 5 })
  assert.equal(quotaFailure({ ...error(), type: "session.text.delta" }), undefined)
  assert.equal(quotaFailure({ type: "session.step.failed", data: { sessionID: "s", error: { type: "provider.rate_limit" } } }), undefined)
  assert.equal(quotaMarkTtl("5 hour"), 5 * 3_600_000)
  for (const name of ["weekly", "monthly", undefined, "anything"]) assert.equal(quotaMarkTtl(name), 24 * 3_600_000)
})
