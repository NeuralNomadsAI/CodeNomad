import assert from "node:assert/strict"
import test from "node:test"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { createOpenCodeFreeExhaustion } from "./opencode-free-exhaustion"
import { calibrateOpenCodeFreeRequests, createOpenCodeFreeUsage } from "./opencode-free-usage"

const day = Date.UTC(2026, 10, 6)
const signal = () => AbortSignal.timeout(3000)
function fixture() {
  const state = { statsFail: false, credentials: 0, steps: 30, exhausted: false,
    statsGate: undefined as (() => Promise<void>) | undefined, key: "synthetic-one" }
  const connection = { client: {
    session: { stats: async () => {
      await state.statsGate?.()
      if (state.statsFail) throw new Error("synthetic stats failure")
      return { models: [{ model: { providerID: "opencode", id: "big-pickle" }, steps: state.steps }] }
    } },
    credential: { list: async () => { state.credentials++; return [{ active: true, integrationID: "opencode",
      value: { type: "key", key: state.key } }] } },
  } } as unknown as ServiceConnection
  return { state, connection, exhaustion: { exhausted: () => state.exhausted } }
}
const row = (model: string, requests: number, index = 0) => ({ provider: `vendor-${index}`, model, totalRequests: String(requests),
  totalInputTokens: "0", totalOutputTokens: "0", totalCacheReadTokens: "0", totalCacheWrite5mTokens: "0",
  totalCacheWrite1hTokens: "0", totalCostMicroCents: "0" })
const page = (requests: number) => ({ items: [row("big-pickle", requests)], pageInfo: { page: 1, pageSize: 50, total: 1, pageCount: 1 } })

test("calibration takes the maximum, keeping zero and counts above the reference", () => {
  for (const [local, console, expected] of [[30, 10, 30], [30, 80, 80], [30, 0, 30], [30, 250, 250],
    [null, null, null], [30, null, 30], [null, 0, null]] as const) assert.equal(calibrateOpenCodeFreeRequests(local, console), expected)
})

test("explicit gate OFF never reads credentials or Console; stats failure preserves exhaustion and actual count", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  let consoleCalls = 0
  t.mock.method(globalThis, "fetch", async () => { consoleCalls++; throw new Error("Console must not be called") })
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion, { consoleCalibration: false })
  try {
    let result = await usage.read(f.connection, "opencode", "big-pickle", signal())
    assert.deepEqual(result.freeEstimate, { requests: 30, reference: 200, exhausted: false })
    f.state.exhausted = true
    assert.equal(usage.refreshExhaustion(f.connection, result).windows.daily.usedPercent, 100,
      "a mark received after the read but before route publication stays visible")
    result = await usage.read(f.connection, "opencode", "x-free", signal())
    assert.equal(result.windows.daily.usedPercent, 100)
    assert.equal(result.windows.daily.valueLabel, "30 / 200")
    f.state.statsFail = true
    result = await usage.read(f.connection, "opencode", "x-free", signal())
    assert.deepEqual(result.freeEstimate, { requests: null, reference: 200, exhausted: true })
    assert.equal(result.ok, true)
    assert.equal(result.windows.daily.usedPercent, 100)
    assert.equal(result.windows.daily.valueLabel, undefined)
    f.state.exhausted = false
    result = await usage.read(f.connection, "opencode", "x-free", signal())
    assert.equal(result.ok, false)
    assert.deepEqual(result.windows, {})
    assert.equal(f.state.credentials, 0)
    assert.equal(consoleCalls, 0)
  } finally { usage.dispose() }
})

test("failure received during an in-flight stats read and before publication stays visible", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  const f = fixture(), exhaustion = createOpenCodeFreeExhaustion(), usage = createOpenCodeFreeUsage(exhaustion, { consoleCalibration: false })
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.state.statsGate = async () => { entered(); await gate }
  const read = usage.read(f.connection, "opencode", "big-pickle", signal())
  await started
  exhaustion.observe(f.connection, { type: "session.step.started", created: day + 1,
    data: { sessionID: "s", assistantMessageID: "m", model: { providerID: "opencode", id: "x-free" } } })
  exhaustion.observe(f.connection, { type: "session.step.failed", created: day + 2,
    data: { sessionID: "s", assistantMessageID: "m", error: { type: "provider.quota" } } })
  release()
  const result = await read
  assert.equal(result.freeEstimate?.exhausted, true)
  assert.equal(result.windows.daily.usedPercent, 100)
  assert.equal(usage.refreshExhaustion(f.connection, result).freeEstimate?.requests, 30)
  usage.dispose()
})

