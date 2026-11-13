import assert from "node:assert/strict"
import test from "node:test"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { createOpenCodeFreeUsage } from "./opencode-free-usage"

const day = Date.UTC(2026, 10, 6)
const signal = () => AbortSignal.timeout(3000)
function fixture() {
  const state = { key: "synthetic-one", exhausted: false }
  const connection = { client: {
    session: { stats: async () => { assert.fail("free quota must never read local stats") } },
    credential: { list: async () => [{ active: true, integrationID: "opencode", value: { type: "key", key: state.key } }] },
  } } as unknown as ServiceConnection
  return { state, connection, exhaustion: { exhausted: () => state.exhausted } }
}
const row = (model: string, requests: number, index = 0) => ({ provider: `vendor-${index}`, model, totalRequests: String(requests),
  totalInputTokens: "0", totalOutputTokens: "0", totalCacheReadTokens: "0", totalCacheWrite5mTokens: "0",
  totalCacheWrite1hTokens: "0", totalCostMicroCents: "0" })
const page = (requests: number) => ({ items: [row("big-pickle", requests)], pageInfo: { page: 1, pageSize: 50, total: 1, pageCount: 1 } })

test("Console counts are authoritative, including zero and counts above 800", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion)
  let count = 0
  t.mock.method(globalThis, "fetch", async () => Response.json(page(count)))
  try {
    for (count of [0, 30, 800, 950]) {
      f.state.key = `synthetic-${count}`
      const result = await usage.read(f.connection, "opencode", "big-pickle", signal())
      assert.equal(result.ok, true)
      assert.deepEqual(result.freeEstimate, { requests: count, reference: 800, exhausted: false })
      assert.equal(result.windows.daily.valueLabel, `${count} / 800`)
      assert.equal(result.windows.daily.usedPercent, Math.min(100, count / 800 * 100))
      f.state.exhausted = true
      const marked = usage.refreshExhaustion(f.connection, result)
      assert.equal(marked.freeEstimate?.requests, count)
      assert.equal(marked.windows.daily.usedPercent, 100)
      f.state.exhausted = false
    }
  } finally { usage.dispose() }
})

test("cache shares reads per credential/day, expires after 60 seconds and preserves Console zero at midnight", async t => {
  let now = day + 1000, count = 250, calls = 0
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(page(count)) })
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion)
  const read = () => usage.read(f.connection, "opencode", "big-pickle", signal())
  try {
    const [a, b] = await Promise.all([read(), read()])
    assert.equal(a.freeEstimate?.requests, 250); assert.equal(b.freeEstimate?.requests, 250)
    assert.equal(calls, 1)
    now += 60_000; count = 400
    assert.equal((await read()).freeEstimate?.requests, 400)
    assert.equal(calls, 2)
    now = day + 86_400_000; count = 0
    assert.equal((await read()).freeEstimate?.requests, 0)
    assert.equal(calls, 3)
    now++
    assert.equal((await read()).freeEstimate?.requests, 0)
    f.state.key = "synthetic-two"; count = 80
    assert.equal((await read()).freeEstimate?.requests, 80)
    assert.equal(calls, 4)
  } finally { usage.dispose() }
})

test("any failed Console page discards the full count and the gauge, even with exhaustion", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  for (const status of [401, 403, 500, 200]) {
    t.mock.method(globalThis, "fetch", async (input: unknown) => {
      const n = Number(new URL(String(input)).searchParams.get("page"))
      if (n === 2) return status === 200 ? Response.json({ invalid: true }) : new Response("secret upstream body", { status })
      return Response.json({ items: Array.from({ length: 50 }, (_, i) => row(i === 0 ? "big-pickle" : `paid-${i}`, 100, i)),
        pageInfo: { page: 1, pageSize: 50, total: 51, pageCount: 2 } })
    })
    const f = fixture(); f.state.exhausted = true
    const usage = createOpenCodeFreeUsage(f.exhaustion)
    try {
      const result = await usage.read(f.connection, "opencode", "big-pickle", signal())
      assert.equal(result.freeEstimate?.requests, null)
      assert.equal(result.freeEstimate?.exhausted, true)
      assert.equal(result.ok, false)
      assert.deepEqual(result.windows, {})
      assert.equal(result.unavailableReason, status === 401 ? "opencode-console-invalid-credential" : status === 403
        ? "opencode-console-access-denied" : status === 200 ? "opencode-console-invalid-response" : "opencode-console-network-error")
      assert.equal(JSON.stringify(result).includes("secret"), false)
    } finally { usage.dispose() }
  }
})

