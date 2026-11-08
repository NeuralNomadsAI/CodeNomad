import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { missionGeneralAction } from "./mission-actions"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  url = (await borrowFixture({ name: "mission-playbook-details", routes: [{ path: "/mission-fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })).url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

for (const locale of ["en", "fr"]) test(`all five playbooks open their selected localized help destination by keyboard without fetching details (${locale})`, async () => {
  const page = await browser.newPage({ locale: "en-US" }), reads: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await events.route(page)
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { locale } } }))
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: { location: { directory: "fixture" }, capability: null, effectiveDepth: null, project: null } }))
  await page.route("**/api/workspaces/fixture/missions**", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/missions/playbooks*", route => { reads.push(route.request().url()); return route.fulfill({ status: 503, json: {} }) })
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).missionFixture?.loaded())
    await page.waitForFunction(locale => document.documentElement.lang === locale
      && (locale === "en" || (window as any).missionFixture.text("missions.control.template") !== "Playbook"), locale)
    const text = (key: string) => page.evaluate(key => (window as any).missionFixture.text(key), key)
    await page.evaluate(() => {
      ;(window as any).playbookOpens = []
      window.open = url => { (window as any).playbookOpens.push(String(url)); return null }
    })
    await missionGeneralAction(page, await text("missions.control.create")).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(await text("missions.create.objective"), { exact: true }).fill("Keep this draft")
    const templates = ["custom", "debug", "wayfinder", "delivery", "compare"]
    for (const [index, template] of templates.entries()) {
      await form.getByRole("combobox", { name: await text("missions.control.template"), exact: true }).selectOption(template)
      const help = form.locator(".mission-create-template").getByRole("link", {
        name: await text(`missions.control.template.${template}.description`), exact: true })
      await help.focus(); await page.keyboard.press("Enter")
      await page.waitForFunction(count => (window as any).playbookOpens.length === count, index + 1)
      assert.equal(await form.locator(".mission-profiles").first().isVisible(), true)
      assert.equal(await form.getByRole("button", { name: "See details", exact: true }).count(), 0)
      assert.equal(await form.locator(".mission-create-template > p").count(), 0)
    }
    assert.deepEqual(await page.evaluate(() => (window as any).playbookOpens),
      templates.map(template => `https://neuralnomadsai.github.io/CodeNomad/${locale}/playbooks.html#${template}`))
    await form.getByRole("combobox", { name: await text("missions.taskMode.label"), exact: true }).selectOption("independent")
    assert.equal(await form.getByLabel(await text("missions.create.objective"), { exact: true }).inputValue(), "Keep this draft")
    assert.deepEqual(reads, [])
    assert.equal(await page.locator(".mission-reader").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
