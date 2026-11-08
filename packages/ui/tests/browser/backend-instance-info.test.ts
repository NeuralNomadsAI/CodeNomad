import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "backend-instance-info", routes: [{ path: "/info",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-instance-info.tsx"></script></body></html>' }] })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await events?.close() })

test("project information reads only its server environment and masking policy, including cold loads", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await events.route(page)
  await page.route("**/api/**", route => route.request().url().includes("/api/events") ? route.fallback()
    : route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 90_000 })
    const local = page.locator('[data-owner="local"]'), remote = page.locator('[data-owner="remote"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.coldEnvironment), {})
    assert.doesNotMatch(await remote.innerText(), /host-secret|HOST_ONLY|host-only|host-mask|SHARED/)
    assert.equal(await remote.getByRole("button", { name: "Reload OpenCode configuration", exact: true }).count(), 0)
    assert.match(await local.innerText(), /HOST_ONLY/)
    assert.match(await local.innerText(), /LOCAL_SNAPSHOT[\s\S]*kept/)
    assert.doesNotMatch(await local.innerText(), /host-secret|host-mask/)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.loadRemote()), {
      SHARED: "remote-secret", REMOTE_ONLY: "remote-only", HOST_MASK: "remote-public",
    })
    await remote.getByText("remote-only", { exact: true }).waitFor()
    assert.match(await remote.innerText(), /remote-public/)
    assert.doesNotMatch(await remote.innerText(), /remote-secret|host-secret|HOST_ONLY|host-only|host-mask/)
    const secretRow = remote.getByText("SHARED", { exact: true }).locator("..")
    assert.match(await secretRow.innerText(), /\*\*\*/)
    assert.doesNotMatch(await secretRow.locator("[title]").evaluateAll(elements => elements.map(element => element.getAttribute("title")).join(" ")), /remote-secret/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("reload remains local and a captured confirmation cannot administer after project change or unmount", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await events.route(page)
  await page.route("**/api/**", route => route.request().url().includes("/api/events") ? route.fallback()
    : route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 90_000 })
    const reload = (owner: string) => page.locator(`[data-owner="${owner}"]`).getByRole("button", { name: "Reload OpenCode configuration", exact: true })
    await reload("changing").click()
    await page.getByRole("dialog").waitFor()
    await page.evaluate(() => (window as any).fixture.selectRemote())
    await page.getByRole("dialog").getByRole("button", { name: "Reload OpenCode configuration", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.reloads), 0)
    assert.equal(await reload("changing").count(), 0)
    await page.evaluate(() => (window as any).fixture.selectLocal())
    await reload("changing").click()
    await page.getByRole("dialog").waitFor()
    await page.evaluate(() => (window as any).fixture.hide())
    await page.getByRole("dialog").getByRole("button", { name: "Reload OpenCode configuration", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.reloads), 0)
    await reload("local").click()
    await page.getByRole("dialog").getByRole("button", { name: "Reload OpenCode configuration", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.reloads === 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
