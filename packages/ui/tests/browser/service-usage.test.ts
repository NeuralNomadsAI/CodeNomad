import assert from "node:assert/strict"
import { test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { SettingsService } from "../../../server/src/settings/service"
import { resolveConfigLocation } from "../../../server/src/config/location"
import { ServiceUsage } from "../../../server/src/opencode/service-usage"
import type { BrowserContextOptions } from "playwright"

async function statsPage(fixture: Awaited<ReturnType<typeof startProductFixture>>, options: BrowserContextOptions = {}) {
  const page = await fixture.browser.newPage(options)
  // Events are dispatched explicitly by this fixture. A JSON stub is not a
  // real SSE connection and must not generate unrelated reconnect failures.
  await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} } as any })
  return page
}

function ownerProbeSnapshot(steps: number, owner: string, connection: string, identity?: string) {
  const to = Date.now(), tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  return { scope: "service", owner, connection, ...(identity ? { identity } : {}), stats: {
    range: { from: to - 30 * 86400000, to }, sessions: 1, subagents: 0, prompts: 1, steps,
    tokens, cost: 0, tools: { mode: "none" }, activeDays: 1, streak: 1, models: [], activity: [{ date: "2026-10-20", steps }],
  } }
}

test("Pass2 missing fresh identity cannot inherit another connection's proof, with cache before or after fresh totals", async () => {
  const fixture = await startProductFixture("service-usage")
  try {
    for (const cacheFirst of [true, false]) {
      const page = await statsPage(fixture, { locale: "en-US" })
      let returning = false, releaseFresh!: () => void, releaseCache!: () => void
      const freshGate = new Promise<void>(resolve => { releaseFresh = resolve }), cacheGate = new Promise<void>(resolve => { releaseCache = resolve })
      const proofA = { owner: "shared-channel", identity: "discovery-a", connection: "connection-a" }
      await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
      await page.route("**/api/workspaces/*/service-usage**", async route => {
        const path = new URL(route.request().url()).pathname
        if (path.endsWith("/owner")) return route.fulfill({ json: proofA })
        if (path.endsWith("/cache")) {
          await cacheGate
          return route.fulfill({ json: { ...proofA, days: 30, ...(!returning ? { snapshot: ownerProbeSnapshot(11, proofA.owner, proofA.connection, proofA.identity) } : {}) } })
        }
        if (returning) return route.fulfill({ status: 503, json: {} })
        await freshGate
        return route.fulfill({ json: ownerProbeSnapshot(84, proofA.owner, "connection-b") })
      })
      try {
        await page.goto(`${fixture.url}?backend`)
        await page.waitForFunction(() => (window as any).fixture.ownerReplies === 1)
        if (cacheFirst) {
          releaseCache()
          await page.waitForFunction(() => [...document.querySelectorAll(".usage-metrics dt")].find(el => el.textContent === "Steps")?.nextElementSibling?.textContent === "11")
        }
        releaseFresh()
        await page.waitForFunction(() => [...document.querySelectorAll(".usage-metrics dt")].find(el => el.textContent === "Steps")?.nextElementSibling?.textContent === "84")
        releaseCache()
        await page.waitForFunction(() => (window as any).fixture.cacheReplies === 1)
        returning = true
        await page.evaluate(() => (window as any).fixture.connection("connected", 2))
        await page.getByRole("alert").waitFor()
        assert.equal(await page.locator(".usage-metrics").count(), 0, `B totals must not be relabelled as A (cacheFirst=${cacheFirst})`)
        assert.equal(await page.locator("meter").count(), 0)
      } finally { releaseFresh(); releaseCache(); await page.close() }
    }
  } finally { await fixture.close() }
})

