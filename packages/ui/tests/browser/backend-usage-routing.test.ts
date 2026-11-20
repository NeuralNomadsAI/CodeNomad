import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

async function fixturePage(run: (page: Page) => Promise<void>) {
  const fixture = await borrowFixture({ name: "backend-usage-routing", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-usage-routing.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => document.querySelectorAll('.usage-metrics').length === 2
      && document.querySelectorAll('[role="progressbar"]').length === 2
      && document.querySelectorAll('[data-accounts] select option').length === 4)
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}

test("Stats, quota and account consumers route raw workspace IDs to their owner and deduplicate generations", async () => fixturePage(async page => {
  const remote = page.locator('[data-owner="remote"]'), local = page.locator('[data-owner="local"]')
  assert.equal(await remote.getByRole("progressbar").getAttribute("aria-valuenow"), "77")
  assert.equal(await local.getByRole("progressbar").getAttribute("aria-valuenow"), "11")
  assert.equal(await remote.locator(".usage-metrics dd").nth(3).textContent(), "77")
  await remote.getByRole("switch").click()
  await page.waitForFunction(() => (window as any).routing.calls.some((call: any) => call.method === "selection"))
  const calls = await page.evaluate(() => (window as any).routing.calls)
  for (const owner of ["local", "remote"]) {
    for (const method of ["owner", "cache", "stats", "quota", "accounts"]) {
      assert.ok(calls.some((call: any) => call.owner === owner && call.method === method && call.id === "same"), `${owner}:${method}`)
    }
  }
  assert.ok(calls.filter((call: any) => ["accounts", "selection"].includes(call.method)).every((call: any) => call.directory === "/Exact\\Folder/"))
  assert.equal(calls.find((call: any) => call.method === "selection").owner, "remote")
  const localCount = calls.filter((call: any) => call.owner === "local").length
  const statsCount = calls.filter((call: any) => call.owner === "remote" && call.method === "stats").length
  await page.evaluate(() => (window as any).routing.status(1))
  await page.waitForFunction(count => (window as any).routing.calls.filter((call: any) => call.owner === "remote" && call.method === "stats").length > count
    && !(document.querySelector('[data-owner="remote"] [data-accounts] select') as HTMLSelectElement).disabled, statsCount)
  const before = await page.evaluate(() => (window as any).routing.calls.length)
  await page.evaluate(() => (window as any).routing.status(1))
  assert.equal(await page.evaluate(() => (window as any).routing.calls.length), before)
  await page.evaluate(() => (window as any).routing.status(2))
  await page.waitForFunction(before => (window as any).routing.calls.length > before, before)
  assert.equal(await page.evaluate(() => (window as any).routing.calls.filter((call: any) => call.owner === "local").length), localCount)
}))

test("detach fences pending Stats, quotas and account writes; reattachment recovers without stale publication", async () => fixturePage(async page => {
  const remote = page.locator('[data-owner="remote"]')
  await page.evaluate(() => (window as any).routing.hold())
  await remote.getByRole("switch").click()
  await remote.locator('[data-stats] button').click()
  await page.evaluate(() => (window as any).routing.event("remote"))
  await page.waitForFunction(() => (window as any).routing.pending >= 3)
  await page.evaluate(() => (window as any).routing.detach())
  await page.waitForFunction(() => !document.querySelector('[data-owner="remote"] [role="progressbar"]')
    && !document.querySelector('[data-owner="remote"] .usage-metrics')
    && document.querySelectorAll('[data-owner="remote"] [data-accounts] option').length === 0)
  await page.evaluate(() => { (window as any).routing.release(); (window as any).routing.reattach() })
  await page.waitForFunction(() => document.querySelector('[data-owner="remote"] [role="progressbar"]')?.getAttribute("aria-valuenow") === "22"
    && document.querySelector('[data-owner="remote"] [data-accounts] select')?.textContent?.includes("remote-2"))
  assert.equal(await remote.locator(".usage-metrics dd").nth(3).textContent(), "22")
  assert.equal(await remote.getByRole("switch").isChecked(), true)
  assert.equal(await remote.locator('[data-accounts] select').isDisabled(), false)
  assert.equal(await remote.locator('[data-stats] button').isDisabled(), false)
}))

test("a missing backend clears consumers and never sends their reads to local", async () => fixturePage(async page => {
  const count = await page.evaluate(() => (window as any).routing.calls.length)
  await page.evaluate(() => (window as any).routing.missing())
  await page.waitForFunction(() => !document.querySelector('[data-owner="remote"] [role="progressbar"]')
    && !document.querySelector('[data-owner="remote"] .usage-metrics')
    && document.querySelectorAll('[data-owner="remote"] [data-accounts] option').length === 0)
  assert.equal(await page.evaluate(() => (window as any).routing.calls.length), count)
}))