test("missing or expired Console login never fetches or fabricates a count", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  t.mock.method(globalThis, "fetch", async () => { assert.fail("Console must not be called") })
  for (const expired of [false, true]) {
    const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion)
    t.mock.method(f.connection.client.credential, "list", async () => expired ? [{ active: true, integrationID: "opencode",
      value: { type: "oauth", access: "secret", expires: day, metadata: { server: "https://opencode.ai/console", orgID: "org_fixture" } } }] : [])
    try {
      const result = await usage.read(f.connection, "opencode", "big-pickle", signal())
      assert.equal(result.configured, expired)
      assert.equal(result.ok, false)
      assert.equal(result.freeEstimate?.requests, null)
      assert.deepEqual(result.windows, {})
      assert.equal(result.unavailableReason, expired ? "opencode-console-invalid-credential" : "opencode-console-missing-credential")
    } finally { usage.dispose() }
  }
})

test("a caller's deadline reports unknown without cancelling another caller's shared read", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  let entered!: () => void, release!: (response: Response) => void, calls = 0, transport: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls++; transport = init!.signal!; entered()
    return new Promise<Response>(resolve => { release = resolve })
  })
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion), deadline = new AbortController()
  try {
    const first = usage.read(f.connection, "opencode", "big-pickle", signal(), deadline.signal)
    await started
    const second = usage.read(f.connection, "opencode", "big-pickle", signal())
    deadline.abort()
    const result = await first
    assert.equal(result.freeEstimate?.requests, null)
    assert.equal(result.unavailableReason, "opencode-console-network-error")
    assert.equal(transport?.aborted, false)
    release(Response.json(page(80)))
    assert.equal((await second).freeEstimate?.requests, 80)
    assert.equal(calls, 1)
  } finally { usage.dispose() }
})

test("sums only free models across sequential 24h pages", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  const pages: number[] = []
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input)), n = Number(url.searchParams.get("page"))
    assert.equal(url.origin, "https://opencode.ai")
    assert.equal(url.pathname, "/console/api/usage/models")
    assert.equal(url.searchParams.get("range"), "24h")
    assert.equal(init?.redirect, "error")
    pages.push(n)
    return Response.json({ items: n === 1
      ? Array.from({ length: 50 }, (_, i) => row(i === 0 ? "big-pickle" : `paid-${i}`, 100, i))
      : [row("beam-free", 160), row("longcat-2.5-free", 40)], pageInfo: { page: n, pageSize: 50, total: 52, pageCount: 2 } })
  })
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion)
  try {
    assert.equal((await usage.read(f.connection, "opencode", "big-pickle", signal())).freeEstimate?.requests, 300)
    assert.deepEqual(pages, [1, 2])
  } finally { usage.dispose() }
})

test("cross-midnight reads discard yesterday's count before publication", async t => {
  let now = day + 86_400_000 - 1
  t.mock.method(Date, "now", () => now)
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion)
  t.mock.method(globalThis, "fetch", async () => { now++; return Response.json(page(250)) })
  try {
    const result = await usage.read(f.connection, "opencode", "big-pickle", signal())
    assert.deepEqual(result.freeEstimate, { requests: null, reference: 800, exhausted: false })
    assert.deepEqual(result.windows, {})
    assert.equal(result.ok, false)
    assert.equal((await usage.read(f.connection, "opencode", "big-pickle", signal())).freeEstimate?.requests, 250)
  } finally { usage.dispose() }
})