test("Pass2 fresh owner or discovery conflicts revoke retained cached metrics instead of leaving them beside an error", async () => {
  const fixture = await startProductFixture("service-usage")
  try {
    for (const { change, cacheFirst } of [
      { change: "owner", cacheFirst: true }, { change: "identity", cacheFirst: true },
      { change: "owner", cacheFirst: false }, { change: "identity", cacheFirst: false },
    ]) {
      const page = await statsPage(fixture, { locale: "en-US" })
      let release!: () => void, releaseCache!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const cacheGate = new Promise<void>(resolve => { releaseCache = resolve })
      const proofA = { owner: "owner-a", identity: "discovery-a", connection: "connection-a" }
      await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
      await page.route("**/api/workspaces/*/service-usage**", async route => {
        const path = new URL(route.request().url()).pathname
        if (path.endsWith("/owner")) return route.fulfill({ json: proofA })
        if (path.endsWith("/cache")) {
          await cacheGate
          return route.fulfill({ json: { ...proofA, days: 30, snapshot: ownerProbeSnapshot(11, proofA.owner, proofA.connection, proofA.identity) } })
        }
        await gate
        return route.fulfill({ json: ownerProbeSnapshot(84, change === "owner" ? "owner-b" : proofA.owner, "connection-b", "discovery-b") })
      })
      try {
        await page.goto(`${fixture.url}?backend`)
        await page.waitForFunction(() => (window as any).fixture.ownerReplies === 1)
        if (cacheFirst) {
          releaseCache()
          await page.waitForFunction(() => [...document.querySelectorAll(".usage-metrics dt")].find(el => el.textContent === "Steps")?.nextElementSibling?.textContent === "11")
        }
        release()
        await page.getByRole("alert").waitFor()
        releaseCache()
        await page.waitForFunction(() => (window as any).fixture.cacheReplies === 1)
        assert.equal(await page.locator(".usage-metrics").count(), 0, `confirmed ${change} conflict must revoke A totals`)
        assert.equal(await page.locator("meter").count(), 0)
      } finally { release(); releaseCache(); await page.close() }
    }
  } finally { await fixture.close() }
})

test("service-wide usage dashboard declares scope, bounds requests, fences stale connection reads and stops when disposed", async () => {
  const fixture = await startProductFixture("service-usage"), page = await statsPage(fixture, { viewport: { width: 380, height: 1000 }, locale: "en-US" })
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(fixture.url)
    await page.locator(".usage-metrics").waitFor()
    await page.getByText(/Entire connected OpenCode service: all projects, independent clones and subsessions/).waitFor()
    assert.equal(await page.locator(".usage-metrics > div").filter({ has: page.getByText("Input tokens", { exact: true }) }).locator("dd").innerText(), "12,345")
    assert.equal(await page.getByRole("rowheader").innerText(), "fixture/synthetic · high")
    assert.equal(await page.locator("meter").count(), 2)
    assert.equal(await page.locator(".usage-dashboard").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.getByLabel("Period", { exact: true }).selectOption("7")
    await page.waitForFunction(() => (window as any).fixture.queries.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.queries.map((q: any) => (q.to - q.from) / 86400000)), [30, 7])
    await page.evaluate(() => (window as any).fixture.fail())
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.locator(".usage-metrics").count(), 1)
    await page.evaluate(() => { (window as any).fixture.defer(); (window as any).fixture.refresh("session.deleted") })
    await page.waitForFunction(() => (window as any).fixture.queries.length === 4)
    await page.evaluate(() => (window as any).fixture.setInstanceId("other"))
    const steps = page.locator(".usage-metrics > div").filter({ has: page.getByText("Steps", { exact: true }) }).locator("dd")
    await page.waitForFunction(() => [...document.querySelectorAll(".usage-metrics dt")].find(el => el.textContent === "Steps")?.nextElementSibling?.textContent === "7")
    await page.evaluate(() => (window as any).fixture.release())
    assert.equal(await steps.innerText(), "7")
    await page.evaluate(() => (window as any).fixture.setVisible(false))
    const queries = await page.evaluate(() => (window as any).fixture.queries.length)
    await page.evaluate(() => (window as any).fixture.refresh())
    assert.equal(await page.evaluate(() => (window as any).fixture.queries.length), queries)
    assert.deepEqual(errors, [])
  } finally { await page.close(); await fixture.close() }
})