test("default calibration cache is credential/day scoped, shares reads and never reuses yesterday's count", async t => {
  let now = day + 86_400_000 - 1000, count = 250, calls = 0
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    calls++; assert.equal(new URL(String(input)).searchParams.get("range"), "24h")
    return Response.json(page(count))
  })
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion)
  const read = () => usage.read(f.connection, "opencode", "big-pickle", signal())
  try {
    const [a, b] = await Promise.all([read(), read()])
    assert.equal(a.freeEstimate?.requests, 250); assert.equal(b.freeEstimate?.requests, 250)
    assert.equal(a.windows.daily.usedPercent, 100); assert.equal(a.estimated, true); assert.equal(calls, 1)
    now = day + 86_400_000
    count = 0
    assert.equal((await read()).freeEstimate?.requests, 0, "midnight starts a new cache and no stats query")
    assert.equal(calls, 2)
    now++
    assert.equal((await read()).freeEstimate?.requests, 30)
    f.state.key = "synthetic-two"; count = 80
    assert.equal((await read()).freeEstimate?.requests, 80)
    assert.equal(calls, 3)
  } finally { usage.dispose() }
})

test("default calibration retains local estimate/exhaustion on any Console page failure, never a partial count", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  for (const invalid of [false, true]) {
    t.mock.method(globalThis, "fetch", async (input: unknown) => {
      const n = Number(new URL(String(input)).searchParams.get("page"))
      if (n === 2) return invalid ? Response.json({ invalid: true }) : new Response("synthetic", { status: 403 })
      return Response.json({ items: Array.from({ length: 50 }, (_, i) => row(i === 0 ? "big-pickle" : `paid-${i}`, 100, i)),
        pageInfo: { page: 1, pageSize: 50, total: 51, pageCount: 2 } })
    })
    const f = fixture(); f.state.exhausted = true
    const usage = createOpenCodeFreeUsage(f.exhaustion)
    const result = await usage.read(f.connection, "opencode", "big-pickle", signal())
    assert.equal(result.freeEstimate?.requests, 30)
    assert.equal(result.freeEstimate?.exhausted, true)
    assert.equal(result.windows.daily.valueLabel, "30 / 200")
    usage.dispose()
  }
})

test("default calibration without a Console credential stays local and never calls Console", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  t.mock.method(globalThis, "fetch", async () => { assert.fail("Console must not be called without a credential") })
  const f = fixture()
  t.mock.method(f.connection.client.credential, "list", async () => [])
  const usage = createOpenCodeFreeUsage(f.exhaustion)
  try {
    const result = await usage.read(f.connection, "opencode", "big-pickle", signal())
    assert.deepEqual(result.freeEstimate, { requests: 30, reference: 200, exhausted: false })
    assert.equal(result.estimated, true)
  } finally { usage.dispose() }
})

test("a calibration deadline preserves local usage without cancelling another caller's shared read", async t => {
  t.mock.method(Date, "now", () => day + 1000)
  let entered!: () => void, release!: (response: Response) => void, calls = 0, transport: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls++; transport = init!.signal!
    entered()
    return new Promise<Response>(resolve => { release = resolve })
  })
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion), deadline = new AbortController()
  try {
    const first = usage.read(f.connection, "opencode", "big-pickle", signal(), deadline.signal)
    await started
    const second = usage.read(f.connection, "opencode", "big-pickle", signal())
    deadline.abort()
    assert.equal((await first).freeEstimate?.requests, 30)
    assert.equal(transport?.aborted, false)
    release(Response.json(page(80)))
    assert.equal((await second).freeEstimate?.requests, 80)
    assert.equal(calls, 1)
  } finally { usage.dispose() }
})

test("gate ON sums every free model across sequential 24h pages using the Console parser bounds", async t => {
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
      : [row("example-free", 160)], pageInfo: { page: n, pageSize: 50, total: 51, pageCount: 2 } })
  })
  const f = fixture(), usage = createOpenCodeFreeUsage(f.exhaustion, { consoleCalibration: true })
  try {
    assert.equal((await usage.read(f.connection, "opencode", "big-pickle", signal())).freeEstimate?.requests, 260)
    assert.deepEqual(pages, [1, 2])
  } finally { usage.dispose() }
})

test("cross-midnight in-flight reads cannot publish the previous UTC day's estimate or mark", async t => {
  let now = day + 86_400_000 - 1
  t.mock.method(Date, "now", () => now)
  const f = fixture(), exhaustion = createOpenCodeFreeExhaustion(), usage = createOpenCodeFreeUsage(exhaustion, { consoleCalibration: true })
  exhaustion.observe(f.connection, { type: "session.step.started", created: now - 2,
    data: { sessionID: "s", assistantMessageID: "m", model: { providerID: "opencode", id: "big-pickle" } } })
  exhaustion.observe(f.connection, { type: "session.step.failed", created: now - 1,
    data: { sessionID: "s", assistantMessageID: "m", error: { type: "provider.quota" } } })
  t.mock.method(globalThis, "fetch", async () => { now++; return Response.json(page(250)) })
  try {
    const result = await usage.read(f.connection, "opencode", "big-pickle", signal())
    assert.deepEqual(result.freeEstimate, { requests: null, reference: 200, exhausted: false })
    assert.deepEqual(result.windows, {})
    assert.equal(result.ok, false)
    assert.equal((await usage.read(f.connection, "opencode", "big-pickle", signal())).freeEstimate?.requests, 250)
  } finally { usage.dispose() }
})
