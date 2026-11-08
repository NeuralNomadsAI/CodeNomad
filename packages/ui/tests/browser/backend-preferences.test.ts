import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "backend-preferences", routes: [{ path: "/preferences",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-preferences.tsx"></script></body></html>' }] })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await events?.close() })

test("real model and Mission library controls preserve two server owners and host inheritance", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await events.route(page)
  await page.route("**/api/**", route => route.request().url().includes("/api/events") ? route.fallback()
    : route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    const a = page.locator('[data-owner="a"]'), b = page.locator('[data-owner="b"]')
    await b.locator(".mission-brief-picker select").waitFor({ timeout: 90_000 }).catch(error => { throw new Error(`${error}\nPage errors: ${errors.join("; ")}`) })
    assert.match(await a.locator(".mission-brief-picker select").innerText(), /A brief/)
    assert.doesNotMatch(await a.locator(".mission-brief-picker select").innerText(), /Host brief/)
    assert.match(await b.locator(".mission-brief-picker select").innerText(), /Host brief/)
    await b.locator("[data-model-selector-control] .selector-trigger").click()
    await page.locator(".selector-favorites-toggle").click()
    await page.waitForFunction(() => (window as any).fixture.records.b.state.models?.favoritesOnly === true)
    assert.deepEqual(await page.locator(".selector-listbox .selector-option-label").allInnerTexts(), ["Model host"])
    await page.keyboard.press("Escape")
    await a.locator("[data-model-selector-control] .selector-trigger").click()
    assert.equal(await page.locator(".selector-favorites-toggle").getAttribute("aria-pressed"), "false")
    await page.keyboard.press("Escape")
    await b.getByRole("button", { name: "Save as brief", exact: true }).click()
    await b.getByRole("textbox").fill("B saved")
    await b.getByRole("button", { name: "Save brief", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.records.b.config.settings?.missionModels?.length === 2)
    await b.locator(".mission-brief-picker select").getByRole("option", { name: "B saved", exact: true }).waitFor({ state: "attached" })
    assert.match(await b.locator(".mission-brief-picker select").innerText(), /B saved/)
    assert.doesNotMatch(await a.locator(".mission-brief-picker select").innerText(), /B saved/)
    await page.evaluate(() => { (window as any).fixture.hold("a"); (window as any).fixture.hold("b") })
    const shared = page.locator("[data-shared-save]")
    await shared.getByRole("button", { name: "Save as brief", exact: true }).click()
    await shared.getByRole("textbox").fill("Pending A")
    await shared.getByRole("button", { name: "Save brief", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.records.a.writes.some((write: any) => write.patch.settings?.missionModels?.some((model: any) => model.name === "Pending A")))
    await shared.getByRole("button", { name: "B owner", exact: true }).click()
    await shared.getByRole("textbox").fill("Pending B")
    await shared.getByRole("button", { name: "Save brief", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.records.b.writes.some((write: any) => write.patch.settings?.missionModels?.some((model: any) => model.name === "Pending B")))
    await page.evaluate(() => (window as any).fixture.release("a"))
    await page.waitForFunction(() => (window as any).fixture.records.a.config.settings.missionModels.some((model: any) => model.name === "Pending A"))
    assert.equal(await shared.getByRole("button", { name: "Save brief", exact: true }).isDisabled(), true, "A's late settlement cannot release B's pending edit")
    await page.evaluate(() => (window as any).fixture.release("b"))
    await shared.getByRole("button", { name: "Save as brief", exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.localWrites), [])
    for (const [id, dispose] of [["a", false], ["b", true]] as const) {
      await page.evaluate(id => { (window as any).fixture.hold(id); (window as any).fixture.favorite(id, "dispatched") }, id)
      await page.waitForFunction(id => (window as any).fixture.records[id].writes.some((write: any) => write.patch.models?.favorites?.some((model: any) => model.modelId === "dispatched")), id)
      const revoked = await page.evaluate(({ id, dispose }) => {
        const fixture = (window as any).fixture
        fixture.favorite(id, "queued")
        const result = fixture.revoke(id, dispose)
        fixture.release(id)
        return result
      }, { id, dispose })
      assert.deepEqual(revoked, { aborted: true, attached: false })
      await page.waitForFunction(id => (window as any).fixture.records[id].state.models?.favorites?.some((model: any) => model.modelId === "dispatched"), id)
      assert.equal(await page.evaluate(id => (window as any).fixture.records[id].writes.some((write: any) => write.patch.models?.favorites?.some((model: any) => model.modelId === "queued")), id), false)
      await page.locator(`[data-owner="${id}"] .mission-brief-picker select`).getByRole("option", { name: "Host brief", exact: true }).waitFor({ state: "attached" })
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