test("a mounted but hidden Preferences document does not read Stats until activation", async () => {
  const fixture = await startProductFixture("service-usage"), page = await statsPage(fixture)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${fixture.url}?hidden`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.clock.install(); await page.clock.runFor(100)
    assert.equal(await page.evaluate(() => (window as any).fixture.queries.length), 0)
    await page.evaluate(() => { for (let i = 0; i < 30; i++) (window as any).fixture.refresh("session.execution.interrupted") })
    await page.clock.runFor(6000)
    assert.equal(await page.evaluate(() => (window as any).fixture.queries.length), 0)
    await page.evaluate(() => (window as any).fixture.documentHidden(false))
    await page.clock.runFor(100)
    await page.locator(".usage-metrics").waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.queries.length), 1)
  } finally { await page.close(); await fixture.close() }
})

test("hidden Stats never read; native hints coalesce and hidden in-flight work cannot launch trailing scans", async () => {
  const fixture = await startProductFixture("service-usage"), page = await statsPage(fixture, { viewport: { width: 760, height: 1000 }, locale: "en-US" })
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(fixture.url)
    await page.locator(".usage-metrics").waitFor()
    const queries = () => page.evaluate(() => (window as any).fixture.queries.length as number)
    const initial = await queries()
    await page.clock.install()
    await page.evaluate(() => { for (let i = 0; i < 100; i++) (window as any).fixture.refresh() })
    await page.clock.runFor(100)
    assert.equal(await queries(), initial, "activity hints wait for the shared cooldown")
    await page.evaluate(() => { (window as any).fixture.documentHidden(true); for (let i = 0; i < 100; i++) (window as any).fixture.refresh() })
    await page.clock.runFor(6000)
    assert.equal(await queries(), initial, "hidden cancels queued reads")
    await page.evaluate(() => (window as any).fixture.documentHidden(false))
    await page.clock.runFor(100)
    assert.equal(await queries(), initial + 1, "activation revalidates exactly once")
    await page.evaluate(() => { (window as any).fixture.defer(); (window as any).fixture.refresh("session.deleted") })
    await page.clock.runFor(100)
    assert.equal(await queries(), initial + 2)
    await page.evaluate(() => { for (let i = 0; i < 100; i++) (window as any).fixture.refresh(); (window as any).fixture.documentHidden(true); (window as any).fixture.release() })
    await page.clock.runFor(6000)
    assert.equal(await queries(), initial + 2, "settlement while hidden does not reschedule")
    await page.evaluate(() => (window as any).fixture.documentHidden(false))
    await page.clock.runFor(100)
    assert.equal(await queries(), initial + 3)
    await page.evaluate(() => { for (let i = 0; i < 100; i++) (window as any).fixture.refresh() })
    await page.clock.runFor(5100)
    assert.equal(await queries(), initial + 4, "one read for a visible burst, not one per terminal event")
    await page.evaluate(() => (window as any).fixture.refresh("session.text.delta"))
    await page.clock.runFor(6000)
    assert.equal(await queries(), initial + 4, "streaming deltas never refresh durable statistics")
    await page.evaluate(() => (window as any).fixture.connection("connected", 1))
    await page.clock.runFor(100)
    assert.equal(await queries(), initial + 5)
    await page.evaluate(() => { for (let i = 0; i < 30; i++) (window as any).fixture.connection("connected", 1) })
    await page.clock.runFor(6000)
    assert.equal(await queries(), initial + 5, "duplicate connection snapshots are not reconnects")
    await page.evaluate(() => { (window as any).fixture.documentHidden(true); (window as any).fixture.connection("connected", 2) })
    await page.clock.runFor(6000)
    assert.equal(await queries(), initial + 5, "hidden reconnect waits for visible demand")
    await page.evaluate(() => (window as any).fixture.documentHidden(false))
    await page.clock.runFor(100)
    assert.equal(await queries(), initial + 6)
    assert.deepEqual(errors, [])
  } finally { await page.close(); await fixture.close() }
})

test("Stats is reachable in the real preferences screen", async () => {
  const fixture = await startProductFixture("service-usage"), page = await statsPage(fixture, { viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${fixture.url}?parent`)
    await page.locator(".usage-metrics").waitFor()
    assert.equal(await page.getByRole("navigation").getByRole("button", { name: "Stats", exact: true }).getAttribute("aria-current"), "page")
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE, fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await page.close(); await fixture.close() }
})

