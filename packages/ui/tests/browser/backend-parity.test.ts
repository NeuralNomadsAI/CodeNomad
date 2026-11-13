import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

async function fixturePage(run: (page: Page) => Promise<void>) {
  const fixture = await borrowFixture({ name: "backend-parity", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-parity.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => Boolean((window as any).parity) && document.querySelectorAll(".image-settings select:not(:disabled)").length === 3
      && document.querySelectorAll(".websearch-settings-defaults select:not(:disabled)").length === 6)
    await run(page)
    assert.deepEqual(await page.evaluate(() => (window as any).parity.violations), [])
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}

test("real Images and Web search consumers route A/B/local reads and mutations exclusively to their owner", async () => fixturePage(async page => {
  for (const owner of ["A", "B", "local"]) {
    const section = page.locator(`[data-owner="${owner}"]`)
    await section.locator(".image-settings select").selectOption("off")
    await page.waitForFunction(owner => (window as any).parity.calls.some((call: any) => call.owner === owner && call.body?.generation === false), owner)
    await page.waitForFunction(owner => !document.querySelector(`[data-owner="${owner}"] .image-settings select:disabled`), owner)
    await section.locator(".image-settings").getByRole("checkbox").click()
    await section.locator(".websearch-settings-defaults select").first().selectOption("off")
    await page.waitForFunction(owner => !document.querySelector(`[data-owner="${owner}"] .websearch-settings-defaults select:disabled`), owner)
    await section.locator(".websearch-settings-defaults select").last().selectOption("provider:search")
    await section.getByRole("button", { name: `New Images ${owner}`, exact: true }).click()
  }
  await page.waitForFunction(() => (window as any).parity.calls.filter((call: any) => call.path.endsWith("images-conversation")).length === 3)
  const calls = await page.evaluate(() => (window as any).parity.calls)
  for (const owner of ["A", "B", "local"]) {
    for (const suffix of ["image-settings", "websearch-settings", "images-conversation"]) {
      assert.ok(calls.some((call: any) => call.owner === owner && call.path === `/api/workspaces/same/${suffix}`))
    }
    const writes = calls.filter((call: any) => call.owner === owner && call.method !== "GET")
    assert.equal(writes.length, 5)
    assert.ok(writes.every((call: any) => (call.body.directory ?? call.body.location.directory) === `/${owner}`))
    assert.ok(writes.some((call: any) => call.body.mediaStorage === true))
    assert.ok(writes.some((call: any) => call.body.scope === "global" && call.body.provider === false))
    assert.ok(writes.some((call: any) => call.body.scope === "project" && call.body.provider === "search"))
  }
}))

test("failed remote writes stay remote; detach fences held completions and clears settings until reattachment", async () => fixturePage(async page => {
  const a = page.locator('[data-owner="A"]')
  await page.evaluate(() => (window as any).parity.fail())
  await a.locator(".image-settings select").selectOption("off")
  await a.locator(".image-settings [role=alert]").waitFor()
  const localBefore = await page.evaluate(() => (window as any).parity.calls.filter((call: any) => call.owner === "local").length)
  await page.evaluate(() => (window as any).parity.hold())
  await a.locator(".websearch-settings-defaults select").first().selectOption("off")
  await a.getByRole("button", { name: "New Images A", exact: true }).click()
  await page.waitForFunction(() => (window as any).parity.pending >= 2)
  await page.evaluate(() => (window as any).parity.detach())
  await page.waitForFunction(() => !document.querySelector('[data-owner="A"] .image-settings select')
    && !document.querySelector('[data-owner="A"] .websearch-settings-defaults select'))
  const dispatched = await page.evaluate(() => (window as any).parity.calls.length)
  await a.getByRole("button", { name: "New Images A", exact: true }).click()
  assert.equal(await page.evaluate(() => (window as any).parity.calls.length), dispatched, "detached action dispatches nothing")
  await page.evaluate(() => (window as any).parity.release())
  await page.waitForFunction(() => (window as any).parity.outcomes.some((result: any) => result.owner === "A" && result.status === "unknown"))
  await page.evaluate(() => (window as any).parity.reattach())
  await a.locator(".image-settings select").waitFor()
  assert.equal(await page.evaluate(() => (window as any).parity.calls.filter((call: any) => call.owner === "local").length), localBefore)
}))

test("homonymous sessions on two servers have independent notices, exact navigation and revoked actions", async () => fixturePage(async page => {
  await page.evaluate(() => { (window as any).parity.notify("A"); (window as any).parity.notify("B"); (window as any).parity.notify("A") })
  await page.waitForFunction(() => (window as any).parity.history().length === 2)
  assert.equal(await page.getByText('Session "Same session" was compacted', { exact: true }).count(), 2, "B never replaces A's bubble")
  let history = await page.evaluate(() => (window as any).parity.history())
  assert.deepEqual(history.map((item: any) => item.title).sort(), ["Server A · A", "Server B · B"])
  for (const owner of ["A", "B"]) {
    assert.deepEqual(history.find((item: any) => item.target.backendId === owner).target,
      { backendId: owner, instanceId: `${owner}~same`, sessionId: "ses_homonym" })
    await page.evaluate(owner => (window as any).parity.action(owner), owner)
    assert.equal((await page.evaluate(() => (window as any).parity.selected())).instance, `${owner}~same`)
  }
  await page.evaluate(() => (window as any).parity.action("A"))
  await page.evaluate(() => (window as any).parity.detach())
  history = await page.evaluate(() => (window as any).parity.history())
  assert.equal(history.length, 1)
  assert.equal(history[0].target.backendId, "B")
  await page.waitForFunction(() => [...document.querySelectorAll("p")].filter(el => el.textContent === 'Session "Same session" was compacted').length === 1)
  await page.evaluate(() => (window as any).parity.action("B"))
  await page.evaluate(() => { (window as any).parity.reattach(); return (window as any).parity.staleAction() })
  assert.equal((await page.evaluate(() => (window as any).parity.selected())).instance, "B~same")
  await page.evaluate(() => (window as any).parity.notify("A", "session.execution.succeeded", 2))
  await page.waitForFunction(() => (window as any).parity.history().length === 2)
  history = await page.evaluate(() => (window as any).parity.history())
  const done = history.find((item: any) => item.message.includes("finished"))
  assert.equal(done.title, "Server A · A")
  assert.deepEqual(done.target, { backendId: "A", instanceId: "A~same", sessionId: "ses_homonym" })
  assert.equal((await page.evaluate(() => (window as any).parity.selected())).instance, "B~same")
}))