test("P1 an unresolved optional cache cannot hold fresh Stats display", async () => {
  const fixture = await startProductFixture("service-usage"), page = await statsPage(fixture, { locale: "en-US" })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.clock.install()
    await page.goto(`${fixture.url}?heldCache`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.clock.runFor(100)
    assert.equal(await page.evaluate(() => (window as any).fixture.queries.length), 1, "fresh HTTP starts before cache release")
    assert.equal(await page.locator(".usage-metrics").count(), 1)
    await page.evaluate(() => (window as any).fixture.releaseCache())
    await page.clock.runFor(100)
    assert.equal(await page.locator(".usage-metrics").count(), 1, "late empty cache cannot erase fresh totals")
  } finally { await page.close(); await fixture.close() }
})

test("P3 transient disconnect and failed reconnect keep explicitly stale totals and charts", async () => {
  const fixture = await startProductFixture("service-usage"), page = await statsPage(fixture, { locale: "en-US" })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(fixture.url); await page.locator(".usage-metrics").waitFor()
    await page.clock.install()
    await page.evaluate(() => (window as any).fixture.connection("disconnected", 1))
    await page.evaluate(() => (window as any).fixture.transport("disconnected"))
    assert.equal(await page.locator(".usage-metrics").count(), 1, "disconnect keeps last known owner's totals")
    assert.equal(await page.locator("meter").count(), 2)
    await page.getByText("Previous saved statistics · awaiting refresh", { exact: true }).waitFor()
    await page.evaluate(() => { (window as any).fixture.fail(); (window as any).fixture.connection("connected", 2) })
    await page.clock.runFor(100)
    await page.getByRole("alert").waitFor()
    assert.equal(await page.locator(".usage-metrics").count(), 1)
    // A different authenticated channel or native discovery root is NOT a
    // transient disconnect. Fence an older result and revoke the old display.
    for (const change of ["changeOwner", "changeDiscovery"]) {
      await page.evaluate(() => { (window as any).fixture.defer(); (window as any).fixture.refresh("session.deleted") })
      await page.clock.runFor(100)
      await page.evaluate(change => { (window as any).fixture[change](); (window as any).fixture.fail(); (window as any).fixture.connection("connected", change === "changeOwner" ? 3 : 4) }, change)
      await page.clock.runFor(100)
      assert.equal(await page.locator(".usage-metrics").count(), 0, `${change} clears old service totals`)
      await page.evaluate(() => (window as any).fixture.release())
      await page.clock.runFor(100)
      assert.equal(await page.locator(".usage-metrics").count(), 0, "superseded native results stay fenced")
      await page.getByRole("button", { name: "Refresh", exact: true }).click()
      await page.clock.runFor(100)
      assert.equal(await page.locator(".usage-metrics").count(), 1)
    }
  } finally { await page.close(); await fixture.close() }
})

test("a new Preferences renderer/backend restores totals and charts before a two-second native read, retains errors and its period", async () => {
  const parent = path.join(os.tmpdir(), "opencode"); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "stats-browser-state-"))
  const fixture = await startProductFixture("service-usage")
  const logger: any = { child() { return this }, warn() {}, info() {}, debug() {} }
  let steps = 42, fail = false, calls = 0
  const record = { path: "/fixture/project" }
  const connection = { endpoint: { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "fixture", password: "fixture-only" } }, assertCurrent() {}, client: {
    config: { get: async () => [{ type: "directory", path: "/fixture/discovery" }] },
    session: { stats: async (query: any) => {
      calls++; const value = steps
      await new Promise(resolve => setTimeout(resolve, 2000))
      if (fail) { fail = false; throw new Error("fixture native failure") }
      const tokens = { input: 12345, output: 987, reasoning: 100, cache: { read: 6789, write: 456 } }
      return { range: { from: query.from, to: query.to }, sessions: 3, subagents: 2, prompts: 10, steps: value,
        tokens, cost: 1.2345, tools: { mode: "none" }, activeDays: 2, streak: 2,
        models: [{ model: { providerID: "fixture", id: "synthetic" }, tokens, steps: value, cost: 1.2345 }],
        activity: [{ date: "2026-10-19", steps: value }] }
    } },
  } }
  const manager: any = { get: () => record, getSharedServiceConnection: async () => connection,
    getServicePathStyle: () => "posix", getServiceWslDistro: () => undefined }
  const reopen = () => new ServiceUsage(manager, new SettingsService(resolveConfigLocation(path.join(root, "config.yaml")), undefined, logger))
  let service = reopen()
  const pageFor = async (instance: string) => {
    const page = await statsPage(fixture, { locale: "en-US" })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.route("**/api/workspaces/*/service-usage**", async route => {
      const url = new URL(route.request().url()), id = url.pathname.split("/")[3]
      try {
        const result = url.pathname.endsWith("/owner") ? await service.owner(id) : url.pathname.endsWith("/cache")
          ? await service.cached(id, url.searchParams.get("timezone")!, url.searchParams.has("days") ? Number(url.searchParams.get("days")) : undefined)
          : await service.read(id, { from: Number(url.searchParams.get("from")), to: Number(url.searchParams.get("to")), timezone: url.searchParams.get("timezone")!, restorePeriod: url.searchParams.get("restorePeriod") === "true" })
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) })
      } catch { await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }) }
    })
    await page.goto(`${fixture.url}?backend&instance=${instance}`)
    return page
  }
  try {
    const cold = await pageFor("old-workspace-uuid")
    await cold.locator(".usage-metrics").waitFor()
    const coldMs = await cold.evaluate(() => (window as any).fixture.metricsAt - (window as any).fixture.mountedAt)
    assert.ok(coldMs >= 2000)
    await cold.getByLabel("Period", { exact: true }).selectOption("7")
    await cold.getByRole("button", { name: "Refresh", exact: true }).waitFor({ state: "visible" })
    await cold.waitForFunction(() => (document.querySelector(".usage-toolbar button") as HTMLButtonElement)?.disabled === false && (window as any).fixture.queries.length === 2)
    await cold.close()
    await service.close(); service = reopen(); steps = 99 // New backend/settings and JS window; no renderer Map survives.
    const warm = await pageFor("new-workspace-uuid")
    await warm.locator(".usage-metrics").waitFor()
    const warmMs = await warm.evaluate(() => (window as any).fixture.metricsAt - (window as any).fixture.mountedAt)
    assert.ok(warmMs < 1000, `restored display took ${warmMs}ms`)
    assert.equal(await warm.getByLabel("Period", { exact: true }).inputValue(), "7")
    const total = warm.locator(".usage-metrics > div").filter({ has: warm.getByText("Steps", { exact: true }) }).locator("dd")
    assert.equal(await total.innerText(), "42")
    assert.equal(await warm.locator("meter").count(), 1)
    await warm.getByText("Previous saved statistics · awaiting refresh", { exact: true }).waitFor()
    await warm.waitForFunction(() => [...document.querySelectorAll(".usage-metrics dt")].find(el => el.textContent === "Steps")?.nextElementSibling?.textContent === "99")
    fail = true
    await warm.getByRole("button", { name: "Refresh", exact: true }).click()
    await warm.getByRole("alert").waitFor()
    assert.equal(await total.innerText(), "99")
    console.log(`Stats isolated delayed-read latency: cold=${Math.round(coldMs)}ms, restored=${Math.round(warmMs)}ms; native delay=2000ms; calls=${calls}`)
    await warm.close()
  } finally { await fixture.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

test("P1/P2 held discovery cannot block real fresh display; abandoned periods cannot change restart restoration", async () => {
  const parent = path.join(os.tmpdir(), "opencode"); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "stats-period-race-")), fixture = await startProductFixture("service-usage")
  const logger: any = { child() { return this }, warn() {}, info() {}, debug() {} }
  let release!: () => void, releaseDiscovery!: () => void, released!: () => void, oldReturned!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { oldReturned = resolve })
  const finished = new Promise<void>(resolve => { released = resolve })
  const admitted = new Promise<void>(resolve => { entered = resolve })
  const discovery = new Promise<void>(resolve => { releaseDiscovery = resolve })
  const calls: number[] = [], record = { path: "/fixture/project" }
  const connection = { endpoint: { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "fixture", password: "fixture-only" } }, assertCurrent() {}, client: {
    config: { get: async () => { await discovery; return [{ type: "directory", path: "/fixture/discovery" }] } },
    session: { stats: async (query: any) => {
      const days = (query.to - query.from) / 86400000; calls.push(days)
      if (days === 30) { entered(); await held; released() }
      const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
      return { range: { from: query.from, to: query.to }, sessions: 1, subagents: 0, prompts: 1, steps: days,
        tokens, cost: 0, tools: { mode: "none" }, activeDays: 1, streak: 1, models: [], activity: [{ date: "2026-10-20", steps: days }] }
    } },
  } }
  const manager: any = { get: () => record, getSharedServiceConnection: async () => connection,
    getServicePathStyle: () => "posix", getServiceWslDistro: () => undefined }
  const reopen = () => new ServiceUsage(manager, new SettingsService(resolveConfigLocation(path.join(root, "config.yaml")), undefined, logger))
  let service = reopen()
  const open = async (instance: string) => {
    const page = await statsPage(fixture, { locale: "en-US", timezoneId: "UTC" })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.route("**/api/workspaces/*/service-usage**", async route => {
      const url = new URL(route.request().url())
      try {
        const result = url.pathname.endsWith("/owner") ? await service.owner(instance)
          : url.pathname.endsWith("/cache") ? await service.cached(instance, "UTC", url.searchParams.has("days") ? Number(url.searchParams.get("days")) : undefined)
          : await service.read(instance, { from: Number(url.searchParams.get("from")), to: Number(url.searchParams.get("to")), timezone: "UTC", restorePeriod: url.searchParams.get("restorePeriod") === "true" })
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) })
      } catch { /* Browser cancellation is deliberately NOT backend cancellation. */ }
      finally { if (calls.includes(30) && url.pathname.endsWith("service-usage") && url.searchParams.get("from") === String(Number(url.searchParams.get("to")) - 30 * 86400000)) oldReturned() }
    })
    await page.goto(`${fixture.url}?backend&instance=${instance}`)
    return page
  }
  try {
    const page = await open("before-restart")
    await page.waitForFunction(() => (window as any).fixture.queries.length === 1)
    // The route has admitted the real initial native request before selection.
    await admitted
    assert.deepEqual(calls, [30])
    await page.getByLabel("Period", { exact: true }).selectOption("7")
    await page.waitForFunction(() => [...document.querySelectorAll(".usage-metrics dt")].find(el => el.textContent === "Steps")?.nextElementSibling?.textContent === "7")
    // Both the UI cache request and the backend's optional identity work are
    // still held. These fresh totals came through the real production service.
    releaseDiscovery(); await service.cached("before-restart", "UTC", 7)
    release(); await finished; await done
    assert.equal(await page.getByLabel("Period", { exact: true }).inputValue(), "7")
    assert.equal(await page.locator(".usage-metrics dd").nth(3).innerText(), "7")
    await page.close(); await service.close(); service = reopen()
    assert.equal((await service.cached("after-restart", "UTC")).days, 7)
    const restored = await open("after-restart")
    await restored.locator(".usage-metrics").waitFor()
    assert.equal(await restored.getByLabel("Period", { exact: true }).inputValue(), "7")
    assert.deepEqual(calls, [30, 7, 7], "restart chooses saved period without waiting for optional discovery")
    await restored.close()
  } finally { release(); releaseDiscovery(); await fixture.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})
